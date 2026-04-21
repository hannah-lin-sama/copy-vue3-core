import {
  type CacheExpression,
  type CallExpression,
  type ComponentNode,
  ConstantTypes,
  ElementTypes,
  type ExpressionNode,
  type JSChildNode,
  NodeTypes,
  type ParentNode,
  type PlainElementNode,
  type RootNode,
  type SimpleExpressionNode,
  type SlotFunctionExpression,
  type TemplateChildNode,
  type TemplateNode,
  type TextCallNode,
  type VNodeCall,
  createArrayExpression,
  getVNodeBlockHelper,
  getVNodeHelper,
} from '../ast'
import type { TransformContext } from '../transform'
import {
  PatchFlagNames,
  PatchFlags,
  isArray,
  isString,
  isSymbol,
} from '@vue/shared'
import { findDir, isSlotOutlet } from '../utils'
import {
  GUARD_REACTIVE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_PROPS,
  NORMALIZE_STYLE,
  OPEN_BLOCK,
} from '../runtimeHelpers'

/**
 * 识别和缓存模板中的静态内容，以提高渲染性能
 * @param root
 * @param context
 */
export function cacheStatic(root: RootNode, context: TransformContext): void {
  walk(
    root, // 根节点
    undefined, // 父节点
    context,
    // Root node is unfortunately non-hoistable due to potential parent
    // fallthrough attributes.
    !!getSingleElementRoot(root),
  )
}

export function getSingleElementRoot(
  root: RootNode,
): PlainElementNode | ComponentNode | TemplateNode | null {
  const children = root.children.filter(x => x.type !== NodeTypes.COMMENT)
  return children.length === 1 &&
    children[0].type === NodeTypes.ELEMENT &&
    !isSlotOutlet(children[0])
    ? children[0]
    : null
}

/**
 * 遍历 AST 节点树，识别和处理静态内容，以优化渲染性能
 * @param node // 当前处理的节点
 * @param parent // 父节点
 * @param context
 * @param doNotHoistNode // 是否禁止提升节点
 * @param inFor // 是否在 for 循环中
 */
function walk(
  node: ParentNode,
  parent: ParentNode | undefined,
  context: TransformContext,
  doNotHoistNode: boolean = false,
  inFor = false,
) {
  const { children } = node // 获取子节点列表
  // 收集可缓存的静态节点（最终编译为 _cache 缓存）
  const toCache: (PlainElementNode | TextCallNode)[] = []

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    // only plain elements & text calls are eligible for caching.

    // 一、普通元素节点
    // 只处理普通元素（非组件、非插槽等）
    if (
      child.type === NodeTypes.ELEMENT &&
      child.tagType === ElementTypes.ELEMENT
    ) {
      // 计算节点的常量类型
      const constantType = doNotHoistNode
        ? // 如果 doNotHoistNode 为 true（表示该节点不应被提升）
          ConstantTypes.NOT_CONSTANT
        : getConstantType(child, context)

      /**
          NOT_CONSTANT = 0, // 非常量表达式，在编译时无法确定其值
          CAN_SKIP_PATCH, // 1 可以跳过补丁的常量，通常是静态节点
          CAN_CACHE, // 2 可以缓存的常量，其值在编译时已知
          CAN_STRINGIFY, // 3 可以字符串化的常量，其值可以在编译时转换为字符串
         */
      // ============== 场景1：节点是静态节点 ==============
      if (constantType > ConstantTypes.NOT_CONSTANT) {
        if (constantType >= ConstantTypes.CAN_CACHE) {
          // 如果常量类型达到 CAN_CACHE（意味着节点极其稳定，可被 v-once 缓存）

          // 设置 patchFlag 为 PatchFlags.CACHED （即 -1，表示完全静态）
          ;(child.codegenNode as VNodeCall).patchFlag = PatchFlags.CACHED
          // 节点添加到 toCache 数组中
          toCache.push(child)
          continue
        }

        // ============== 场景2：节点非整体静态，但属性可提升 ==============
      } else {
        // node may contain dynamic children, but its props may be eligible for
        // hoisting.
        // 获取节点的生成节点
        const codegenNode = child.codegenNode!

        // 节点是VNODE_CALL 类型（虚拟节点调用）
        if (codegenNode.type === NodeTypes.VNODE_CALL) {
          const flag = codegenNode.patchFlag

          if (
            (flag === undefined || // 未标记的节点
              flag === PatchFlags.NEED_PATCH || // 需要比对的节点
              flag === PatchFlags.TEXT) && // 只有文本内容会变化的节点
            // 检查节点属性的常量类型
            getGeneratedPropsConstantType(child, context) >=
              ConstantTypes.CAN_CACHE
          ) {
            // 获取节点的属性对象
            const props = getNodeProps(child)
            if (props) {
              // 将属性对象提升到渲染函数外部
              // 更新代码生成节点
              codegenNode.props = context.hoist(props)
            }
          }
          // 动态属性列表（dynamicProps）：它是编译器生成的一个静态字符串数组，仅用于记录哪些属性名是动态绑定的。
          // 这个数组本身不依赖任何响应式数据，所以可以被提升。
          if (codegenNode.dynamicProps) {
            codegenNode.dynamicProps = context.hoist(codegenNode.dynamicProps)
          }
        }
      }

      // 处理文本调用节点
    } else if (child.type === NodeTypes.TEXT_CALL) {
      const constantType = doNotHoistNode
        ? ConstantTypes.NOT_CONSTANT
        : // 计算节点的常量类型
          getConstantType(child, context)

      // 纯静态文本节点 → 加入缓存，避免重复生成文本 VNode。
      if (constantType >= ConstantTypes.CAN_CACHE) {
        if (
          // 代码生成节点类型为 JavaScript 调用表达式
          child.codegenNode.type === NodeTypes.JS_CALL_EXPRESSION &&
          child.codegenNode.arguments.length > 0 // 参数大于0
        ) {
          child.codegenNode.arguments.push(
            // 添加 PatchFlags.CACHED 标记到参数列表中
            PatchFlags.CACHED +
              (__DEV__ ? ` /* ${PatchFlagNames[PatchFlags.CACHED]} */` : ``),
          )
        }
        toCache.push(child) // 存储可缓存的节点
        continue
      }
    }

    // walk further
    // 递归处理元素节点
    // 表示元素节点，包括普通 HTML 元素和组件
    if (child.type === NodeTypes.ELEMENT) {
      const isComponent = child.tagType === ElementTypes.COMPONENT

      if (isComponent) {
        // 跟踪当前 v-slot 作用域的深度
        // 进入组件时增加计数
        context.scopes.vSlot++
      }
      walk(child, node, context, false, inFor)

      if (isComponent) {
        // 退出时减少计数
        context.scopes.vSlot--
      }

      // 递归处理 v-for 循环节点
    } else if (child.type === NodeTypes.FOR) {
      // Do not hoist v-for single child because it has to be a block
      walk(
        child,
        node,
        context,
        // 只有一个子节点，如果是则禁止提升
        // 原因：v-for 的单个子节点必须是一个块（block），因为 v-for 指令需要在 DOM 中创建和管理多个元素
        child.children.length === 1,
        true,
      )

      // 递归处理 v-if 条件判断节点
    } else if (child.type === NodeTypes.IF) {
      // 遍历 v-if 节点的所有分支，包括 if、else-if 和 else
      for (let i = 0; i < child.branches.length; i++) {
        // Do not hoist v-if single child because it has to be a block
        walk(
          child.branches[i],
          node,
          context,
          // 只有一个子节点，禁止提升
          // 原因：v-if 的单个子节点必须是一个块（block），因为 v-if 指令需要在 DOM 中创建和销毁元素
          child.branches[i].children.length === 1,
          inFor,
        )
      }
    }
  }

  let cachedAsArray = false // 缓存标识

  // 所有子节点都可缓存 并且 当前节点是元素节点
  if (toCache.length === children.length && node.type === NodeTypes.ELEMENT) {
    if (
      node.tagType === ElementTypes.ELEMENT && // 普通 HTML 元素
      node.codegenNode &&
      node.codegenNode.type === NodeTypes.VNODE_CALL && // 代码生成节点是虚拟节点调用
      isArray(node.codegenNode.children) // 节点是数组形式
    ) {
      // all children were hoisted - the entire children array is cacheable.
      // 对整个子节点数组进行缓存
      node.codegenNode.children = getCacheExpression(
        createArrayExpression(node.codegenNode.children),
      )
      cachedAsArray = true // 标记为已缓存
    } else if (
      node.tagType === ElementTypes.COMPONENT && // 组件
      node.codegenNode &&
      node.codegenNode.type === NodeTypes.VNODE_CALL && // 代码生成节点是虚拟节点调用
      node.codegenNode.children && // 子节点存在
      !isArray(node.codegenNode.children) && // 子节点不是数组形式
      // 子节点是 JavaScript 对象表达式
      node.codegenNode.children.type === NodeTypes.JS_OBJECT_EXPRESSION
    ) {
      // default slot
      // 获取名称为 'default' 的默认插槽
      const slot = getSlotNode(node.codegenNode, 'default')
      if (slot) {
        slot.returns = getCacheExpression(
          createArrayExpression(slot.returns as TemplateChildNode[]),
        )
        cachedAsArray = true // 标记已缓存
      }
    } else if (
      node.tagType === ElementTypes.TEMPLATE && // 模板
      parent &&
      parent.type === NodeTypes.ELEMENT && // 父节点是元素节点
      parent.tagType === ElementTypes.COMPONENT && // 父节点是组件
      parent.codegenNode &&
      parent.codegenNode.type === NodeTypes.VNODE_CALL && // 代码生成节点是虚拟节点调用
      parent.codegenNode.children && // 子节点存在
      !isArray(parent.codegenNode.children) && // 子节点不是数组形式
      // 子节点是 JavaScript 对象表达式
      parent.codegenNode.children.type === NodeTypes.JS_OBJECT_EXPRESSION
    ) {
      // named <template> slot
      // 获取名称为 'slot' 的插槽名称
      const slotName = findDir(node, 'slot', true)
      const slot =
        slotName &&
        slotName.arg &&
        getSlotNode(parent.codegenNode, slotName.arg)

      if (slot) {
        slot.returns = getCacheExpression(
          createArrayExpression(slot.returns as TemplateChildNode[]),
        )
        cachedAsArray = true // 标记已缓存
      }
    }
  }

  // 未标记缓存
  if (!cachedAsArray) {
    for (const child of toCache) {
      // 对每个子节点进行缓存
      child.codegenNode = context.cache(child.codegenNode!)
    }
  }

  /**
   * 缓存表达式
   * @param value 要缓存的表达式
   * @returns 缓存后的表达式
   */
  function getCacheExpression(value: JSChildNode): CacheExpression {
    // 创建缓存表达式，将传入的 value（通常是静态内容）进行缓存
    const exp = context.cache(value)
    // #6978, #7138, #7114
    // a cached children array inside v-for can caused HMR errors since
    // it might be mutated when mounting the first item
    // 问题：在 v-for 循环中使用缓存的子数组可能导致热模块替换（HMR）错误
    // 原因：当挂载第一个项目时，缓存的数组可能会被修改
    // 解决方法：通过数组展开避免直接修改原始缓存数组
    // #13221
    // fix memory leak in cached array:
    // cached vnodes get replaced by cloned ones during mountChildren,
    // which bind DOM elements. These DOM references persist after unmount,
    // preventing garbage collection. Array spread avoids mutating cached
    // array, preventing memory leaks.
    // 问题：缓存的 vnode 数组可能导致内存泄漏
    // 原因：
    // 1、在 mountChildren 期间，缓存的 vnode 会被克隆的 vnode 替换
    // 2、克隆的 vnode 会绑定 DOM 元素
    // 3、这些 DOM 引用在组件卸载后仍然存在，阻止垃圾回收
    // 解决方法：使用数组展开语法创建新数组，避免修改原始缓存数组，从而防止内存泄漏
    exp.needArraySpread = true // 设置数组展开标志
    return exp
  }

  /**
   * 获取插槽节点
   * @param node 生成代码节点
   * @param name 插槽名称
   * @returns 插槽节点
   */
  function getSlotNode(
    node: VNodeCall,
    name: string | ExpressionNode,
  ): SlotFunctionExpression | undefined {
    if (
      node.children && // 子节点存在
      !isArray(node.children) && // 子节点不是数组形式
      // 子节点是 JavaScript 对象表达式
      node.children.type === NodeTypes.JS_OBJECT_EXPRESSION
    ) {
      const slot = node.children.properties.find(
        // 属性的 key 直接等于 name
        // 属性的 key 是 SimpleExpressionNode 类型，且其 content 属性等于 name
        p => p.key === name || (p.key as SimpleExpressionNode).content === name,
      )
      // 返回其 value 属性（即插槽函数表达式）
      return slot && slot.value
    }
  }

  if (toCache.length && context.transformHoist) {
    // 静态提升
    context.transformHoist(children, context, node)
  }
}

/**
 * 获取节点的常类型
 * @param node 节点
 * @param context 上下文
 * @returns 常类型
 */
export function getConstantType(
  node: TemplateChildNode | SimpleExpressionNode | CacheExpression,
  context: TransformContext,
): ConstantTypes {
  const { constantCache } = context
  switch (node.type) {
    case NodeTypes.ELEMENT:
      if (node.tagType !== ElementTypes.ELEMENT) {
        return ConstantTypes.NOT_CONSTANT
      }
      const cached = constantCache.get(node)
      if (cached !== undefined) {
        return cached
      }
      const codegenNode = node.codegenNode!
      if (codegenNode.type !== NodeTypes.VNODE_CALL) {
        return ConstantTypes.NOT_CONSTANT
      }
      if (
        codegenNode.isBlock &&
        node.tag !== 'svg' &&
        node.tag !== 'foreignObject' &&
        node.tag !== 'math'
      ) {
        return ConstantTypes.NOT_CONSTANT
      }
      if (codegenNode.patchFlag === undefined) {
        let returnType = ConstantTypes.CAN_STRINGIFY

        // Element itself has no patch flag. However we still need to check:

        // 1. Even for a node with no patch flag, it is possible for it to contain
        // non-hoistable expressions that refers to scope variables, e.g. compiler
        // injected keys or cached event handlers. Therefore we need to always
        // check the codegenNode's props to be sure.
        const generatedPropsType = getGeneratedPropsConstantType(node, context)
        if (generatedPropsType === ConstantTypes.NOT_CONSTANT) {
          constantCache.set(node, ConstantTypes.NOT_CONSTANT)
          return ConstantTypes.NOT_CONSTANT
        }
        if (generatedPropsType < returnType) {
          returnType = generatedPropsType
        }

        // 2. its children.
        for (let i = 0; i < node.children.length; i++) {
          const childType = getConstantType(node.children[i], context)
          if (childType === ConstantTypes.NOT_CONSTANT) {
            constantCache.set(node, ConstantTypes.NOT_CONSTANT)
            return ConstantTypes.NOT_CONSTANT
          }
          if (childType < returnType) {
            returnType = childType
          }
        }

        // 3. if the type is not already CAN_SKIP_PATCH which is the lowest non-0
        // type, check if any of the props can cause the type to be lowered
        // we can skip can_patch because it's guaranteed by the absence of a
        // patchFlag.
        if (returnType > ConstantTypes.CAN_SKIP_PATCH) {
          for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i]
            if (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && p.exp) {
              const expType = getConstantType(p.exp, context)
              if (expType === ConstantTypes.NOT_CONSTANT) {
                constantCache.set(node, ConstantTypes.NOT_CONSTANT)
                return ConstantTypes.NOT_CONSTANT
              }
              if (expType < returnType) {
                returnType = expType
              }
            }
          }
        }

        // only svg/foreignObject could be block here, however if they are
        // static then they don't need to be blocks since there will be no
        // nested updates.
        if (codegenNode.isBlock) {
          // except set custom directives.
          for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i]
            if (p.type === NodeTypes.DIRECTIVE) {
              constantCache.set(node, ConstantTypes.NOT_CONSTANT)
              return ConstantTypes.NOT_CONSTANT
            }
          }

          context.removeHelper(OPEN_BLOCK)
          context.removeHelper(
            getVNodeBlockHelper(context.inSSR, codegenNode.isComponent),
          )
          codegenNode.isBlock = false
          context.helper(getVNodeHelper(context.inSSR, codegenNode.isComponent))
        }

        constantCache.set(node, returnType)
        return returnType
      } else {
        constantCache.set(node, ConstantTypes.NOT_CONSTANT)
        return ConstantTypes.NOT_CONSTANT
      }
    case NodeTypes.TEXT:
    case NodeTypes.COMMENT:
      return ConstantTypes.CAN_STRINGIFY
    case NodeTypes.IF:
    case NodeTypes.FOR:
    case NodeTypes.IF_BRANCH:
      return ConstantTypes.NOT_CONSTANT
    case NodeTypes.INTERPOLATION:
    case NodeTypes.TEXT_CALL:
      return getConstantType(node.content, context)
    case NodeTypes.SIMPLE_EXPRESSION:
      return node.constType
    case NodeTypes.COMPOUND_EXPRESSION:
      let returnType = ConstantTypes.CAN_STRINGIFY
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (isString(child) || isSymbol(child)) {
          continue
        }
        const childType = getConstantType(child, context)
        if (childType === ConstantTypes.NOT_CONSTANT) {
          return ConstantTypes.NOT_CONSTANT
        } else if (childType < returnType) {
          returnType = childType
        }
      }
      return returnType
    case NodeTypes.JS_CACHE_EXPRESSION:
      return ConstantTypes.CAN_CACHE
    default:
      if (__DEV__) {
        const exhaustiveCheck: never = node
        exhaustiveCheck
      }
      return ConstantTypes.NOT_CONSTANT
  }
}

const allowHoistedHelperSet = new Set([
  NORMALIZE_CLASS,
  NORMALIZE_STYLE,
  NORMALIZE_PROPS,
  GUARD_REACTIVE_PROPS,
])

function getConstantTypeOfHelperCall(
  value: CallExpression,
  context: TransformContext,
): ConstantTypes {
  if (
    value.type === NodeTypes.JS_CALL_EXPRESSION &&
    !isString(value.callee) &&
    allowHoistedHelperSet.has(value.callee)
  ) {
    const arg = value.arguments[0] as JSChildNode
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      return getConstantType(arg, context)
    } else if (arg.type === NodeTypes.JS_CALL_EXPRESSION) {
      // in the case of nested helper call, e.g. `normalizeProps(guardReactiveProps(exp))`
      return getConstantTypeOfHelperCall(arg, context)
    }
  }
  return ConstantTypes.NOT_CONSTANT
}

function getGeneratedPropsConstantType(
  node: PlainElementNode,
  context: TransformContext,
): ConstantTypes {
  let returnType = ConstantTypes.CAN_STRINGIFY
  const props = getNodeProps(node)
  if (props && props.type === NodeTypes.JS_OBJECT_EXPRESSION) {
    const { properties } = props
    for (let i = 0; i < properties.length; i++) {
      const { key, value } = properties[i]
      const keyType = getConstantType(key, context)
      if (keyType === ConstantTypes.NOT_CONSTANT) {
        return keyType
      }
      if (keyType < returnType) {
        returnType = keyType
      }
      let valueType: ConstantTypes
      if (value.type === NodeTypes.SIMPLE_EXPRESSION) {
        valueType = getConstantType(value, context)
      } else if (value.type === NodeTypes.JS_CALL_EXPRESSION) {
        // some helper calls can be hoisted,
        // such as the `normalizeProps` generated by the compiler for pre-normalize class,
        // in this case we need to respect the ConstantType of the helper's arguments
        valueType = getConstantTypeOfHelperCall(value, context)
      } else {
        valueType = ConstantTypes.NOT_CONSTANT
      }
      if (valueType === ConstantTypes.NOT_CONSTANT) {
        return valueType
      }
      if (valueType < returnType) {
        returnType = valueType
      }
    }
  }
  return returnType
}

function getNodeProps(node: PlainElementNode) {
  const codegenNode = node.codegenNode!
  if (codegenNode.type === NodeTypes.VNODE_CALL) {
    return codegenNode.props
  }
}
