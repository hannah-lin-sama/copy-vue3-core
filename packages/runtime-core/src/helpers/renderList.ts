import type { VNode, VNodeChild } from '../vnode'
import {
  isReactive,
  isReadonly,
  isShallow,
  shallowReadArray,
  toReactive,
  toReadonly,
} from '@vue/reactivity'
import { isArray, isObject, isString } from '@vue/shared'
import { warn } from '../warning'

/**
 * v-for string
 * @private
 */
export function renderList(
  source: string,
  renderItem: (value: string, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for number
 */
export function renderList(
  source: number,
  renderItem: (value: number, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for array
 */
export function renderList<T>(
  source: T[],
  renderItem: (value: T, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for iterable
 */
export function renderList<T>(
  source: Iterable<T>,
  renderItem: (value: T, index: number) => VNodeChild,
): VNodeChild[]

/**
 * v-for object
 */
export function renderList<T>(
  source: T,
  renderItem: <K extends keyof T>(
    value: T[K],
    key: string,
    index: number,
  ) => VNodeChild,
): VNodeChild[]

/**
 * Actual implementation
 * 处理 v-for 指令的渲染逻辑。它能够根据不同类型的数据源生成对应的 VNode 数组
 */
export function renderList(
  source: any, // 要遍历的数据源，可以是数组、字符串、数字、对象或可迭代对象
  renderItem: (...args: any[]) => VNodeChild, // 渲染每个项目的函数
  cache?: any[], // 可选的缓存数组，用于存储已渲染的列表项
  index?: number, // 可选的缓存索引，用于在缓存数组中定位当前列表的缓存
): VNodeChild[] {
  let ret: VNodeChild[]
  const cached = (cache && cache[index!]) as VNode[] | undefined
  const sourceIsArray = isArray(source)

  // 处理数组和字符串
  if (sourceIsArray || isString(source)) {
    const sourceIsReactiveArray = sourceIsArray && isReactive(source)
    let needsWrap = false
    let isReadonlySource = false
    if (sourceIsReactiveArray) {
      needsWrap = !isShallow(source) // 非浅响应式数组需要包装
      isReadonlySource = isReadonly(source)
      // 对于响应式数组，使用 shallowReadArray 避免深层响应式
      source = shallowReadArray(source)
    }
    ret = new Array(source.length)
    for (let i = 0, l = source.length; i < l; i++) {
      // 调用 renderItem 生成 VNode
      ret[i] = renderItem(
        needsWrap
          ? isReadonlySource
            ? toReadonly(toReactive(source[i]))
            : toReactive(source[i])
          : source[i],
        i,
        undefined,
        cached && cached[i],
      )
    }
  } else if (typeof source === 'number') {
    if (__DEV__ && !Number.isInteger(source)) {
      warn(`The v-for range expect an integer value but got ${source}.`)
    }
    // 生成指定长度的序列，调用 renderItem 生成 VNode
    ret = new Array(source)
    for (let i = 0; i < source; i++) {
      ret[i] = renderItem(i + 1, i, undefined, cached && cached[i])
    }
  } else if (isObject(source)) {
    // 如果是可迭代对象，使用 Array.from 处理
    if (source[Symbol.iterator as any]) {
      ret = Array.from(source as Iterable<any>, (item, i) =>
        renderItem(item, i, undefined, cached && cached[i]),
      )
    } else {
      // 如果是对象，遍历键值对，调用 renderItem 生成 VNode
      const keys = Object.keys(source)
      ret = new Array(keys.length)
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i]
        ret[i] = renderItem(source[key], key, i, cached && cached[i])
      }
    }
  } else {
    ret = []
  }

  if (cache) {
    cache[index!] = ret
  }
  return ret
}
