import {
  Comment,
  type VNode,
  type VNodeProps,
  closeBlock,
  createVNode,
  currentBlock,
  isBlockTreeEnabled,
  isSameVNodeType,
  normalizeVNode,
  openBlock,
} from '../vnode'
import { ShapeFlags, isArray, isFunction, toNumber } from '@vue/shared'
import { type ComponentInternalInstance, handleSetupResult } from '../component'
import type { Slots } from '../componentSlots'
import {
  type ElementNamespace,
  MoveType,
  type RendererElement,
  type RendererInternals,
  type RendererNode,
  type SetupRenderEffectFn,
  queuePostRenderEffect,
} from '../renderer'
import { queuePostFlushCb } from '../scheduler'
import { filterSingleRoot, updateHOCHostEl } from '../componentRenderUtils'
import {
  assertNumber,
  popWarningContext,
  pushWarningContext,
  warn,
} from '../warning'
import { ErrorCodes, handleError } from '../errorHandling'
import { NULL_DYNAMIC_COMPONENT } from '../helpers/resolveAssets'

export interface SuspenseProps {
  onResolve?: () => void
  onPending?: () => void
  onFallback?: () => void
  timeout?: string | number
  /**
   * Allow suspense to be captured by parent suspense
   *
   * @default false
   */
  suspensible?: boolean
}

export const isSuspense = (type: any): boolean => type.__isSuspense

// incrementing unique id for every pending branch
let suspenseId = 0

/**
 * For testing only
 */
export const resetSuspenseId = (): number => (suspenseId = 0)

/**
 * Suspense 是 Vue 内置的「异步渲染组件」，用于处理异步依赖（如异步组件、await 异步数据）的加载状态：
 *「pending 分支」：异步依赖加载中显示的内容（如骨架屏）；
 *「fallback 分支」：异步依赖加载失败 / 超时显示的内容；
 *「active 分支」：异步依赖加载完成后显示的内容；
 */

// Suspense exposes a component-like API, and is treated like a component
// in the compiler, but internally it's a special built-in type that hooks
// directly into the renderer.
// Suspense 组件实现
export const SuspenseImpl = {
  name: 'Suspense', // 组件名称
  // In order to make Suspense tree-shakable, we need to avoid importing it
  // directly in the renderer. The renderer checks for the __isSuspense flag
  // on a vnode's type and calls the `process` method, passing in renderer
  // internals.
  __isSuspense: true, // 标识为 Suspense 组件
  // 处理组件的挂载/更新逻辑（核心方法）
  process(
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
    // platform-specific impl passed from renderer
    rendererInternals: RendererInternals,
  ): void {
    // 1. 首次挂载
    if (n1 == null) {
      mountSuspense(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
        rendererInternals,
      )
    } else {
      // 2、更新操作
      // #8678 if the current suspense needs to be patched and parentSuspense has
      // not been resolved. this means that both the current suspense and parentSuspense
      // need to be patched. because parentSuspense's pendingBranch includes the
      // current suspense, it will be processed twice:
      //  1. current patch
      //  2. mounting along with the pendingBranch of parentSuspense
      // it is necessary to skip the current patch to avoid multiple mounts
      // of inner components.
      // 特殊情况处理
      if (
        parentSuspense &&
        parentSuspense.deps > 0 &&
        !n1.suspense!.isInFallback
      ) {
        n2.suspense = n1.suspense!
        n2.suspense.vnode = n2
        n2.el = n1.el
        return
      }
      // 常规更新（patchSuspense）
      patchSuspense(
        n1,
        n2,
        container,
        anchor,
        parentComponent,
        namespace,
        slotScopeIds,
        optimized,
        rendererInternals,
      )
    }
  },
  // 服务端渲染时的 hydration 逻辑（将服务端渲染的 HTML 激活为响应式 DOM）
  hydrate: hydrateSuspense as typeof hydrateSuspense,
  // 标准化 Suspense 的子节点（区分主内容和 fallback 内容）
  normalize: normalizeSuspenseChildren as typeof normalizeSuspenseChildren,
}

// Force-casted public typing for h and TSX props inference
export const Suspense = (__FEATURE_SUSPENSE__
  ? SuspenseImpl
  : null) as unknown as {
  __isSuspense: true
  new (): {
    $props: VNodeProps & SuspenseProps
    $slots: {
      default(): VNode[]
      fallback(): VNode[]
    }
  }
}

/**
 * 触发 Suspense 组件生命周期事件
 * @param vnode  Suspense 组件的 VNode
 * @param name  事件名（onResolve/onPending/onFallback）
 */
function triggerEvent(
  vnode: VNode,
  name: 'onResolve' | 'onPending' | 'onFallback',
) {
  // 从 VNode 的 props 中获取指定事件的回调函数
  const eventListener = vnode.props && vnode.props[name]

  // 校验回调是否为函数，是则执行
  if (isFunction(eventListener)) {
    eventListener()
  }
}

/**
 *
 * @param vnode 要挂载的 Suspense 节点
 * @param container 挂载容器
 * @param anchor 挂载锚点
 * @param parentComponent 父组件实例
 * @param parentSuspense 父 Suspense 实例
 * @param namespace 元素命名空间
 * @param slotScopeIds 插槽作用域 ID 列表
 * @param optimized 是否开启优化模式
 * @param rendererInternals 渲染器内部实现
 */
function mountSuspense(
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
) {
  const {
    p: patch,
    o: { createElement },
  } = rendererInternals

  // 创建一个隐藏的 DOM 容器（off-dom container），用于预渲染主内容（不立即显示）
  const hiddenContainer = createElement('div')
  // 创建 Suspense 边界实例（SuspenseBoundary），管理异步依赖和内容切换
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    container,
    hiddenContainer,
    anchor,
    namespace,
    slotScopeIds,
    optimized,
    rendererInternals,
  ))

  // start mounting the content subtree in an off-dom container
  patch(
    null,
    (suspense.pendingBranch = vnode.ssContent!),
    hiddenContainer,
    null,
    parentComponent,
    suspense,
    namespace,
    slotScopeIds,
  )
  // now check if we have encountered any async deps
  if (suspense.deps > 0) {
    // has async
    // invoke @fallback event
    triggerEvent(vnode, 'onPending')
    triggerEvent(vnode, 'onFallback')

    // mount the fallback tree
    patch(
      null,
      vnode.ssFallback!,
      container,
      anchor,
      parentComponent,
      null, // fallback tree will not have suspense context
      namespace,
      slotScopeIds,
    )
    setActiveBranch(suspense, vnode.ssFallback!)
  } else {
    // Suspense has no async deps. Just resolve.
    suspense.resolve(false, true)
  }
}

function patchSuspense(
  n1: VNode,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
  { p: patch, um: unmount, o: { createElement } }: RendererInternals,
) {
  const suspense = (n2.suspense = n1.suspense)!
  suspense.vnode = n2
  n2.el = n1.el
  const newBranch = n2.ssContent!
  const newFallback = n2.ssFallback!

  const { activeBranch, pendingBranch, isInFallback, isHydrating } = suspense
  if (pendingBranch) {
    suspense.pendingBranch = newBranch
    if (isSameVNodeType(pendingBranch, newBranch)) {
      // same root type but content may have changed.
      patch(
        pendingBranch,
        newBranch,
        suspense.hiddenContainer,
        null,
        parentComponent,
        suspense,
        namespace,
        slotScopeIds,
        optimized,
      )
      if (suspense.deps <= 0) {
        suspense.resolve()
      } else if (isInFallback) {
        // It's possible that the app is in hydrating state when patching the
        // suspense instance. If someone updates the dependency during component
        // setup in children of suspense boundary, that would be problemtic
        // because we aren't actually showing a fallback content when
        // patchSuspense is called. In such case, patch of fallback content
        // should be no op
        if (!isHydrating) {
          patch(
            activeBranch,
            newFallback,
            container,
            anchor,
            parentComponent,
            null, // fallback tree will not have suspense context
            namespace,
            slotScopeIds,
            optimized,
          )
          setActiveBranch(suspense, newFallback)
        }
      }
    } else {
      // toggled before pending tree is resolved
      // increment pending ID. this is used to invalidate async callbacks
      suspense.pendingId = suspenseId++
      if (isHydrating) {
        // if toggled before hydration is finished, the current DOM tree is
        // no longer valid. set it as the active branch so it will be unmounted
        // when resolved
        suspense.isHydrating = false
        suspense.activeBranch = pendingBranch
      } else {
        unmount(pendingBranch, parentComponent, suspense)
      }
      // reset suspense state
      suspense.deps = 0
      // discard effects from pending branch
      suspense.effects.length = 0
      // discard previous container
      suspense.hiddenContainer = createElement('div')

      if (isInFallback) {
        // already in fallback state
        patch(
          null,
          newBranch,
          suspense.hiddenContainer,
          null,
          parentComponent,
          suspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        if (suspense.deps <= 0) {
          suspense.resolve()
        } else {
          patch(
            activeBranch,
            newFallback,
            container,
            anchor,
            parentComponent,
            null, // fallback tree will not have suspense context
            namespace,
            slotScopeIds,
            optimized,
          )
          setActiveBranch(suspense, newFallback)
        }
      } else if (activeBranch && isSameVNodeType(activeBranch, newBranch)) {
        // toggled "back" to current active branch
        patch(
          activeBranch,
          newBranch,
          container,
          anchor,
          parentComponent,
          suspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        // force resolve
        suspense.resolve(true)
      } else {
        // switched to a 3rd branch
        patch(
          null,
          newBranch,
          suspense.hiddenContainer,
          null,
          parentComponent,
          suspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        if (suspense.deps <= 0) {
          suspense.resolve()
        }
      }
    }
  } else {
    if (activeBranch && isSameVNodeType(activeBranch, newBranch)) {
      // root did not change, just normal patch
      patch(
        activeBranch,
        newBranch,
        container,
        anchor,
        parentComponent,
        suspense,
        namespace,
        slotScopeIds,
        optimized,
      )
      setActiveBranch(suspense, newBranch)
    } else {
      // root node toggled
      // invoke @pending event
      triggerEvent(n2, 'onPending')
      // mount pending branch in off-dom container
      suspense.pendingBranch = newBranch
      if (newBranch.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) {
        suspense.pendingId = newBranch.component!.suspenseId!
      } else {
        suspense.pendingId = suspenseId++
      }
      patch(
        null,
        newBranch,
        suspense.hiddenContainer,
        null,
        parentComponent,
        suspense,
        namespace,
        slotScopeIds,
        optimized,
      )
      if (suspense.deps <= 0) {
        // incoming branch has no async deps, resolve now.
        suspense.resolve()
      } else {
        const { timeout, pendingId } = suspense
        if (timeout > 0) {
          setTimeout(() => {
            if (suspense.pendingId === pendingId) {
              suspense.fallback(newFallback)
            }
          }, timeout)
        } else if (timeout === 0) {
          suspense.fallback(newFallback)
        }
      }
    }
  }
}

export interface SuspenseBoundary {
  // 指向 Suspense 组件自身的 VNode
  // 访问 Suspense 的 props（如 timeout、fallback）
  vnode: VNode<RendererNode, RendererElement, SuspenseProps>
  // 父 Suspense 边界（嵌套 Suspense 场景）
  parent: SuspenseBoundary | null // 所属的父组件实例
  parentComponent: ComponentInternalInstance | null
  namespace: ElementNamespace // DOM 命名空间
  // Suspense 渲染的主容器（真实 DOM 元素）
  // 最终渲染的内容（active/fallback 分支）插入到该容器
  container: RendererElement
  // 「隐藏容器」（内存中的 DOM 容器）
  // 异步依赖加载中，先将 active 分支渲染到该容器（不可见），加载完成后再切换到主容器
  hiddenContainer: RendererElement
  // 当前激活的渲染分支 VNode（加载完成后的内容）
  activeBranch: VNode | null
  // 待解析的异步分支 VNode（加载中的内容）
  pendingBranch: VNode | null
  deps: number // 未解析的异步依赖数量
  pendingId: number // 异步请求的唯一 ID
  // 超过该时间未加载完成，自动切换到 fallback 分支
  timeout: number // 超时时间（ms）
  // 标记当前显示的是 fallback 分支（加载失败 / 超时）
  isInFallback: boolean // 是否处于 fallback 状态
  isHydrating: boolean // 是否处于 SSR 水化（hydration）阶段
  // 标记 Suspense 边界是否被销毁，避免已卸载后执行 DOM 操作
  isUnmounted: boolean // 是否已卸载
  // 异步解析完成后，批量执行的回调（如更新 DOM、触发钩子）
  effects: Function[] // 待执行的副作用函数
  // 解析异步依赖，切换到 active 分支
  // 异步依赖加载完成后调用，force 强制解析，sync 同步执行
  resolve(force?: boolean, sync?: boolean): void
  // 加载超时 / 失败时调用，渲染 fallback 内容
  fallback(fallbackVNode: VNode): void // 切换到 fallback 分支
  // Suspense 专属的 DOM 移动方法
  // 切换分支时，将 active/fallback 分支的 DOM 移动到目标容
  move(
    container: RendererElement,
    anchor: RendererNode | null,
    type: MoveType,
  ): void
  // 嵌套 Suspense 时，计算 DOM 插入的位置
  next(): RendererNode | null // 获取下一个渲染节点的锚点
  // 异步组件 /await 数据时，注册依赖并关联到 Suspense 边界
  // 注册异步依赖
  registerDep(
    instance: ComponentInternalInstance,
    setupRenderEffect: SetupRenderEffectFn,
    optimized: boolean,
  ): void
  // 卸载 Suspense 边界
  // 销毁时清理 DOM、依赖、副作用，doRemove 控制是否移除 DOM 节点
  unmount(parentSuspense: SuspenseBoundary | null, doRemove?: boolean): void
}

let hasWarned = false

/**
 * 创建 SuspenseBoundary 实例的工厂函数，是 Suspense 组件初始化的入口，
 * 封装了 Suspense 边界的「状态初始化、核心方法实现、异步依赖管理、DOM 操作」全流程
 * @param vnode Suspense 节点
 * @param parentSuspense 父 Suspense 实例
 * @param parentComponent 父组件实例
 * @param container 挂载容器
 * @param hiddenContainer 隐藏容器（off-dom container）
 * @param anchor 挂载锚点
 * @param namespace 元素命名空间
 * @param slotScopeIds 插槽作用域 ID 列表
 * @param optimized 是否开启优化模式
 * @param rendererInternals 渲染器内部实现
 * @param isHydrating 是否为 hydration 过程
 * @returns Suspense 边界实例
 */
function createSuspenseBoundary(
  vnode: VNode,
  parentSuspense: SuspenseBoundary | null,
  parentComponent: ComponentInternalInstance | null,
  container: RendererElement,
  hiddenContainer: RendererElement,
  anchor: RendererNode | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
  isHydrating = false,
): SuspenseBoundary {
  // 开发环境警告（实验性功能）
  /* v8 ignore start */
  if (__DEV__ && !__TEST__ && !hasWarned) {
    hasWarned = true
    // @ts-expect-error `console.info` cannot be null error
    // eslint-disable-next-line no-console
    console[console.info ? 'info' : 'log'](
      `<Suspense> is an experimental feature and its API will likely change.`,
    )
  }
  /* v8 ignore stop */

  const {
    p: patch,
    m: move,
    um: unmount,
    n: next,
    o: { parentNode, remove },
  } = rendererInternals

  // 父 Suspense 依赖关联（suspensible 特性）
  // if set `suspensible: true`, set the current suspense as a dep of parent suspense
  let parentSuspenseId: number | undefined
  const isSuspensible = isVNodeSuspensible(vnode) // 检查是否开启 suspensible
  /**
   * 若当前 Suspense 开启 suspensible: true（允许作为父 Suspense 的依赖），则将自身注册为父 Suspense 的异步依赖，
   * 父 Suspense 需等待当前 Suspense 解析完成后才会 resolve。
   */
  if (isSuspensible) {
    if (parentSuspense && parentSuspense.pendingBranch) {
      parentSuspenseId = parentSuspense.pendingId // 记录父 Suspense 的请求 ID
      parentSuspense.deps++ // 父 Suspense 的依赖计数 +1
    }
  }

  // 超时时间（ms）
  const timeout = vnode.props ? toNumber(vnode.props.timeout) : undefined
  if (__DEV__) {
    assertNumber(timeout, `Suspense timeout`)
  }

  const initialAnchor = anchor

  // SuspenseBoundary 实例初始化
  const suspense: SuspenseBoundary = {
    vnode,
    parent: parentSuspense,
    parentComponent,
    namespace,
    container,
    hiddenContainer,
    deps: 0,
    pendingId: suspenseId++,
    timeout: typeof timeout === 'number' ? timeout : -1,
    activeBranch: null,
    pendingBranch: null,
    isInFallback: !isHydrating,
    isHydrating,
    isUnmounted: false,
    effects: [],

    /**
     * 解析异步依赖，切换到 active 分支
     * @param resume 是否恢复到 activeBranch，默认 false
     * @param sync 是否同步执行副作用，默认 false
     */
    resolve(resume = false, sync = false) {
      // 参数校验（开发环境）
      if (__DEV__) {
        if (!resume && !suspense.pendingBranch) {
          throw new Error(
            `suspense.resolve() is called without a pending branch.`,
          )
        }
        if (suspense.isUnmounted) {
          throw new Error(
            `suspense.resolve() is called on an already unmounted suspense boundary.`,
          )
        }
      }
      const {
        vnode,
        activeBranch,
        pendingBranch,
        pendingId,
        effects,
        parentComponent,
        container,
        isInFallback,
      } = suspense

      // if there's a transition happening we need to wait it to finish.
      // 处理过渡动画（out-in 模式）
      let delayEnter: boolean | null = false
      if (suspense.isHydrating) {
        suspense.isHydrating = false
      } else if (!resume) {
        delayEnter =
          activeBranch &&
          pendingBranch!.transition &&
          pendingBranch!.transition.mode === 'out-in'
        if (delayEnter) {
          // out-in 模式：等待当前 active 分支 leave 动画完成后，再插入 pending 分支
          //  out-in 过渡模式下，先执行当前分支的离开动画，再插入新分支的 DOM。
          activeBranch!.transition!.afterLeave = () => {
            if (pendingId === suspense.pendingId) {
              // 避免旧请求覆盖
              move(
                pendingBranch!,
                container,
                anchor === initialAnchor ? next(activeBranch!) : anchor,
                MoveType.ENTER,
              )
              queuePostFlushCb(effects)
              // clear el reference from fallback vnode to allow GC after transition
              if (isInFallback && vnode.ssFallback) {
                vnode.ssFallback.el = null
              }
            }
          }
        }
        // unmount current active tree
        // 卸载当前 active 分支
        if (activeBranch) {
          // if the fallback tree was mounted, it may have been moved
          // as part of a parent suspense. get the latest anchor for insertion
          // #8105 if `delayEnter` is true, it means that the mounting of
          // `activeBranch` will be delayed. if the branch switches before
          // transition completes, both `activeBranch` and `pendingBranch` may
          // coexist in the `hiddenContainer`. This could result in
          // `next(activeBranch!)` obtaining an incorrect anchor
          // (got `pendingBranch.el`).
          // Therefore, after the mounting of activeBranch is completed,
          // it is necessary to get the latest anchor.
          if (parentNode(activeBranch.el!) === container) {
            anchor = next(activeBranch)
          }
          unmount(activeBranch, parentComponent, suspense, true)
          // clear el reference from fallback vnode to allow GC
          if (!delayEnter && isInFallback && vnode.ssFallback) {
            queuePostRenderEffect(() => (vnode.ssFallback!.el = null), suspense)
          }
        }
        // 插入 pending 分支（异步加载完成的内容）
        if (!delayEnter) {
          // move content from off-dom container to actual container
          move(pendingBranch!, container, anchor, MoveType.ENTER)
        }
      }

      // 更新状态，执行副作用
      setActiveBranch(suspense, pendingBranch!)
      suspense.pendingBranch = null // 清空 pending 分支
      suspense.isInFallback = false // 标记退出 fallback 状态

      // flush buffered effects
      // check if there is a pending parent suspense
      let parent = suspense.parent
      let hasUnresolvedAncestor = false
      while (parent) {
        if (parent.pendingBranch) {
          // found a pending parent suspense, merge buffered post jobs
          // into that parent
          parent.effects.push(...effects)
          hasUnresolvedAncestor = true
          break
        }
        parent = parent.parent
      }
      // no pending parent suspense nor transition, flush all jobs
      if (!hasUnresolvedAncestor && !delayEnter) {
        queuePostFlushCb(effects)
      }
      suspense.effects = [] // 清空副作用

      // 通知父 Suspense 解析
      // resolve parent suspense if all async deps are resolved
      if (isSuspensible) {
        if (
          parentSuspense &&
          parentSuspense.pendingBranch &&
          parentSuspenseId === parentSuspense.pendingId
        ) {
          parentSuspense.deps--
          if (parentSuspense.deps === 0 && !sync) {
            parentSuspense.resolve()
          }
        }
      }

      // invoke @resolve event
      triggerEvent(vnode, 'onResolve') // 触发 onResolve 事件
    },

    /**
     * 切换到 fallback 分支（超时 / 失败）
     * @param fallbackVNode
     * @returns
     */
    fallback(fallbackVNode) {
      if (!suspense.pendingBranch) {
        return
      }

      const { vnode, activeBranch, parentComponent, container, namespace } =
        suspense

      // invoke @fallback event
      triggerEvent(vnode, 'onFallback')

      const anchor = next(activeBranch!)

      const mountFallback = () => {
        if (!suspense.isInFallback) {
          return
        }
        // mount the fallback tree
        patch(
          null,
          fallbackVNode,
          container,
          anchor,
          parentComponent,
          null, // fallback tree will not have suspense context
          namespace,
          slotScopeIds,
          optimized,
        )
        setActiveBranch(suspense, fallbackVNode)
      }

      const delayEnter =
        fallbackVNode.transition && fallbackVNode.transition.mode === 'out-in'
      if (delayEnter) {
        activeBranch!.transition!.afterLeave = mountFallback
      }
      suspense.isInFallback = true

      // unmount current active branch
      unmount(
        activeBranch!,
        parentComponent,
        null, // no suspense so unmount hooks fire now
        true, // shouldRemove
      )

      if (!delayEnter) {
        mountFallback()
      }
    },

    /**
     * Suspense 分支 DOM 移动
     * @param container
     * @param anchor
     * @param type
     */
    move(container, anchor, type) {
      // 仅当存在激活分支时，执行 DOM 移动
      suspense.activeBranch &&
        move(suspense.activeBranch, container, anchor, type)
      suspense.container = container // 更新 Suspense 边界的主容器引用
    },

    /**
     * 计算下一个 DOM 节点（用于 DOM 移动）
     * @returns 下一个 DOM 节点（或 null）
     */
    next() {
      return suspense.activeBranch && next(suspense.activeBranch)
    },

    /**
     * 注册异步依赖
     * @param instance
     * @param setupRenderEffect
     * @param optimized
     */
    registerDep(instance, setupRenderEffect, optimized) {
      const isInPendingSuspense = !!suspense.pendingBranch
      if (isInPendingSuspense) {
        suspense.deps++
      }
      const hydratedEl = instance.vnode.el
      instance
        .asyncDep!.catch(err => {
          handleError(err, instance, ErrorCodes.SETUP_FUNCTION)
        })
        .then(asyncSetupResult => {
          // retry when the setup() promise resolves.
          // component may have been unmounted before resolve.
          if (
            instance.isUnmounted ||
            suspense.isUnmounted ||
            suspense.pendingId !== instance.suspenseId
          ) {
            return
          }
          // retry from this component
          instance.asyncResolved = true
          const { vnode } = instance
          if (__DEV__) {
            pushWarningContext(vnode)
          }
          handleSetupResult(instance, asyncSetupResult, false)
          if (hydratedEl) {
            // vnode may have been replaced if an update happened before the
            // async dep is resolved.
            vnode.el = hydratedEl
          }
          const placeholder = !hydratedEl && instance.subTree.el
          setupRenderEffect(
            instance,
            vnode,
            // component may have been moved before resolve.
            // if this is not a hydration, instance.subTree will be the comment
            // placeholder.
            parentNode(hydratedEl || instance.subTree.el!)!,
            // anchor will not be used if this is hydration, so only need to
            // consider the comment placeholder case.
            hydratedEl ? null : next(instance.subTree),
            suspense,
            namespace,
            optimized,
          )
          if (placeholder) {
            // clean up placeholder reference
            vnode.placeholder = null
            remove(placeholder)
          }
          updateHOCHostEl(instance, vnode.el)
          if (__DEV__) {
            popWarningContext()
          }
          // only decrease deps count if suspense is not already resolved
          if (isInPendingSuspense && --suspense.deps === 0) {
            suspense.resolve()
          }
        })
    },

    /**
     * 卸载 Suspense 边界
     * 「安全销毁 Suspense 边界及其管理的所有渲染分支（active/pending）」，
     * 保证卸载时无内存泄漏、无无效 DOM 操作，同时兼容 KeepAlive 缓存场景下的卸载行为。
     * @param parentSuspense 所属的父 Suspense 边界
     * @param doRemove 是否移除 DOM 节点
     */
    unmount(parentSuspense, doRemove) {
      suspense.isUnmounted = true // 标记为已卸载
      // 卸载当前激活的分支（activeBranch）
      if (suspense.activeBranch) {
        unmount(
          // 要卸载的 VNode（active 分支，如已渲染的异步组件/fallback）
          suspense.activeBranch,
          parentComponent, // 所属的父组件实例（用于生命周期联动）
          parentSuspense, // 父 Suspense 边界（嵌套场景下传递上下文）
          doRemove, // 是否移除 DOM 节点
        )
      }
      // 卸载待解析的分支（pendingBranch）
      if (suspense.pendingBranch) {
        unmount(
          suspense.pendingBranch,
          parentComponent,
          parentSuspense,
          doRemove,
        )
      }
    },
  }

  return suspense
}

function hydrateSuspense(
  node: Node,
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
  hydrateNode: (
    node: Node,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => Node | null,
): Node | null {
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    node.parentNode!,
    // eslint-disable-next-line no-restricted-globals
    document.createElement('div'),
    null,
    namespace,
    slotScopeIds,
    optimized,
    rendererInternals,
    true /* hydrating */,
  ))
  // there are two possible scenarios for server-rendered suspense:
  // - success: ssr content should be fully resolved
  // - failure: ssr content should be the fallback branch.
  // however, on the client we don't really know if it has failed or not
  // attempt to hydrate the DOM assuming it has succeeded, but we still
  // need to construct a suspense boundary first
  const result = hydrateNode(
    node,
    (suspense.pendingBranch = vnode.ssContent!),
    parentComponent,
    suspense,
    slotScopeIds,
    optimized,
  )
  if (suspense.deps === 0) {
    suspense.resolve(false, true)
  }
  return result
}

function normalizeSuspenseChildren(vnode: VNode): void {
  const { shapeFlag, children } = vnode
  const isSlotChildren = shapeFlag & ShapeFlags.SLOTS_CHILDREN
  vnode.ssContent = normalizeSuspenseSlot(
    isSlotChildren ? (children as Slots).default : children,
  )
  vnode.ssFallback = isSlotChildren
    ? normalizeSuspenseSlot((children as Slots).fallback)
    : createVNode(Comment)
}

function normalizeSuspenseSlot(s: any) {
  let block: VNode[] | null | undefined
  if (isFunction(s)) {
    const trackBlock = isBlockTreeEnabled && s._c
    if (trackBlock) {
      // disableTracking: false
      // allow block tracking for compiled slots
      // (see ./componentRenderContext.ts)
      s._d = false
      openBlock()
    }
    s = s()
    if (trackBlock) {
      s._d = true
      block = currentBlock
      closeBlock()
    }
  }
  if (isArray(s)) {
    const singleChild = filterSingleRoot(s)
    if (
      __DEV__ &&
      !singleChild &&
      s.filter(child => child !== NULL_DYNAMIC_COMPONENT).length > 0
    ) {
      warn(`<Suspense> slots expect a single root node.`)
    }
    s = singleChild
  }
  s = normalizeVNode(s)
  if (block && !s.dynamicChildren) {
    s.dynamicChildren = block.filter(c => c !== s)
  }
  return s
}

export function queueEffectWithSuspense(
  fn: Function | Function[],
  suspense: SuspenseBoundary | null,
): void {
  if (suspense && suspense.pendingBranch) {
    if (isArray(fn)) {
      suspense.effects.push(...fn)
    } else {
      suspense.effects.push(fn)
    }
  } else {
    queuePostFlushCb(fn)
  }
}

/**
 * 更新 Suspense 边界「激活分支」并同步 DOM 节点引用
 * @param suspense Suspense 边界实例
 * @param branch 要设置为激活分支的 VNode（异步组件/fallback 分支）
 */
function setActiveBranch(suspense: SuspenseBoundary, branch: VNode) {
  suspense.activeBranch = branch // 将传入的分支标记为 Suspense 的激活分支
  const { vnode, parentComponent } = suspense
  let el = branch.el // 取分支 VNode 的 el（DOM 节点）

  // 递归穿透 HOC/异步组件，找到真实的 DOM 节点
  // if branch has no el after patch, it's a HOC wrapping async components
  // drill and locate the placeholder comment node
  while (!el && branch.component) {
    branch = branch.component.subTree
    el = branch.el // 重新获取子树的 el
  }
  vnode.el = el

  // 同步 DOM 节点到父组件（若 Suspense 是父组件的根节点）
  // in case suspense is the root node of a component,
  // recursively update the HOC el
  if (parentComponent && parentComponent.subTree === vnode) {
    parentComponent.vnode.el = el
    // 同步更新高阶组件的宿主 el
    updateHOCHostEl(parentComponent, el)
  }
}

function isVNodeSuspensible(vnode: VNode) {
  const suspensible = vnode.props && vnode.props.suspensible
  return suspensible != null && suspensible !== false
}
