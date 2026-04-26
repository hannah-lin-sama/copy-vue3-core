import { isFunction } from '@vue/shared'
import {
  type DebuggerEvent,
  type DebuggerOptions,
  EffectFlags,
  type Subscriber,
  activeSub,
  batch,
  refreshComputed,
} from './effect'
import type { Ref } from './ref'
import { warn } from './warning'
import { Dep, type Link, globalVersion } from './dep'
import { ReactiveFlags, TrackOpTypes } from './constants'

declare const ComputedRefSymbol: unique symbol
declare const WritableComputedRefSymbol: unique symbol

interface BaseComputedRef<T, S = T> extends Ref<T, S> {
  [ComputedRefSymbol]: true
  /**
   * @deprecated computed no longer uses effect
   */
  effect: ComputedRefImpl
}

// 计算属性引用接口
export interface ComputedRef<T = any> extends BaseComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T, S = T> extends BaseComputedRef<T, S> {
  [WritableComputedRefSymbol]: true
}

export type ComputedGetter<T> = (oldValue?: T) => T
export type ComputedSetter<T> = (newValue: T) => void

export interface WritableComputedOptions<T, S = T> {
  get: ComputedGetter<T>
  set: ComputedSetter<S>
}

/**
 * @private exported by @vue/reactivity for Vue core use, but not exported from
 * the main vue package
 * Subscriber 接口：定义了订阅者的基本行为，包括依赖追踪和通知机制
 */
export class ComputedRefImpl<T = any> implements Subscriber {
  /**
   * @internal
   * 存储计算结果，初始值为 undefined
   */
  _value: any = undefined
  /**
   * @internal
   * 管理计算属性自身的依赖，类型为 Dep
   */
  readonly dep: Dep = new Dep(this)
  /**
   * @internal
   * 标记为响应式引用
   */
  readonly __v_isRef = true
  // TODO isolatedDeclarations ReactiveFlags.IS_REF
  /**
   * @internal
   */
  readonly __v_isReadonly: boolean
  // TODO isolatedDeclarations ReactiveFlags.IS_READONLY
  // A computed is also a subscriber that tracks other deps
  /**
   * @internal
   * 计算属性所依赖的其他响应式数据 链表头
   */
  deps?: Link = undefined
  /**
   * @internal
   * 计算属性所依赖的其他响应式数据 链表尾
   */
  depsTail?: Link = undefined
  /**
   * @internal
   * 状态标志，初始为 EffectFlags.DIRTY，表示需要重新计算
   */
  flags: EffectFlags = EffectFlags.DIRTY
  /**
   * @internal
   * 全局版本号，初始为 globalVersion - 1，用于优化计算
   */
  globalVersion: number = globalVersion - 1
  /**
   * @internal
   */
  isSSR: boolean
  /**
   * @internal
   * 指向下一个订阅者，用于批处理
   */
  next?: Subscriber = undefined

  // for backwards compat
  // 为了向后兼容，指向自身
  effect: this = this
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  /**
   * Dev only
   * @internal
   */
  _warnRecursive?: boolean

  constructor(
    // 作为实例属性
    public fn: ComputedGetter<T>,
    // 作为实例属性
    private readonly setter: ComputedSetter<T> | undefined,
    isSSR: boolean,
  ) {
    this[ReactiveFlags.IS_READONLY] = !setter // 标记是否只读
    this.isSSR = isSSR
  }

  /**
   * @internal
   */
  notify(): true | void {
    this.flags |= EffectFlags.DIRTY // 设置 DIRTY 标志，表示需要重新计算
    if (
      !(this.flags & EffectFlags.NOTIFIED) &&
      // avoid infinite self recursion
      activeSub !== this
    ) {
      // 第二个参数 true，将计算属性加入计算批处理队列
      batch(this, true)
      return true // 返回 true，表示这是一个计算属性，需要通知其依赖
    } else if (__DEV__) {
      // TODO warn
    }
  }

  // 执行计算属性的 getter 函数
  get value(): T {
    // 记录依赖追踪信息
    const link = __DEV__
      ? this.dep.track({
          target: this,
          type: TrackOpTypes.GET,
          key: 'value',
        })
      : this.dep.track()

    // 刷新计算值
    refreshComputed(this)
    // sync version after evaluation
    if (link) {
      // 同步版本号
      link.version = this.dep.version
    }
    return this._value
  }

  // 执行计算属性的 setter 函数
  set value(newValue) {
    if (this.setter) {
      // 执行 setter 函数，更新计算属性的值
      this.setter(newValue)
    } else if (__DEV__) {
      warn('Write operation failed: computed value is readonly')
    }
  }
}

/**
 * Takes a getter function and returns a readonly reactive ref object for the
 * returned value from the getter. It can also take an object with get and set
 * functions to create a writable ref object.
 *
 * @example
 * ```js
 * // Creating a readonly computed ref:
 * const count = ref(1)
 * const plusOne = computed(() => count.value + 1)
 *
 * console.log(plusOne.value) // 2
 * plusOne.value++ // error
 * ```
 *
 * ```js
 * // Creating a writable computed ref:
 * const count = ref(1)
 * const plusOne = computed({
 *   get: () => count.value + 1,
 *   set: (val) => {
 *     count.value = val - 1
 *   }
 * })
 *
 * plusOne.value = 1
 * console.log(count.value) // 0
 * ```
 *
 * @param getter - Function that produces the next value.
 * @param debugOptions - For debugging. See {@link https://vuejs.org/guide/extras/reactivity-in-depth.html#computed-debugging}.
 * @see {@link https://vuejs.org/api/reactivity-core.html#computed}
 */
export function computed<T>(
  // 计算属性的 getter 函数
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions,
): ComputedRef<T>
export function computed<T, S = T>(
  // 计算属性的 getter 函数
  options: WritableComputedOptions<T, S>,
  debugOptions?: DebuggerOptions,
): WritableComputedRef<T, S>
/*@__NO_SIDE_EFFECTS__*/
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false,
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T> | undefined

  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 创建计算属性实例
  const cRef = new ComputedRefImpl(getter, setter, isSSR)

  // 如果是开发环境，且提供了调试选项，将调试选项赋值给计算属性实例的 onTrack 和 onTrigger 属性
  if (__DEV__ && debugOptions && !isSSR) {
    cRef.onTrack = debugOptions.onTrack
    cRef.onTrigger = debugOptions.onTrigger
  }

  // 返回计算属性实例
  return cRef as any
}
