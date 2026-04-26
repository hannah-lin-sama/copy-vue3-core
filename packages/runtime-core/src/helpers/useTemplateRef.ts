import { type ShallowRef, readonly, shallowRef } from '@vue/reactivity'
import { type Data, getCurrentInstance } from '../component'
import { warn } from '../warning'
import { EMPTY_OBJ } from '@vue/shared'

export const knownTemplateRefs: WeakSet<ShallowRef> = new WeakSet()

export type TemplateRef<T = unknown> = Readonly<ShallowRef<T | null>>

/**
 * 创建一个模板引用，用于在模板中访问响应式数据
 * @param key 模板引用的键名
 * @returns 模板引用对象
 */
export function useTemplateRef<T = unknown, Keys extends string = string>(
  key: Keys,
): TemplateRef<T> {
  const i = getCurrentInstance()
  const r = shallowRef(null)
  if (i) {
    // 获取或初始化组件实例的 refs 对象
    const refs = i.refs === EMPTY_OBJ ? (i.refs = {}) : i.refs
    if (__DEV__ && isTemplateRefKey(refs, key)) {
      warn(`useTemplateRef('${key}') already exists.`)
    } else {
      // 使用 Object.defineProperty 定义一个属性
      Object.defineProperty(refs, key, {
        enumerable: true,
        get: () => r.value,
        set: val => (r.value = val),
      })
    }
  } else if (__DEV__) {
    warn(
      `useTemplateRef() is called when there is no active component ` +
        `instance to be associated with.`,
    )
  }
  // 在开发环境下，返回只读版本的 ref，防止开发者意外修改
  const ret = __DEV__ ? readonly(r) : r
  if (__DEV__) {
    knownTemplateRefs.add(ret)
  }
  return ret
}

export function isTemplateRefKey(refs: Data, key: string): boolean {
  let desc: PropertyDescriptor | undefined
  return !!(
    (desc = Object.getOwnPropertyDescriptor(refs, key)) && !desc.configurable
  )
}
