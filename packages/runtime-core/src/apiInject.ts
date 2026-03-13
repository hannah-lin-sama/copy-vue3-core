import { isFunction } from '@vue/shared'
import { currentInstance, getCurrentInstance } from './component'
import { currentApp } from './apiCreateApp'
import { warn } from './warning'

interface InjectionConstraint<T> {}

export type InjectionKey<T> = symbol & InjectionConstraint<T>

/**
 * provide 是 Vue3 组合式 API 中依赖注入的「提供方」核心函数，
 * 用于在父组件 / 祖先组件中定义可被后代组件通过 inject 读取的响应式数据 / 方法，
 * 实现跨组件层级的数据传递（无需逐层 props 透传）。
 * @param key 注入键
 * @param value 注入值
 */
export function provide<T, K = InjectionKey<T> | string | number>(
  key: K,
  value: K extends InjectionKey<infer V> ? V : T,
): void {
  if (__DEV__) {
    // / 无当前组件实例 或 组件已挂载 → 抛出警告
    if (!currentInstance || currentInstance.isMounted) {
      warn(`provide() can only be used inside setup().`)
    }
  }
  if (currentInstance) {
    // 获取当前组件的 provides 对象（默认继承父组件）
    let provides = currentInstance.provides
    // by default an instance inherits its parent's provides object
    // but when it needs to provide values of its own, it creates its
    // own provides object using parent provides object as prototype.
    // this way in `inject` we can simply look up injections from direct
    // parent and let the prototype chain do the work.
    // 获取父组件的 provides 对象
    const parentProvides =
      currentInstance.parent && currentInstance.parent.provides

    // 若当前 provides 与父 provides 指向同一对象（未初始化过）
    if (parentProvides === provides) {
      // 创建新的 provides 对象，原型链指向父 provides → 继承父的注入值
      provides = currentInstance.provides = Object.create(parentProvides)
    }
    // TS doesn't allow symbol as index type
    provides[key as string] = value
  }
}

// 重载 1：仅传入 key（无默认值）/
export function inject<T>(key: InjectionKey<T> | string): T | undefined

// 重载 2：传入 key + 普通默认值
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T,
  treatDefaultAsFactory?: false,
): T
// 重载 3：传入 key + 工厂函数默认值
export function inject<T>(
  key: InjectionKey<T> | string,
  defaultValue: T | (() => T),
  treatDefaultAsFactory: true,
): T
export function inject(
  key: InjectionKey<any> | string,
  defaultValue?: unknown,
  treatDefaultAsFactory = false,·
) {
  // fallback to `currentRenderingInstance` so that this can be called in
  // a functional component
  // 获取当前组件实例（兼容函数式组件，回退到 currentRenderingInstance）
  const instance = getCurrentInstance()

  // also support looking up from app-level provides w/ `app.runWithContext()`
  // 仅当存在组件实例/应用上下文时执行核心逻辑
  if (instance || currentApp) {
    // #2400
    // to support `app.use` plugins,
    // fallback to appContext's `provides` if the instance is at root
    // #11488, in a nested createApp, prioritize using the provides from currentApp
    // #13212, for custom elements we must get injected values from its appContext
    // as it already inherits the provides object from the parent element
    // 确定要查找的 provides 对象
    let provides = currentApp
      ? currentApp._context.provides // 场景1：有应用上下文 → 用应用级 provides
      : instance
        ? instance.parent == null || instance.ce // 场景2：组件是根组件/自定义元素
        // 从 vnode 的 appContext 取 provides
          ? instance.vnode.appContext && instance.vnode.appContext.provides
          : instance.parent.provides // 普通组件 → 从父组件 provides 开始查找
        : undefined

    // 查找 key 并返回结果
    if (provides && (key as string | symbol) in provides) {
      // TS doesn't allow symbol as index type
      return provides[key as string]

      // 未找到 key，处理默认值（参数个数 > 1 表示传了 defaultValue）
    } else if (arguments.length > 1) {
      return treatDefaultAsFactory && isFunction(defaultValue)
        ? defaultValue.call(instance && instance.proxy)
        : defaultValue
        // 未找到 key 且无默认值 → 开发环境警告
    } else if (__DEV__) {
      warn(`injection "${String(key)}" not found.`)
    }
    // 无组件实例/应用上下文 → 开发环境警告（调用时机错误）
  } else if (__DEV__) {
    warn(`inject() can only be used inside setup() or functional components.`)
  }
}

/**
 * Returns true if `inject()` can be used without warning about being called in the wrong place (e.g. outside of
 * setup()). This is used by libraries that want to use `inject()` internally without triggering a warning to the end
 * user. One example is `useRoute()` in `vue-router`.
 */
export function hasInjectionContext(): boolean {
  return !!(getCurrentInstance() || currentApp)
}
