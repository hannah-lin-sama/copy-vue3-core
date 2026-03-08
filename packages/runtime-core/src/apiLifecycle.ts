import {
  type ComponentInternalInstance,
  currentInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
} from './component'
import type { ComponentPublicInstance } from './componentPublicInstance'
import { ErrorTypeStrings, callWithAsyncErrorHandling } from './errorHandling'
import { warn } from './warning'
import { toHandlerKey } from '@vue/shared'
import {
  type DebuggerEvent,
  pauseTracking,
  resetTracking,
} from '@vue/reactivity'
import { LifecycleHooks } from './enums'

export { onActivated, onDeactivated } from './components/KeepAlive'

/**
 * 将用户定义的生命周期钩子（如 onMounted、onUpdated）注册到组件实例的钩子队列中
 * @param type 生命周期钩子类型
 * @param hook 要注入的钩子函数
 * @param target 目标组件实例（默认当前实例）
 * @param prepend 是否在钩子数组前端插入（默认 false）
 * @returns 注入后的钩子函数（带错误处理）
 */
export function injectHook(
  type: LifecycleHooks,
  hook: Function & { __weh?: Function },
  target: ComponentInternalInstance | null = currentInstance,
  prepend: boolean = false,
): Function | undefined {
  // 基础校验：确保目标组件实例存在
  if (target) {
    const hooks = target[type] || (target[type] = [])
    // cache the error handling wrapper for injected hooks so the same hook
    // can be properly deduped by the scheduler. "__weh" stands for "with error
    // handling".
    // 缓存「带错误处理的包装钩子」
    const wrappedHook =
      hook.__weh ||
      (hook.__weh = (...args: unknown[]) => {
        // disable tracking inside all lifecycle hooks
        // since they can potentially be called inside effects.
        pauseTracking() // 暂停响应式依赖追踪
        // Set currentInstance during hook invocation.
        // This assumes the hook does not synchronously trigger other hooks, which
        // can only be false when the user does something really funky.
        const reset = setCurrentInstance(target) // 绑定当前组件实例
        // 执行原始钩子（带错误处理）
        const res = callWithAsyncErrorHandling(hook, target, type, args)
        reset() // 恢复之前的 currentInstance
        resetTracking() // 恢复响应式依赖追踪
        return res
      })
    if (prepend) {
      hooks.unshift(wrappedHook) // 插入队列头部（优先执行）
    } else {
      hooks.push(wrappedHook) // 插入队列尾部（默认，按注册顺序执行）
    }
    return wrappedHook
  } else if (__DEV__) {
    // 开发环境下，无目标实例时抛出警告
    const apiName = toHandlerKey(ErrorTypeStrings[type].replace(/ hook$/, ''))
    warn(
      `${apiName} is called when there is no active component instance to be ` +
        `associated with. ` +
        `Lifecycle injection APIs can only be used during execution of setup().` +
        (__FEATURE_SUSPENSE__
          ? ` If you are using async setup(), make sure to register lifecycle ` +
            `hooks before the first await statement.`
          : ``),
    )
  }
}

const createHook =
  <T extends Function = () => any>(lifecycle: LifecycleHooks) =>
  (
    hook: T,
    target: ComponentInternalInstance | null = currentInstance,
  ): void => {
    // post-create lifecycle registrations are noops during SSR (except for serverPrefetch)
    if (
      !isInSSRComponentSetup ||
      lifecycle === LifecycleHooks.SERVER_PREFETCH
    ) {
      injectHook(lifecycle, (...args: unknown[]) => hook(...args), target)
    }
  }
type CreateHook<T = any> = (
  hook: T,
  target?: ComponentInternalInstance | null,
) => void

export const onBeforeMount: CreateHook = createHook(LifecycleHooks.BEFORE_MOUNT)
export const onMounted: CreateHook = createHook(LifecycleHooks.MOUNTED)
export const onBeforeUpdate: CreateHook = createHook(
  LifecycleHooks.BEFORE_UPDATE,
)
export const onUpdated: CreateHook = createHook(LifecycleHooks.UPDATED)
export const onBeforeUnmount: CreateHook = createHook(
  LifecycleHooks.BEFORE_UNMOUNT,
)
export const onUnmounted: CreateHook = createHook(LifecycleHooks.UNMOUNTED)
export const onServerPrefetch: CreateHook = createHook(
  LifecycleHooks.SERVER_PREFETCH,
)

export type DebuggerHook = (e: DebuggerEvent) => void
export const onRenderTriggered: CreateHook<DebuggerHook> =
  createHook<DebuggerHook>(LifecycleHooks.RENDER_TRIGGERED)
export const onRenderTracked: CreateHook<DebuggerHook> =
  createHook<DebuggerHook>(LifecycleHooks.RENDER_TRACKED)

export type ErrorCapturedHook<TError = unknown> = (
  err: TError,
  instance: ComponentPublicInstance | null,
  info: string,
) => boolean | void

export function onErrorCaptured<TError = Error>(
  hook: ErrorCapturedHook<TError>,
  target: ComponentInternalInstance | null = currentInstance,
): void {
  injectHook(LifecycleHooks.ERROR_CAPTURED, hook, target)
}
