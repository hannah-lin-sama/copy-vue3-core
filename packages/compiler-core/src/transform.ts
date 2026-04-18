import type { TransformOptions } from './options'
import {
  type ArrayExpression,
  type CacheExpression,
  ConstantTypes,
  type DirectiveNode,
  type ElementNode,
  ElementTypes,
  type ExpressionNode,
  type JSChildNode,
  NodeTypes,
  type ParentNode,
  type Property,
  type RootNode,
  type SimpleExpressionNode,
  type TemplateChildNode,
  type TemplateLiteral,
  convertToBlock,
  createCacheExpression,
  createSimpleExpression,
  createVNodeCall,
} from './ast'
import {
  EMPTY_OBJ,
  NOOP,
  PatchFlags,
  camelize,
  capitalize,
  isArray,
  isString,
} from '@vue/shared'
import { defaultOnError, defaultOnWarn } from './errors'
import {
  CREATE_COMMENT,
  FRAGMENT,
  TO_DISPLAY_STRING,
  helperNameMap,
} from './runtimeHelpers'
import { isVSlot } from './utils'
import { cacheStatic, getSingleElementRoot } from './transforms/cacheStatic'
import type { CompilerCompatOptions } from './compat/compatConfig'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext,
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  node: ElementNode,
  context: TransformContext,
  // a platform specific compiler can import the base transform and augment
  // it by passing in this optional argument.
  augmentor?: (ret: DirectiveTransformResult) => DirectiveTransformResult,
) => DirectiveTransformResult

export interface DirectiveTransformResult {
  props: Property[]
  needRuntime?: boolean | symbol
  ssrTagParts?: TemplateLiteral['elements']
}

// A structural directive transform is technically also a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
) => void | (() => void)

export interface ImportItem {
  exp: string | ExpressionNode
  path: string
}

export interface TransformContext
  extends
    Required<Omit<TransformOptions, keyof CompilerCompatOptions>>,
    CompilerCompatOptions {
  selfName: string | null
  root: RootNode
  helpers: Map<symbol, number>
  components: Set<string>
  directives: Set<string>
  hoists: (JSChildNode | null)[]
  imports: ImportItem[]
  temps: number
  cached: (CacheExpression | null)[]
  identifiers: { [name: string]: number | undefined }
  scopes: {
    vFor: number
    vSlot: number
    vPre: number
    vOnce: number
  }
  parent: ParentNode | null
  // we could use a stack but in practice we've only ever needed two layers up
  // so this is more efficient
  grandParent: ParentNode | null
  childIndex: number
  currentNode: RootNode | TemplateChildNode | null
  inVOnce: boolean
  helper<T extends symbol>(name: T): T
  removeHelper<T extends symbol>(name: T): void
  helperString(name: symbol): string
  replaceNode(node: TemplateChildNode): void
  removeNode(node?: TemplateChildNode): void
  onNodeRemoved(): void
  addIdentifiers(exp: ExpressionNode | string): void
  removeIdentifiers(exp: ExpressionNode | string): void
  hoist(exp: string | JSChildNode | ArrayExpression): SimpleExpressionNode
  cache(exp: JSChildNode, isVNode?: boolean, inVOnce?: boolean): CacheExpression
  constantCache: WeakMap<TemplateChildNode, ConstantTypes>

  // 2.x Compat only
  filters?: Set<string>
}

/**
 * 创建编译转换的上下文对象
 * @param root 编译的根节点，通常是模板的 AST 根节点
 * @param param 编译转换的配置选项
 * @returns
 */
export function createTransformContext(
  root: RootNode,
  {
    filename = '', // 当前编译的文件名
    prefixIdentifiers = false, // 是否为标识符添加前缀
    hoistStatic = false, // 是否提升静态内容
    hmr = false, // 是否开启热模块替换（HMR）
    cacheHandlers = false, // 是否缓存事件处理器
    nodeTransforms = [], // 节点转换函数数组
    directiveTransforms = {}, // 指令转换函数对象
    transformHoist = null, // 静态内容提升的转换器
    isBuiltInComponent = NOOP, // 是否为内置组件
    isCustomElement = NOOP, // 是否为自定义元素
    expressionPlugins = [], // 表达式插件数组
    scopeId = null, // 当前作用域的 ID
    slotted = true, // 是否为插槽
    ssr = false, // 是否为服务端渲染
    inSSR = false, // 是否在服务端渲染中
    ssrCssVars = ``, // 服务端渲染时的 CSS 变量
    bindingMetadata = EMPTY_OBJ, // 绑定元数据对象
    inline = false, // 是否内联
    isTS = false, // 是否为 TypeScript 代码
    onError = defaultOnError, // 错误处理函数
    onWarn = defaultOnWarn, // 警告处理函数
    compatConfig, // 兼容配置对象
  }: TransformOptions,
): TransformContext {
  const nameMatch = filename.replace(/\?.*$/, '').match(/([^/\\]+)\.\w+$/)
  const context: TransformContext = {
    // options
    filename,
    selfName: nameMatch && capitalize(camelize(nameMatch[1])),
    prefixIdentifiers,
    hoistStatic,
    hmr,
    cacheHandlers,
    nodeTransforms,
    directiveTransforms,
    transformHoist,
    isBuiltInComponent,
    isCustomElement,
    expressionPlugins,
    scopeId,
    slotted,
    ssr,
    inSSR,
    ssrCssVars,
    bindingMetadata,
    inline,
    isTS,
    onError,
    onWarn,
    compatConfig,

    // state
    root,
    helpers: new Map(), // 辅助函数映射
    components: new Set(), // 组件集合
    directives: new Set(), // 指令集合
    hoists: [], // 提升的静态内容
    imports: [], // 导入的模块
    cached: [], // 缓存的表达式
    constantCache: new WeakMap(), // 常量缓存
    temps: 0, // 临时变量计数器
    identifiers: Object.create(null), // 标识符使用情况
    scopes: {
      vFor: 0,
      vSlot: 0,
      vPre: 0,
      vOnce: 0,
    },
    parent: null, // 当前节点的父节点
    grandParent: null, // 当前节点的祖父节点
    currentNode: root, // 当前处理的节点
    childIndex: 0, // 当前子节点的索引
    inVOnce: false, // 是否在 v-once 中

    // methods
    /**
     * 注册并返回辅助函数
     * @param name 辅助函数的名称
     * @returns 辅助函数的名称
     */
    helper(name) {
      const count = context.helpers.get(name) || 0
      context.helpers.set(name, count + 1)
      return name
    },
    /**
     * 移除辅助函数的引用计数
     * @param name 辅助函数的名称
     */
    removeHelper(name) {
      const count = context.helpers.get(name)
      if (count) {
        const currentCount = count - 1
        if (!currentCount) {
          context.helpers.delete(name)
        } else {
          context.helpers.set(name, currentCount)
        }
      }
    },
    /**
     * 获取辅助函数的字符串表示
     * @param name 辅助函数的名称
     * @returns 辅助函数的字符串表示
     */
    helperString(name) {
      return `_${helperNameMap[context.helper(name)]}`
    },
    /**
     * 替换当前节点为指定节点
     * @param node 新节点
     */
    replaceNode(node) {
      /* v8 ignore start */
      if (__DEV__) {
        // 不存在则抛出错误（节点已被移除）
        if (!context.currentNode) {
          throw new Error(`Node being replaced is already removed.`)
        }
        // 不存在则抛出错误（不能替换根节点）
        if (!context.parent) {
          throw new Error(`Cannot replace root node.`)
        }
      }
      /* v8 ignore stop */
      context.parent!.children[context.childIndex] = context.currentNode = node
    },
    /**
     * 移除当前节点或指定节点
     * @param node
     */
    removeNode(node) {
      /* v8 ignore next 3 */
      // 不存在则抛出错误（不能移除根节点）
      if (__DEV__ && !context.parent) {
        throw new Error(`Cannot remove root node.`)
      }
      const list = context.parent!.children
      // 计算移除索引
      const removalIndex = node
        ? list.indexOf(node)
        : context.currentNode
          ? context.childIndex
          : -1
      /* v8 ignore next 3 */
      // 找不到节点，则抛出错误
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      // 当前节点被移除：如果没有提供 node 参数或 node 是当前节点
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed
        // 兄弟节点被移除：如果 node 是当前节点的兄弟节点
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      // 从父节点的子数组中移除指定索引的节点
      context.parent!.children.splice(removalIndex, 1)
    },
    onNodeRemoved: NOOP,
    /**
     * 添加标识符引用计数
     * @param exp 表达式节点
     */
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (isString(exp)) {
          addId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    /**
     * 移除标识符引用计数
     * @param exp 表达式节点
     */
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (isString(exp)) {
          removeId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    /**
     * 提升静态内容
     * @param exp 表达式节点
     * @returns
     */
    hoist(exp) {
      // 如果输入 exp 是字符串，将其转换为简单表达式节点
      if (isString(exp)) exp = createSimpleExpression(exp)
      // 存储所有提升的静态内容
      context.hoists.push(exp)
      // 创建一个新的简单表达式节点作为标识符
      const identifier = createSimpleExpression(
        // 标识符名称为 _hoisted_ 加上提升数组的长度（确保唯一性）
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc,
        ConstantTypes.CAN_CACHE, // 缓存
      )
      // 关联提升的表达式
      identifier.hoisted = exp
      return identifier
    },
    /**
     * 缓存表达式节点
     * @param exp 表达式节点
     * @param isVNode 是否为 vnode
     * @param inVOnce 是否在 v-once 中
     * @returns
     */
    cache(exp, isVNode = false, inVOnce = false) {
      // 创建缓存表达式节点
      const cacheExp = createCacheExpression(
        context.cached.length,
        exp,
        isVNode,
        inVOnce,
      )
      // 存储所有缓存的表达式节点
      context.cached.push(cacheExp)
      return cacheExp
    },
  }

  if (__COMPAT__) {
    context.filters = new Set()
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    identifiers[id]!++
  }

  function removeId(id: string) {
    context.identifiers[id]!--
  }

  return context
}

export function transform(root: RootNode, options: TransformOptions): void {
  const context = createTransformContext(root, options)
  traverseNode(root, context)
  if (options.hoistStatic) {
    cacheStatic(root, context)
  }
  if (!options.ssr) {
    createRootCodegen(root, context)
  }
  // finalize meta information
  root.helpers = new Set([...context.helpers.keys()])
  root.components = [...context.components]
  root.directives = [...context.directives]
  root.imports = context.imports
  root.hoists = context.hoists
  root.temps = context.temps
  root.cached = context.cached
  root.transformed = true

  if (__COMPAT__) {
    root.filters = [...context.filters!]
  }
}

function createRootCodegen(root: RootNode, context: TransformContext) {
  const { helper } = context
  const { children } = root
  if (children.length === 1) {
    const singleElementRootChild = getSingleElementRoot(root)
    // if the single child is an element, turn it into a block.
    if (singleElementRootChild && singleElementRootChild.codegenNode) {
      // single element root is never hoisted so codegenNode will never be
      // SimpleExpressionNode
      const codegenNode = singleElementRootChild.codegenNode
      if (codegenNode.type === NodeTypes.VNODE_CALL) {
        convertToBlock(codegenNode, context)
      }
      root.codegenNode = codegenNode
    } else {
      // - single <slot/>, IfNode, ForNode: already blocks.
      // - single text node: always patched.
      // root codegen falls through via genNode()
      root.codegenNode = children[0]
    }
  } else if (children.length > 1) {
    // root has multiple nodes - return a fragment block.
    let patchFlag = PatchFlags.STABLE_FRAGMENT
    // check if the fragment actually contains a single valid child with
    // the rest being comments
    if (
      __DEV__ &&
      children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
    ) {
      patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
    }
    root.codegenNode = createVNodeCall(
      context,
      helper(FRAGMENT),
      undefined,
      root.children,
      patchFlag,
      undefined,
      undefined,
      true,
      undefined,
      false /* isComponent */,
    )
  } else {
    // no children = noop. codegen will return null.
  }
}

export function traverseChildren(
  parent: ParentNode,
  context: TransformContext,
): void {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (isString(child)) continue
    context.grandParent = context.parent
    context.parent = parent
    context.childIndex = i
    context.onNodeRemoved = nodeRemoved
    traverseNode(child, context)
  }
}

export function traverseNode(
  node: RootNode | TemplateChildNode,
  context: TransformContext,
): void {
  context.currentNode = node
  // apply transform plugins
  const { nodeTransforms } = context
  const exitFns = []
  for (let i = 0; i < nodeTransforms.length; i++) {
    const onExit = nodeTransforms[i](node, context)
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    if (!context.currentNode) {
      // node was removed
      return
    } else {
      // node may have been replaced
      node = context.currentNode
    }
  }

  switch (node.type) {
    case NodeTypes.COMMENT:
      if (!context.ssr) {
        // inject import for the Comment symbol, which is needed for creating
        // comment nodes with `createVNode`
        context.helper(CREATE_COMMENT)
      }
      break
    case NodeTypes.INTERPOLATION:
      // no need to traverse, but we need to inject toString helper
      if (!context.ssr) {
        context.helper(TO_DISPLAY_STRING)
      }
      break

    // for container types, further traverse downwards
    case NodeTypes.IF:
      for (let i = 0; i < node.branches.length; i++) {
        traverseNode(node.branches[i], context)
      }
      break
    case NodeTypes.IF_BRANCH:
    case NodeTypes.FOR:
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT:
      traverseChildren(node, context)
      break
  }

  // exit transforms
  context.currentNode = node
  let i = exitFns.length
  while (i--) {
    exitFns[i]()
  }
}

/**
 * 创建结构指令转换器
 * @param name
 * @param fn
 * @returns
 */
export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform,
): NodeTransform {
  // 根据指令名称类型，生成对应的匹配函数
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  return (node, context) => {
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      // structural directive transforms are not concerned with slots
      // as they are handled separately in vSlot.ts
      if (node.tagType === ElementTypes.TEMPLATE && props.some(isVSlot)) {
        // 跳过包含 v-slot 指令的模板元素（因为 v-slot 有专门的处理逻辑
        return
      }
      const exitFns = []
      // 遍历节点的所有属性
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]

        // 如果属性是指令且指令名称匹配
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around
          // 从属性列表中移除匹配的指令，避免无限递归
          props.splice(i, 1)
          i--
          // 调用传入的转换函数 fn 处理指令
          const onExit = fn(node, prop, context)
          if (onExit) exitFns.push(onExit)
        }
      }
      return exitFns
    }
  }
}
