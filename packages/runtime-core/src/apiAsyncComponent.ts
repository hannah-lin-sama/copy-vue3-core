import {
  type Component,
  type ComponentInternalInstance,
  type ComponentOptions,
  type ConcreteComponent,
  currentInstance,
  getComponentName,
  isInSSRComponentSetup,
} from './component'
import { isFunction, isObject } from '@vue/shared'
import type { ComponentPublicInstance } from './componentPublicInstance'
import { type VNode, createVNode } from './vnode'
import { defineComponent } from './apiDefineComponent'
import { warn } from './warning'
import { ref } from '@vue/reactivity'
import { ErrorCodes, handleError } from './errorHandling'
import { isKeepAlive } from './components/KeepAlive'
import { markAsyncBoundary } from './helpers/useId'
import { type HydrationStrategy, forEachElement } from './hydrationStrategies'

export type AsyncComponentResolveResult<T = Component> = T | { default: T } // es modules

export type AsyncComponentLoader<T = any> = () => Promise<
  AsyncComponentResolveResult<T>
>

export interface AsyncComponentOptions<T = any> {
  /** 异步组件的加载函数 */
  loader: AsyncComponentLoader<T>
  /** 加载中显示的组件 */
  loadingComponent?: Component
  /** 加载失败显示的组件 */
  errorComponent?: Component
  /** 显示 loading 的延迟时间（默认 200ms） */
  delay?: number
  /** 超时时间（undefined 表示永不超时） */
  timeout?: number
  /** 是否可挂起（默认 true） */
  suspensible?: boolean
  /** SSR 水合策略 */
  hydrate?: HydrationStrategy
  /** 错误处理函数 */
  onError?: (
    error: Error,
    retry: () => void,
    fail: () => void,
    attempts: number,
  ) => any
}

export const isAsyncWrapper = (i: ComponentInternalInstance | VNode): boolean =>
  !!(i.type as ComponentOptions).__asyncLoader

/*@__NO_SIDE_EFFECTS__*/
// 定义异步组件
export function defineAsyncComponent<
  T extends Component = { new (): ComponentPublicInstance },
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  // 如果 source 是一个函数，说明是 loader 函数
  if (isFunction(source)) {
    source = { loader: source }
  }

  const {
    loader,
    loadingComponent, // 加载中显示的组件
    errorComponent, // 加载失败显示的组件
    delay = 200, // 显示 loading 的延迟时间（默认 200ms）
    hydrate: hydrateStrategy, // SSR 水合策略
    timeout, // undefined = never times out  超时时间（undefined 表示永不超时）
    suspensible = true, // 是否可挂起（默认 true）
    onError: userOnError,
  } = source

  let pendingRequest: Promise<ConcreteComponent> | null = null // 请求复用
  let resolvedComp: ConcreteComponent | undefined

  let retries = 0 // 重试次数
  const retry = () => {
    retries++ // 递增重试计数
    pendingRequest = null // 重置挂起的请求
    return load()
  }

  const load = (): Promise<ConcreteComponent> => {
    // 当前请求 Promise
    let thisRequest: Promise<ConcreteComponent>
    return (
      pendingRequest || // 请求复用
      (thisRequest = pendingRequest =
        loader()
          .catch(err => {
            err = err instanceof Error ? err : new Error(String(err))
            if (userOnError) {
              return new Promise((resolve, reject) => {
                const userRetry = () => resolve(retry())
                const userFail = () => reject(err)
                userOnError(err, userRetry, userFail, retries + 1)
              })
            } else {
              throw err
            }
          })
          // 异步组件加载成功后的结果验证和处理
          .then((comp: any) => {
            // 当前请求不是最新的请求
            if (thisRequest !== pendingRequest && pendingRequest) {
              return pendingRequest
            }
            if (__DEV__ && !comp) {
              warn(
                `Async component loader resolved to undefined. ` +
                  `If you are using retry(), make sure to return its return value.`,
              )
            }
            // interop module default
            // 模块默认导出处理
            if (
              comp &&
              // comp.__esModule：Babel/TypeScript 编译后的标记
              // comp[Symbol.toStringTag] === 'Module'：原生 ES Module 标记
              (comp.__esModule || comp[Symbol.toStringTag] === 'Module')
            ) {
              comp = comp.default
            }
            // 组件必须是对象或函数
            if (__DEV__ && comp && !isObject(comp) && !isFunction(comp)) {
              throw new Error(`Invalid async component load result: ${comp}`)
            }
            resolvedComp = comp // 缓存已解析的组件
            return comp
          }))
    )
  }

  return defineComponent({
    name: 'AsyncComponentWrapper',

    __asyncLoader: load, // 异步组件加载函数

    __asyncHydrate(el, instance, hydrate) {
      let patched = false
      ;(instance.bu || (instance.bu = [])).push(() => (patched = true))
      const performHydrate = () => {
        // skip hydration if the component has been patched
        if (patched) {
          if (__DEV__) {
            warn(
              `Skipping lazy hydration for component '${getComponentName(resolvedComp!) || resolvedComp!.__file}': ` +
                `it was updated before lazy hydration performed.`,
            )
          }
          return
        }
        hydrate()
      }
      const doHydrate = hydrateStrategy
        ? () => {
            const teardown = hydrateStrategy(performHydrate, cb =>
              forEachElement(el, cb),
            )
            if (teardown) {
              ;(instance.bum || (instance.bum = [])).push(teardown)
            }
          }
        : performHydrate
      if (resolvedComp) {
        doHydrate()
      } else {
        load().then(() => !instance.isUnmounted && doHydrate())
      }
    },

    get __asyncResolved() {
      return resolvedComp
    },

    setup() {
      const instance = currentInstance!
      markAsyncBoundary(instance) // 标记异步边界（用于 Suspense 检测）

      // already resolved
      // 处理已缓存的组件（避免重复加载）
      if (resolvedComp) {
        return () => createInnerComp(resolvedComp!, instance)
      }

      const onError = (err: Error) => {
        pendingRequest = null
        handleError(
          err,
          instance,
          ErrorCodes.ASYNC_COMPONENT_LOADER,
          !errorComponent /* do not throw in dev if user provided error component */,
        )
      }

      // suspense-controlled or SSR.
      // Suspense 模式
      if (
        (__FEATURE_SUSPENSE__ && suspensible && instance.suspense) ||
        (__SSR__ && isInSSRComponentSetup)
      ) {
        return load()
          .then(comp => {
            return () => createInnerComp(comp, instance)
          })
          .catch(err => {
            onError(err)
            return () =>
              errorComponent
                ? createVNode(errorComponent as ConcreteComponent, {
                    error: err,
                  })
                : null
          })
      }

      const loaded = ref(false) //加载完成状态
      const error = ref() // 错误信息
      const delayed = ref(!!delay) // 延迟显示状态

      // 延迟显示 loading
      if (delay) {
        setTimeout(() => {
          delayed.value = false // 延迟显示结束
        }, delay)
      }

      // 超时处理
      if (timeout != null) {
        setTimeout(() => {
          // 组件未加载完成 且 组件未加载失败
          if (!loaded.value && !error.value) {
            const err = new Error(
              `Async component timed out after ${timeout}ms.`,
            )
            onError(err)
            error.value = err
          }
        }, timeout)
      }

      load()
        .then(() => {
          loaded.value = true // 加载完成
          if (instance.parent && isKeepAlive(instance.parent.vnode)) {
            // parent is keep-alive, force update so the loaded component's
            // name is taken into account
            // 强制更新父组件，当父组件是 KeepAlive 组件时
            instance.parent.update()
          }
        })
        .catch(err => {
          onError(err)
          error.value = err
        })

      return () => {
        if (loaded.value && resolvedComp) {
          // 加载完成，渲染组件
          return createInnerComp(resolvedComp, instance)
        } else if (error.value && errorComponent) {
          // 加载失败，渲染错误组件
          return createVNode(errorComponent, {
            error: error.value,
          })
        } else if (loadingComponent && !delayed.value) {
          // 加载中，渲染 loading 组件
          return createInnerComp(
            loadingComponent as ConcreteComponent,
            instance,
          )
        }
      }
    },
  }) as T
}

/**
 * 创建异步组件的内部组件
 * - 继承父组件的 ref，确保 ref 能正确指向内部组件
 * - 继承父组件的 props，保持属性传递
 * - 继承父组件的 children，保持插槽内容
 * - 继承自定义元素相关属性
 * @param comp 异步组件实例
 * @param parent 父组件实例
 * @returns 内部组件的 VNode
 */
function createInnerComp(
  comp: ConcreteComponent,
  parent: ComponentInternalInstance,
) {
  const { ref, props, children, ce } = parent.vnode
  // 创建内部组件的 VNode，传递父组件的 props、children 信息
  const vnode = createVNode(comp, props, children)
  // ensure inner component inherits the async wrapper's ref owner
  // 异步包装器的 ref，需要传递给内部组件
  vnode.ref = ref
  // pass the custom element callback on to the inner comp
  // and remove it from the async wrapper
  vnode.ce = ce
  delete parent.vnode.ce // 删除父组件的 ce 属性，避免重复调用

  return vnode
}
