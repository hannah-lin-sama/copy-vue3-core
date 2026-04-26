import {
  EMPTY_OBJ,
  NOOP,
  hasChanged,
  isArray,
  isFunction,
  isMap,
  isObject,
  isPlainObject,
  isSet,
  remove,
} from '@vue/shared'
import { warn } from './warning'
import type { ComputedRef } from './computed'
import { ReactiveFlags } from './constants'
import {
  type DebuggerOptions,
  EffectFlags,
  type EffectScheduler,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
} from './effect'
import { isReactive, isShallow } from './reactive'
import { type Ref, isRef } from './ref'
import { getCurrentScope } from './effectScope'

// These errors were transferred from `packages/runtime-core/src/errorHandling.ts`
// to @vue/reactivity to allow co-location with the moved base watch logic, hence
// it is essential to keep these values unchanged.
export enum WatchErrorCodes {
  WATCH_GETTER = 2,
  WATCH_CALLBACK,
  WATCH_CLEANUP,
}

export type WatchEffect = (onCleanup: OnCleanup) => void

export type WatchSource<T = any> = Ref<T, any> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup,
) => any

export type OnCleanup = (cleanupFn: () => void) => void

export interface WatchOptions<Immediate = boolean> extends DebuggerOptions {
  // 控制是否在创建 watch 时立即执行回调函数
  // 使用场景：需要在初始化时就执行一次回调的场景
  immediate?: Immediate
  // 控制是否深度监听
  deep?: boolean | number
  // 控制是否只执行一次回调
  once?: boolean
  // 自定义调度器函数，控制回调的执行时机
  scheduler?: WatchScheduler
  // 自定义警告处理函数
  onWarn?: (msg: string, ...args: any[]) => void
  /**
   * @internal
   * 增强 job 函数，添加额外的功能
   */
  augmentJob?: (job: (...args: any[]) => void) => void
  /**
   * @internal
   * 调用函数并处理错误
   * 注意：这是内部 API，不建议在应用代码中使用
   */
  call?: (
    fn: Function | Function[],
    type: WatchErrorCodes,
    args?: unknown[],
  ) => void
}

export type WatchStopHandle = () => void

export interface WatchHandle extends WatchStopHandle {
  pause: () => void
  resume: () => void
  stop: () => void
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

export type WatchScheduler = (job: () => void, isFirstRun: boolean) => void

const cleanupMap: WeakMap<ReactiveEffect, (() => void)[]> = new WeakMap()

// 当前 active watcher
let activeWatcher: ReactiveEffect | undefined = undefined

/**
 * Returns the current active effect if there is one.
 */
export function getCurrentWatcher(): ReactiveEffect<any> | undefined {
  return activeWatcher
}

/**
 * Registers a cleanup callback on the current active effect. This
 * registered cleanup callback will be invoked right before the
 * associated effect re-runs.
 *
 * @param cleanupFn - The callback function to attach to the effect's cleanup.
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 * @param owner - The effect that this cleanup function should be attached to.
 * By default, the current active effect.
 * 为 watcher 注册清理函数。这些清理函数会在 watcher 重新执行前被调用，用于清理之前执行产生的副作用
 */
export function onWatcherCleanup(
  cleanupFn: () => void,
  // 是否静默失败，默认为 false，如果为 true，则在没有活跃 watcher 时不发出警告
  failSilently = false,
  // 清理函数的所有者，默认为当前活跃 watcher
  owner: ReactiveEffect | undefined = activeWatcher,
): void {
  if (owner) {
    let cleanups = cleanupMap.get(owner)
    if (!cleanups) cleanupMap.set(owner, (cleanups = []))
    cleanups.push(cleanupFn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onWatcherCleanup() was called when there was no active watcher` +
        ` to associate with.`,
    )
  }
}

export function watch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  // 数据变化时的回调函数
  cb?: WatchCallback | null,
  options: WatchOptions = EMPTY_OBJ,
): WatchHandle {
  const { immediate, deep, once, scheduler, augmentJob, call } = options

  const warnInvalidSource = (s: unknown) => {
    ;(options.onWarn || warn)(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`,
    )
  }

  const reactiveGetter = (source: object) => {
    // traverse will happen in wrapped getter below
    if (deep) return source
    // for `deep: false | 0` or shallow reactive, only traverse root-level properties
    if (isShallow(source) || deep === false || deep === 0)
      return traverse(source, 1) // 仅遍历根属性
    // for `deep: undefined` on a reactive object, deeply traverse all properties
    // 递归遍历所有属性
    return traverse(source)
  }

  let effect: ReactiveEffect // 创建一个 ReactiveEffect 实例
  let getter: () => any
  let cleanup: (() => void) | undefined
  let boundCleanup: typeof onWatcherCleanup
  let forceTrigger = false
  let isMultiSource = false

  // 处理 source 参数
  // 1、如果 source 是一个 ref，直接返回其值
  if (isRef(source)) {
    getter = () => source.value
    forceTrigger = isShallow(source) // 如果 source 是一个浅响应式对象，直接触发一次

    // 2、如果 source 是一个 reactive object，递归遍历其所有属性
  } else if (isReactive(source)) {
    getter = () => reactiveGetter(source)
    forceTrigger = true // 标记为需要触发一次

    // 如果 source 是一个数组，递归遍历其所有元素
  } else if (isArray(source)) {
    isMultiSource = true // 标记为多源 watch
    // 如果 source 中有任何一个元素是响应式对象或浅响应式对象，就标记为需要触发一次
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return reactiveGetter(s)
        } else if (isFunction(s)) {
          return call ? call(s, WatchErrorCodes.WATCH_GETTER) : s()
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    // 1、有回调函数
    if (cb) {
      // getter with cb
      // 如果有回调，作为 getter 使用
      getter = call
        ? () => call(source, WatchErrorCodes.WATCH_GETTER)
        : (source as () => any)

      // 2、没有回调函数
      // 如果没有回调，作为 watchEffect 使用，处理清理逻辑
    } else {
      // no cb -> simple effect
      // 如果没有回调，作为 watchEffect 使用，处理清理逻辑
      getter = () => {
        if (cleanup) {
          pauseTracking() // 暂停依赖追踪，避免清理过程中产生新的依赖
          try {
            cleanup() // 执行清理函数
          } finally {
            resetTracking()
          }
        }
        // 将 activeWatcher 保存到 currentEffect
        const currentEffect = activeWatcher
        activeWatcher = effect // 设置当前 watcher
        try {
          return call
            ? // 使用 call 函数执行 source
              call(source, WatchErrorCodes.WATCH_CALLBACK, [boundCleanup])
            : // 直接调用 source 函数
              source(boundCleanup)
        } finally {
          activeWatcher = currentEffect
        }
      }
    }
  } else {
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 有回调 并配置深度监听
  if (cb && deep) {
    // 将原始的 getter 函数保存到 baseGetter 变量
    const baseGetter = getter
    const depth = deep === true ? Infinity : deep

    // 重写 getter 函数，以支持深度遍历
    getter = () => traverse(baseGetter(), depth)
  }

  const scope = getCurrentScope()

  // 手动停止 watch 的函数
  const watchHandle: WatchHandle = () => {
    // 停止内部的 ReactiveEffect 实例
    effect.stop()
    // 如果存在 scope 且 scope 是活跃的
    if (scope && scope.active) {
      // 移除当前 effect
      remove(scope.effects, effect)
    }
  }

  // 如果有回调且需要只触发一次，包装回调函数
  if (once && cb) {
    const _cb = cb
    cb = (...args) => {
      _cb(...args)
      watchHandle()
    }
  }

  let oldValue: any = isMultiSource
    ? // 创建一个新数组，长度与 source 数组相同
      // 用 INITIAL_WATCHER_VALUE 填充数组的每个元素
      new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  const job = (immediateFirstRun?: boolean) => {
    // 前提检查：effect非活跃、不是脏的，且不是首次运行
    // 避免不必要的执行，提高性能
    if (
      !(effect.flags & EffectFlags.ACTIVE) ||
      (!effect.dirty && !immediateFirstRun)
    ) {
      return
    }
    //  1、有回调函数的情况（watch 模式）
    if (cb) {
      // watch(source, cb)
      // 执行 effect.run() 获取当前值作为新值
      const newValue = effect.run()
      if (
        deep || // 深度监听
        forceTrigger || // 强制触发
        (isMultiSource
          ? // 多源 watch 时，只要有个元素变化
            (newValue as any[]).some((v, i) => hasChanged(v, oldValue[i]))
          : // 新值与旧值不同
            hasChanged(newValue, oldValue))
      ) {
        // cleanup before running cb again
        if (cleanup) {
          cleanup() // 执行清理函数
        }
        const currentWatcher = activeWatcher
        activeWatcher = effect
        try {
          // 构建回调函数的参数数组
          const args = [
            newValue, // 新值
            // pass undefined as the old value when it's changed for the first time
            // 首次执行时为 undefined 或 []，否则为之前的 oldValue
            oldValue === INITIAL_WATCHER_VALUE
              ? undefined
              : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
                ? []
                : oldValue,
            boundCleanup, // 清理函数
          ]
          // 更新 oldValue值为 newValue
          oldValue = newValue
          call
            ? call(cb!, WatchErrorCodes.WATCH_CALLBACK, args)
            : // @ts-expect-error
              // 直接调用回调 函数
              cb!(...args)
        } finally {
          activeWatcher = currentWatcher
        }
      }
    } else {
      // 2、watchEffect
      effect.run()
    }
  }

  // 如果提供了 augmentJob 函数，调用它增强 job 函数
  if (augmentJob) {
    augmentJob(job)
  }

  // 创建一个 ReactiveEffect 实例
  effect = new ReactiveEffect(getter)

  // 设置调度函数
  effect.scheduler = scheduler
    ? () => scheduler(job, false)
    : (job as EffectScheduler)

  // 绑定清理函数
  boundCleanup = fn => onWatcherCleanup(fn, false, effect)

  // 绑定清理函数
  cleanup = effect.onStop = () => {
    const cleanups = cleanupMap.get(effect)
    if (cleanups) {
      if (call) {
        call(cleanups, WatchErrorCodes.WATCH_CLEANUP)
      } else {
        for (const cleanup of cleanups) cleanup()
      }
      cleanupMap.delete(effect)
    }
  }

  if (__DEV__) {
    effect.onTrack = options.onTrack
    effect.onTrigger = options.onTrigger
  }

  // initial run
  // 1、有回调
  if (cb) {
    // 设置了 immediate: true，立即执行 job(true)，其中 true 表示这是首次执行
    if (immediate) {
      job(true)
    } else {
      // 延迟执行
      // 执行 effect.run() 获取初始值并保存为 oldValue
      oldValue = effect.run()
    }

    // 2、无回调函数的情况（watchEffect 模式）
    // 调度器执行：如果提供了 scheduler，使用调度器执行 job
  } else if (scheduler) {
    scheduler(job.bind(null, true), true)
  } else {
    // 直接执行
    effect.run()
  }

  // 绑定暂停、恢复和停止函数
  watchHandle.pause = effect.pause.bind(effect)
  watchHandle.resume = effect.resume.bind(effect)
  watchHandle.stop = watchHandle

  return watchHandle
}

export function traverse(
  // 要遍历的值
  value: unknown,
  // 遍历深度
  depth: number = Infinity,
  // 已遍历的值集合
  seen?: Map<unknown, number>,
): unknown {
  if (depth <= 0 || !isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }

  seen = seen || new Map()

  // 如果值已遍历过，且深度未超过已遍历深度，直接返回值
  if ((seen.get(value) || 0) >= depth) {
    return value
  }
  // 标记当前值为已遍历
  // 并将遍历深度减一
  seen.set(value, depth)
  depth--

  // 如果是 ref 对象，递归遍历其 value 属性
  if (isRef(value)) {
    traverse(value.value, depth, seen)

    // 如果是数组，递归遍历其元素
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen)
    }

    // 如果是 Set 或 Map，递归遍历其元素
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, depth, seen)
    })

    // 如果是普通对象，递归遍历其属性
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], depth, seen)
    }
    // 如果是普通对象，递归遍历其 symbol 属性
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key as any], depth, seen)
      }
    }
  }
  return value
}
