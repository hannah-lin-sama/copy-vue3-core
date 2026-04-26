import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Link, globalVersion } from './dep'
import { activeEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  // 调度器函数，用于在依赖变化时调用
  scheduler?: EffectScheduler
  // 是否允许递归调用
  allowRecurse?: boolean
  // 停止函数，用于在订阅者被移除时调用
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

// 当前活跃的订阅者
export let activeSub: Subscriber | undefined

export enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  ACTIVE = 1 << 0, // 活跃状态
  RUNNING = 1 << 1, // 运行状态
  TRACKING = 1 << 2, // 跟踪状态
  NOTIFIED = 1 << 3, // 已通知状态
  DIRTY = 1 << 4, // 脏状态
  ALLOW_RECURSE = 1 << 5, // 允许递归状态
  PAUSED = 1 << 6, // 暂停状态
  EVALUATED = 1 << 7, // 已评估状态
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * 依赖链表的头部指针，指向订阅者的第一个依赖
   * @internal
   */
  deps?: Link
  /**
   * Tail of the same list
   * 赖链表的尾部指针，指向订阅者的最后一个依赖
   * @internal
   */
  depsTail?: Link
  /**
   * @internal
   * 状态标志，用于表示订阅者的状态
   */
  flags: EffectFlags
  /**
   * @internal
   * 指向下一个订阅者的指针，用于批处理时构建订阅者链表
   */
  next?: Subscriber
  /**
   * returning `true` indicates it's a computed that needs to call notify
   * on its dep too
   * 通知方法，当依赖变化时被调用
   * @internal
   */
  notify(): true | void
}

const pausedQueueEffects = new WeakSet<ReactiveEffect>()

export class ReactiveEffect<T = any>
  // Subscriber 接口：定义了依赖追踪相关的属性和方法
  // ReactiveEffectOptions 接口：定义了配置选项，如调度器、调试回调等
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * 双向链表头指针
   * @internal
   */
  deps?: Link = undefined
  /**
   * 双向链表尾指针
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * effect 状态标志位 , 活跃状态➕跟踪状态
   * @internal
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * 下一个 订阅者的指针
   * @internal
   */
  next?: Subscriber = undefined
  /**
   * @internal
   */
  cleanup?: () => void = undefined

  scheduler?: EffectScheduler = undefined
  // 停止函数，用于在订阅者被移除时调用
  onStop?: () => void
  // 依赖追踪时的调试回调
  onTrack?: (event: DebuggerEvent) => void
  // 依赖触发时的调试回调
  onTrigger?: (event: DebuggerEvent) => void

  constructor(public fn: () => T) {
    // 构造函数接收一个函数 fn，并将其存储为实例属性
    if (activeEffectScope && activeEffectScope.active) {
      // 将当前 effect 实例天道到作用域的 effect 列表中
      activeEffectScope.effects.push(this)
    }
  }

  pause(): void {
    // 暂停当前 effect 实例
    this.flags |= EffectFlags.PAUSED
  }

  // 恢复当前 effect 实例
  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      // 移除暂停 effect 实例的标志位
      this.flags &= ~EffectFlags.PAUSED
      if (pausedQueueEffects.has(this)) {
        // 从暂停队列中移除当前 effect 实例
        pausedQueueEffects.delete(this)
        this.trigger()
      }
    }
  }

  /**
   * @internal
   */
  notify(): void {
    if (
      // 如果当前 effect 实例正在运行中，且不允许递归调用
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      return
    }
    // 如果当前 effect 实例未被通知过
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      // 标记当前 effect 实例为已通知
      batch(this)
    }
  }

  run(): T {
    // TODO cleanupEffect

    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      // 调用当前 effect 实例的 fn 函数
      return this.fn()
    }

    // 标记当前 effect 实例为正在运行
    this.flags |= EffectFlags.RUNNING
    // 清理当前 effect 实例的依赖链表
    cleanupEffect(this)
    // 准备当前 effect 实例的依赖链表
    prepareDeps(this)
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack

    // 设置当前实例为活跃订阅者
    activeSub = this

    // 标记当前实例为正在追踪依赖
    shouldTrack = true

    try {
      // 调用当前 effect 实例的 fn 函数
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      cleanupDeps(this)
      activeSub = prevEffect // 恢复上一个活跃订阅者
      shouldTrack = prevShouldTrack // 恢复上一个 shouldTrack 状态
      // 移除当前 effect 实例正在运行的标志位
      this.flags &= ~EffectFlags.RUNNING
    }
  }

  // 停止当前 effect 实例
  stop(): void {
    // 如果当前 effect 实例正在运行中
    if (this.flags & EffectFlags.ACTIVE) {
      // 移除当前 effect 实例的所有依赖
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      // 清理当前 effect 实例的依赖链表
      this.deps = this.depsTail = undefined
      // 清理当前 effect 实例的依赖链表
      cleanupEffect(this)
      // 调用当前 effect 实例的 onStop 回调
      this.onStop && this.onStop()
      // 移除当前 effect 实例活跃的标志位
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  // 触发当前 effect 执行，根据调度器函数或直接运行
  trigger(): void {
    // 如果当前 effect 实例正在暂停中
    if (this.flags & EffectFlags.PAUSED) {
      // 将当前 effect 实例添加到暂停队列中
      pausedQueueEffects.add(this)

      // 调用当前 effect 实例的 scheduler 函数
    } else if (this.scheduler) {
      this.scheduler()
    } else {
      // 如果当前 effect 实例脏了
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty(): void {
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty(): boolean {
    return isDirty(this)
  }
}

/**
 * For debugging
 */
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

// 跟踪当前批处理的深度
let batchDepth = 0

// 存储普通订阅者（非计算属性）的批处理队列头
let batchedSub: Subscriber | undefined

// 存储计算属性订阅者的批处理队列头
let batchedComputed: Subscriber | undefined

/**
 * 添加订阅者到批处理队列中
 * @param sub 订阅者实例
 * @param isComputed 是否为计算属性
 * @returns
 */
export function batch(sub: Subscriber, isComputed = false): void {
  sub.flags |= EffectFlags.NOTIFIED // 标记订阅者为已通知

  // 如果是计算属性，将其加入到批处理队列中
  if (isComputed) {
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }

  // 如果不是计算属性，将其加入到批处理队列中
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * @internal
 */
export function startBatch(): void {
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * 结束批处理并执行批处理队列中的所有订阅者
 * @internal
 */
export function endBatch(): void {
  // 检查深度：如果减后仍然大于 0，说明还有嵌套的批处理，直接返回
  if (--batchDepth > 0) {
    return
  }

  // 处理计算属性队列
  if (batchedComputed) {
    let e: Subscriber | undefined = batchedComputed
    batchedComputed = undefined

    // 遍历队列：从队列头开始遍历每个计算属性订阅者
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined // 清除当前订阅者的 next 指针
      e.flags &= ~EffectFlags.NOTIFIED // 移除当前订阅者的已通知标志位
      e = next
    }
  }

  // 处理普通订阅者队列
  let error: unknown
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE flag is effect-only
          // 如果激活，调用其 trigger() 方法
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          if (!error) error = err
        }
      }
      e = next
    }
  }

  if (error) throw error
}

/**
 * 准备订阅者（Subscriber）的依赖链表
 * @param sub 订阅者实例
 */
function prepareDeps(sub: Subscriber) {
  // Prepare deps for tracking, starting from the head
  // 从订阅者的 deps（依赖链表头部）开始，遍历所有依赖链接
  for (let link = sub.deps; link; link = link.nextDep) {
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run
    // 将 每个 link 的 version 设置为 -1
    link.version = -1
    // store previous active sub if link was being used in another context
    // 保存依赖当前的 activeLink 到 link.prevActiveLink
    link.prevActiveLink = link.dep.activeLink
    // 将当前链接设置为依赖的 activeLink
    link.dep.activeLink = link
  }
}

// 清理订阅者（Subscriber）中未使用的依赖
function cleanupDeps(sub: Subscriber) {
  // Cleanup unused deps
  let head // 用于记录新的依赖链表头部
  let tail = sub.depsTail // 从订阅者的 depsTail 开始，即依赖链表的尾部
  let link = tail // 当前处理的依赖链接，初始化为 tail

  // 逆序遍历依赖链表
  while (link) {
    const prev = link.prevDep

    // 在 prepareDeps 函数中，所有依赖的版本号会被重置为 -1
    // 版本号仍为 -1 的依赖表示在本次运行中未被使用
    if (link.version === -1) {
      // 如果当前链接是尾部，更新 tail 为前一个节点
      if (link === tail) tail = prev
      // unused - remove it from the dep's subscribing effect list
      // 从依赖的订阅者列表中移除该链接
      removeSub(link)
      // also remove it from this effect's dep list
      // 从订阅者的依赖列表中移除该链接
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      // 因为是逆序遍历，最后一个被使用的链接会成为新的头部
      head = link
    }

    // restore previous active link if any
    // 复依赖的 activeLink 为之前保存的 prevActiveLink
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined // 清除 prevActiveLink，避免内存泄漏
    link = prev
  }
  // set the new head & tail
  sub.deps = head
  sub.depsTail = tail
}

/**
 * 检查当前 effect 实例是否脏了
 * @param sub effect 实例
 * @returns 是否脏了
 */
function isDirty(sub: Subscriber): boolean {
  for (let link = sub.deps; link; link = link.nextDep) {
    // 版本号检查：
    // 对于每个依赖，检查 link.dep.version（依赖的当前版本）是否与 link.version（订阅者记录的版本）不一致。
    // 版本号不一致意味着依赖的数据发生了变化，订阅者需要重新执行。
    if (
      link.dep.version !== link.version ||
      // 计算属性特殊处理：
      // 如果依赖关联了计算属性（link.dep.computed），则：
      // 调用 refreshComputed 刷新计算属性，确保其状态为最新。
      // 检查刷新后是否需要重新执行，或刷新后依赖的版本是否变化。
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * Returning false indicates the refresh failed
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  // 如果计算属性正在追踪依赖，且没有脏了，直接返回
  if (
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }

  // 清除脏标志标志
  computed.flags &= ~EffectFlags.DIRTY

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  // 如果计算属性的全局版本号与当前全局版本号相同，直接返回
  // 这意味着计算属性的值没有变化，不需要重新计算
  if (computed.globalVersion === globalVersion) {
    return
  }
  // 更新全局版本号
  computed.globalVersion = globalVersion

  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  // #12337 if computed has no deps (does not rely on any reactive data) and evaluated,
  // there is no need to re-evaluate.
  // 非 SSR 环境下，且计算属性已评估，且没有依赖或依赖脏了，直接返回
  // 这意味着计算属性的值没有变化，不需要重新计算
  if (
    !computed.isSSR &&
    computed.flags & EffectFlags.EVALUATED &&
    ((!computed.deps && !(computed as any)._dirty) || !isDirty(computed))
  ) {
    return
  }
  // 设置运行标志标志
  computed.flags |= EffectFlags.RUNNING

  const dep = computed.dep // 获取计算属性的依赖
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack

  activeSub = computed

  shouldTrack = true

  try {
    prepareDeps(computed)
    // 计算属性的 getter 函数
    const value = computed.fn(computed._value)

    // 如果依赖的版本号为 0，或计算属性的值与旧值不同，需要重新计算
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed.flags |= EffectFlags.EVALUATED
      computed._value = value
      dep.version++
    }
  } catch (err) {
    dep.version++ // 增加依赖的版本号，表示依赖的数据发生了变化
    throw err
  } finally {
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    cleanupDeps(computed)
    computed.flags &= ~EffectFlags.RUNNING
  }
}

/**
 * 从依赖（Dep）的订阅者链表中移除指定的链接（Link）
 * @param link 订阅者链接
 * @param soft 是否软移除
 */
function removeSub(link: Link, soft = false) {
  // 从 link 中解构出 dep（依赖）、prevSub（前一个订阅者链接）和 nextSub（后一个订阅者链接）
  const { dep, prevSub, nextSub } = link

  // 如果前一个订阅者链接存在，将 nextSub 赋值给 prevSub.nextSub
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined // 清除 link 的 prevSub 指针，避免内存泄漏
  }
  // 如果后一个订阅者链接存在，将 prevSub 赋值给 nextSub.prevSub
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined // 清除 link 的 nextSub 指针，避免内存泄漏
  }
  if (__DEV__ && dep.subsHead === link) {
    // was previous head, point new head to next
    dep.subsHead = nextSub
  }

  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub

    if (!prevSub && dep.computed) {
      // if computed, unsubscribe it from all its deps so this computed and its
      // value can be GCed
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // here we are only "soft" unsubscribing because the computed still keeps
        // referencing the deps and the dep should not decrease its sub count
        removeSub(l, true)
      }
    }
  }

  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // property dep no longer has effect subscribers, delete it
    // this mostly is for the case where an object is kept in memory but only a
    // subset of its properties is tracked at one time
    dep.map.delete(dep.key)
  }
}

/**
 * 从订阅者的依赖链表中移除指定的链接
 * @param link
 */
function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined // 清除 link 的 prevDep 指针，避免内存泄漏
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined // 清除 link 的 nextDep 指针，避免内存泄漏
  }
}

/**
 * 创建响应式的副作用函数。它会追踪函数执行过程中访问的响应式数据，并在这些数据变化时自动重新执行函数
 * @param fn 要执行的副作用函数
 * @param options 选项对象
 * @returns
 */
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  // 检查 fn 是否已经是一个 ReactiveEffectRunner（即之前通过 effect 函数创建的 runner）
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    // 使用其内部的原始函数 effect.fn
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建一个新的 ReactiveEffect 实例，传入副作用函数 fn
  const e = new ReactiveEffect(fn)
  if (options) {
    extend(e, options)
  }
  try {
    e.run()
  } catch (err) {
    // 如果副作用函数执行过程中抛出异常，停止该副作用函数的依赖追踪
    e.stop()
    throw err
  }

  // 创建 runner 函数，用于手动触发副作用函数的执行
  const runner = e.run.bind(e) as ReactiveEffectRunner
  // 将 runner 函数关联的 effect 实例赋值给 runner.effect，方便后续调用
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true // 是否应该跟踪依赖, 默认为 true

// 用于存储临时的 shouldTrack 状态
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 * 临时暂停依赖依赖收集
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 * 临时恢复依赖依赖收集
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 * 重置依赖依赖收集状态
 */
export function resetTracking(): void {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(e: ReactiveEffect) {
  const { cleanup } = e
  e.cleanup = undefined
  if (cleanup) {
    // run cleanup without active effect
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup() // 执行清理函数
    } finally {
      activeSub = prevSub
    }
  }
}
