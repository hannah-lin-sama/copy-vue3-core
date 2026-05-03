import { TrackOpTypes } from './constants'
import { endBatch, pauseTracking, resetTracking, startBatch } from './effect'
import {
  isProxy,
  isReactive,
  isReadonly,
  isShallow,
  toRaw,
  toReactive,
  toReadonly,
} from './reactive'
import { ARRAY_ITERATE_KEY, track } from './dep'
import { isArray } from '@vue/shared'

/**
 * Track array iteration and return:
 * - if input is reactive: a cloned raw array with reactive values
 * - if input is non-reactive or shallowReactive: the original raw array
 */
export function reactiveReadArray<T>(array: T[]): T[] {
  const raw = toRaw(array)
  if (raw === array) return raw
  // 跟踪数组迭代
  track(raw, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return isShallow(array) ? raw : raw.map(toReactive)
}

/**
 * Track array iteration and return raw array
 */
export function shallowReadArray<T>(arr: T[]): T[] {
  // 确保数组是原始值，避免循环引用
  track((arr = toRaw(arr)), TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return arr
}

function toWrapped(target: unknown, item: unknown) {
  if (isReadonly(target)) {
    // 将item转为只读响应式值
    return isReactive(target) ? toReadonly(toReactive(item)) : toReadonly(item)
  }
  // 非只读数组，直接返回响应式值
  return toReactive(item)
}

export const arrayInstrumentations: Record<string | symbol, Function> = <any>{
  __proto__: null, // 防止继承 Array.prototype

  // 直接原因是为了解决 Ref 自动解包 和 代理/原始值混合遍历 时的正确性问题。
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, item => toWrapped(this, item))
  },

  // 合并数组
  concat(...args: unknown[]) {
    return reactiveReadArray(this).concat(
      ...args.map(x => (isArray(x) ? reactiveReadArray(x) : x)),
    )
  },

  // 遍历数组的每个元素
  entries() {
    return iterator(this, 'entries', (value: [number, unknown]) => {
      value[1] = toWrapped(this, value[1])
      return value
    })
  },

  // 遍历数组
  every(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'every', fn, thisArg, undefined, arguments)
  },

  // 遍历数组
  filter(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(
      this,
      'filter',
      fn,
      thisArg,
      v => v.map((item: unknown) => toWrapped(this, item)),
      arguments,
    )
  },

  /**
   * 查找数组中第一个满足测试函数的元素
   * @param fn 回调函数，用于测试数组中的每个元素
   * @param thisArg 回调函数的 上 this 指向
   * @returns 第一个满足测试函数的数组元素
   */
  find(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(
      this, // 确保数组是响应式的
      'find',
      fn, // 用户传入的回调函数
      thisArg, // 用户传入的 thisArg
      item => toWrapped(this, item), // 包装数组元素，确保响应式
      arguments, // 传递原始参数
    )
  },

  // 遍历数组
  findIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findIndex', fn, thisArg, undefined, arguments)
  },

  findLast(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(
      this,
      'findLast',
      fn,
      thisArg,
      item => toWrapped(this, item),
      arguments,
    )
  },

  findLastIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLastIndex', fn, thisArg, undefined, arguments)
  },

  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement

  forEach(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'forEach', fn, thisArg, undefined, arguments)
  },

  includes(...args: unknown[]) {
    return searchProxy(this, 'includes', args)
  },

  indexOf(...args: unknown[]) {
    return searchProxy(this, 'indexOf', args)
  },

  join(separator?: string) {
    return reactiveReadArray(this).join(separator)
  },

  // keys() iterator only reads `length`, no optimization required

  lastIndexOf(...args: unknown[]) {
    return searchProxy(this, 'lastIndexOf', args)
  },

  map(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'map', fn, thisArg, undefined, arguments)
  },

  pop() {
    return noTracking(this, 'pop')
  },

  push(...args: unknown[]) {
    return noTracking(this, 'push', args)
  },

  reduce(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduce', fn, args)
  },

  reduceRight(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduceRight', fn, args)
  },

  shift() {
    return noTracking(this, 'shift')
  },

  // slice could use ARRAY_ITERATE but also seems to beg for range tracking

  some(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'some', fn, thisArg, undefined, arguments)
  },

  splice(...args: unknown[]) {
    return noTracking(this, 'splice', args)
  },

  toReversed() {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toReversed()
  },

  toSorted(comparer?: (a: unknown, b: unknown) => number) {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toSorted(comparer)
  },

  toSpliced(...args: unknown[]) {
    // @ts-expect-error user code may run in es2016+
    return (reactiveReadArray(this).toSpliced as any)(...args)
  },

  unshift(...args: unknown[]) {
    return noTracking(this, 'unshift', args)
  },

  values() {
    return iterator(this, 'values', item => toWrapped(this, item))
  },
}

// instrument iterators to take ARRAY_ITERATE dependency
// 为响应式数组创建一个自定义迭代器。它确保在迭代过程中返回的值能够被正确地包装为响应式对象。
function iterator(
  self: unknown[], // 输入的数组，通常是响应式数组
  method: keyof Array<unknown>, // 要调用的数组方法，通常是 Symbol.iterator
  wrapValue: (value: any) => unknown, // 用于包装迭代过程中返回值的函数
) {
  const arr = shallowReadArray(self) // 获取原始数组

  // 调用原生迭代器方法，生成原生迭代器对象
  const iter = (arr[method] as any)() as IterableIterator<unknown> & {
    _next: IterableIterator<unknown>['next']
  }
  // 数组是响应式的， 且不是浅层响应式的
  if (arr !== self && !isShallow(self)) {
    iter._next = iter.next
    // 重写迭代器的 next 方法
    iter.next = () => {
      const result = iter._next() // 调用原生迭代器的 next 方法
      if (!result.done) {
        // 只有当迭代未完成时（!result.done），才对值进行包装
        result.value = wrapValue(result.value)
      }
      return result
    }
  }
  return iter
}

// in the codebase we enforce es2016, but user code may run in environments
// higher than that
type ArrayMethods = keyof Array<any> | 'findLast' | 'findLastIndex'

const arrayProto = Array.prototype
// instrument functions that read (potentially) all items
// to take ARRAY_ITERATE dependency
function apply(
  self: unknown[],
  method: ArrayMethods,
  fn: (item: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
  wrappedRetFn?: (result: any) => unknown,
  args?: IArguments,
) {
  const arr = shallowReadArray(self) // 获取原始数组、依赖追踪
  const needsWrap = arr !== self && !isShallow(self) // 是否需要包装数组元素
  // @ts-expect-error our code is limited to es2016 but user code is not
  const methodFn = arr[method]

  if (methodFn !== arrayProto[method as any]) {
    const result = methodFn.apply(self, args)
    return needsWrap ? toReactive(result) : result
  }

  let wrappedFn = fn
  if (arr !== self) {
    if (needsWrap) {
      // 包装数组元素，确保响应式
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, toWrapped(self, item), index, self)
      }
    } else if (fn.length > 2) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, item, index, self)
      }
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg)
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
}

// instrument reduce and reduceRight to take ARRAY_ITERATE dependency
function reduce(
  self: unknown[],
  method: keyof Array<any>,
  fn: (acc: unknown, item: unknown, index: number, array: unknown[]) => unknown,
  args: unknown[],
) {
  const arr = shallowReadArray(self) // 获取原始数组、依赖追踪
  let wrappedFn = fn
  if (arr !== self) {
    if (!isShallow(self)) {
      // 包装回调函数
      wrappedFn = function (this: unknown, acc, item, index) {
        // 执行回调函数，确保数组元素是响应式的
        return fn.call(this, acc, toWrapped(self, item), index, self)
      }
    } else if (fn.length > 3) {
      wrappedFn = function (this: unknown, acc, item, index) {
        // 目的：只修复第四个参数（数组引用），保持浅响应式语义
        return fn.call(this, acc, item, index, self)
      }
    }
  }
  // 执行原生方法并返回结果
  // 示例 arr.reduce((sum,item,index.arr) => sum + item, 0)
  return (arr[method] as any)(wrappedFn, ...args)
}

// instrument identity-sensitive methods to account for reactive proxies
function searchProxy(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[],
) {
  const arr = toRaw(self) as any
  track(arr, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // we run the method using the original args first (which may be reactive)
  const res = arr[method](...args)

  // if that didn't work, run it again using raw values.
  if ((res === -1 || res === false) && isProxy(args[0])) {
    args[0] = toRaw(args[0])
    return arr[method](...args)
  }

  return res
}

// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
// 在不追踪依赖的情况下执行数组方法
function noTracking(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[] = [],
) {
  pauseTracking() // 暂停依赖收集，但已存在的依赖仍然会被触发更新
  startBatch() // 开启批量更新

  // 直接调用原始数组的方法可以避免再次经过 Proxy 的拦截器，防止递归调用或循环依赖
  const res = (toRaw(self) as any)[method].apply(self, args)
  endBatch()
  resetTracking() // 恢复依赖追踪
  return res
}
