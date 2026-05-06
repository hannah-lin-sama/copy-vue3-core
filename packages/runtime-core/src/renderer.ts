import {
  Comment,
  Fragment,
  Static,
  Text,
  type VNode,
  type VNodeArrayChildren,
  type VNodeHook,
  type VNodeProps,
  cloneIfMounted,
  createVNode,
  invokeVNodeHook,
  isSameVNodeType,
  normalizeVNode,
} from './vnode'
import {
  type ComponentInternalInstance,
  type ComponentOptions,
  type Data,
  type LifecycleHook,
  createComponentInstance,
  setupComponent,
} from './component'
import {
  filterSingleRoot,
  renderComponentRoot,
  shouldUpdateComponent,
  updateHOCHostEl,
} from './componentRenderUtils'
import {
  EMPTY_ARR,
  EMPTY_OBJ,
  NOOP,
  PatchFlags,
  ShapeFlags,
  def,
  getGlobalThis,
  invokeArrayFns,
  isArray,
  isReservedProp,
} from '@vue/shared'
import {
  type SchedulerJob,
  SchedulerJobFlags,
  type SchedulerJobs,
  flushPostFlushCbs,
  flushPreFlushCbs,
  queueJob,
  queuePostFlushCb,
} from './scheduler'
import {
  EffectFlags,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
} from '@vue/reactivity'
import { updateProps } from './componentProps'
import { updateSlots } from './componentSlots'
import { popWarningContext, pushWarningContext, warn } from './warning'
import { type CreateAppFunction, createAppAPI } from './apiCreateApp'
import { setRef } from './rendererTemplateRef'
import {
  type SuspenseBoundary,
  type SuspenseImpl,
  isSuspense,
  queueEffectWithSuspense,
} from './components/Suspense'
import {
  TeleportEndKey,
  type TeleportImpl,
  type TeleportVNode,
} from './components/Teleport'
import { type KeepAliveContext, isKeepAlive } from './components/KeepAlive'
import { isHmrUpdating, registerHMR, unregisterHMR } from './hmr'
import { type RootHydrateFunction, createHydrationFunctions } from './hydration'
import { invokeDirectiveHook } from './directives'
import { endMeasure, startMeasure } from './profiling'
import {
  devtoolsComponentAdded,
  devtoolsComponentRemoved,
  devtoolsComponentUpdated,
  setDevtoolsHook,
} from './devtools'
import { initFeatureFlags } from './featureFlags'
import { isAsyncWrapper } from './apiAsyncComponent'
import { isCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'
import { type TransitionHooks, leaveCbKey } from './components/BaseTransition'
import type { ComponentCustomElementInterface } from './component'

export interface Renderer<HostElement = RendererElement> {
  render: RootRenderFunction<HostElement>
  createApp: CreateAppFunction<HostElement>
}

export interface HydrationRenderer extends Renderer<Element | ShadowRoot> {
  hydrate: RootHydrateFunction
}

export type ElementNamespace = 'svg' | 'mathml' | undefined

export type RootRenderFunction<HostElement = RendererElement> = (
  vnode: VNode | null,
  container: HostElement,
  namespace?: ElementNamespace,
) => void

export interface RendererOptions<
  HostNode = RendererNode,
  HostElement = RendererElement,
> {
  patchProp(
    el: HostElement,
    key: string,
    prevValue: any,
    nextValue: any,
    namespace?: ElementNamespace,
    parentComponent?: ComponentInternalInstance | null,
  ): void
  insert(el: HostNode, parent: HostElement, anchor?: HostNode | null): void
  remove(el: HostNode): void
  createElement(
    type: string,
    namespace?: ElementNamespace,
    isCustomizedBuiltIn?: string,
    vnodeProps?: (VNodeProps & { [key: string]: any }) | null,
  ): HostElement
  createText(text: string): HostNode
  createComment(text: string): HostNode
  setText(node: HostNode, text: string): void
  setElementText(node: HostElement, text: string): void
  parentNode(node: HostNode): HostElement | null
  nextSibling(node: HostNode): HostNode | null
  querySelector?(selector: string): HostElement | null
  setScopeId?(el: HostElement, id: string): void
  cloneNode?(node: HostNode): HostNode
  insertStaticContent?(
    content: string,
    parent: HostElement,
    anchor: HostNode | null,
    namespace: ElementNamespace,
    start?: HostNode | null,
    end?: HostNode | null,
  ): [HostNode, HostNode]
}

// Renderer Node can technically be any object in the context of core renderer
// logic - they are never directly operated on and always passed to the node op
// functions provided via options, so the internal constraint is really just
// a generic object.
export interface RendererNode {
  [key: string | symbol]: any
}

export interface RendererElement extends RendererNode {}

// An object exposing the internals of a renderer, passed to tree-shakeable
// features so that they can be decoupled from this file. Keys are shortened
// to optimize bundle size.
export interface RendererInternals<
  HostNode = RendererNode,
  HostElement = RendererElement,
> {
  p: PatchFn
  um: UnmountFn
  r: RemoveFn
  m: MoveFn
  mt: MountComponentFn
  mc: MountChildrenFn
  pc: PatchChildrenFn
  pbc: PatchBlockChildrenFn
  n: NextFn
  o: RendererOptions<HostNode, HostElement>
}

// These functions are created inside a closure and therefore their types cannot
// be directly exported. In order to avoid maintaining function signatures in
// two places, we declare them once here and use them inside the closure.
type PatchFn = (
  n1: VNode | null, // null means this is a mount
  n2: VNode,
  container: RendererElement,
  anchor?: RendererNode | null,
  parentComponent?: ComponentInternalInstance | null,
  parentSuspense?: SuspenseBoundary | null,
  namespace?: ElementNamespace,
  slotScopeIds?: string[] | null,
  optimized?: boolean,
) => void

type MountChildrenFn = (
  children: VNodeArrayChildren,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
  start?: number,
) => void

type PatchChildrenFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
  optimized: boolean,
) => void

type PatchBlockChildrenFn = (
  oldChildren: VNode[],
  newChildren: VNode[],
  fallbackContainer: RendererElement,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  slotScopeIds: string[] | null,
) => void

type MoveFn = (
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  type: MoveType,
  parentSuspense?: SuspenseBoundary | null,
) => void

type NextFn = (vnode: VNode) => RendererNode | null

type UnmountFn = (
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean,
) => void

type RemoveFn = (vnode: VNode) => void

type UnmountChildrenFn = (
  children: VNode[],
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean,
  start?: number,
) => void

export type MountComponentFn = (
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  optimized: boolean,
) => void

type ProcessTextOrCommentFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
) => void

export type SetupRenderEffectFn = (
  instance: ComponentInternalInstance,
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentSuspense: SuspenseBoundary | null,
  namespace: ElementNamespace,
  optimized: boolean,
) => void

export enum MoveType {
  ENTER,
  LEAVE,
  REORDER,
}

/**
 * Vue 的「副作用调度」分为多个阶段：
 * queuePreFlushCb：刷新前执行（如 watch 的 flush: 'pre'）；
 * queuePostFlushCb：刷新后执行（如 watch 的 flush: 'post'）；
 * queueEffectWithSuspense：适配 Suspense 的特殊调度（等待 Suspense 解析完成后执行）；
 */

/**
 * 根据「Suspense 特性是否开启」和「环境（测试 / 生产）」动态赋值的「渲染后副作用队列函数」
 * fn：要执行的副作用函数
 * suspense：关联的 Suspense 边界（如果有）
 */
export const queuePostRenderEffect: (
  fn: SchedulerJobs,
  suspense: SuspenseBoundary | null,
) => void = __FEATURE_SUSPENSE__ // 分支1：开启了Suspense特性
  ? __TEST__ // 测试环境（vitest）
    ? // vitest can't seem to handle eager circular dependency
      // vitest 无法处理「急切循环依赖」，包裹一层函数规避
      (fn: Function | Function[], suspense: SuspenseBoundary | null) =>
        queueEffectWithSuspense(fn, suspense)
    : queueEffectWithSuspense // 非测试环境 → 直接使用 queueEffectWithSuspense
  : queuePostFlushCb // 未开启Suspense特性 → 降级为普通的渲染后回调队列

/**
 * The createRenderer function accepts two generic arguments:
 * HostNode and HostElement, corresponding to Node and Element types in the
 * host environment. For example, for runtime-dom, HostNode would be the DOM
 * `Node` interface and HostElement would be the DOM `Element` interface.
 *
 * Custom renderers can pass in the platform specific types like this:
 *
 * ``` js
 * const { render, createApp } = createRenderer<Node, Element>({
 *   patchProp,
 *   ...nodeOps
 * })
 * ```
 */
export function createRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement,
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement> {
  return baseCreateRenderer<HostNode, HostElement>(options)
}

// Separate API for creating hydration-enabled renderer.
// Hydration logic is only used when calling this function, making it
// tree-shakable.
export function createHydrationRenderer(
  options: RendererOptions<Node, Element>,
): HydrationRenderer {
  return baseCreateRenderer(options, createHydrationFunctions)
}

// overload 1: no hydration
function baseCreateRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement,
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement>

// overload 2: with hydration
function baseCreateRenderer(
  options: RendererOptions<Node, Element>,
  createHydrationFns: typeof createHydrationFunctions,
): HydrationRenderer

// implementation
function baseCreateRenderer(
  options: RendererOptions,
  createHydrationFns?: typeof createHydrationFunctions,
): any {
  // compile-time feature flags check
  if (__ESM_BUNDLER__ && !__TEST__) {
    initFeatureFlags()
  }

  const target = getGlobalThis()
  target.__VUE__ = true
  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    setDevtoolsHook(target.__VUE_DEVTOOLS_GLOBAL_HOOK__, target)
  }

  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    insertStaticContent: hostInsertStaticContent,
  } = options

  /**
   *
   * @param n1 旧节点
   * @param n2 新节点
   * @param container 容器元素
   * @param anchor 锚点元素
   * @param parentComponent 父组件实例
   * @param parentSuspense 父 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 数组
   * @param optimized 是否开启优化模式
   * @returns
   */
  // Note: functions inside this closure should use `const xxx = () => {}`
  // style in order to prevent being inlined by minifiers.
  const patch: PatchFn = (
    n1,
    n2,
    container,
    anchor = null,
    parentComponent = null,
    parentSuspense = null,
    namespace = undefined,
    slotScopeIds = null,
    optimized = __DEV__ && isHmrUpdating ? false : !!n2.dynamicChildren,
  ) => {
    // 新旧节点一致，无需处理
    if (n1 === n2) {
      return
    }

    // patching & not same type, unmount old tree
    // isSameVNodeType 同时比较 type 和 key 是否相同
    if (n1 && !isSameVNodeType(n1, n2)) {
      // 获取旧节点的下一个兄弟节点作为锚点，然后完全卸载旧节点
      anchor = getNextHostNode(n1)
      unmount(n1, parentComponent, parentSuspense, true)
      n1 = null
    }

    // 禁用编译优化（例如动态模板结构变化），此时回退到全量对比
    if (n2.patchFlag === PatchFlags.BAIL) {
      optimized = false
      n2.dynamicChildren = null
    }

    const { type, ref, shapeFlag } = n2
    switch (type) {
      case Text:
        // 文本节点，直接更新文本内容
        processText(n1, n2, container, anchor)
        break
      case Comment:
        // 注释节点
        processCommentNode(n1, n2, container, anchor)
        break
      case Static:
        // 静态节点（编译时已优化，只挂载不更新）
        if (n1 == null) {
          mountStaticNode(n2, container, anchor, namespace)
        } else if (__DEV__) {
          patchStaticNode(n1, n2, container, namespace)
        }
        break
      case Fragment:
        // 多根节点片段，处理子节点列表
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        break
      default:
        if (shapeFlag & ShapeFlags.ELEMENT) {
          // 普通 DOM 元素，处理属性、子节点、事件等
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else if (shapeFlag & ShapeFlags.COMPONENT) {
          // 组件节点，触发组件生命周期与更新
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else if (shapeFlag & ShapeFlags.TELEPORT) {
          // 内置 Teleport 组件的特殊处理
          ;(type as typeof TeleportImpl).process(
            n1 as TeleportVNode,
            n2 as TeleportVNode,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals,
          )
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
          // 内置 Suspense 组件的异步处理
          ;(type as typeof SuspenseImpl).process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals,
          )
        } else if (__DEV__) {
          warn('Invalid VNode type:', type, `(${typeof type})`)
        }
    }

    // ref 用于获取组件或 DOM 元素的引用，
    // 其更新时机必须在 patch 完成之后，以确保引用指向最新的真实 DOM 或组件实例
    // set ref
    if (ref != null && parentComponent) {
      // 情况一：新 VNode 存在 ref 且位于组件内 → 设置新引用，并卸载旧引用（如果旧 VNode 也有 ref）。
      setRef(ref, n1 && n1.ref, parentSuspense, n2 || n1, !n2)

      // 情况二：新 VNode 无 ref 但旧 VNode 有 ref → 卸载旧的 ref（置为 null）
    } else if (ref == null && n1 && n1.ref != null) {
      setRef(n1.ref, null, parentSuspense, n1, true)
    }
  }

  /**
   * 处理文本节点
   * @param n1 旧节点
   * @param n2 新节点
   * @param container 容器元素
   * @param anchor 锚点元素
   */
  const processText: ProcessTextOrCommentFn = (n1, n2, container, anchor) => {
    if (n1 == null) {
      // 将文本节点插入到容器的指定位置
      hostInsert(
        // 创建 DOM 文本节点
        (n2.el = hostCreateText(n2.children as string)),
        container,
        anchor,
      )
    } else {
      const el = (n2.el = n1.el!)
      if (n2.children !== n1.children) {
        // 文本内容发生变化，更新 DOM 文本节点
        hostSetText(el, n2.children as string)
      }
    }
  }

  /**
   * 处理注释节点
   * @param n1 旧节点
   * @param n2 新节点
   * @param container 容器元素
   * @param anchor 锚点元素
   */
  const processCommentNode: ProcessTextOrCommentFn = (
    n1,
    n2,
    container,
    anchor,
  ) => {
    if (n1 == null) {
      // 将注释节点插入到指定位置
      hostInsert(
        // 创建 DOM 注释节点
        (n2.el = hostCreateComment((n2.children as string) || '')),
        container,
        anchor,
      )
    } else {
      // there's no support for dynamic comments
      // 复用旧节点：直接将旧节点的 DOM 引用赋值给新节点
      // 注释节点不支持动态更新
      n2.el = n1.el
    }
  }

  /**
   * 将编译时优化后的静态 HTML 内容高效地插入到 DOM 中
   * @param n2 新节点
   * @param container 容器元素
   * @param anchor 锚点元素
   * @param namespace 元素命名空间
   */
  const mountStaticNode = (
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    namespace: ElementNamespace,
  ) => {
    // static nodes are only present when used with compiler-dom/runtime-dom
    // which guarantees presence of hostInsertStaticContent.
    // [0]：静态内容的第一个 DOM 节点（el）
    // [1]：静态内容的最后一个 DOM 节点（anchor）
    ;[n2.el, n2.anchor] = hostInsertStaticContent!(
      // 静态 VNode 的 children 属性存储的是序列化后的 HTML 字符串
      n2.children as string,
      container,
      anchor,
      namespace,
      n2.el,
      n2.anchor,
    )
  }

  /**
   * 静态节点的补丁函数
   * 静态节点在生产环境中永不更新（编译时已确定）
   */
  const patchStaticNode = (
    n1: VNode,
    n2: VNode,
    container: RendererElement,
    namespace: ElementNamespace,
  ) => {
    // static nodes are only patched during dev for HMR
    // 比较新旧静态内容是否相同。静态内容存储在 children 属性中（HTML 字符串）
    if (n2.children !== n1.children) {
      // 获取旧静态内容的下一个兄弟节点（作为新内容的插入锚点）
      // n1.anchor 是旧静态内容的最后一个 DOM 节点
      const anchor = hostNextSibling(n1.anchor!)
      // remove existing
      // 移除静态内容占用的所有 DOM 节点（从 n1.el 到 n1.anchor 之间的所有节点）
      removeStaticNode(n1)
      // insert new
      // 插入新的静态内容
      ;[n2.el, n2.anchor] = hostInsertStaticContent!(
        n2.children as string,
        container,
        anchor,
        namespace,
      )
    } else {
      n2.el = n1.el
      n2.anchor = n1.anchor
    }
  }

  /**
   *
   * @param param0 包含 el 和 anchor 属性的 VNode 对象
   * @param container 容器元素
   * @param nextSibling 下一个兄弟节点
   */
  const moveStaticNode = (
    { el, anchor }: VNode,
    container: RendererElement,
    nextSibling: RendererNode | null,
  ) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el)
      hostInsert(el, container, nextSibling)
      el = next
    }
    hostInsert(anchor!, container, nextSibling)
  }

  /**
   * 删除静态节点
   * @param param0 包含 el 和 anchor 属性的 VNode 对象
   */
  const removeStaticNode = ({ el, anchor }: VNode) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el) // 获取下一个兄弟节点
      hostRemove(el)
      el = next
    }
    hostRemove(anchor!)
  }

  /**
   * 处理元素节点
   * @param n1 旧节点
   * @param n2 新节点
   * @param container 容器元素
   * @param anchor 锚点元素
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param optimized 是否开启优化模式
   */
  const processElement = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // SVG 和 MathML 元素需要正确的命名空间才能正确渲染
    if (n2.type === 'svg') {
      namespace = 'svg'
    } else if (n2.type === 'math') {
      namespace = 'mathml'
    }

    if (n1 == null) {
      // 新节点：挂载新元素
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    } else {
      // 检测自定义元素
      const customElement =
        n1.el && (n1.el as ComponentCustomElementInterface)._isVueCE
          ? (n1.el as ComponentCustomElementInterface)
          : null
      try {
        if (customElement) {
          // 调用开始钩子
          customElement._beginPatch()
        }
        patchElement(
          n1,
          n2,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      } finally {
        if (customElement) {
          // 调用结束钩子
          customElement._endPatch()
        }
      }
    }
  }

  /**
   * 挂载元素节点
   * 负责将一个 VNode 转换为真实的 DOM 元素，并插入到指定容器中
   * @param vnode 要渲染的虚拟节点
   * @param container 容器元素
   * @param anchor 锚点元素
   * @param parentComponent
   * @param parentSuspense
   * @param namespace 元素命名空间
   * @param slotScopeIds
   * @param optimized
   */
  const mountElement = (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    let el: RendererElement
    let vnodeHook: VNodeHook | undefined | null
    const { props, shapeFlag, transition, dirs } = vnode

    // 创建 DOM 元素
    // 平台相关的元素创建函数（如浏览器中的 document.createElement
    el = vnode.el = hostCreateElement(
      vnode.type as string,
      namespace,
      props && props.is, // 用于自定义内置元素
      props,
    )

    // 先挂载子节点：某些 props（如 <select value>）需要子节点已存在才能正确设置
    // mount children first, since some props may rely on child content
    // being already rendered, e.g. `<select value>`
    // 有文本子节点时，直接设置文本内容
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      hostSetElementText(el, vnode.children as string)
      // 有数组子节点时，递归渲染子节点
    } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      mountChildren(
        vnode.children as VNodeArrayChildren,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(vnode, namespace),
        slotScopeIds,
        optimized,
      )
    }

    // 调用指令的 created 钩子（在元素创建后、属性设置前执行）
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, 'created')
    }
    // scopeId
    // 为元素添加 scoped CSS 的属性选择器
    setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent)
    // props
    if (props) {
      for (const key in props) {
        if (key !== 'value' && !isReservedProp(key)) {
          hostPatchProp(el, key, null, props[key], namespace, parentComponent)
        }
      }
      /**
       * Special case for setting value on DOM elements:
       * - it can be order-sensitive (e.g. should be set *after* min/max, #2325, #4024)
       * - it needs to be forced (#1471)
       * #2353 proposes adding another renderer option to configure this, but
       * the properties affects are so finite it is worth special casing it
       * here to reduce the complexity. (Special casing it also should not
       * affect non-DOM renderers)
       */
      // value 属性特殊处理：需要在其他属性之后设置
      if ('value' in props) {
        hostPatchProp(el, 'value', null, props.value, namespace)
      }
      // onVnodeBeforeMount 钩子
      if ((vnodeHook = props.onVnodeBeforeMount)) {
        invokeVNodeHook(vnodeHook, parentComponent, vnode)
      }
    }

    // 在开发模式下，为 DOM 元素添加 VNode 和父组件引用
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      def(el, '__vnode', vnode, true)
      def(el, '__vueParentComponent', parentComponent, true)
    }

    // 调用指令的 beforeMount 钩子（在元素插入 DOM 前执行）
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
    }
    // #1583 For inside suspense + suspense not resolved case, enter hook should call when suspense resolved
    // #1689 For inside suspense + suspense resolved case, just call it
    const needCallTransitionHooks = needTransition(parentSuspense, transition)
    if (needCallTransitionHooks) {
      // 调用 transition.beforeEnter 在插入 DOM 前执行
      transition!.beforeEnter(el)
    }
    // 将创建的 DOM 元素插入到容器中的指定位置
    hostInsert(el, container, anchor)
    if (
      (vnodeHook = props && props.onVnodeMounted) ||
      needCallTransitionHooks ||
      dirs
    ) {
      queuePostRenderEffect(() => {
        // 将 onVnodeMounted、transition.enter、指令 mounted 钩子放入后置队列
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        needCallTransitionHooks && transition!.enter(el)
        dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
      }, parentSuspense)
    }
  }

  /**
   *
   * @param el 渲染元素
   * @param vnode 虚拟节点
   * @param scopeId 作用域 ID
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param parentComponent 父组件实例
   */
  const setScopeId = (
    el: RendererElement,
    vnode: VNode,
    scopeId: string | null,
    slotScopeIds: string[] | null,
    parentComponent: ComponentInternalInstance | null,
  ) => {
    if (scopeId) {
      hostSetScopeId(el, scopeId)
    }
    if (slotScopeIds) {
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i])
      }
    }
    if (parentComponent) {
      let subTree = parentComponent.subTree
      if (
        __DEV__ &&
        subTree.patchFlag > 0 &&
        subTree.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
      ) {
        subTree =
          filterSingleRoot(subTree.children as VNodeArrayChildren) || subTree
      }
      if (
        vnode === subTree ||
        (isSuspense(subTree.type) &&
          (subTree.ssContent === vnode || subTree.ssFallback === vnode))
      ) {
        const parentVNode = parentComponent.vnode
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent,
        )
      }
    }
  }

  /**
   * 批量挂载子节点
   * @param children 子节点数组
   * @param container 容器元素
   * @param anchor 锚点元素
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param optimized 是否开启优化模式
   * @param start 起始索引
   */
  const mountChildren: MountChildrenFn = (
    children,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    slotScopeIds,
    optimized,
    start = 0,
  ) => {
    for (let i = start; i < children.length; i++) {
      const child = (children[i] = optimized
        ? // 优编译时优化的静态节点，复用已挂载的 VNode
          cloneIfMounted(children[i] as VNode)
        : // 运行时动态生成的节点，需要标准化
          normalizeVNode(children[i]))
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    }
  }

  /**
   * 处理元素节点更新
   * 负责对比新旧 VNode，高效地更新对应的 DOM 元素
   * @param n1 旧节点
   * @param n2 新节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param optimized 是否开启优化模式
   */
  const patchElement = (
    n1: VNode,
    n2: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 复用 DOM 元素：n2.el = n1.el! 确保新 VNode 引用同一个 DOM 元素
    const el = (n2.el = n1.el!)
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      el.__vnode = n2
    }
    let { patchFlag, dynamicChildren, dirs } = n2
    // #1426 take the old vnode's patch flag into account since user may clone a
    // compiler-generated vnode, which de-opts to FULL_PROPS
    // patchFlag 合并
    patchFlag |= n1.patchFlag & PatchFlags.FULL_PROPS
    const oldProps = n1.props || EMPTY_OBJ
    const newProps = n2.props || EMPTY_OBJ
    let vnodeHook: VNodeHook | undefined | null

    // disable recurse in beforeUpdate hooks
    // beforeUpdate 钩子（禁用递归）
    parentComponent && toggleRecurse(parentComponent, false)
    if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
    }
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate')
    }
    parentComponent && toggleRecurse(parentComponent, true)

    // HMR 更新需要重新渲染整个组件，不能依赖编译时优化
    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // #9135 innerHTML / textContent unset needs to happen before possible
    // new children mount
    // innerHTML/textContent 清除
    if (
      (oldProps.innerHTML && newProps.innerHTML == null) ||
      (oldProps.textContent && newProps.textContent == null)
    ) {
      hostSetElementText(el, '')
    }

    if (dynamicChildren) {
      // 编译时优化路径：只更新动态子节点/
      patchBlockChildren(
        n1.dynamicChildren!,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
      )
      if (__DEV__) {
        // necessary for HMR
        traverseStaticChildren(n1, n2)
      }
    } else if (!optimized) {
      // full diff
      //  完整 diff 路径
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
        false,
      )
    }

    if (patchFlag > 0) {
      // the presence of a patchFlag means this element's render code was
      // generated by the compiler and can take the fast path.
      // in this path old node and new node are guaranteed to have the same shape
      // (i.e. at the exact same position in the source template)
      if (patchFlag & PatchFlags.FULL_PROPS) {
        // element props contain dynamic keys, full diff needed
        // 动态 key，需要完整 props diff
        patchProps(el, oldProps, newProps, parentComponent, namespace)
      } else {
        // class
        // this flag is matched when the element has dynamic class bindings.
        if (patchFlag & PatchFlags.CLASS) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, 'class', null, newProps.class, namespace)
          }
        }

        // style
        // this flag is matched when the element has dynamic style bindings
        if (patchFlag & PatchFlags.STYLE) {
          hostPatchProp(el, 'style', oldProps.style, newProps.style, namespace)
        }

        // props
        // This flag is matched when the element has dynamic prop/attr bindings
        // other than class and style. The keys of dynamic prop/attrs are saved for
        // faster iteration.
        // Note dynamic keys like :[foo]="bar" will cause this optimization to
        // bail out and go through a full diff because we need to unset the old key
        if (patchFlag & PatchFlags.PROPS) {
          // if the flag is present then dynamicProps must be non-null
          const propsToUpdate = n2.dynamicProps!
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i]
            const prev = oldProps[key]
            const next = newProps[key]
            // #1471 force patch value
            if (next !== prev || key === 'value') {
              hostPatchProp(el, key, prev, next, namespace, parentComponent)
            }
          }
        }
      }

      // text
      // This flag is matched when the element has only dynamic text children.
      if (patchFlag & PatchFlags.TEXT) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children as string)
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      // unoptimized, full diff
      patchProps(el, oldProps, newProps, parentComponent, namespace)
    }

    // 将更新钩子放入后置队列，确保在 DOM 更新完成后执行
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
        dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated')
      }, parentSuspense)
    }
  }

  /**
   *  Block Tree（块树）优化
   * @param oldChildren 旧子节点数组
   * @param newChildren 新子节点数组
   * @param fallbackContainer 回退容器
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   */
  // The fast path for blocks.
  const patchBlockChildren: PatchBlockChildrenFn = (
    oldChildren,
    newChildren,
    fallbackContainer,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    slotScopeIds,
  ) => {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i]
      const newVNode = newChildren[i]
      // Determine the container (parent element) for the patch.
      // 动态容器确定
      const container =
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        oldVNode.el &&
        // Fragment 没有自己的包裹元素，其子节点都位于锚点文本节点之间
        // ragment 的 el 存储的是起始锚点文本节点，而子节点的父节点实际上是 起始锚点与结束锚点共同所在的容器（通常是父 Fragment 的容器或普通元素）。
        (oldVNode.type === Fragment ||
          // - In the case of different nodes, there is going to be a replacement
          // which also requires the correct parent container
          // 当新旧节点类型不同（type 或 key 改变），旧节点会被卸载并替换为新节点。在替换过程中，新节点需要插入到旧节点的同级位置，因此必须知道旧节点的父节点
          !isSameVNodeType(oldVNode, newVNode) ||
          // - In the case of a component, it could contain anything.
          // oldVNode.shapeFlag 包含 COMPONENT | TELEPORT | SUSPENSE
          oldVNode.shapeFlag &
            (ShapeFlags.COMPONENT | ShapeFlags.TELEPORT | ShapeFlags.SUSPENSE))
          ? hostParentNode(oldVNode.el)!
          : // In other cases, the parent container is not actually used so we
            // just pass the block element here to avoid a DOM parentNode call.
            fallbackContainer
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        true,
      )
    }
  }

  /**
   * 更新 DOM 元素的属性
   * @param el 渲染元素
   * @param oldProps 旧属性
   * @param newProps 新属性
   * @param parentComponent 父组件实例
   * @param namespace 元素命名空间
   */
  const patchProps = (
    el: RendererElement,
    oldProps: Data,
    newProps: Data,
    parentComponent: ComponentInternalInstance | null,
    namespace: ElementNamespace,
  ) => {
    if (oldProps !== newProps) {
      // 如果旧属性不是空对象，遍历旧属性
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          // 不是保留属性（如 key、ref 等），且在新属性中不存在该属性
          // 则删除旧属性
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key, // 属性名
              oldProps[key], // 旧属性值
              null,
              namespace,
              parentComponent, // 父组件实例，用于处理指令等需要组件上下文的情况
            )
          }
        }
      }
      for (const key in newProps) {
        // empty string is not valid prop
        if (isReservedProp(key)) continue
        const next = newProps[key]
        const prev = oldProps[key]
        // defer patching value
        if (next !== prev && key !== 'value') {
          hostPatchProp(el, key, prev, next, namespace, parentComponent)
        }
      }
      if ('value' in newProps) {
        hostPatchProp(el, 'value', oldProps.value, newProps.value, namespace)
      }
    }
  }

  /**
   * Fragment 是 Vue 3 引入的多根节点容器，允许组件返回多个根节点而无需额外的包装元素
   * @param n1 旧节点
   * @param n2 新节点
   * @param container 渲染目标容器
   * @param anchor 锚点节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 数组
   * @param optimized 是否开启优化模式
   */
  const processFragment = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 为什么使用空文本节点？
    // 1、轻量级	文本节点开销最小
    // 2、不可见	空文本不影响渲染结果
    // 3、稳定	不会被 CSS 选择器意外选中
    // 4、兼容性	所有浏览器都支持
    // Fragment 本身不是真实 DOM 节点，需要用两个空文本节点作为标记
    const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''))!
    const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''))!

    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2

    // 开发环境下 HMR 或根 Fragment 更新时，禁用优化，执行全量 diff。
    if (
      __DEV__ &&
      // #5523 dev root fragment may inherit directives
      (isHmrUpdating || patchFlag & PatchFlags.DEV_ROOT_FRAGMENT)
    ) {
      // HMR updated / Dev root fragment (w/ comments), force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // check if this is a slot fragment with :slotted scope ids
    // 合并父级和当前 Fragment 的 slot scope IDs，用于样式隔离
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds
        ? slotScopeIds.concat(fragmentSlotScopeIds)
        : fragmentSlotScopeIds
    }

    if (n1 == null) {
      // 插入开始锚点和结束锚点
      hostInsert(fragmentStartAnchor, container, anchor)
      hostInsert(fragmentEndAnchor, container, anchor)
      // 在两个锚点之间挂载所有子 VNode
      mountChildren(
        // #10007
        // such fragment like `<></>` will be compiled into
        // a fragment which doesn't have a children.
        // In this case fallback to an empty array
        (n2.children || []) as VNodeArrayChildren,
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    } else {
      // 路径 1：稳定 Fragment 优化
      if (
        patchFlag > 0 &&
        patchFlag & PatchFlags.STABLE_FRAGMENT && // 编译时标记为稳定
        dynamicChildren && // 有动态子节点
        // 新旧动态子节点数量相同
        n1.dynamicChildren &&
        n1.dynamicChildren.length === dynamicChildren.length
      ) {
        // a stable fragment (template root or <template v-for>) doesn't need to
        // patch children order, but it may contain dynamicChildren.
        patchBlockChildren(
          n1.dynamicChildren, // 旧动态子节点
          dynamicChildren, // 新动态子节点
          container,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
        )
        if (__DEV__) {
          // necessary for HMR
          traverseStaticChildren(n1, n2)
        } else if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          n2.key != null ||
          (parentComponent && n2 === parentComponent.subTree)
        ) {
          traverseStaticChildren(n1, n2, true /* shallow */)
        }
      } else {
        //  路径 2：普通 Fragment 更新
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      }
    }
  }

  /**
   * 处理组件节点
   * @param n1 旧节点
   * @param n2 新节点
   * @param container 渲染目标容器
   * @param anchor 锚点节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 数组
   * @param optimized 是否开启优化模式
   */
  const processComponent = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    // 将父组件的 slot scope IDs 传递给子组件，用于支持 scoped CSS 的样式隔离
    n2.slotScopeIds = slotScopeIds
    if (n1 == null) {
      // KeepAlive 组件：复用缓存实例
      if (n2.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) {
        ;(parentComponent!.ctx as KeepAliveContext).activate(
          n2,
          container,
          anchor,
          namespace,
          optimized,
        )
      } else {
        // 普通组件：创建新实例并挂载
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          optimized,
        )
      }
    } else {
      updateComponent(n1, n2, optimized)
    }
  }

  /**
   * Vue 3 组件挂载的核心函数，负责将组件 VNode 挂载到 DOM 容器中
   * 协调组件实例创建、初始化、渲染和 DOM 插入的完整流程
   * @param initialVNode 初始虚拟节点
   * @param container 渲染目标容器
   * @param anchor 锚点节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param optimized 是否开启优化模式
   */
  const mountComponent: MountComponentFn = (
    initialVNode,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    optimized,
  ) => {
    // 2.x compat may pre-create the component instance before actually
    // mounting
    // 兼容模式：2.x 兼容模式下可能已预创建实例
    const compatMountInstance =
      __COMPAT__ && initialVNode.isCompatRoot && initialVNode.component

    const instance: ComponentInternalInstance =
      compatMountInstance ||
      // 创建新实例
      (initialVNode.component = createComponentInstance(
        initialVNode,
        parentComponent,
        parentSuspense,
      ))

    // 开发环境下，如果组件有 HMR ID（热更新标识），则注册到 HMR 系统，支持热模块替换
    if (__DEV__ && instance.type.__hmrId) {
      registerHMR(instance)
    }

    if (__DEV__) {
      pushWarningContext(initialVNode)
      startMeasure(instance, `mount`) // 开始性能测量
    }

    // inject renderer internals for keepAlive
    // 为 KeepAlive 组件注入渲染器内部方法，使其能够管理缓存组件的挂载和卸载
    if (isKeepAlive(initialVNode)) {
      ;(instance.ctx as KeepAliveContext).renderer = internals
    }

    // resolve props and slots for setup context
    if (!(__COMPAT__ && compatMountInstance)) {
      if (__DEV__) {
        startMeasure(instance, `init`)
      }
      // 初始化组件实例
      setupComponent(instance, false /** 非SSR模式 */, optimized)
      if (__DEV__) {
        endMeasure(instance, `init`)
      }
    }

    // avoid hydration for hmr updating
    // HMR 更新时，清空已存在的 DOM 引用，避免 hydration 错误
    if (__DEV__ && isHmrUpdating) initialVNode.el = null

    // setup() is async. This component relies on async logic to be resolved
    // before proceeding
    // 注册依赖：将组件注册到父级 Suspense，等待异步依赖解析
    if (__FEATURE_SUSPENSE__ && instance.asyncDep) {
      parentSuspense &&
        parentSuspense.registerDep(instance, setupRenderEffect, optimized)

      // Give it a placeholder if this is not hydration
      // TODO handle self-defined fallback
      // 创建占位符：插入注释节点作为占位符，异步完成后替换
      if (!initialVNode.el) {
        const placeholder = (instance.subTree = createVNode(Comment))
        processCommentNode(null, placeholder, container!, anchor)
        initialVNode.placeholder = placeholder.el
      }
    } else {
      // 同步组件：直接设置渲染 effect
      setupRenderEffect(
        instance,
        initialVNode,
        container,
        anchor,
        parentSuspense,
        namespace,
        optimized,
      )
    }

    if (__DEV__) {
      popWarningContext()
      endMeasure(instance, `mount`)
    }
  }

  /**
   * 处理组件更新
   * @param n1 旧节点
   * @param n2 新节点
   * @param optimized 是否开启优化模式
   * @returns
   */
  const updateComponent = (n1: VNode, n2: VNode, optimized: boolean) => {
    // 复用组件实例
    const instance = (n2.component = n1.component)!

    // 判断是否需要更新
    if (shouldUpdateComponent(n1, n2, optimized)) {
      // 异步组件等待中
      if (
        __FEATURE_SUSPENSE__ &&
        instance.asyncDep &&
        !instance.asyncResolved
      ) {
        // 异步组件仍在等待中
        // async & still pending - just update props and slots
        // since the component's reactive effect for render isn't set-up yet
        if (__DEV__) {
          pushWarningContext(n2)
        }
        // 此时组件的响应式 effect 尚未设置，只能更新 props 和 slots
        updateComponentPreRender(instance, n2, optimized)
        if (__DEV__) {
          popWarningContext()
        }
        return
      } else {
        // normal update
        instance.next = n2
        // instance.update is the reactive effect.
        // instance.update 是响应式 effect
        instance.update()
      }
    } else {
      // no update needed. just copy over properties
      // 只需更新 VNode 引用，无需触发重新渲染
      n2.el = n1.el
      instance.vnode = n2
    }
  }

  /**
   * 负责为组件实例创建并运行渲染副作用（effect）
   * @param instance 组件实例
   * @param initialVNode 初始虚拟节点
   * @param container 渲染目标容器
   * @param anchor 锚点节点
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param optimized 是否开启优化模式
   */
  const setupRenderEffect: SetupRenderEffectFn = (
    instance,
    initialVNode,
    container,
    anchor,
    parentSuspense,
    namespace: ElementNamespace,
    optimized,
  ) => {
    const componentUpdateFn = () => {
      // 组件首次挂载逻辑
      if (!instance.isMounted) {
        let vnodeHook: VNodeHook | null | undefined
        const { el, props } = initialVNode
        const { bm, m, parent, root, type } = instance
        // 检查是否为异步包装 VNode
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode)

        toggleRecurse(instance, false) // 暂时关闭递归更新
        // beforeMount hook
        if (bm) {
          // 执行 beforeMount 钩子
          invokeArrayFns(bm)
        }
        // onVnodeBeforeMount
        // 执行 onVnodeBeforeMount 钩子
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeBeforeMount)
        ) {
          invokeVNodeHook(vnodeHook, parent, initialVNode)
        }

        // 在兼容模式下触发 hook:beforeMount 事件
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeMount')
        }

        // 重新开启递归更新
        toggleRecurse(instance, true)

        if (el && hydrateNode) {
          // vnode has adopted host node - perform hydration instead of mount.
          const hydrateSubTree = () => {
            if (__DEV__) {
              startMeasure(instance, `render`)
            }
            instance.subTree = renderComponentRoot(instance)
            if (__DEV__) {
              endMeasure(instance, `render`)
            }
            if (__DEV__) {
              startMeasure(instance, `hydrate`)
            }
            hydrateNode!(
              el as Node,
              instance.subTree,
              instance,
              parentSuspense,
              null,
            )
            if (__DEV__) {
              endMeasure(instance, `hydrate`)
            }
          }

          if (
            isAsyncWrapperVNode &&
            (type as ComponentOptions).__asyncHydrate
          ) {
            ;(type as ComponentOptions).__asyncHydrate!(
              el as Element,
              instance,
              hydrateSubTree,
            )
          } else {
            hydrateSubTree()
          }
        } else {
          // custom element style injection
          // 处理自定义元素样式注入
          if (root.ce && root.ce._hasShadowRoot()) {
            root.ce._injectChildStyle(type)
          }

          if (__DEV__) {
            startMeasure(instance, `render`)
          }

          // 生成组件根节点的 VNode（子 subTree）
          const subTree = (instance.subTree = renderComponentRoot(instance))
          if (__DEV__) {
            endMeasure(instance, `render`)
          }
          if (__DEV__) {
            startMeasure(instance, `patch`)
          }
          // 执行 patch 操作
          // 将虚拟 DOM 转换为真实 DOM 并插入容器
          patch(
            null, // 旧 DOM 节点（null 表示首次挂载）
            subTree, // 新 DOM 节点（子 subTree）
            container,
            anchor,
            instance,
            parentSuspense,
            namespace,
          )
          if (__DEV__) {
            endMeasure(instance, `patch`)
          }
          initialVNode.el = subTree.el
        }
        // mounted hook
        if (m) {
          // 将 mounted 钩子加入到后渲染队列
          queuePostRenderEffect(m, parentSuspense)
        }
        // onVnodeMounted
        // 将 onVnodeMounted 钩子加入到后渲染队列
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeMounted)
        ) {
          const scopedInitialVNode = initialVNode
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, scopedInitialVNode),
            parentSuspense,
          )
        }
        // 在兼容模式下，将 hook:mounted 事件触发加入到后渲染队列
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:mounted'),
            parentSuspense,
          )
        }

        // activated hook for keep-alive roots.
        // #1742 activated hook must be accessed after first render
        // since the hook may be injected by a child keep-alive
        // 处理 keep-alive 相关逻辑
        if (
          initialVNode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE ||
          (parent &&
            isAsyncWrapper(parent.vnode) &&
            parent.vnode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE)
        ) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense)
          if (
            __COMPAT__ &&
            isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
          ) {
            queuePostRenderEffect(
              () => instance.emit('hook:activated'),
              parentSuspense,
            )
          }
        }
        instance.isMounted = true // 标记组件已挂载
        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentAdded(instance)
        }

        // #2458: deference mount-only object parameters to prevent memleaks
        // 清理挂载时的临时变量，防止内存泄漏
        initialVNode = container = anchor = null as any

        // 组件更新逻辑
      } else {
        let { next, bu, u, parent, vnode } = instance

        // 处理 Suspense 相关的异步组件更新
        if (__FEATURE_SUSPENSE__) {
          const nonHydratedAsyncRoot = locateNonHydratedAsyncRoot(instance)
          // we are trying to update some async comp before hydration
          // this will cause crash because we don't know the root node yet
          if (nonHydratedAsyncRoot) {
            // only sync the properties and abort the rest of operations
            if (next) {
              next.el = vnode.el
              updateComponentPreRender(instance, next, optimized)
            }
            // and continue the rest of operations once the deps are resolved
            nonHydratedAsyncRoot.asyncDep!.then(() => {
              // the instance may be destroyed during the time period
              queuePostRenderEffect(() => {
                if (!instance.isUnmounted) update()
              }, parentSuspense)
            })
            return
          }
        }

        // updateComponent
        // This is triggered by mutation of component's own state (next: null)
        // OR parent calling processComponent (next: VNode)
        let originNext = next
        let vnodeHook: VNodeHook | null | undefined
        if (__DEV__) {
          // 在开发模式下，推送警告上下文
          pushWarningContext(next || instance.vnode)
        }

        // Disallow component effect recursion during pre-lifecycle hooks.
        toggleRecurse(instance, false)

        // 如果有 next VNode，更新其 el 属性并执行预渲染更新
        if (next) {
          next.el = vnode.el
          updateComponentPreRender(instance, next, optimized)
        } else {
          next = vnode
        }

        // beforeUpdate hook
        // 执行 beforeUpdate 钩子
        if (bu) {
          invokeArrayFns(bu)
        }
        // onVnodeBeforeUpdate
        // 执行 onVnodeBeforeUpdate 钩子
        if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
          invokeVNodeHook(vnodeHook, parent, next, vnode)
        }

        // 在兼容模式下，触发 hook:beforeUpdate 事件
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeUpdate')
        }
        toggleRecurse(instance, true)

        // render
        if (__DEV__) {
          startMeasure(instance, `render`)
        }
        // 渲染新的组件树
        const nextTree = renderComponentRoot(instance)
        if (__DEV__) {
          endMeasure(instance, `render`)
        }
        // 保存旧的组件树
        const prevTree = instance.subTree
        // 更新实例的 subTree 属性
        instance.subTree = nextTree

        if (__DEV__) {
          startMeasure(instance, `patch`)
        }

        // 执行 patch 操作，比较新旧组件树并更新 DOM
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          hostParentNode(prevTree.el!)!,
          // anchor may have changed if it's in a fragment
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          namespace,
        )
        if (__DEV__) {
          endMeasure(instance, `patch`)
        }
        // 更新 next VNode 的 el 属性
        next.el = nextTree.el

        // 如果是自触发的更新（originNext === null），处理高阶组件 (HOC) 的情况
        if (originNext === null) {
          // self-triggered update. In case of HOC, update parent component
          // vnode el. HOC is indicated by parent instance's subTree pointing
          // to child component's vnode
          updateHOCHostEl(instance, nextTree.el)
        }
        // updated hook
        // 将 updated 钩子加入到后渲染队列
        if (u) {
          queuePostRenderEffect(u, parentSuspense)
        }
        // onVnodeUpdated
        // 将 onVnodeUpdated 钩子加入到后渲染队列
        if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, next!, vnode),
            parentSuspense,
          )
        }
        // 在兼容模式下，将 hook:updated 事件触发加入到后渲染队列
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:updated'),
            parentSuspense,
          )
        }

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentUpdated(instance)
        }

        if (__DEV__) {
          popWarningContext()
        }
      }
    }

    // create reactive effect for rendering
    // 激活组件的 effect 作用域
    instance.scope.on()
    // 创建一个新的响应式 effect，关联组件的更新函数
    const effect = (instance.effect = new ReactiveEffect(componentUpdateFn))
    // 关闭组件的 effect 作用域
    instance.scope.off()

    const update = (instance.update = effect.run.bind(effect))

    // 创建一个调度函数，用于在组件的 effect 变化时触发更新
    const job: SchedulerJob = (instance.job = effect.runIfDirty.bind(effect))
    job.i = instance
    job.id = instance.uid
    // 调度器：将更新任务放入异步队列
    effect.scheduler = () => queueJob(job)

    // allowRecurse
    // #1801, #2043 component render effects should allow recursive updates
    toggleRecurse(instance, true)

    if (__DEV__) {
      effect.onTrack = instance.rtc
        ? e => invokeArrayFns(instance.rtc!, e)
        : void 0
      effect.onTrigger = instance.rtg
        ? e => invokeArrayFns(instance.rtg!, e)
        : void 0
    }

    // 首次执行，进入首次挂载分支
    update()
  }

  /**
   * 组件渲染前准备
   * 负责在组件重新渲染前更新 props 和 slots，并处理预刷新回调
   * @param instance 组件实例
   * @param nextVNode 新节点
   * @param optimized 是否开启优化模式
   */
  const updateComponentPreRender = (
    instance: ComponentInternalInstance,
    nextVNode: VNode,
    optimized: boolean,
  ) => {
    nextVNode.component = instance
    const prevProps = instance.vnode.props // 保存旧 props
    instance.vnode = nextVNode // 更新 vnode
    instance.next = null // 清空 next

    updateProps(instance, nextVNode.props, prevProps, optimized)
    updateSlots(instance, nextVNode.children, optimized)

    pauseTracking()
    // props update may have triggered pre-flush watchers.
    // flush them before the render update.
    // 在渲染更新前刷新它们
    flushPreFlushCbs(instance)
    resetTracking()
  }

  /**
   * 处理子节点更新
   * @param n1 旧子节点，可能是 undefined、null、字符串或数组
   * @param n2 新节点
   * @param container 渲染目标容器
   * @param anchor 锚点节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param optimized 是否开启优化模式
   * @returns
   */
  const patchChildren: PatchChildrenFn = (
    n1,
    n2,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    namespace: ElementNamespace,
    slotScopeIds,
    optimized = false,
  ) => {
    const c1 = n1 && n1.children
    const prevShapeFlag = n1 ? n1.shapeFlag : 0 // 描述子节点类型（文本/数组/空）
    const c2 = n2.children

    const { patchFlag, shapeFlag } = n2
    // fast path
    if (patchFlag > 0) {
      // KEYED_FRAGMENT（带 key 的子节点）
      if (patchFlag & PatchFlags.KEYED_FRAGMENT) {
        // this could be either fully-keyed or mixed (some keyed some not)
        // presence of patchFlag means children are guaranteed to be arrays
        // 双端 diff 算法：对于带 key 的子节点，使用高效的双端比较算法
        // 最少 DOM 操作：最小化节点的移动、删除、插入操作
        patchKeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        return

        // UNKEYED_FRAGMENT（无 key 的子节点）
        // 顺序比较：无 key 子节点按顺序逐一比较
        // 简单直接：不涉及复杂的 key 查找和节点移动
      } else if (patchFlag & PatchFlags.UNKEYED_FRAGMENT) {
        // unkeyed
        patchUnkeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
        return
      }
    }

    // children has 3 possibilities: text, array or no children.
    // 文本子节点快速路径
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // text children fast path
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        unmountChildren(c1 as VNode[], parentComponent, parentSuspense)
      }
      if (c2 !== c1) {
        hostSetElementText(container, c2 as string)
      }
    } else {
      // 数组子节点处理
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // prev children was array
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // two arrays, cannot assume anything, do full diff
          // 两个都是数组 → 完整 diff
          patchKeyedChildren(
            c1 as VNode[],
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else {
          // no new children, just unmount old
          // 旧是数组，新不是数组（比如新是文本或空）→ 卸载所有旧子节点
          unmountChildren(c1 as VNode[], parentComponent, parentSuspense, true)
        }
      } else {
        // prev children was text OR null
        // new children is array OR null
        // 旧子节点是文本或空，新子节点是数组
        if (prevShapeFlag & ShapeFlags.TEXT_CHILDREN) {
          // 如果旧子节点是文本，先清空容器内的文本内容
          hostSetElementText(container, '')
        }
        // mount new if array
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // 如果新子节点是数组，递归挂载所有子节点
          mountChildren(
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        }
      }
    }
  }

  /**
   * 处理无 key 子节点更新
   * 使用原因？1、编译器知道子节点没有 key，无法使用高效的双端 diff
   * 2、采用简单的顺序匹配策略，避免复杂的 key 查找
   * @param c1 旧节点数组
   * @param c2 新节点数组
   * @param container 渲染目标容器
   * @param anchor 锚点节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param optimized 是否开启优化模式
   */
  const patchUnkeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    c1 = c1 || EMPTY_ARR
    c2 = c2 || EMPTY_ARR
    const oldLength = c1.length
    const newLength = c2.length
    const commonLength = Math.min(oldLength, newLength)
    let i
    for (i = 0; i < commonLength; i++) {
      // 规范化新节点
      const nextChild = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
      )
    }
    if (oldLength > newLength) {
      // remove old
      // 移除多余的旧节点
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true /** 是否移除旧节点 */,
        false /** 是否优化模式 */,
        commonLength /** 开始移除的索引 */,
      )
    } else {
      // mount new
      // 挂载新增的节点
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
        commonLength /** 开始挂载的索引 */,
      )
    }
  }

  /**
   * 带 key 的子节点列表更新
   * 采用双端预处理 + 中间乱序部分最长递增子序列的策略
   * @param c1 旧节点数组
   * @param c2 新节点数组
   * @param container 渲染目标容器
   * @param parentAnchor 父锚点节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param namespace 元素命名空间
   * @param slotScopeIds 插槽作用域 ID 列表
   * @param optimized 是否开启优化模式
   */
  // can be all-keyed or mixed
  const patchKeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    parentAnchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    namespace: ElementNamespace,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => {
    let i = 0 // 从头部开始同步
    const l2 = c2.length
    let e1 = c1.length - 1 // prev ending index
    let e2 = l2 - 1 // next ending index

    // 1. sync from start
    // 步骤 1：从头部开始同步（sync from start）
    // (a b) c
    // (a b) d e
    while (i <= e1 && i <= e2) {
      const n1 = c1[i]
      const n2 = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))

      // 只要新旧节点类型相同（type + key 相同），就进行 patch
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      } else {
        // 一旦遇到不同的节点，立即停止头部同步
        break
      }
      i++
    }

    // 2. sync from end
    // 步骤 2：从尾部开始同步（sync from end）
    // a (b c)
    // d e (b c)
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1]
      const n2 = (c2[e2] = optimized
        ? cloneIfMounted(c2[e2] as VNode)
        : normalizeVNode(c2[e2]))
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized,
        )
      } else {
        break
      }
      e1--
      e2--
    }

    // 3. common sequence + mount
    // 步骤 3：挂载剩余新节点（common sequence + mount）
    // (a b)
    // (a b) c
    // i = 2, e1 = 1, e2 = 2
    // (a b)
    // c (a b)
    // i = 0, e1 = -1, e2 = 0
    // 条件 i > e1 表示旧子节点已经全部处理完（旧列表已空）
    if (i > e1) {
      // 如果此时新列表还有剩余节点（i <= e2），说明它们是新增节点，需要挂载。
      if (i <= e2) {
        const nextPos = e2 + 1
        const anchor = nextPos < l2 ? (c2[nextPos] as VNode).el : parentAnchor
        while (i <= e2) {
          patch(
            null,
            (c2[i] = optimized
              ? cloneIfMounted(c2[i] as VNode)
              : normalizeVNode(c2[i])),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
          i++
        }
      }
    }

    // 4. common sequence + unmount
    // 步骤 4：卸载多余旧节点（common sequence + unmount）
    // (a b) c
    // (a b)
    // i = 2, e1 = 2, e2 = 1
    // a (b c)
    // (b c)
    // i = 0, e1 = 0, e2 = -1
    else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true)
        i++
      }
    }

    // 5. unknown sequence
    // 步骤 5：处理未知顺序的中间部分（unknown sequence）
    // [i ... e1 + 1]: a b [c d e] f g
    // [i ... e2 + 1]: a b [e d c h] f g
    // i = 2, e1 = 4, e2 = 5
    else {
      const s1 = i // prev starting index
      const s2 = i // next starting index

      // 5.1 build key:index map for newChildren
      // 构建新子节点的 key → index 映射
      const keyToNewIndexMap: Map<PropertyKey, number> = new Map()
      for (i = s2; i <= e2; i++) {
        // 遍历新列表中间部分
        const nextChild = (c2[i] = optimized
          ? cloneIfMounted(c2[i] as VNode)
          : normalizeVNode(c2[i]))
        if (nextChild.key != null) {
          if (__DEV__ && keyToNewIndexMap.has(nextChild.key)) {
            warn(
              `Duplicate keys found during update:`,
              JSON.stringify(nextChild.key),
              `Make sure keys are unique.`,
            )
          }
          // 记录新节点的 key → index 映射
          keyToNewIndexMap.set(nextChild.key, i)
        }
      }

      // 5.2 loop through old children left to be patched and try to patch
      // matching nodes & remove nodes that are no longer present
      // 遍历旧列表中间部分，尝试 patch 匹配节点
      let j
      let patched = 0 // 统计已匹配并更新的节点数
      const toBePatched = e2 - s2 + 1 // 新列表中间部分的节点数量
      let moved = false
      // used to track whether any node has moved
      let maxNewIndexSoFar = 0 // 记录遍历旧节点过程中遇到的最大新索引

      const newIndexToOldIndexMap = new Array(toBePatched)
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0 // 0 表示新节点没有对应的旧节点

      for (i = s1; i <= e1; i++) {
        // 遍历旧列表中间部分
        const prevChild = c1[i]

        if (patched >= toBePatched) {
          // 说明所有新节点都已匹配完成，剩余的旧节点都是多余的，直接卸载
          // all new children have been patched so this can only be a removal
          unmount(prevChild, parentComponent, parentSuspense, true)
          continue
        }
        let newIndex // 当前元素在 完整新列表中的索引

        // 有 key 节点：哈希表快速查找
        if (prevChild.key != null) {
          newIndex = keyToNewIndexMap.get(prevChild.key)
        } else {
          // 无 key 节点：遍历查找同类型节点
          // key-less node, try to locate a key-less node of the same type
          for (j = s2; j <= e2; j++) {
            if (
              newIndexToOldIndexMap[j - s2] === 0 && // 新节点尚未被其他旧节点匹配
              isSameVNodeType(prevChild, c2[j] as VNode) // 新旧节点类型相同
            ) {
              newIndex = j
              break
            }
          }
        }
        if (newIndex === undefined) {
          // 找不到匹配的新节点，卸载旧节点
          unmount(prevChild, parentComponent, parentSuspense, true)
        } else {
          //  newIndex - s2 当前旧节点在新数组中的索引
          newIndexToOldIndexMap[newIndex - s2] = i + 1 // +1 表示旧节点的索引从 1 开始
          if (newIndex >= maxNewIndexSoFar) {
            maxNewIndexSoFar = newIndex
          } else {
            moved = true
          }
          // patch 更新节点内容
          patch(
            prevChild,
            c2[newIndex] as VNode,
            container,
            null,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
          patched++
        }
      }

      // 5.3 move and mount
      // generate longest stable subsequence only when nodes have moved
      // 移动 & 挂载剩余节点（最长递增子序列优化）
      const increasingNewIndexSequence = moved
        ? // getSequence 计算最长稳定子序列
          getSequence(newIndexToOldIndexMap)
        : EMPTY_ARR
      j = increasingNewIndexSequence.length - 1
      // looping backwards so that we can use last patched node as anchor
      // 倒序
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i
        const nextChild = c2[nextIndex] as VNode
        const anchorVNode = c2[nextIndex + 1] as VNode
        const anchor =
          nextIndex + 1 < l2
            ? // 1、优先使用真实 DOM 元素 2、回退到占位符
              anchorVNode.el || resolveAsyncComponentPlaceholder(anchorVNode)
            : parentAnchor // 父容器的锚点

        if (newIndexToOldIndexMap[i] === 0) {
          // mount new
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
          )
        } else if (moved) {
          // move if:
          // There is no stable subsequence (e.g. a reverse)
          // OR current node is not among the stable sequence
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            // 移动节点到新位置
            move(
              nextChild,
              container,
              anchor /** 插入位置的锚点节点 */,
              MoveType.REORDER /** 移动类型：REORDER */,
            )
          } else {
            j--
          }
        }
      }
    }
  }

  /**
   * Vue 渲染器（Renderer）中处理 VNode 节点「移动 / 插入」的核心方法，
   * 负责将不同类型的 VNode（组件、Fragment、Teleport、普通元素等）挂载到指定 DOM 容器中，
   * 也是 KeepAlive 组件激活时「复用 DOM」的底层依赖
   * @param vnode 要移动的目标 VNode
   * @param container 目标父容器（DOM 元素）
   * @param anchor 插入位置的锚点节点（DOM 元素，insertBefore 的第二个参数）
   * @param moveType 移动类型（ENTER/REORDER 等，区分「首次插入」和「重新排序」）
   * @param parentSuspense 关联的 Suspense 实例（异步组件 / 懒加载场景）
   * @returns
   */
  const move: MoveFn = (
    vnode,
    container,
    anchor,
    moveType,
    parentSuspense = null,
  ) => {
    const { el, type, transition, children, shapeFlag } = vnode

    // 组件 VNode 处理（ShapeFlags.COMPONENT）
    if (shapeFlag & ShapeFlags.COMPONENT) {
      // 递归调用 move 处理组件的 subTree（组件渲染的真实内容 VNode）
      move(vnode.component!.subTree, container, anchor, moveType)
      return
    }

    //  Suspense VNode 处理（ShapeFlags.SUSPENSE）
    if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
      // Suspense 是特殊的内置组件，有自己的 move 方法，直接调用其内部实现
      vnode.suspense!.move(container, anchor, moveType)
      return
    }

    //  Teleport VNode 处理（ShapeFlags.TELEPORT）
    if (shapeFlag & ShapeFlags.TELEPORT) {
      // Teleport（传送门）组件的 DOM 会被挂载到指定目标容器（如 body），
      // 因此调用 Teleport 内置的 move 方法，处理跨容器的 DOM 移动
      ;(type as typeof TeleportImpl).move(vnode, container, anchor, internals)
      return
    }

    //  Fragment VNode 处理（type === Fragment）
    if (type === Fragment) {
      hostInsert(el!, container, anchor) // 插入 Fragment 的占位注释节点
      for (let i = 0; i < (children as VNode[]).length; i++) {
        // 递归处理子节点
        move((children as VNode[])[i], container, anchor, moveType)
      }
      hostInsert(vnode.anchor!, container, anchor) // 插入 Fragment 的结束注释节点
      return
    }

    // 静态节点处理（type === Static）
    // 静态节点移动时无需重新渲染，直接复用原有 DOM
    if (type === Static) {
      moveStaticNode(vnode, container, anchor)
      return
    }

    // 普通元素 VNode 处理（核心 DOM 操作）
    // single nodes
    // 判断是否需要过渡动画
    const needTransition =
      moveType !== MoveType.REORDER &&
      shapeFlag & ShapeFlags.ELEMENT &&
      transition

    if (needTransition) {
      // 首次插入：执行 beforeEnter → 插入 DOM → 执行 enter
      if (moveType === MoveType.ENTER) {
        transition!.beforeEnter(el!)
        hostInsert(el!, container, anchor)
        queuePostRenderEffect(() => transition!.enter(el!), parentSuspense)
      } else {
        // 移动/重新插入：先执行 leave 动画 → 动画结束后插入 DOM
        const { leave, delayLeave, afterLeave } = transition!
        const remove = () => {
          if (vnode.ctx!.isUnmounted) {
            hostRemove(el!)
          } else {
            hostInsert(el!, container, anchor)
          }
        }
        const performLeave = () => {
          // #13153 move kept-alive node before v-show transition leave finishes
          // it needs to call the leaving callback to ensure element's `display`
          // is `none`
          if (el!._isLeaving) {
            el![leaveCbKey](true /* cancelled */)
          }
          leave(el!, () => {
            remove()
            afterLeave && afterLeave()
          })
        }
        if (delayLeave) {
          delayLeave(el!, remove, performLeave)
        } else {
          performLeave()
        }
      }
    } else {
      /**
       * 无过渡动画时，直接插入
       */
      hostInsert(el!, container, anchor)
    }
  }

  /**
   * 处理 VNode 从「组件实例销毁、DOM 移除、指令钩子执行、缓存清理」的全生命周期卸载
   * @param vnode 要卸载的 VNode
   * @param parentComponent 父组件实例
   * @param parentSuspense 关联的 Suspense 实例（异步组件 / 懒加载场景）
   * @param doRemove 是否直接从 DOM 中移除节点（默认 false）
   * @param optimized 是否开启优化模式（默认 false）
   * @returns
   */
  const unmount: UnmountFn = (
    vnode,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false,
  ) => {
    const {
      type,
      props,
      ref,
      children,
      dynamicChildren,
      shapeFlag, // 核心类型标记，用于区分 VNode 是「组件」「元素」「Suspense」等
      patchFlag, // 优化标记，BAIL 表示当前 VNode 无法优化，需走全量卸载逻辑
      dirs,
      cacheIndex,
    } = vnode

    // 若 patchFlag 为 BAIL（退出优化），则关闭优化模式
    if (patchFlag === PatchFlags.BAIL) {
      optimized = false
    }

    // 清理 Ref 引用（避免内存泄漏）
    // unset ref
    if (ref != null) {
      pauseTracking() // 暂停响应式追踪（避免触发不必要的依赖更新）
      setRef(ref, null, parentSuspense, vnode, true) // 将 ref 置为 null
      resetTracking() // 恢复响应式追踪
    }

    // 清理 memo 缓存，确保下次渲染时重新计算
    // #6593 should clean memo cache when unmount
    if (cacheIndex != null) {
      parentComponent!.renderCache[cacheIndex] = undefined
    }

    // KeepAlive 组件特殊处理（核心分支）
    if (shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
      // 调用 deactivate 方法：仅失活组件（保留 DOM / 实例，移到隐藏容器），而非彻底卸载
      ;(parentComponent!.ctx as KeepAliveContext).deactivate(vnode)
      // return 跳过「组件卸载、DOM 移除」，这是 KeepAlive 缓存的核心！
      return
    }

    const shouldInvokeDirs = shapeFlag & ShapeFlags.ELEMENT && dirs
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode) // 是否 非异步包装组件

    // 在卸载前执行 onVnodeBeforeUnmount 钩子
    let vnodeHook: VNodeHook | undefined | null
    if (
      shouldInvokeVnodeHook &&
      (vnodeHook = props && props.onVnodeBeforeUnmount)
    ) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode)
    }

    // 分类型卸载 VNode（核心分支）
    // 1、组件类型 VNode（普通组件，非 KeepAlive）
    if (shapeFlag & ShapeFlags.COMPONENT) {
      // 调用 unmountComponent 卸载组件实例
      unmountComponent(vnode.component!, parentSuspense, doRemove)

      // 2、非组件类型 VNode
    } else {
      // 2-1 Suspense 类型
      if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
        vnode.suspense!.unmount(parentSuspense, doRemove)
        return
      }

      // 2-2 元素类型 + 有指令：执行指令 beforeUnmount 钩子
      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount')
      }

      // 2-3 Teleport 类型：调用 Teleport 专属 remove 方法
      if (shapeFlag & ShapeFlags.TELEPORT) {
        ;(vnode.type as typeof TeleportImpl).remove(
          vnode,
          parentComponent,
          parentSuspense,
          internals,
          doRemove,
        )

        // 优化模式下的 Block 节点：仅卸载动态子节点（性能优化）
      } else if (
        dynamicChildren &&
        !dynamicChildren.hasOnce &&
        (type !== Fragment ||
          (patchFlag > 0 && patchFlag & PatchFlags.STABLE_FRAGMENT))
      ) {
        // fast path for block nodes: only need to unmount dynamic children.
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true,
        )

        // 2-4 Fragment/数组子节点：全量卸载子节点
      } else if (
        (type === Fragment &&
          patchFlag &
            (PatchFlags.KEYED_FRAGMENT | PatchFlags.UNKEYED_FRAGMENT)) ||
        (!optimized && shapeFlag & ShapeFlags.ARRAY_CHILDREN)
      ) {
        unmountChildren(children as VNode[], parentComponent, parentSuspense)
      }

      // 彻底移除 DOM 节点
      if (doRemove) {
        remove(vnode)
      }
    }

    // 执行后置卸载钩子（异步队列）
    if (
      (shouldInvokeVnodeHook &&
        (vnodeHook = props && props.onVnodeUnmounted)) ||
      shouldInvokeDirs
    ) {
      // 将 onVnodeUnmounted 和指令 unmounted 钩子放入后置队列，确保在 DOM 移除后执行
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        shouldInvokeDirs &&
          invokeDirectiveHook(vnode, null, parentComponent, 'unmounted')
      }, parentSuspense)
    }
  }

  /**
   * Vue3 渲染器 负责移除 VNode 对应真实 DOM 节点
   * @param vnode
   * @returns
   */
  const remove: RemoveFn = vnode => {
    const { type, el, anchor, transition } = vnode

    // 处理 Fragment 类型 VNode（无单个根 DOM，需移除所有子节点）
    if (type === Fragment) {
      // 开发环境 - 根 Fragment + 过渡动画（特殊处理注释节点）
      if (
        __DEV__ &&
        vnode.patchFlag > 0 &&
        vnode.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT &&
        transition &&
        !transition.persisted
      ) {
        ;(vnode.children as VNode[]).forEach(child => {
          if (child.type === Comment) {
            hostRemove(child.el!) // 移除注释节点（Vue 内部占位用）
          } else {
            remove(child) // 递归移除子 VNode 的 DOM
          }
        })
      } else {
        removeFragment(el!, anchor!)
      }
      return // 终止后续逻辑
    }

    // 处理静态节点（特殊处理）
    if (type === Static) {
      removeStaticNode(vnode)
      return
    }

    const performRemove = () => {
      hostRemove(el!)
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave()
      }
    }

    // 处理元素类型 VNode 过渡动画（特殊处理）
    if (
      vnode.shapeFlag & ShapeFlags.ELEMENT &&
      transition &&
      !transition.persisted
    ) {
      const { leave, delayLeave } = transition
      const performLeave = () => leave(el!, performRemove)
      if (delayLeave) {
        delayLeave(vnode.el!, performRemove, performLeave)
      } else {
        performLeave()
      }
    } else {
      performRemove()
    }
  }

  /**
   *
   * @param cur 当前节点
   * @param end 结束节点
   */
  const removeFragment = (cur: RendererNode, end: RendererNode) => {
    // For fragments, directly remove all contained DOM nodes.
    // (fragment child nodes cannot have transition)
    let next
    while (cur !== end) {
      next = hostNextSibling(cur)!
      hostRemove(cur)
      cur = next
    }
    hostRemove(end)
  }

  /**
   * Vue3 渲染器 负责销毁组件实例
   * 「按生命周期执行组件卸载钩子、清理组件作用域副作用、终止调度任务、递归卸载组件子树」，
   *  是普通组件（非 KeepAlive）卸载的最终执行者。
   * @param instance 组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param doRemove 是否执行 DOM 移除操作
   */
  const unmountComponent = (
    instance: ComponentInternalInstance,
    parentSuspense: SuspenseBoundary | null,
    doRemove?: boolean,
  ) => {
    // 开发环境 - 移除 HMR（热更新）注册（避免热更新异常）
    if (__DEV__ && instance.type.__hmrId) {
      unregisterHMR(instance)
    }

    // 解构组件实例的核心属性，清理挂载相关标记
    const { bum, scope, job, subTree, um, m, a } = instance
    invalidateMount(m) // 失效挂载（mount）相关标记
    invalidateMount(a) // 失效激活（activate）相关标记

    // beforeUnmount hook
    // 同步执行 beforeUnmount 钩子（组件卸载前）
    if (bum) {
      invokeArrayFns(bum)
    }

    // 兼容 Vue2 生命周期（hook:beforeDestroy）
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      instance.emit('hook:beforeDestroy')
    }

    // 停止组件作用域的所有响应式副作用（核心！）
    // stop effects in component scope
    scope.stop()

    // 终止组件的调度任务，递归卸载子树
    // job may be null if a component is unmounted before its async
    // setup has resolved.
    if (job) {
      // so that scheduler will no longer invoke it
      // 标记任务为已销毁，调度器不再执行
      job.flags! |= SchedulerJobFlags.DISPOSED
      // 递归卸载组件的根子树（subTree 是组件渲染的真实内容）
      unmount(subTree, instance, parentSuspense, doRemove)
    }
    // 异步执行 unmounted 钩子（组件卸载后）
    // unmounted hook
    if (um) {
      queuePostRenderEffect(um, parentSuspense) // 加入后置渲染队列
    }

    // 兼容 Vue2 生命周期（hook:destroyed）
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      queuePostRenderEffect(
        () => instance.emit('hook:destroyed'),
        parentSuspense,
      )
    }

    // 标记组件为已卸载（安全保障）
    queuePostRenderEffect(() => {
      instance.isUnmounted = true
    }, parentSuspense)

    // 开发环境/调试工具 - 通知组件已移除
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      devtoolsComponentRemoved(instance)
    }
  }

  /**
   * 批量卸载子节点
   * @param children 子节点数组
   * @param parentComponent 父组件实例
   * @param parentSuspense 父级 Suspense 边界
   * @param doRemove 是否执行 DOM 移除操作
   * @param optimized 是否开启优化模式
   * @param start 起始索引
   */
  const unmountChildren: UnmountChildrenFn = (
    children,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false,
    start = 0,
  ) => {
    for (let i = start; i < children.length; i++) {
      // 卸载子节点
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized)
    }
  }

  /**
   *
   * @param vnode 当前节点
   * @returns 下一个节点
   */
  const getNextHostNode: NextFn = vnode => {
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      return getNextHostNode(vnode.component!.subTree)
    }
    if (__FEATURE_SUSPENSE__ && vnode.shapeFlag & ShapeFlags.SUSPENSE) {
      return vnode.suspense!.next()
    }
    const el = hostNextSibling((vnode.anchor || vnode.el)!)
    // #9071, #9313
    // teleported content can mess up nextSibling searches during patch so
    // we need to skip them during nextSibling search
    const teleportEnd = el && el[TeleportEndKey]
    return teleportEnd ? hostNextSibling(teleportEnd) : el
  }

  let isFlushing = false

  /**
   *
   * @param vnode 要渲染的虚拟节点
   * @param container 渲染目标容器
   * @param namespace 元素命名空间
   */
  const render: RootRenderFunction = (vnode, container, namespace) => {
    let instance
    if (vnode == null) {
      if (container._vnode) {
        unmount(container._vnode, null, null, true)
        instance = container._vnode.component
      }
    } else {
      patch(
        container._vnode || null, // 旧的虚拟节点（如果存在）
        vnode, // 新的虚拟节点
        container, // 渲染目标容器
        null, // 元素命名空间
        null, // 子节点
        null, // 元素命名空间
        namespace,
      )
    }
    container._vnode = vnode
    if (!isFlushing) {
      isFlushing = true
      flushPreFlushCbs(instance)
      flushPostFlushCbs()
      isFlushing = false
    }
  }

  const internals: RendererInternals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options,
  }

  let hydrate: ReturnType<typeof createHydrationFunctions>[0] | undefined
  let hydrateNode: ReturnType<typeof createHydrationFunctions>[1] | undefined
  if (createHydrationFns) {
    ;[hydrate, hydrateNode] = createHydrationFns(
      internals as RendererInternals<Node, Element>,
    )
  }

  return {
    render,
    hydrate,
    createApp: createAppAPI(render, hydrate),
  }
}

function resolveChildrenNamespace(
  { type, props }: VNode,
  currentNamespace: ElementNamespace,
): ElementNamespace {
  return (currentNamespace === 'svg' && type === 'foreignObject') ||
    (currentNamespace === 'mathml' &&
      type === 'annotation-xml' &&
      props &&
      props.encoding &&
      props.encoding.includes('html'))
    ? undefined
    : currentNamespace
}

function toggleRecurse(
  { effect, job }: ComponentInternalInstance,
  allowed: boolean,
) {
  if (allowed) {
    // 响应式 effect 允许递归
    effect.flags |= EffectFlags.ALLOW_RECURSE
    // 调度器任务允许递归
    job.flags! |= SchedulerJobFlags.ALLOW_RECURSE
  } else {
    effect.flags &= ~EffectFlags.ALLOW_RECURSE
    job.flags! &= ~SchedulerJobFlags.ALLOW_RECURSE
  }
}

export function needTransition(
  parentSuspense: SuspenseBoundary | null,
  transition: TransitionHooks | null,
): boolean | null {
  return (
    (!parentSuspense || (parentSuspense && !parentSuspense.pendingBranch)) &&
    transition &&
    !transition.persisted
  )
}

/**
 * #1156
 * When a component is HMR-enabled, we need to make sure that all static nodes
 * inside a block also inherit the DOM element from the previous tree so that
 * HMR updates (which are full updates) can retrieve the element for patching.
 *
 * #2080
 * Inside keyed `template` fragment static children, if a fragment is moved,
 * the children will always be moved. Therefore, in order to ensure correct move
 * position, el should be inherited from previous nodes.
 */
export function traverseStaticChildren(
  n1: VNode,
  n2: VNode,
  shallow = false,
): void {
  const ch1 = n1.children
  const ch2 = n2.children
  if (isArray(ch1) && isArray(ch2)) {
    for (let i = 0; i < ch1.length; i++) {
      // this is only called in the optimized path so array children are
      // guaranteed to be vnodes
      const c1 = ch1[i] as VNode
      let c2 = ch2[i] as VNode
      if (c2.shapeFlag & ShapeFlags.ELEMENT && !c2.dynamicChildren) {
        if (c2.patchFlag <= 0 || c2.patchFlag === PatchFlags.NEED_HYDRATION) {
          c2 = ch2[i] = cloneIfMounted(ch2[i] as VNode)
          c2.el = c1.el
        }
        if (!shallow && c2.patchFlag !== PatchFlags.BAIL)
          traverseStaticChildren(c1, c2)
      }
      // #6852 also inherit for text nodes
      if (c2.type === Text) {
        // avoid cached text nodes retaining detached dom nodes
        if (c2.patchFlag === PatchFlags.CACHED) {
          c2 = ch2[i] = cloneIfMounted(c2)
        }
        c2.el = c1.el
      }
      // #2324 also inherit for comment nodes, but not placeholders (e.g. v-if which
      // would have received .el during block patch)
      if (c2.type === Comment && !c2.el) {
        c2.el = c1.el
      }

      if (__DEV__) {
        c2.el && (c2.el.__vnode = c2)
      }
    }
  }
}

// https://en.wikipedia.org/wiki/Longest_increasing_subsequence
function getSequence(arr: number[]): number[] {
  const p = arr.slice()
  const result = [0]
  let i, j, u, v, c
  const len = arr.length
  for (i = 0; i < len; i++) {
    const arrI = arr[i]
    if (arrI !== 0) {
      j = result[result.length - 1] // 当前 LIS 的最后一个元素索引
      if (arr[j] < arrI) {
        // 当前元素大于 LIS 最后一个元素，直接加入
        p[i] = j
        result.push(i)
        continue
      }
      // 二分查找：找到第一个大于等于 arrI 的位置
      u = 0
      v = result.length - 1
      while (u < v) {
        c = (u + v) >> 1 // // 等价于 Math.floor((u + v) / 2)
        if (arr[result[c]] < arrI) {
          u = c + 1
        } else {
          v = c
        }
      }
      // 如果找到的位置可以被替换
      if (arrI < arr[result[u]]) {
        if (u > 0) {
          p[i] = result[u - 1]
        }
        result[u] = i
      }
    }
  }
  u = result.length
  v = result[u - 1] // LIS 的最后一个元素索引
  while (u-- > 0) {
    result[u] = v
    v = p[v]
  }
  return result
}

function locateNonHydratedAsyncRoot(
  instance: ComponentInternalInstance,
): ComponentInternalInstance | undefined {
  const subComponent = instance.subTree.component
  if (subComponent) {
    if (subComponent.asyncDep && !subComponent.asyncResolved) {
      return subComponent
    } else {
      return locateNonHydratedAsyncRoot(subComponent)
    }
  }
}

// 无效化挂载钩子，将所有钩子的标志位设置为已销毁或已取消
export function invalidateMount(hooks: LifecycleHook): void {
  if (hooks) {
    for (let i = 0; i < hooks.length; i++)
      hooks[i].flags! |= SchedulerJobFlags.DISPOSED
  }
}

function resolveAsyncComponentPlaceholder(anchorVnode: VNode) {
  if (anchorVnode.placeholder) {
    return anchorVnode.placeholder
  }

  // anchor vnode maybe is a wrapper component has single unresolved async component
  const instance = anchorVnode.component
  if (instance) {
    return resolveAsyncComponentPlaceholder(instance.subTree)
  }

  return null
}
