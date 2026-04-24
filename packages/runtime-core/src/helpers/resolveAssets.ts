import {
  type ComponentOptions,
  type ConcreteComponent,
  currentInstance,
  getComponentName,
} from '../component'
import { currentRenderingInstance } from '../componentRenderContext'
import type { Directive } from '../directives'
import { camelize, capitalize, isString } from '@vue/shared'
import { warn } from '../warning'
import type { VNodeTypes } from '../vnode'

export const COMPONENTS = 'components'
export const DIRECTIVES = 'directives'
export const FILTERS = 'filters'

export type AssetTypes = typeof COMPONENTS | typeof DIRECTIVES | typeof FILTERS

/**
 * @private
 */
export function resolveComponent(
  name: string,
  maybeSelfReference?: boolean,
): ConcreteComponent | string {
  return resolveAsset(COMPONENTS, name, true, maybeSelfReference) || name
}

export const NULL_DYNAMIC_COMPONENT: unique symbol = Symbol.for('v-ndc')

/**
 * @private
 */
export function resolveDynamicComponent(component: unknown): VNodeTypes {
  if (isString(component)) {
    return resolveAsset(COMPONENTS, component, false) || component
  } else {
    // invalid types will fallthrough to createVNode and raise warning
    return (component || NULL_DYNAMIC_COMPONENT) as any
  }
}

/**
 * @private
 */
export function resolveDirective(name: string): Directive | undefined {
  return resolveAsset(DIRECTIVES, name)
}

/**
 * v2 compat only
 * @internal
 */
export function resolveFilter(name: string): Function | undefined {
  return resolveAsset(FILTERS, name)
}

/**
 * @private
 * overload 1: components
 */
function resolveAsset(
  type: typeof COMPONENTS,
  name: string,
  warnMissing?: boolean,
  maybeSelfReference?: boolean,
): ConcreteComponent | undefined
// overload 2: directives
function resolveAsset(
  type: typeof DIRECTIVES,
  name: string,
): Directive | undefined
// implementation
// overload 3: filters (compat only)
function resolveAsset(type: typeof FILTERS, name: string): Function | undefined
// implementation

/**
 * 解析组件中的资源，如组件、指令等。它按照特定的优先级顺序查找并返回指定类型的资源
 * @param type 资源类型，如 'components'、'directives'、'filters'
 * @param name 资源名称，如组件名、指令名、过滤器名等
 * @param warnMissing 是否在资源未找到时发出警告，默认为 true
 * @param maybeSelfReference 是否允许自引用，默认为 false
 * @returns
 */
function resolveAsset(
  type: AssetTypes,
  name: string,
  warnMissing = true,
  maybeSelfReference = false,
) {
  // 首先获取当前渲染实例或当前实例
  const instance = currentRenderingInstance || currentInstance
  if (instance) {
    const Component = instance.type

    // explicit self name has highest priority
    if (type === COMPONENTS) {
      // 获取组件的显式名称
      const selfName = getComponentName(
        Component,
        false /* do not include inferred name to avoid breaking existing code */,
      )
      // 检查名称是否匹配（支持原始名称、驼峰式和首字母大写的驼峰式）
      if (
        selfName &&
        (selfName === name ||
          selfName === camelize(name) ||
          selfName === capitalize(camelize(name)))
      ) {
        return Component
      }
    }

    const res =
      // local registration
      // check instance[type] first which is resolved for options API
      // 检查 instance[type]（Options API 已解析的资源）
      // 检查 Component[type]（组件选项中的资源）
      resolve(instance[type] || (Component as ComponentOptions)[type], name) ||
      // global registration
      // 解析全局注册的资源
      resolve(instance.appContext[type], name)

    if (!res && maybeSelfReference) {
      // fallback to implicit self-reference
      // 如果未找到资源且允许自引用，返回组件自身
      return Component
    }

    // 在开发模式下，如果未找到资源且需要警告，发出警告信息
    if (__DEV__ && warnMissing && !res) {
      const extra =
        type === COMPONENTS
          ? `\nIf this is a native custom element, make sure to exclude it from ` +
            `component resolution via compilerOptions.isCustomElement.`
          : ``
      warn(`Failed to resolve ${type.slice(0, -1)}: ${name}${extra}`)
    }

    return res
  } else if (__DEV__) {
    // 如果没有实例，在开发模式下发出警告
    warn(
      `resolve${capitalize(type.slice(0, -1))} ` +
        `can only be used in render() or setup().`,
    )
  }
}

function resolve(registry: Record<string, any> | undefined, name: string) {
  return (
    registry &&
    (registry[name] ||
      registry[camelize(name)] ||
      registry[capitalize(camelize(name))])
  )
}
