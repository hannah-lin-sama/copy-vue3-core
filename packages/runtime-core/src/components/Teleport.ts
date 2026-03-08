import type { ComponentInternalInstance } from '../component'
import type { SuspenseBoundary } from './Suspense'
import {
  type ElementNamespace,
  MoveType,
  type RendererElement,
  type RendererInternals,
  type RendererNode,
  type RendererOptions,
  queuePostRenderEffect,
  traverseStaticChildren,
} from '../renderer'
import type { VNode, VNodeArrayChildren, VNodeProps } from '../vnode'
import { ShapeFlags, isString } from '@vue/shared'
import { warn } from '../warning'
import { isHmrUpdating } from '../hmr'

export type TeleportVNode = VNode<RendererNode, RendererElement, TeleportProps>

export interface TeleportProps {
  to: string | RendererElement | null | undefined
  disabled?: boolean
  defer?: boolean
}

export const TeleportEndKey: unique symbol = Symbol('_vte')

export const isTeleport = (type: any): boolean => type.__isTeleport

const isTeleportDisabled = (props: VNode['props']): boolean =>
  props && (props.disabled || props.disabled === '')

const isTeleportDeferred = (props: VNode['props']): boolean =>
  props && (props.defer || props.defer === '')

const isTargetSVG = (target: RendererElement): boolean =>
  typeof SVGElement !== 'undefined' && target instanceof SVGElement

const isTargetMathML = (target: RendererElement): boolean =>
  typeof MathMLElement === 'function' && target instanceof MathMLElement

/**
 *
 * @param props Teleport 组件的属性
 * @param select 渲染器的 querySelector 方法，用于根据选择器查找 DOM 元素
 * @returns 解析后的目标容器元素或 null
 */
const resolveTarget = <T = RendererElement>(
  props: TeleportProps | null,
  select: RendererOptions['querySelector'],
): T | null => {
  // 解析 Teleport 组件的目标容器
  const targetSelector = props && props.to

  if (isString(targetSelector)) {
    if (!select) {
      // 渲染器不支持字符串选择器，开发环境给出警告
      __DEV__ &&
        warn(
          `Current renderer does not support string target for Teleports. ` +
            `(missing querySelector renderer option)`,
        )
      return null
    } else {
      // 使用渲染器的 querySelector 方法查找目标容器元素
      const target = select(targetSelector)
      // 目标容器不存在且未禁用时，开发环境给出警告
      if (__DEV__ && !target && !isTeleportDisabled(props)) {
        warn(
          `Failed to locate Teleport target with selector "${targetSelector}". ` +
            `Note the target element must exist before the component is mounted - ` +
            `i.e. the target cannot be rendered by the component itself, and ` +
            `ideally should be outside of the entire Vue component tree.`,
        )
      }
      return target as T
    }
  } else {
    // 目标容器为 null 或 undefined 时，开发环境给出警告
    if (__DEV__ && !targetSelector && !isTeleportDisabled(props)) {
      warn(`Invalid Teleport target: ${targetSelector}`)
    }
    // 目标容器为 RendererElement 类型时，直接返回
    return targetSelector as T
  }
}

/**
 * Teleport 本质是「DOM 位置分离，逻辑归属不变」：
 * 组件逻辑仍属于当前组件树（props/emit/ 响应式正常）；
 * 渲染的 DOM 节点被移动到指定目标容器（如 body）；
 * 通过「占位锚点」标记 Teleport 在原组件树的位置，保证更新 / 卸载时能定位到内容。
 */
// <Teleport> 组件的核心实现
export const TeleportImpl = {
  name: 'Teleport', // 组件名称，用于调试和日志记录
  __isTeleport: true, // 标识 Teleport 组件，用于渲染器判断
  // 处理 Teleport 组件的挂载/更新逻辑
  process(
    n1: TeleportVNode | null, // 旧 VNode（首次挂载为 null）
    n2: TeleportVNode, // 新 VNode
    container: RendererElement, // 组件挂载的容器（如 body）
    anchor: RendererNode | null, // 占位锚点，用于插入占位节点
    parentComponent: ComponentInternalInstance | null, // 父组件实例，用于事件冒泡和访问父组件状态
    parentSuspense: SuspenseBoundary | null, // 父 Suspense 边界，用于处理异步组件的延迟挂载
    namespace: ElementNamespace, // 元素命名空间
    slotScopeIds: string[] | null, // 插槽作用域 ID，用于传递父组件状态到子组件
    optimized: boolean, // 是否开启优化模式（如静态节点）
    internals: RendererInternals, // 渲染器内部方法，如挂载/更新子节点
  ): void {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment },
    } = internals

    const disabled = isTeleportDisabled(n2.props) // 是否禁用 Teleport 功能

    let { shapeFlag, children, dynamicChildren } = n2

    // #3302
    // HMR updated, force full diff
    if (__DEV__ && isHmrUpdating) {
      optimized = false
      dynamicChildren = null
    }

    // 阶段 1：首次挂载
    if (n1 == null) {
      // 在原组件树插入占位锚点（开发环境为注释，生产为文本节点）
      // insert anchors in the main view
      const placeholder = (n2.el = __DEV__
        ? createComment('teleport start')
        : createText('')) // 占位节点，用于占位和后续更新
      const mainAnchor = (n2.anchor = __DEV__
        ? createComment('teleport end')
        : createText('')) // 主锚点，用于插入实际内容

      insert(placeholder, container, anchor) // 插入起始锚点
      insert(mainAnchor, container, anchor) // 插入结束锚点

      /**
       * 挂载子节点到指定容器
       * @param container 要挂载到的目标 DOM 容器（Teleport 的 to 容器 / 原组件容器）
       * @param anchor 锚点，用于插入实际内容
       */
      const mount = (container: RendererElement, anchor: RendererNode) => {
        // Teleport *always* has Array children. This is enforced in both the
        // compiler and vnode children normalization.
        // 校验子节点类型为「数组子节点」（安全兜底）
        // 虽然 Teleport 子节点强制为数组，但仍做兜底校验（防止运行时异常修改 VNode）
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // 调用 mountChildren 挂载所有子节点
          mountChildren(
            children as VNodeArrayChildren, // Teleport 的子 VNode 数组
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
       *  Teleport 组件将内容挂载到目标容器（如 body）
       */
      const mountToTarget = () => {
        // 解析并缓存 Teleport 的目标容器（核心！）
        const target = (n2.target = resolveTarget(n2.props, querySelector))
        // 准备目标容器内的挂载锚点（控制插入位置）
        const targetAnchor = prepareAnchor(target, n2, createText, insert)

        // 目标容器有效时执行核心逻辑
        if (target) {
          // #2652 we could be teleporting from a non-SVG tree into an SVG tree
          // 步骤 3.1：兼容 SVG/MathML 命名空间（跨命名空间渲染）
          // 场景：从普通 HTML 树 Teleport 到 SVG/MathML 容器
          if (namespace !== 'svg' && isTargetSVG(target)) {
            // 切换为 SVG 命名空间，保证 <rect> 等标签正确渲染
            namespace = 'svg'
          } else if (namespace !== 'mathml' && isTargetMathML(target)) {
            // 切换为 MathML 命名空间
            namespace = 'mathml'
          }

          // track CE teleport targets
          // 追踪自定义元素（CE）的 Teleport 目标容器（避免内存泄漏）
          if (parentComponent && parentComponent.isCE) {
            // 初始化 Set 容器，存储该自定义元素关联的 Teleport 目标
            ;(
              parentComponent.ce!._teleportTargets ||
              (parentComponent.ce!._teleportTargets = new Set())
            ).add(target)
          }

          // 非禁用状态下，执行挂载 + 更新 CSS 变量
          if (!disabled) {
            mount(target, targetAnchor)
            updateCssVars(n2, false)
          }

          // 目标容器无效时，开发环境给出警告（生产环境静默失败）
        } else if (__DEV__ && !disabled) {
          warn(
            'Invalid Teleport target on mount:',
            target,
            `(${typeof target})`,
          )
        }
      }

      // 处理禁用状态（disabled = true 时挂载到原组件树）
      if (disabled) {
        mount(container, mainAnchor) // 挂载到原组件树
        updateCssVars(n2, true) // 更新 CSS 变量（禁用状态下）
      }

      // 处理延迟挂载（deferred 属性）
      if (isTeleportDeferred(n2.props)) {
        n2.el!.__isMounted = false // 标记为未挂载（延迟挂载）
        queuePostRenderEffect(() => {
          mountToTarget()
          delete n2.el!.__isMounted // 挂载完成后删除标记
        }, parentSuspense)
      } else {
        mountToTarget() // 同步挂载
      }

      // 阶段 2：更新（n1 != null，已有挂载）
    } else {
      if (isTeleportDeferred(n2.props) && n1.el!.__isMounted === false) {
        queuePostRenderEffect(() => {
          TeleportImpl.process(
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
        }, parentSuspense)
        return
      }
      // update content
      n2.el = n1.el
      n2.targetStart = n1.targetStart
      const mainAnchor = (n2.anchor = n1.anchor)!
      const target = (n2.target = n1.target)!
      const targetAnchor = (n2.targetAnchor = n1.targetAnchor)!
      const wasDisabled = isTeleportDisabled(n1.props)
      const currentContainer = wasDisabled ? container : target
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor

      if (namespace === 'svg' || isTargetSVG(target)) {
        namespace = 'svg'
      } else if (namespace === 'mathml' || isTargetMathML(target)) {
        namespace = 'mathml'
      }

      if (dynamicChildren) {
        // fast path when the teleport happens to be a block root
        patchBlockChildren(
          n1.dynamicChildren!,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
        )
        // even in block tree mode we need to make sure all root-level nodes
        // in the teleport inherit previous DOM references so that they can
        // be moved in future patches.
        // in dev mode, deep traversal is necessary for HMR
        traverseStaticChildren(n1, n2, !__DEV__)
      } else if (!optimized) {
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          false,
        )
      }

      if (disabled) {
        if (!wasDisabled) {
          // enabled -> disabled
          // move into main container
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            TeleportMoveTypes.TOGGLE,
          )
        } else {
          // #7835
          // When `teleport` is disabled, `to` may change, making it always old,
          // to ensure the correct `to` when enabled
          if (n2.props && n1.props && n2.props.to !== n1.props.to) {
            n2.props.to = n1.props.to
          }
        }
      } else {
        // target changed
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          const nextTarget = (n2.target = resolveTarget(
            n2.props,
            querySelector,
          ))
          if (nextTarget) {
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              TeleportMoveTypes.TARGET_CHANGE,
            )
          } else if (__DEV__) {
            warn(
              'Invalid Teleport target on update:',
              target,
              `(${typeof target})`,
            )
          }
        } else if (wasDisabled) {
          // disabled -> enabled
          // move into teleport target
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            TeleportMoveTypes.TOGGLE,
          )
        }
      }
      updateCssVars(n2, disabled)
    }
  },
  /**
   * 移除 Teleport 组件的 DOM 元素
   * @param vnode Teleport 组件的虚拟节点
   * @param parentComponent 父组件实例
   * @param parentSuspense 父 Suspense 边界实例
   * @param param3 渲染器内部方法集合（um: unmount, o: hostRemove）
   * @param doRemove 是否执行 DOM 移除操作
   */
  remove(
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    { um: unmount, o: { remove: hostRemove } }: RendererInternals,
    doRemove: boolean,
  ): void {
    const {
      shapeFlag,
      children,
      anchor,
      targetStart,
      targetAnchor,
      target,
      props,
    } = vnode

    if (target) {
      hostRemove(targetStart!) // 移除 targetStart
      hostRemove(targetAnchor!) // 移除 targetAnchor
    }

    // an unmounted teleport should always unmount its children whether it's disabled or not
    doRemove && hostRemove(anchor!) // 移除 anchor

    // 移除 Teleport 组件的子节点
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      const shouldRemove = doRemove || !isTeleportDisabled(props)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        const child = (children as VNode[])[i]
        unmount(
          child,
          parentComponent,
          parentSuspense,
          shouldRemove,
          !!child.dynamicChildren,
        )
      }
    }
  },
  // 处理 Teleport 内容的移动逻辑
  move: moveTeleport as typeof moveTeleport,
  // 服务端渲染 hydration 逻辑
  hydrate: hydrateTeleport as typeof hydrateTeleport,
}

export enum TeleportMoveTypes {
  TARGET_CHANGE,
  TOGGLE, // enable / disable
  REORDER, // moved in the main view
}

/**
 *
 * @param vnode Teleport 组件的虚拟节点
 * @param container 目标容器元素
 * @param parentAnchor 父容器中的锚点节点
 * @param param3 渲染器内部方法集合
 * @param moveType 移动类型，默认值为 TeleportMoveTypes.REORDER
 */
function moveTeleport(
  vnode: VNode,
  container: RendererElement,
  parentAnchor: RendererNode | null,
  { o: { insert }, m: move }: RendererInternals,
  moveType: TeleportMoveTypes = TeleportMoveTypes.REORDER,
): void {
  // move target anchor if this is a target change.
  if (moveType === TeleportMoveTypes.TARGET_CHANGE) {
    insert(vnode.targetAnchor!, container, parentAnchor)
  }
  const { el, anchor, shapeFlag, children, props } = vnode
  const isReorder = moveType === TeleportMoveTypes.REORDER
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(el!, container, parentAnchor)
  }
  // if this is a re-order and teleport is enabled (content is in target)
  // do not move children. So the opposite is: only move children if this
  // is not a reorder, or the teleport is disabled
  if (!isReorder || isTeleportDisabled(props)) {
    // Teleport has either Array children or no children.
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move(
          (children as VNode[])[i],
          container,
          parentAnchor,
          MoveType.REORDER,
        )
      }
    }
  }
  // move main view anchor if this is a re-order.
  if (isReorder) {
    insert(anchor!, container, parentAnchor)
  }
}

interface TeleportTargetElement extends Element {
  // last teleport target
  _lpa?: Node | null
}

function hydrateTeleport(
  node: Node,
  vnode: TeleportVNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  slotScopeIds: string[] | null,
  optimized: boolean,
  {
    o: { nextSibling, parentNode, querySelector, insert, createText },
  }: RendererInternals<Node, Element>,
  hydrateChildren: (
    node: Node | null,
    vnode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean,
  ) => Node | null,
): Node | null {
  // lookahead until we find the target anchor
  // we cannot rely on return value of hydrateChildren() because there
  // could be nested teleports
  function hydrateAnchor(
    target: TeleportTargetElement,
    targetNode: Node | null,
  ) {
    let targetAnchor = targetNode
    while (targetAnchor) {
      if (targetAnchor && targetAnchor.nodeType === 8) {
        if ((targetAnchor as Comment).data === 'teleport start anchor') {
          vnode.targetStart = targetAnchor
        } else if ((targetAnchor as Comment).data === 'teleport anchor') {
          vnode.targetAnchor = targetAnchor
          target._lpa =
            vnode.targetAnchor && nextSibling(vnode.targetAnchor as Node)
          break
        }
      }
      targetAnchor = nextSibling(targetAnchor)
    }
  }

  function hydrateDisabledTeleport(node: Node, vnode: VNode) {
    vnode.anchor = hydrateChildren(
      nextSibling(node),
      vnode,
      parentNode(node)!,
      parentComponent,
      parentSuspense,
      slotScopeIds,
      optimized,
    )
  }

  const target = (vnode.target = resolveTarget<Element>(
    vnode.props,
    querySelector,
  ))
  const disabled = isTeleportDisabled(vnode.props)
  if (target) {
    // if multiple teleports rendered to the same target element, we need to
    // pick up from where the last teleport finished instead of the first node
    const targetNode =
      (target as TeleportTargetElement)._lpa || target.firstChild
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (disabled) {
        hydrateDisabledTeleport(node, vnode)
        hydrateAnchor(target as TeleportTargetElement, targetNode)
        if (!vnode.targetAnchor) {
          prepareAnchor(
            target,
            vnode,
            createText,
            insert,
            // if target is the same as the main view, insert anchors before current node
            // to avoid hydrating mismatch
            parentNode(node)! === target ? node : null,
          )
        }
      } else {
        vnode.anchor = nextSibling(node)
        hydrateAnchor(target as TeleportTargetElement, targetNode)
        // #11400 if the HTML corresponding to Teleport is not embedded in the
        // correct position on the final page during SSR. the targetAnchor will
        // always be null, we need to manually add targetAnchor to ensure
        // Teleport it can properly unmount or move
        if (!vnode.targetAnchor) {
          prepareAnchor(target, vnode, createText, insert)
        }

        hydrateChildren(
          targetNode && nextSibling(targetNode),
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized,
        )
      }
    }
    updateCssVars(vnode, disabled)
  } else if (disabled) {
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      hydrateDisabledTeleport(node, vnode)
      vnode.targetStart = node
      vnode.targetAnchor = nextSibling(node)
    }
  }
  return vnode.anchor && nextSibling(vnode.anchor as Node)
}

// Force-casted public typing for h and TSX props inference
export const Teleport = TeleportImpl as unknown as {
  __isTeleport: true
  new (): {
    $props: VNodeProps & TeleportProps
    $slots: {
      default(): VNode[]
    }
  }
}

/**
 * Vue 的 scoped CSS 原理是：
 * 1、组件渲染时，给所有子节点添加 data-v-xxx 属性（xxx 是组件唯一 ID）；
 * 2、样式编译时，自动给选择器添加 [data-v-xxx] 后缀，实现样式隔离；
 * Teleport 内容 DOM 被移到其他容器（如 body），脱离了原组件的 data-v-xxx 作用域，
 * 导致 scoped 样式无法匹配。updateCssVars 就是为了修复这个问题。
 */

/**
 *  Vue3 专门解决 Teleport 跨容器 scoped CSS 失效问题
 * @param vnode Teleport 组件的 VNode 实例
 * @param isDisabled Teleport 是否禁用
 */
function updateCssVars(vnode: VNode, isDisabled: boolean) {
  // presence of .ut method indicates owner component uses css vars.
  // code path here can assume browser environment.
  const ctx = vnode.ctx

  // 仅当组件使用 CSS 变量时执行（避免无意义操作）
  if (ctx && ctx.ut) {
    let node, anchor

    // 步骤 1：根据 Teleport 禁用状态，确定要处理的 DOM 区间（核心！）
    if (isDisabled) {
      // 禁用状态：Teleport 内容在原组件容器，处理原锚点区间（vnode.el ~ vnode.anchor）
      node = vnode.el
      anchor = vnode.anchor
    } else {
      // 启用状态：Teleport 内容在目标容器，处理目标锚点区间（targetStart ~ targetAnchor）
      node = vnode.targetStart
      anchor = vnode.targetAnchor
    }
    // 遍历区间内所有 DOM 节点，添加样式归属标记
    while (node && node !== anchor) {
      // 仅处理元素节点（排除文本/注释节点）
      // 添加 data-v-owner 属性，值为原组件的唯一 ID（ctx.uid）
      if (node.nodeType === 1) node.setAttribute('data-v-owner', ctx.uid)
      node = node.nextSibling // 遍历下一个兄弟节点
    }
    ctx.ut() // 触发原组件的 CSS 变量更新方法
  }
}

/**
 * 在 Teleport 目标容器中创建「成对的空文本锚点」，
 * 用于精准标记 Teleport 内容的插入位置、隔离 Teleport 内容与目标容器原有内容
 * @param target 目标容器元素
 * @param vnode Teleport 组件的 VNode 实例
 * @param createText 渲染器的 createText 方法，用于创建文本节点
 * @param insert
 * @param anchor 目标容器插入锚点
 * @returns
 */
function prepareAnchor(
  target: RendererElement | null,
  vnode: TeleportVNode,
  createText: RendererOptions['createText'],
  insert: RendererOptions['insert'],
  anchor: RendererNode | null = null,
) {
  const targetStart = (vnode.targetStart = createText('')) // 目标容器开始锚点
  const targetAnchor = (vnode.targetAnchor = createText('')) // 目标容器结束锚点

  // attach a special property, so we can skip teleported content in
  // renderer's nextSibling search
  // 关联两个锚点，标记「开始锚点 → 结束锚点」的映射关系
  // 渲染器遍历 DOM 兄弟节点时，可通过该属性跳过 Teleport 内容，避免误处理
  targetStart[TeleportEndKey] = targetAnchor

  if (target) {
    insert(targetStart, target, anchor) // 在锚点前插入  targetStart
    insert(targetAnchor, target, anchor) // 在锚点后插入 targetAnchor
  }

  // 返回结束锚点，作为 Teleport 内容的插入参考（内容插入到 start 和 anchor 之间）
  return targetAnchor
}
