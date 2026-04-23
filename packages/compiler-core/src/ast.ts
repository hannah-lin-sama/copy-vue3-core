import { type PatchFlags, isString } from '@vue/shared'
import {
  CREATE_BLOCK,
  CREATE_ELEMENT_BLOCK,
  CREATE_ELEMENT_VNODE,
  type CREATE_SLOTS,
  CREATE_VNODE,
  type FRAGMENT,
  OPEN_BLOCK,
  type RENDER_LIST,
  type RENDER_SLOT,
  WITH_DIRECTIVES,
  type WITH_MEMO,
} from './runtimeHelpers'
import type { PropsExpression } from './transforms/transformElement'
import type { ImportItem, TransformContext } from './transform'
import type { Node as BabelNode } from '@babel/types'

// Vue template is a platform-agnostic superset of HTML (syntax only).
// More namespaces can be declared by platform specific compilers.
export type Namespace = number

export enum Namespaces {
  HTML,
  SVG,
  MATH_ML,
}

export enum NodeTypes {
  ROOT, // 0 根节点，整个模板入口
  ELEMENT, // 1 元素节点 ，如 <div>、<span> 等 HTML 元素或 Vue 组件
  TEXT, // 2 文本节点，如普通文本内容
  COMMENT, // 3 注释节点，如 <!-- comment -->
  SIMPLE_EXPRESSION, // 4 简单表达式节点，如 message
  INTERPOLATION, // 5 插值节点，如 {{ message }}
  ATTRIBUTE, // 6 属性节点，如 v-model
  DIRECTIVE, // 7 指令节点，如 v-if

  // containers
  COMPOUND_EXPRESSION, // 8 复合表达式节点，由多个表达式组成
  IF, // 9 条件节点，如 v-if
  IF_BRANCH, // 10 条件分支节点，如 v-else、v-else-if
  FOR, // 11 循环节点，如 v-for
  TEXT_CALL, // 12 文本调用节点，用于处理带表达式的文本
  // codegen
  VNODE_CALL, // 13 VNode 调用节点，用于创建 VNode 实例
  JS_CALL_EXPRESSION, // 14 调用表达式节点，如 function() 或 method()
  JS_OBJECT_EXPRESSION, // 15 JS对象表达式
  JS_PROPERTY, // 16 JS属性表达式，如 obj.prop
  JS_ARRAY_EXPRESSION, // 17 JS数组表达式，如 [1, 2, 3]
  JS_FUNCTION_EXPRESSION, // 18 JS函数表达式，如 function() {}
  JS_CONDITIONAL_EXPRESSION, // 19 条件表达式，如 a ? b : c
  JS_CACHE_EXPRESSION, // 20 缓存表达式，用于缓存计算结果

  // ssr codegen
  JS_BLOCK_STATEMENT,
  JS_TEMPLATE_LITERAL,
  JS_IF_STATEMENT,
  JS_ASSIGNMENT_EXPRESSION,
  JS_SEQUENCE_EXPRESSION,
  JS_RETURN_STATEMENT,
}

export enum ElementTypes {
  ELEMENT,
  COMPONENT,
  SLOT,
  TEMPLATE,
}

export interface Node {
  type: NodeTypes
  loc: SourceLocation
}

// The node's range. The `start` is inclusive and `end` is exclusive.
// [start, end)
export interface SourceLocation {
  start: Position
  end: Position
  source: string
}

export interface Position {
  offset: number // from start of file
  line: number
  column: number
}

export type ParentNode = RootNode | ElementNode | IfBranchNode | ForNode

export type ExpressionNode = SimpleExpressionNode | CompoundExpressionNode

// 模板中可能出现的各种子节点类型
export type TemplateChildNode =
  | ElementNode // 元素节点，如 <div>、<span> 等 HTML 元素或 Vue 组件
  | InterpolationNode // 插值节点，如 {{ message }}
  | CompoundExpressionNode // 复合表达式节点，由多个表达式组成
  | TextNode // 文本节点，如普通文本内容
  | CommentNode // 注释节点，如 <!-- comment -->
  | IfNode // 条件节点，如 v-if
  | IfBranchNode // 条件分支节点，如 v-else、v-else-if
  | ForNode // 循环节点，如 v-for
  | TextCallNode // 文本调用节点，用于处理带表达式的文本

export interface RootNode extends Node {
  type: NodeTypes.ROOT
  source: string
  children: TemplateChildNode[]
  helpers: Set<symbol>
  components: string[]
  directives: string[]
  hoists: (JSChildNode | null)[]
  imports: ImportItem[]
  cached: (CacheExpression | null)[]
  temps: number
  ssrHelpers?: symbol[]
  codegenNode?: TemplateChildNode | JSChildNode | BlockStatement
  transformed?: boolean

  // v2 compat only
  filters?: string[]
}

export type ElementNode =
  | PlainElementNode // 普通元素节点，如 HTML 内置标签（<div>、<span> 等）
  | ComponentNode // 组件节点，如 Vue 组件（<MyComponent>）
  | SlotOutletNode // 插槽出口节点，如 <slot> 元素
  | TemplateNode // 模板节点，如 <template> 元素

export interface BaseElementNode extends Node {
  type: NodeTypes.ELEMENT
  ns: Namespace
  tag: string
  tagType: ElementTypes
  props: Array<AttributeNode | DirectiveNode>
  children: TemplateChildNode[]
  isSelfClosing?: boolean
  innerLoc?: SourceLocation // only for SFC root level elements
}

export interface PlainElementNode extends BaseElementNode {
  tagType: ElementTypes.ELEMENT
  codegenNode:
    | VNodeCall
    | SimpleExpressionNode // when hoisted
    | CacheExpression // when cached by v-once
    | MemoExpression // when cached by v-memo
    | undefined
  ssrCodegenNode?: TemplateLiteral
}

export interface ComponentNode extends BaseElementNode {
  tagType: ElementTypes.COMPONENT
  codegenNode:
    | VNodeCall
    | CacheExpression // when cached by v-once
    | MemoExpression // when cached by v-memo
    | undefined
  ssrCodegenNode?: CallExpression
}

export interface SlotOutletNode extends BaseElementNode {
  tagType: ElementTypes.SLOT
  codegenNode:
    | RenderSlotCall
    | CacheExpression // when cached by v-once
    | undefined
  ssrCodegenNode?: CallExpression
}

export interface TemplateNode extends BaseElementNode {
  tagType: ElementTypes.TEMPLATE
  // TemplateNode is a container type that always gets compiled away
  codegenNode: undefined
}

export interface TextNode extends Node {
  type: NodeTypes.TEXT
  content: string
}

export interface CommentNode extends Node {
  type: NodeTypes.COMMENT
  content: string
}

export interface AttributeNode extends Node {
  type: NodeTypes.ATTRIBUTE
  name: string
  nameLoc: SourceLocation
  value: TextNode | undefined
}

export interface DirectiveNode extends Node {
  /**
   * 指令节点类型
   */
  type: NodeTypes.DIRECTIVE
  /**
   * the normalized name without prefix or shorthands, e.g. "bind", "on"
   * 指令名称，不包含前缀或短语
   */
  name: string
  /**
   * the raw attribute name, preserving shorthand, and including arg & modifiers
   * this is only used during parse.
   * 原始名称
   */
  rawName?: string
  // 事件处理表达式
  exp: ExpressionNode | undefined
  // 事件处理参数
  arg: ExpressionNode | undefined
  // 事件处理修饰符
  modifiers: SimpleExpressionNode[]
  /**
   * optional property to cache the expression parse result for v-for
   * 用于缓存 v-for 指令的表达式解析结果的可选属性
   */
  forParseResult?: ForParseResult
}

/**
 * Static types have several levels.
 * Higher levels implies lower levels. e.g. a node that can be stringified
 * can always be hoisted and skipped for patch.
 */
export enum ConstantTypes {
  NOT_CONSTANT = 0, // 非常量表达式，在编译时无法确定其值
  CAN_SKIP_PATCH, // 1 可以跳过补丁的常量，通常是静态节点
  CAN_CACHE, // 2 可以缓存的常量，其值在编译时已知
  CAN_STRINGIFY, // 3 可以字符串化的常量，其值可以在编译时转换为字符串
}

// 表示模板中的简单表达式节点
export interface SimpleExpressionNode extends Node {
  type: NodeTypes.SIMPLE_EXPRESSION
  // 存储表达式的原始内容
  // 对于 {{ message }}，content 为 "message"
  // 对于指令：对于 v-bind:id="userId"，content 为 "userId"
  content: string
  // 是否为静态表达式
  isStatic: boolean
  // 常量类型
  constType: ConstantTypes
  /**
   * - `null` means the expression is a simple identifier that doesn't need
   *    parsing
   * - `false` means there was a parsing error
   * 存储表达式的抽象语法树
   */
  ast?: BabelNode | null | false
  /**
   * Indicates this is an identifier for a hoist vnode call and points to the
   * hoisted node.
   * 标记表达式是否为提升的 vnode 调用
   */
  hoisted?: JSChildNode
  /**
   * an expression parsed as the params of a function will track
   * the identifiers declared inside the function body.
   * 跟踪函数参数中声明的标识符
   * 示例：对于 (item, index) => item.name，identifiers 为 ["item", "index"]
   */
  identifiers?: string[]
  // 标记表达式是否为事件处理器的键
  isHandlerKey?: boolean
}

export interface InterpolationNode extends Node {
  type: NodeTypes.INTERPOLATION
  content: ExpressionNode
}

export interface CompoundExpressionNode extends Node {
  type: NodeTypes.COMPOUND_EXPRESSION
  /**
   * - `null` means the expression is a simple identifier that doesn't need
   *    parsing
   * - `false` means there was a parsing error
   */
  ast?: BabelNode | null | false
  children: (
    | SimpleExpressionNode
    | CompoundExpressionNode
    | InterpolationNode
    | TextNode
    | string
    | symbol
  )[]

  /**
   * an expression parsed as the params of a function will track
   * the identifiers declared inside the function body.
   */
  identifiers?: string[]
  isHandlerKey?: boolean
}

// 表示 if 条件节点
export interface IfNode extends Node {
  type: NodeTypes.IF
  // 存储条件分支数组，每个分支对应一个 v-if、v-else-if 或 v-else 指令
  branches: IfBranchNode[]
  // 存储代码生成阶段的中间结果
  codegenNode?: IfConditionalExpression | CacheExpression // <div v-if v-once>
}

// 表示 if 分支节点
export interface IfBranchNode extends Node {
  type: NodeTypes.IF_BRANCH
  // 存储分支的条件表达式
  condition: ExpressionNode | undefined // else
  // 存储分支的子节点，即条件为真时要渲染的内容
  children: TemplateChildNode[]
  // 存储用户为条件分支提供的键，用于优化虚拟 DOM 更新
  userKey?: AttributeNode | DirectiveNode
  // 标记该分支是否来自 <template> 元素的 v-if 指令
  isTemplateIf?: boolean
}

// 表示 v-for 循环节点
export interface ForNode extends Node {
  type: NodeTypes.FOR
  // 存储遍历的数据源表达式
  // v-for="item in items"：source 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'items' }
  source: ExpressionNode
  // 存储遍历项的别名
  // v-for="item in items"：valueAlias 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'item' }
  valueAlias: ExpressionNode | undefined
  // 存储键的别名（数组索引或对象键）
  // v-for="(item, index) in items"：keyAlias 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'index' }
  // v-for="(value, key) in object"：keyAlias 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'key' }
  keyAlias: ExpressionNode | undefined
  // 存储对象索引的别名（仅在遍历对象时使用）
  // v-for="(value, key, index) in object"：
  // objectIndexAlias 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'index' }
  objectIndexAlias: ExpressionNode | undefined
  // 存储 v-for 指令的解析结果
  parseResult: ForParseResult
  // 存储循环的子节点，即 v-for 循环的内容
  children: TemplateChildNode[]
  // 存储代码生成阶段的中间结果
  codegenNode?: ForCodegenNode
}

// 表示 v-for 循环解析结果
export interface ForParseResult {
  // 存储 v-for 指令中的数据源表达式
  // v-for="item in items"：source 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'items' }
  source: ExpressionNode
  // 存储 v-for 指令中的值别名
  // v-for="item in items"：value 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'item' }
  value: ExpressionNode | undefined
  // 存储 v-for 指令中的键别名
  // v-for="(item, index) in items"：key 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'index' }
  key: ExpressionNode | undefined
  // 存储 v-for 指令中的索引别名（仅在遍历对象时使用）
  // v-for="(value, key, index) in object"：index 为 { type: NodeTypes.SIMPLE_EXPRESSION, content: 'index' }
  index: ExpressionNode | undefined
  // 标记解析是否已完成
  finalized: boolean
}

// 表示需要运行时处理的文本内容
export interface TextCallNode extends Node {
  type: NodeTypes.TEXT_CALL
  // 存储文本内容，可以是以下类型
  // TextNode：纯文本节点
  // InterpolationNode：插值表达式节点（如 {{ message }}）
  // CompoundExpressionNode：复合表达式节点（包含多个表达式的组合）
  content: TextNode | InterpolationNode | CompoundExpressionNode
  // 存储代码生成阶段的中间结果
  codegenNode: CallExpression | SimpleExpressionNode // when hoisted
}

export type TemplateTextChildNode =
  | TextNode
  | InterpolationNode
  | CompoundExpressionNode

// 表示编译后生成的虚拟 DOM 节点调用
export interface VNodeCall extends Node {
  type: NodeTypes.VNODE_CALL
  // 表示虚拟节点的标签
  // string：普通 HTML 标签或组件名称
  // symbol：内置组件（如 Fragment、Teleport 等）
  // CallExpression：动态组件或复杂表达式
  tag: string | symbol | CallExpression
  // 表示虚拟节点的属性
  props: PropsExpression | undefined
  children:
    | TemplateChildNode[] // multiple children 多个子节点
    | TemplateTextChildNode // single text child 单个文本子节点
    | SlotsExpression // component slots 组件插槽
    | ForRenderListExpression // v-for fragment call v-for 片段调用
    | SimpleExpressionNode // hoisted 提升表达式
    | CacheExpression // cached 缓存表达式
    | undefined // 没有子节点
  // 虚拟 DOM 更新优化标志
  patchFlag: PatchFlags | undefined
  // 动态属性信息
  dynamicProps: string | SimpleExpressionNode | undefined
  // 指令参数
  directives: DirectiveArguments | undefined
  isBlock: boolean // 是否为块级元素
  disableTracking: boolean // 是否禁用跟踪
  isComponent: boolean // 是否为组件节点
}

// JS Node Types ---------------------------------------------------------------

// We also include a number of JavaScript AST nodes for code generation.
// The AST is an intentionally minimal subset just to meet the exact needs of
// Vue render function generation.
// 表示代码生成阶段可能生成的各种 JavaScript 节点类型
export type JSChildNode =
  | VNodeCall // 虚拟节点调用
  | CallExpression // 函数调用表达式，如 foo()、bar(1, 2)
  | ObjectExpression // 对象表达式，如 { key: value, foo: bar }
  | ArrayExpression // 数组表达式，如 [1, 2, 3]
  | ExpressionNode // 表达式节点，包括简单表达式和复合表达式
  | FunctionExpression // 函数表达式，如 () => {}、function() {}
  | ConditionalExpression // 条件表达式，如 condition ? trueValue : falseValue
  | CacheExpression // 缓存表达式，用于缓存计算结果
  | AssignmentExpression // 赋值表达式，如 a = b、a += b
  | SequenceExpression // 序列表达式，如 a, b, c

export interface CallExpression extends Node {
  type: NodeTypes.JS_CALL_EXPRESSION
  callee: string | symbol
  arguments: (
    | string
    | symbol
    | JSChildNode
    | SSRCodegenNode
    | TemplateChildNode
    | TemplateChildNode[]
  )[]
}

export interface ObjectExpression extends Node {
  type: NodeTypes.JS_OBJECT_EXPRESSION
  properties: Array<Property>
}

export interface Property extends Node {
  type: NodeTypes.JS_PROPERTY
  key: ExpressionNode
  value: JSChildNode
}

export interface ArrayExpression extends Node {
  type: NodeTypes.JS_ARRAY_EXPRESSION
  elements: Array<string | Node>
}

export interface FunctionExpression extends Node {
  type: NodeTypes.JS_FUNCTION_EXPRESSION
  params: ExpressionNode | string | (ExpressionNode | string)[] | undefined
  returns?: TemplateChildNode | TemplateChildNode[] | JSChildNode
  body?: BlockStatement | IfStatement
  newline: boolean
  /**
   * This flag is for codegen to determine whether it needs to generate the
   * withScopeId() wrapper
   */
  isSlot: boolean
  /**
   * __COMPAT__ only, indicates a slot function that should be excluded from
   * the legacy $scopedSlots instance property.
   */
  isNonScopedSlot?: boolean
}

export interface ConditionalExpression extends Node {
  // 节点类型，值为 19，标识这是一个条件表达式节点
  type: NodeTypes.JS_CONDITIONAL_EXPRESSION
  // 条件测试表达式，对应三元表达式中的 condition 部分
  test: JSChildNode
  // 条件为真时的表达式，对应三元表达式中的 trueValue 部分
  consequent: JSChildNode
  // 条件为假时的表达式，对应三元表达式中的 falseValue 部分
  alternate: JSChildNode
  // 代码生成时是否需要换行，用于格式化输出
  newline: boolean
}

export interface CacheExpression extends Node {
  // 节点类型，值为 20，标识这是一个缓存表达式节点
  type: NodeTypes.JS_CACHE_EXPRESSION
  // 缓存索引，用于在生成的代码中标识缓存位置
  index: number
  // 要缓存的表达式值，可以是任何 JavaScript 子节点类型
  value: JSChildNode
  // 是否需要暂停依赖跟踪，用于响应式系统的优化
  needPauseTracking: boolean
  // 是否在 v-once 指令中，用于特殊处理
  inVOnce: boolean
  // 是否需要数组展开，用于处理数组类型的缓存值
  needArraySpread: boolean
}

export interface MemoExpression extends CallExpression {
  callee: typeof WITH_MEMO
  arguments: [ExpressionNode, MemoFactory, string, string]
}

interface MemoFactory extends FunctionExpression {
  returns: BlockCodegenNode
}

// SSR-specific Node Types -----------------------------------------------------

export type SSRCodegenNode =
  | BlockStatement
  | TemplateLiteral
  | IfStatement
  | AssignmentExpression
  | ReturnStatement
  | SequenceExpression

export interface BlockStatement extends Node {
  type: NodeTypes.JS_BLOCK_STATEMENT
  body: (JSChildNode | IfStatement)[]
}

export interface TemplateLiteral extends Node {
  type: NodeTypes.JS_TEMPLATE_LITERAL
  elements: (string | JSChildNode)[]
}

export interface IfStatement extends Node {
  type: NodeTypes.JS_IF_STATEMENT
  test: ExpressionNode
  consequent: BlockStatement
  alternate: IfStatement | BlockStatement | ReturnStatement | undefined
}

export interface AssignmentExpression extends Node {
  type: NodeTypes.JS_ASSIGNMENT_EXPRESSION
  left: SimpleExpressionNode
  right: JSChildNode
}

export interface SequenceExpression extends Node {
  type: NodeTypes.JS_SEQUENCE_EXPRESSION
  expressions: JSChildNode[]
}

export interface ReturnStatement extends Node {
  type: NodeTypes.JS_RETURN_STATEMENT
  returns: TemplateChildNode | TemplateChildNode[] | JSChildNode
}

// Codegen Node Types ----------------------------------------------------------

export interface DirectiveArguments extends ArrayExpression {
  elements: DirectiveArgumentNode[]
}

export interface DirectiveArgumentNode extends ArrayExpression {
  elements: // dir, exp, arg, modifiers
    | [string]
    | [string, ExpressionNode]
    | [string, ExpressionNode, ExpressionNode]
    | [string, ExpressionNode, ExpressionNode, ObjectExpression]
}

// renderSlot(...)
export interface RenderSlotCall extends CallExpression {
  callee: typeof RENDER_SLOT
  arguments: // $slots, name, props, fallback
    | [string, string | ExpressionNode]
    | [string, string | ExpressionNode, PropsExpression]
    | [
        string,
        string | ExpressionNode,
        PropsExpression | '{}',
        TemplateChildNode[],
      ]
}

export type SlotsExpression = SlotsObjectExpression | DynamicSlotsExpression

// { foo: () => [...] }
export interface SlotsObjectExpression extends ObjectExpression {
  properties: SlotsObjectProperty[]
}

export interface SlotsObjectProperty extends Property {
  value: SlotFunctionExpression
}

export interface SlotFunctionExpression extends FunctionExpression {
  returns: TemplateChildNode[] | CacheExpression
}

// createSlots({ ... }, [
//    foo ? () => [] : undefined,
//    renderList(list, i => () => [i])
// ])
export interface DynamicSlotsExpression extends CallExpression {
  callee: typeof CREATE_SLOTS
  arguments: [SlotsObjectExpression, DynamicSlotEntries]
}

export interface DynamicSlotEntries extends ArrayExpression {
  elements: (ConditionalDynamicSlotNode | ListDynamicSlotNode)[]
}

export interface ConditionalDynamicSlotNode extends ConditionalExpression {
  consequent: DynamicSlotNode
  alternate: DynamicSlotNode | SimpleExpressionNode
}

export interface ListDynamicSlotNode extends CallExpression {
  callee: typeof RENDER_LIST
  arguments: [ExpressionNode, ListDynamicSlotIterator]
}

export interface ListDynamicSlotIterator extends FunctionExpression {
  returns: DynamicSlotNode
}

export interface DynamicSlotNode extends ObjectExpression {
  properties: [Property, DynamicSlotFnProperty]
}

export interface DynamicSlotFnProperty extends Property {
  value: SlotFunctionExpression
}

export type BlockCodegenNode = VNodeCall | RenderSlotCall

export interface IfConditionalExpression extends ConditionalExpression {
  consequent: BlockCodegenNode | MemoExpression
  alternate: BlockCodegenNode | IfConditionalExpression | MemoExpression
}

export interface ForCodegenNode extends VNodeCall {
  // 标记 v-for 生成的节点总是块级节点
  isBlock: true
  // 指定 v-for 生成的节点标签为 FRAGMENT
  tag: typeof FRAGMENT
  // 明确 v-for 生成的片段没有属性
  props: undefined
  // 存储列表渲染的表达式
  children: ForRenderListExpression
  // 存储补丁标志，用于虚拟 DOM 的更新优化
  patchFlag: PatchFlags
  // 标记是否禁用块跟踪
  disableTracking: boolean
}

export interface ForRenderListExpression extends CallExpression {
  // 指定调用的函数为 RENDER_LIST 辅助函数
  callee: typeof RENDER_LIST
  // 第一个元素：ExpressionNode 类型，表示数据源表达式
  // 第二个元素：ForIteratorExpression 类型，表示迭代器表达式
  arguments: [ExpressionNode, ForIteratorExpression]
}

export interface ForIteratorExpression extends FunctionExpression {
  // 存储迭代器函数的返回值类型
  returns?: BlockCodegenNode
}

// AST Utilities ---------------------------------------------------------------

// Some expressions, e.g. sequence and conditional expressions, are never
// associated with template nodes, so their source locations are just a stub.
// Container types like CompoundExpression also don't need a real location.
export const locStub: SourceLocation = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 },
  source: '',
}

/**
 * 创建 AST（抽象语法树）的根节点。
 * 它是编译器在解析模板时创建的第一个节点，作为整个模板的抽象语法树的入口点
 * @param children 模板子节点数组，包含模板中的所有内容
 * @param source 源代码字符串，默认为空字符串
 * @returns
 */
export function createRoot(
  children: TemplateChildNode[],
  source = '',
): RootNode {
  return {
    type: NodeTypes.ROOT, // 节点类型
    source, // 源代码字符串
    children, // 子节点数组，包含模板中的所有内容
    helpers: new Set(), // 辅助函数集合，用于记录编译过程中使用的运行时辅助函数
    components: [], // 组件数组，用于记录模板中使用的组件
    directives: [], // 指令数组，用于记录模板中使用的指令
    hoists: [], // 提升的表达式数组，用于优化编译结果
    imports: [], // 导入数组，用于记录需要导入的模块
    cached: [], // 缓存数组，用于记录需要缓存的表达式
    temps: 0, // 临时变量计数，用于生成唯一的临时变量名
    codegenNode: undefined, // 代码生成节点，用于存储代码生成阶段的结果
    loc: locStub, // 位置信息
  }
}

export function createVNodeCall(
  context: TransformContext | null,
  tag: VNodeCall['tag'],
  props?: VNodeCall['props'],
  children?: VNodeCall['children'],
  patchFlag?: VNodeCall['patchFlag'],
  dynamicProps?: VNodeCall['dynamicProps'],
  directives?: VNodeCall['directives'],
  isBlock: VNodeCall['isBlock'] = false,
  disableTracking: VNodeCall['disableTracking'] = false,
  isComponent: VNodeCall['isComponent'] = false,
  loc: SourceLocation = locStub,
): VNodeCall {
  if (context) {
    if (isBlock) {
      context.helper(OPEN_BLOCK)
      context.helper(getVNodeBlockHelper(context.inSSR, isComponent))
    } else {
      context.helper(getVNodeHelper(context.inSSR, isComponent))
    }
    if (directives) {
      context.helper(WITH_DIRECTIVES)
    }
  }

  return {
    type: NodeTypes.VNODE_CALL,
    tag,
    props,
    children,
    patchFlag,
    dynamicProps,
    directives,
    isBlock,
    disableTracking,
    isComponent,
    loc,
  }
}

export function createArrayExpression(
  elements: ArrayExpression['elements'],
  loc: SourceLocation = locStub,
): ArrayExpression {
  return {
    type: NodeTypes.JS_ARRAY_EXPRESSION,
    loc,
    elements,
  }
}

export function createObjectExpression(
  properties: ObjectExpression['properties'],
  loc: SourceLocation = locStub,
): ObjectExpression {
  return {
    type: NodeTypes.JS_OBJECT_EXPRESSION,
    loc,
    properties,
  }
}

/**
 * 创建对象属性的 AST 节点
 * @param key 属性键，可以是字符串或表达式节点
 * @param value 属性值
 * @returns 创建的属性节点
 */
export function createObjectProperty(
  key: Property['key'] | string,
  value: Property['value'],
): Property {
  return {
    // JavaScript 对象属性节点
    type: NodeTypes.JS_PROPERTY,
    loc: locStub, // 位置信息
    key: isString(key) ? createSimpleExpression(key, true) : key,
    value,
  }
}

/**
 * 创建简单表达式的 AST 节点
 * @param content 表达式内容
 * @param isStatic 是否为静态表达式
 * @param loc 位置信息
 * @param constType 常量类型
 * @returns
 */
export function createSimpleExpression(
  content: SimpleExpressionNode['content'],
  isStatic: SimpleExpressionNode['isStatic'] = false,
  loc: SourceLocation = locStub,
  constType: ConstantTypes = ConstantTypes.NOT_CONSTANT,
): SimpleExpressionNode {
  return {
    // 简单表达式节点
    type: NodeTypes.SIMPLE_EXPRESSION,
    loc,
    content, // 表达式内容
    isStatic, // 是否为静态表达式
    // 可以安全地字符串化
    constType: isStatic ? ConstantTypes.CAN_STRINGIFY : constType,
  }
}

export function createInterpolation(
  content: InterpolationNode['content'] | string,
  loc: SourceLocation,
): InterpolationNode {
  return {
    type: NodeTypes.INTERPOLATION,
    loc,
    content: isString(content)
      ? createSimpleExpression(content, false, loc)
      : content,
  }
}

/**
 * 创建复合表达式节点
 * @param children 子表达式节点数组
 * @param loc 位置信息
 * @returns 复合表达式节点
 */
export function createCompoundExpression(
  children: CompoundExpressionNode['children'],
  loc: SourceLocation = locStub,
): CompoundExpressionNode {
  return {
    type: NodeTypes.COMPOUND_EXPRESSION,
    loc,
    children,
  }
}

type InferCodegenNodeType<T> = T extends typeof RENDER_SLOT
  ? RenderSlotCall
  : CallExpression

/**
 * 创建 JavaScript 调用表达式的 AST 节点
 * @param callee 指定被调用的函数或表达式，可以是标识符、成员表达式等
 * @param args 传递给被调用函数的参数列表
 * @param loc 位置信息
 * @returns
 */
export function createCallExpression<T extends CallExpression['callee']>(
  callee: T,
  args: CallExpression['arguments'] = [],
  loc: SourceLocation = locStub,
): InferCodegenNodeType<T> {
  return {
    type: NodeTypes.JS_CALL_EXPRESSION, // 节点类型为 JavaScript 调用表达式
    loc,
    callee,
    arguments: args,
  } as InferCodegenNodeType<T>
}

export function createFunctionExpression(
  params: FunctionExpression['params'],
  returns: FunctionExpression['returns'] = undefined,
  newline: boolean = false,
  isSlot: boolean = false,
  loc: SourceLocation = locStub,
): FunctionExpression {
  return {
    type: NodeTypes.JS_FUNCTION_EXPRESSION,
    params,
    returns,
    newline,
    isSlot,
    loc,
  }
}

export function createConditionalExpression(
  test: ConditionalExpression['test'],
  consequent: ConditionalExpression['consequent'],
  alternate: ConditionalExpression['alternate'],
  newline = true,
): ConditionalExpression {
  return {
    type: NodeTypes.JS_CONDITIONAL_EXPRESSION,
    test,
    consequent,
    alternate,
    newline,
    loc: locStub,
  }
}

export function createCacheExpression(
  index: number,
  value: JSChildNode,
  needPauseTracking: boolean = false,
  inVOnce: boolean = false,
): CacheExpression {
  return {
    type: NodeTypes.JS_CACHE_EXPRESSION, // 缓存表达式节点
    index, // 缓存索引
    value,
    needPauseTracking: needPauseTracking,
    inVOnce, // 是否在 v-once 中
    needArraySpread: false,
    loc: locStub,
  }
}

export function createBlockStatement(
  body: BlockStatement['body'],
): BlockStatement {
  return {
    type: NodeTypes.JS_BLOCK_STATEMENT,
    body,
    loc: locStub,
  }
}

export function createTemplateLiteral(
  elements: TemplateLiteral['elements'],
): TemplateLiteral {
  return {
    type: NodeTypes.JS_TEMPLATE_LITERAL,
    elements,
    loc: locStub,
  }
}

export function createIfStatement(
  test: IfStatement['test'],
  consequent: IfStatement['consequent'],
  alternate?: IfStatement['alternate'],
): IfStatement {
  return {
    type: NodeTypes.JS_IF_STATEMENT,
    test,
    consequent,
    alternate,
    loc: locStub,
  }
}

export function createAssignmentExpression(
  left: AssignmentExpression['left'],
  right: AssignmentExpression['right'],
): AssignmentExpression {
  return {
    type: NodeTypes.JS_ASSIGNMENT_EXPRESSION,
    left,
    right,
    loc: locStub,
  }
}

export function createSequenceExpression(
  expressions: SequenceExpression['expressions'],
): SequenceExpression {
  return {
    type: NodeTypes.JS_SEQUENCE_EXPRESSION,
    expressions,
    loc: locStub,
  }
}

export function createReturnStatement(
  returns: ReturnStatement['returns'],
): ReturnStatement {
  return {
    type: NodeTypes.JS_RETURN_STATEMENT,
    returns,
    loc: locStub,
  }
}

export function getVNodeHelper(
  ssr: boolean,
  isComponent: boolean,
): typeof CREATE_VNODE | typeof CREATE_ELEMENT_VNODE {
  return ssr || isComponent ? CREATE_VNODE : CREATE_ELEMENT_VNODE
}

export function getVNodeBlockHelper(
  ssr: boolean,
  isComponent: boolean,
): typeof CREATE_BLOCK | typeof CREATE_ELEMENT_BLOCK {
  return ssr || isComponent ? CREATE_BLOCK : CREATE_ELEMENT_BLOCK
}

export function convertToBlock(
  node: VNodeCall,
  { helper, removeHelper, inSSR }: TransformContext,
): void {
  if (!node.isBlock) {
    node.isBlock = true
    removeHelper(getVNodeHelper(inSSR, node.isComponent))
    helper(OPEN_BLOCK)
    helper(getVNodeBlockHelper(inSSR, node.isComponent))
  }
}
