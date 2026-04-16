import type {
  ArrayPattern,
  Identifier,
  LVal,
  Node,
  ObjectPattern,
  RestElement,
} from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'
import {
  type TypeResolveContext,
  resolveTypeElements,
  resolveUnionType,
} from './resolveType'

export const DEFINE_EMITS = 'defineEmits'

/**
 * Vue 3 编译器 SFC (Single File Component) 模块 - 处理 defineEmits 函数调用
 * @param ctx
 * @param node
 * @param declId
 * @returns
 */
export function processDefineEmits(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  // 检查传入的 AST 节点是否为 defineEmits 函数调用
  if (!isCallOf(node, DEFINE_EMITS)) {
    return false
  }
  // 确保组件中只调用一次 defineEmits
  if (ctx.hasDefineEmitCall) {
    ctx.error(`duplicate ${DEFINE_EMITS}() call`, node)
  }
  ctx.hasDefineEmitCall = true // 标记已调用

  // 记录 defineEmits 的第一个参数作为运行时声明
  ctx.emitsRuntimeDecl = node.arguments[0]

  if (node.typeParameters) {
    if (ctx.emitsRuntimeDecl) {
      // 如果同时提供了运行时参数和类型参数，报错
      ctx.error(
        `${DEFINE_EMITS}() cannot accept both type and non-type arguments ` +
          `at the same time. Use one or the other.`,
        node,
      )
    }
    // 记录类型参数作为类型声明
    ctx.emitsTypeDecl = node.typeParameters.params[0]
  }

  // 声明标识符
  ctx.emitDecl = declId

  return true
}

/**
 *  Vue 3 编译器 SFC 模块中，用于生成组件运行时的事件声明字符串
 * @param ctx
 * @returns
 */
export function genRuntimeEmits(ctx: ScriptCompileContext): string | undefined {
  // 初始化事件声明字符串
  let emitsDecl = ''

  // 处理运行时声明
  // 示例 defineEmits(['event1', 'event2'])
  if (ctx.emitsRuntimeDecl) {
    emitsDecl = ctx.getString(ctx.emitsRuntimeDecl).trim()

    // 处理类型声明
  } else if (ctx.emitsTypeDecl) {
    const typeDeclaredEmits = extractRuntimeEmits(ctx)
    // 将提取的事件名转换为数组形式的字符串
    emitsDecl = typeDeclaredEmits.size
      ? `[${Array.from(typeDeclaredEmits)
          .map(k => JSON.stringify(k))
          .join(', ')}]`
      : ``
  }

  // 处理模型事件
  if (ctx.hasDefineModelCall) {
    // 为每个模型生成对应的 update:modelName 事件
    let modelEmitsDecl = `[${Object.keys(ctx.modelDecls)
      .map(n => JSON.stringify(`update:${n}`))
      .join(', ')}]`
    emitsDecl = emitsDecl
      ? `/*@__PURE__*/${ctx.helper(
          'mergeModels',
        )}(${emitsDecl}, ${modelEmitsDecl})`
      : modelEmitsDecl
  }
  return emitsDecl
}

/**
 *  Vue 3 编译器 SFC 模块，从 defineEmits 的类型声明中提取运行时事件名
 * @param ctx
 * @returns
 */
export function extractRuntimeEmits(ctx: TypeResolveContext): Set<string> {
  // 存储事件
  const emits = new Set<string>()
  const node = ctx.emitsTypeDecl!

  // 如果类型声明是一个函数类型，从第一个参数中提取事件名并返回
  if (node.type === 'TSFunctionType') {
    extractEventNames(ctx, node.parameters[0], emits)
    return emits
  }

  const { props, calls } = resolveTypeElements(ctx, node)

  let hasProperty = false
  // 遍历所有属性，将属性名添加到事件名集合中
  for (const key in props) {
    emits.add(key)
    hasProperty = true
  }

  if (calls) {
    if (hasProperty) {
      // 如果同时存在属性和调用签名，报错（不能混合使用）
      ctx.error(
        `defineEmits() type cannot mixed call signature and property syntax.`,
        node,
      )
    }

    // 从每个调用签名的第一个参数中提取事件名
    for (const call of calls) {
      extractEventNames(ctx, call.parameters[0], emits)
    }
  }

  return emits
}

/**
 * Vue 3 编译器 SFC 模块,从 TypeScript 类型注解中提取事件名
 * @param ctx
 * @param eventName 事件名参数，可以是数组模式、标识符、对象模式或剩余元素
 * @param emits
 */
function extractEventNames(
  ctx: TypeResolveContext,
  eventName: ArrayPattern | Identifier | ObjectPattern | RestElement,
  emits: Set<string>,
) {
  if (
    eventName.type === 'Identifier' &&
    eventName.typeAnnotation &&
    eventName.typeAnnotation.type === 'TSTypeAnnotation'
  ) {
    const types = resolveUnionType(ctx, eventName.typeAnnotation.typeAnnotation)

    for (const type of types) {
      if (type.type === 'TSLiteralType') {
        // 不是一元表达式或模板字面量，添加到事件名集合中
        if (
          type.literal.type !== 'UnaryExpression' &&
          type.literal.type !== 'TemplateLiteral'
        ) {
          emits.add(String(type.literal.value))
        }
      }
    }
  }
}
