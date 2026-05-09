import {
  type ComponentInternalInstance,
  type Data,
  type FunctionalComponent,
  getComponentName,
} from './component'
import {
  Comment,
  type VNode,
  type VNodeArrayChildren,
  blockStack,
  cloneVNode,
  createVNode,
  isVNode,
  normalizeVNode,
} from './vnode'
import { ErrorCodes, handleError } from './errorHandling'
import {
  PatchFlags,
  ShapeFlags,
  isModelListener,
  isObject,
  isOn,
  looseEqual,
} from '@vue/shared'
import { warn } from './warning'
import { isHmrUpdating } from './hmr'
import type { NormalizedProps } from './componentProps'
import { isEmitListener } from './componentEmits'
import { setCurrentRenderingInstance } from './componentRenderContext'
import {
  DeprecationTypes,
  isCompatEnabled,
  warnDeprecation,
} from './compat/compatConfig'
import { shallowReadonly } from '@vue/reactivity'
import { setTransitionHooks } from './components/BaseTransition'

/**
 * dev only flag to track whether $attrs was used during render.
 * If $attrs was used during render then the warning for failed attrs
 * fallthrough can be suppressed.
 */
let accessedAttrs: boolean = false

export function markAttrsAccessed(): void {
  accessedAttrs = true
}

type SetRootFn = ((root: VNode) => void) | undefined

/**
 *  Vue 3 组件渲染的核心入口函数，负责将组件实例渲染为根 VNode。
 * 它是连接组件定义、响应式数据和虚拟 DOM 的关键桥梁，处理两种类型的组件：有状态组件和函数式组件。
 * @param instance
 * @returns
 */
export function renderComponentRoot(
  instance: ComponentInternalInstance,
): VNode {
  const {
    type: Component, // 组件类型定义
    vnode,
    proxy, // 组件实例的代理对象
    withProxy, // 用于运行时编译的 with 块优化
    propsOptions: [propsOptions], // 组件声明的 props 定义数组
    slots,
    attrs, // 透传的属性对象（非 props 属性）
    emit, // 事件触发函数
    render, // 渲染函数
    renderCache, // 渲染缓存数组
    props,
    data, // 选项式 API 的 data() 返回值
    setupState, // setup() 返回的响应式状态
    ctx,
    inheritAttrs, // 是否将 attrs 透传到根节点
  } = instance

  // 设置渲染上下文
  const prev = setCurrentRenderingInstance(instance)

  let result
  let fallthroughAttrs
  if (__DEV__) {
    accessedAttrs = false
  }

  try {
    // 渲染有状态组件
    if (vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) {
      // withProxy is a proxy with a different `has` trap only for
      // runtime-compiled render functions using `with` block.
      // 为使用 with 块的运行时编译渲染函数创建特殊代理
      const proxyToUse = withProxy || proxy
      // 'this' isn't available in production builds with `<script setup>`,
      // so warn if it's used in dev.
      const thisProxy =
        // 为脚本设置组件创建代理
        __DEV__ && setupState.__isScriptSetup
          ? new Proxy(proxyToUse!, {
              get(target, key, receiver) {
                // 警告用户避免在模板中使用 'this'
                warn(
                  `Property '${String(
                    key,
                  )}' was accessed via 'this'. Avoid using 'this' in templates.`,
                )
                return Reflect.get(target, key, receiver)
              },
            })
          : proxyToUse
      result = normalizeVNode(
        // 调用渲染函数，传递必要的参数
        render!.call(
          thisProxy,
          proxyToUse!,
          renderCache,
          __DEV__ ? shallowReadonly(props) : props,
          setupState,
          data,
          ctx,
        ),
      )
      fallthroughAttrs = attrs
    } else {
      // 函数式组件是一种无状态、无实例的组件形式，通过函数直接返回 VNode
      // functional
      const render = Component as FunctionalComponent
      // attrs === props 表示函数式组件没有声明 props
      if (__DEV__ && attrs === props) {
        markAttrsAccessed() // 标记属性已被访问
      }
      result = normalizeVNode(
        // > 1：函数期望接收第二个参数（上下文对象）
        render.length > 1
          ? render(
              // 防止在模板中意外修改 props
              __DEV__ ? shallowReadonly(props) : props,
              __DEV__
                ? {
                    get attrs() {
                      markAttrsAccessed()
                      return shallowReadonly(attrs)
                    },
                    slots,
                    emit,
                  }
                : { attrs, slots, emit },
            )
          : // <= 1：函数只需要第一个参数（props）
            render(
              __DEV__ ? shallowReadonly(props) : props,
              null as any /* we know it doesn't need it */,
            ),
      )
      fallthroughAttrs = Component.props
        ? attrs
        : getFunctionalFallthrough(attrs)
    }
  } catch (err) {
    blockStack.length = 0
    handleError(err, instance, ErrorCodes.RENDER_FUNCTION)
    result = createVNode(Comment)
  }

  // attr merging
  // in dev mode, comments are preserved, and it's possible for a template
  // to have comments along side the root element which makes it a fragment
  let root = result
  let setRoot: SetRootFn = undefined
  if (
    __DEV__ &&
    result.patchFlag > 0 &&
    result.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
  ) {
    ;[root, setRoot] = getChildRoot(result)
  }

  // 当父组件传递给子组件的属性没有在 props 中声明时，这些属性会作为"透传属性"（fallthrough attrs）
  // 属性透传处理
  // fallthroughAttrs	存在非 props 属性需要透传
  // inheritAttrs !== false	组件没有显式禁用属性继承
  if (fallthroughAttrs && inheritAttrs !== false) {
    const keys = Object.keys(fallthroughAttrs)
    const { shapeFlag } = root
    if (keys.length) {
      // 情况1：根节点是元素或组件
      if (shapeFlag & (ShapeFlags.ELEMENT | ShapeFlags.COMPONENT)) {
        // v-model 监听器特殊处理
        // 如果组件声明了对应的 prop，则 v-model 监听器不应透传
        if (propsOptions && keys.some(isModelListener)) {
          fallthroughAttrs = filterModelListeners(
            fallthroughAttrs,
            propsOptions,
          )
        }
        // 合并透传属性
        root = cloneVNode(
          root,
          fallthroughAttrs,
          false /**不深拷贝childrenn */,
          true /** 合并属性 */,
        )
      } else if (__DEV__ && !accessedAttrs && root.type !== Comment) {
        const allAttrs = Object.keys(attrs)
        const eventAttrs: string[] = []
        const extraAttrs: string[] = []
        for (let i = 0, l = allAttrs.length; i < l; i++) {
          const key = allAttrs[i]
          if (isOn(key)) {
            // 忽略 v-model 处理器
            if (!isModelListener(key)) {
              // 转换事件名称格式：onClick → click
              eventAttrs.push(key[2].toLowerCase() + key.slice(3))
            }
          } else {
            extraAttrs.push(key)
          }
        }
        // 非 props 属性	class, style, data-*	无法自动继承，因为根节点不是元素
        if (extraAttrs.length) {
          warn(
            `Extraneous non-props attributes (` +
              `${extraAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text or teleport root nodes.`,
          )
        }
        // 非 emits 事件	onClick, onCustomEvent	无法自动继承，建议在 emits 中声明
        if (eventAttrs.length) {
          warn(
            `Extraneous non-emits event listeners (` +
              `${eventAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text root nodes. ` +
              `If the listener is intended to be a component custom event listener only, ` +
              `declare it using the "emits" option.`,
          )
        }
      }
    }
  }

  if (
    __COMPAT__ &&
    isCompatEnabled(DeprecationTypes.INSTANCE_ATTRS_CLASS_STYLE, instance) &&
    vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT &&
    root.shapeFlag & (ShapeFlags.ELEMENT | ShapeFlags.COMPONENT)
  ) {
    const { class: cls, style } = vnode.props || {}
    if (cls || style) {
      if (__DEV__ && inheritAttrs === false) {
        warnDeprecation(
          DeprecationTypes.INSTANCE_ATTRS_CLASS_STYLE,
          instance,
          getComponentName(instance.type),
        )
      }
      root = cloneVNode(
        root,
        {
          class: cls,
          style: style,
        },
        false,
        true,
      )
    }
  }

  // inherit directives
  // Vue 组件的指令（directives）继承逻辑。
  // 当组件上使用了指令（如 v-if、v-show、自定义指令等），
  // 需要将这些指令传递到组件渲染后的根 VNode 上
  if (vnode.dirs) {
    // 根节点不是元素类型
    // 指令只能作用于 DOM 元素，如果组件根节点是片段（Fragment）、文本或注释，指令无法正常工作。
    if (__DEV__ && !isElementRoot(root)) {
      warn(
        `Runtime directive used on component with non-element root node. ` +
          `The directives will not function as intended.`,
      )
    }
    // clone before mutating since the root may be a hoisted vnode
    root = cloneVNode(root, null, false, true)
    root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs
  }
  // inherit transition data
  // Vue 组件的过渡（Transition）钩子继承逻辑。
  // 当组件被包裹在 <Transition> 组件中时，
  // 需要将过渡相关的钩子函数传递到组件渲染后的根 VNode 上
  if (vnode.transition) {
    // 过渡动画只能作用于 DOM 元素，如果组件根节点是片段（Fragment）、文本或注释，过渡效果无法正常工作。
    if (__DEV__ && !isElementRoot(root)) {
      warn(
        `Component inside <Transition> renders non-element root node ` +
          `that cannot be animated.`,
      )
    }
    // 将过渡钩子函数绑定到根 VNode 上，以便在 DOM 更新时触发过渡动画
    setTransitionHooks(root, vnode.transition)
  }

  if (__DEV__ && setRoot) {
    setRoot(root)
  } else {
    result = root
  }

  // 恢复上下文
  setCurrentRenderingInstance(prev)
  return result
}

/**
 * dev only
 * In dev mode, template root level comments are rendered, which turns the
 * template into a fragment root, but we need to locate the single element
 * root for attrs and scope id processing.
 */
const getChildRoot = (vnode: VNode): [VNode, SetRootFn] => {
  const rawChildren = vnode.children as VNodeArrayChildren
  const dynamicChildren = vnode.dynamicChildren
  const childRoot = filterSingleRoot(rawChildren, false)
  if (!childRoot) {
    return [vnode, undefined]
  } else if (
    __DEV__ &&
    childRoot.patchFlag > 0 &&
    childRoot.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
  ) {
    return getChildRoot(childRoot)
  }

  const index = rawChildren.indexOf(childRoot)
  const dynamicIndex = dynamicChildren ? dynamicChildren.indexOf(childRoot) : -1
  const setRoot: SetRootFn = (updatedRoot: VNode) => {
    rawChildren[index] = updatedRoot
    if (dynamicChildren) {
      if (dynamicIndex > -1) {
        dynamicChildren[dynamicIndex] = updatedRoot
      } else if (updatedRoot.patchFlag > 0) {
        vnode.dynamicChildren = [...dynamicChildren, updatedRoot]
      }
    }
  }
  return [normalizeVNode(childRoot), setRoot]
}

export function filterSingleRoot(
  children: VNodeArrayChildren,
  recurse = true,
): VNode | undefined {
  let singleRoot
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isVNode(child)) {
      // ignore user comment
      if (child.type !== Comment || child.children === 'v-if') {
        if (singleRoot) {
          // has more than 1 non-comment child, return now
          return
        } else {
          singleRoot = child
          if (
            __DEV__ &&
            recurse &&
            singleRoot.patchFlag > 0 &&
            singleRoot.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
          ) {
            return filterSingleRoot(singleRoot.children as VNodeArrayChildren)
          }
        }
      }
    } else {
      return
    }
  }
  return singleRoot
}

const getFunctionalFallthrough = (attrs: Data): Data | undefined => {
  let res: Data | undefined
  for (const key in attrs) {
    if (key === 'class' || key === 'style' || isOn(key)) {
      ;(res || (res = {}))[key] = attrs[key]
    }
  }
  return res
}

const filterModelListeners = (attrs: Data, props: NormalizedProps): Data => {
  const res: Data = {}
  for (const key in attrs) {
    if (!isModelListener(key) || !(key.slice(9) in props)) {
      res[key] = attrs[key]
    }
  }
  return res
}

const isElementRoot = (vnode: VNode) => {
  return (
    vnode.shapeFlag & (ShapeFlags.COMPONENT | ShapeFlags.ELEMENT) ||
    vnode.type === Comment // potential v-if branch switch
  )
}

/**
 * 判断是否需要更新组件
 * @param prevVNode 旧 VNode
 * @param nextVNode 新 VNode
 * @param optimized 是否开启优化模式
 * @returns 是否需要更新组件
 */
export function shouldUpdateComponent(
  prevVNode: VNode,
  nextVNode: VNode,
  optimized?: boolean,
): boolean {
  const { props: prevProps, children: prevChildren, component } = prevVNode
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode
  const emits = component!.emitsOptions

  // Parent component's render function was hot-updated. Since this may have
  // caused the child component's slots content to have changed, we need to
  // force the child to update as well.
  if (__DEV__ && (prevChildren || nextChildren) && isHmrUpdating) {
    return true
  }

  // force child update for runtime directive or transition on component vnode.
  // 组件 VNode 上有运行时指令（如 v-show、v-model）,或有过渡效果（transition）
  if (nextVNode.dirs || nextVNode.transition) {
    return true
  }

  // 优化模式处理（编译时优化）
  if (optimized && patchFlag >= 0) {
    // DYNAMIC_SLOTS：slot 内容引用了可能变化的值（如 v-for）
    if (patchFlag & PatchFlags.DYNAMIC_SLOTS) {
      // slot content that references values that might have changed,
      // e.g. in a v-for
      return true
    }
    // 什么场景会触发 FULL_PROPS？
    // 1、动态key :key="dynamicKey"	key 在运行时才能确定
    // 2、展开运算符 {...dynamicObj}	展开对象的属性不确定
    // 3、条件props ondition ? {a: 1} : {b: 2}	不同分支返回不同 props
    // FULL_PROPS：props 包含动态 key，需要完整 diff
    if (patchFlag & PatchFlags.FULL_PROPS) {
      if (!prevProps) {
        return !!nextProps // 旧 props 为空，检查新 props 是否存在
      }
      // presence of this flag indicates props are always non-null
      // 深度比较属性值（处理响应式对象）
      return hasPropsChanged(prevProps, nextProps!, emits)

      // PROPS：只有指定的 props 可能变化
    } else if (patchFlag & PatchFlags.PROPS) {
      const dynamicProps = nextVNode.dynamicProps!
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i]
        if (
          hasPropValueChanged(nextProps!, prevProps!, key) &&
          !isEmitListener(emits, key)
        ) {
          return true
        }
      }
    }
    // 非优化模式处理（手动编写的渲染函数）
  } else {
    // this path is only taken by manually written render functions
    // so presence of any children leads to a forced update
    // 任何子节点变化都强制更新
    if (prevChildren || nextChildren) {
      if (!nextChildren || !(nextChildren as any).$stable) {
        return true
      }
    }
    // props 引用相同，无需更新
    if (prevProps === nextProps) {
      return false
    }
    // 旧 props 为空，检查新 props
    if (!prevProps) {
      return !!nextProps
    }
    // 新 props 为空，需要更新
    if (!nextProps) {
      return true
    }
    // 检查 props 是否变化
    return hasPropsChanged(prevProps, nextProps, emits)
  }

  return false
}

function hasPropsChanged(
  prevProps: Data,
  nextProps: Data,
  emitsOptions: ComponentInternalInstance['emitsOptions'],
): boolean {
  const nextKeys = Object.keys(nextProps)
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i]
    if (
      hasPropValueChanged(nextProps, prevProps, key) &&
      !isEmitListener(emitsOptions, key)
    ) {
      return true
    }
  }
  return false
}

function hasPropValueChanged(
  nextProps: Data,
  prevProps: Data,
  key: string,
): boolean {
  const nextProp = nextProps[key]
  const prevProp = prevProps[key]
  if (key === 'style' && isObject(nextProp) && isObject(prevProp)) {
    return !looseEqual(nextProp, prevProp)
  }
  return nextProp !== prevProp
}

/**
 * 用于向上同步「高阶组件（HOC）」宿主 DOM 节点引用
 * @param param0 组件实例，包含 vnode 和 parent 信息
 * @param el 要更新的 DOM 节点（HostNode）
 */
export function updateHOCHostEl(
  { vnode, parent }: ComponentInternalInstance,
  el: typeof vnode.el, // HostNode
): void {
  // 递归遍历父组件链，直到无父组件或跳出条件
  while (parent) {
    // 获取父组件的根渲染子树（subTree 是组件渲染的真实内容）
    const root = parent.subTree

    // 兼容 Suspense 嵌套场景：同步 Suspense 根节点的 el
    if (root.suspense && root.suspense.activeBranch === vnode) {
      root.el = vnode.el
    }

    // 判断当前父组件的根子树是否等于当前组件的 VNode（是否是直接包裹的 HOC）
    if (root === vnode) {
      ;(vnode = parent.vnode).el = el // 更新父组件的 VNode el 为真实 DOM 节点
      parent = parent.parent // 继续向上遍历父组件链（处理多层 HOC 嵌套）
    } else {
      break // 非直接包裹的 HOC，终止遍历（避免无限循环）
    }
  }
}
