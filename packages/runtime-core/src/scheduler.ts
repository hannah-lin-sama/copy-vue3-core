import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { NOOP, isArray } from '@vue/shared'
import { type ComponentInternalInstance, getComponentName } from './component'

export enum SchedulerJobFlags {
  QUEUED = 1 << 0, // 1 标记已经加入队列
  PRE = 1 << 1, // 2 标记任务在 DOM 更新前 执行
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  ALLOW_RECURSE = 1 << 2, // 4 允许自身递归
  DISPOSED = 1 << 3, // 已被销毁或已取消
}

export interface SchedulerJob extends Function {
  id?: number // 任务 ID（用于去重和调试）
  /**
   * flags can technically be undefined, but it can still be used in bitwise
   * operations just like 0.
   */
  flags?: SchedulerJobFlags // 任务标志（用于调度控制）
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   */
  i?: ComponentInternalInstance // 组件实例（用于错误处理）
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

// 存储待执行的主任务
const queue: SchedulerJob[] = []

// 跟踪当前正在执行的任务在队列中的索引
let flushIndex = -1

// 存储待执行的后置任务
// DOM 更新后需要执行的任务，如 watchPostEffect、组件挂载后的回调等
const pendingPostFlushCbs: SchedulerJob[] = []

// 当前正在执行的后置任务队列
// 在执行后置任务时使用，避免直接修改 pendingPostFlushCbs
let activePostFlushCbs: SchedulerJob[] | null = null

// 跟踪当前正在执行的后置任务在队列中的索引
let postFlushIndex = 0

// 一个已解决的 Promise 实例
// 用于创建微任务，将任务延迟到下一个微任务执行
const resolvedPromise = /*@__PURE__*/ Promise.resolve() as Promise<any>

// 当前正在执行的刷新 Promise
// 用于跟踪当前正在执行的刷新操作，避免重复触发
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick(): Promise<void>
export function nextTick<T, R>(
  this: T,
  fn: (this: T) => R | Promise<R>,
): Promise<R>
/**
 * 将回调函数推迟到下一个 DOM 更新周期后执行
 * @param this
 * @param fn
 * @returns
 */
export function nextTick<T, R>(
  this: T,
  fn?: (this: T) => R | Promise<R>,
): Promise<void | R> {
  // 优先使用 currentFlushPromise（当前正在执行的刷新 Promise）
  // 如果不存在，则使用 resolvedPromise（一个已解决的 Promise 实例）
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// Use binary-search to find a suitable position in the queue. The queue needs
// to be sorted in increasing order of the job ids. This ensures that:
// 1. Components are updated from parent to child. As the parent is always
//    created before the child it will always have a smaller id.
// 2. If a component is unmounted during a parent component's update, its update
//    can be skipped.
// A pre watcher will have the same id as its component's update job. The
// watcher should be inserted immediately before the update job. This allows
// watchers to be skipped if the component is unmounted by the parent update.
// 在任务队列中找到合适的插入位置
function findInsertionIndex(id: number) {
  // 搜索起点：从 flushIndex + 1 开始，因为 flushIndex 之前的任务已经开始执行，不需要重新排序
  let start = flushIndex + 1
  // 搜索终点：队列的长度，即队列的末尾
  let end = queue.length

  while (start < end) {
    // 计算中间位置
    const middle = (start + end) >>> 1
    // 获取中间任务：获取中间位置的任务和其 ID
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)

    // 如果中间任务的 ID 小于目标 ID，说明目标任务应该插入到右半部分
    // 如果中间任务的 ID 等于目标 ID，但中间任务有 PRE 标志，说明目标任务应该插入到右半部分
    if (
      middleJobId < id ||
      (middleJobId === id && middleJob.flags! & SchedulerJobFlags.PRE)
    ) {
      start = middle + 1
    } else {
      // 目标任务应该插入到左半部分
      end = middle
    }
  }

  return start
}

/**
 * 将任务（job）添加到调度队列中，并确保任务按照正确的顺序执行
 * @param job 添加到队列的任务
 */
export function queueJob(job: SchedulerJob): void {
  // 如果任务未被标志为QUEUED，则执行入队操作
  if (!(job.flags! & SchedulerJobFlags.QUEUED)) {
    const jobId = getId(job) // 获取任务的唯一标识符
    const lastJob = queue[queue.length - 1] // 获取当前队列中的最后一个任务
    // 入队策略：
    // 快速路径：如果队列为空，或者任务没有 PRE 标志且任务 ID 大于等于队尾任务的 ID，则直接将任务推入队列末尾
    if (
      !lastJob ||
      (!(job.flags! & SchedulerJobFlags.PRE) && jobId >= getId(lastJob))
    ) {
      queue.push(job)

      // 插入路径：否则，通过 findInsertionIndex 找到合适的插入位置，使用 splice 插入任务
    } else {
      queue.splice(findInsertionIndex(jobId), 0, job)
    }

    job.flags! |= SchedulerJobFlags.QUEUED // 标记任务为已入队

    queueFlush()
  }
}
/**
 * 触发刷新操作，执行队列中的任务
 */
function queueFlush() {
  // 检查是否已经有正在执行的刷新操作
  // 这是一个防重复机制，确保同一时间只触发一次刷新
  if (!currentFlushPromise) {
    // 在 Promise 解析后执行 flushJobs 函数
    // flushJobs 函数负责执行所有任务，包括 DOM 更新操作
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

/**
 * 将回调函数添加到后置任务队列中
 * @param cb 可以是单个回调函数或回调函数数组
 */
export function queuePostFlushCb(cb: SchedulerJobs): void {
  if (!isArray(cb)) {
    if (activePostFlushCbs && cb.id === -1) {
      // 如果 activePostFlushCbs 存在且回调的 id === -1，则将回调插入到当前执行索引 postFlushIndex 之后
      // 这通常用于紧急任务，需要在当前执行队列中立即插入
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb)
    } else if (!(cb.flags! & SchedulerJobFlags.QUEUED)) {
      // 如果回调没有 QUEUED 标志，则将其添加到 pendingPostFlushCbs 队列，并标记为 QUEUED
      // 这避免了重复添加同一个回调
      pendingPostFlushCbs.push(cb)
      cb.flags! |= SchedulerJobFlags.QUEUED
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    // 如果 cb 是数组，直接将数组中的所有回调添加到 pendingPostFlushCbs 队列
    pendingPostFlushCbs.push(...cb)
  }
  // 触发刷新
  queueFlush()
}

/**
 * 执行队列中带有 PRE 标志的前置任务
 * @param instance 当前组件实例，用于筛选出与该实例相关的预任务
 * @param seen 用于检测递归调用的 Map，用于记录已处理的任务
 * @param i 当前任务队列的索引，用于跳过当前任务
 */
export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,
  seen?: CountMap,
  // skip the current job
  i: number = flushIndex + 1,
): void {
  if (__DEV__) {
    seen = seen || new Map()
  }
  // 从索引 i 开始遍历 queue 队列
  for (; i < queue.length; i++) {
    const cb = queue[i]

    // 如果任务有 PRE 标志，说明是前置任务
    if (cb && cb.flags! & SchedulerJobFlags.PRE) {
      // 任务的 id 与实例的 uid 不同，则跳过该任务
      if (instance && cb.id !== instance.uid) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      // 从队列中移除任务：使用 splice 从队列中移除当前任务
      queue.splice(i, 1)
      // 调整索引：由于队列长度减少，需要将索引 i 减 1
      i--
      if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
      // 执行任务：直接调用任务函数
      cb()
      if (!(cb.flags! & SchedulerJobFlags.ALLOW_RECURSE)) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
    }
  }
}

/**
 * 执行后置任务队列中的所有任务
 * @param seen 用于检测递归调用的 Map，用于记录已处理的任务
 * @returns
 */
export function flushPostFlushCbs(seen?: CountMap): void {
  if (pendingPostFlushCbs.length) {
    // 使用 Set 去除重复的任务，避免重复执行
    // 根据任务的 ID 进行排序，确保任务按照正确的顺序执行
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b),
    )
    // 清空队列
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 如果是嵌套调用，将任务添加到当前活跃队列中，然后返回
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    // 设置活跃队列：将去重和排序后的任务队列设置为当前活跃队列
    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 遍历执行：按照顺序遍历执行每个任务
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      const cb = activePostFlushCbs[postFlushIndex]
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED // 清除 QUEUED 标志
      }
      // 执行任务：如果任务没有被标记为 DISPOSED，执行任务
      if (!(cb.flags! & SchedulerJobFlags.DISPOSED)) cb()
      cb.flags! &= ~SchedulerJobFlags.QUEUED // 清除 QUEUED 标志
    }
    activePostFlushCbs = null // 重置活跃队列
    postFlushIndex = 0 // 重置索引
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? (job.flags! & SchedulerJobFlags.PRE ? -1 : Infinity) : job.id

/**
 * 执行主任务队列中的所有任务
 * @param seen 用于检测递归调用的 Map，用于记录已处理的任务
 */
function flushJobs(seen?: CountMap) {
  if (__DEV__) {
    seen = seen || new Map()
  }

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 1、执行主任务队列：按照顺序执行 queue 中的所有任务
    // 遍历队列中的任务，执行每个任务
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]

      // 任务未被设置为已销毁
      if (job && !(job.flags! & SchedulerJobFlags.DISPOSED)) {
        if (__DEV__ && check(job)) {
          continue
        }
        if (job.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
          job.flags! &= ~SchedulerJobFlags.QUEUED // 清除 QUEUED 标志
        }
        // 执行任务：如果任务没有被标记为 DISPOSED，执行任务
        callWithErrorHandling(
          job,
          job.i,
          job.i ? ErrorCodes.COMPONENT_UPDATE : ErrorCodes.SCHEDULER,
        )
        if (!(job.flags! & SchedulerJobFlags.ALLOW_RECURSE)) {
          job.flags! &= ~SchedulerJobFlags.QUEUED // 清除 QUEUED 标志
        }
      }
    }
  } finally {
    // If there was an error we still need to clear the QUEUED flags
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job) {
        job.flags! &= ~SchedulerJobFlags.QUEUED // 清除 QUEUED 标志
      }
    }

    // 重置索引：将 flushIndex 重置为 -1，表示队列执行完成
    flushIndex = -1
    // 清空队列：将 queue 长度设置为 0，清空主任务队列
    queue.length = 0

    // 调用 flushPostFlushCbs 执行后置任务队列
    flushPostFlushCbs(seen)

    currentFlushPromise = null
    // If new jobs have been added to either queue, keep flushing
    // 新任务：如果执行过程中又有新任务加入队列，继续执行
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  const count = seen.get(fn) || 0
  if (count > RECURSION_LIMIT) {
    const instance = fn.i
    const componentName = instance && getComponentName(instance.type)
    handleError(
      `Maximum recursive updates exceeded${
        componentName ? ` in component <${componentName}>` : ``
      }. ` +
        `This means you have a reactive effect that is mutating its own ` +
        `dependencies and thus recursively triggering itself. Possible sources ` +
        `include component template, render function, updated hook or ` +
        `watcher source function.`,
      null,
      ErrorCodes.APP_ERROR_HANDLER,
    )
    return true
  }
  seen.set(fn, count + 1)
  return false
}
