import type { LVal, Node, TSType } from '@babel/types'
import type { ScriptCompileContext } from './context'
import { inferRuntimeType } from './resolveType'
import { UNKNOWN_TYPE, isCallOf, toRuntimeTypeString } from './utils'
import { BindingTypes, unwrapTSNode } from '@vue/compiler-dom'

export const DEFINE_MODEL = 'defineModel'

export interface ModelDecl {
  type: TSType | undefined
  options: string | undefined
  identifier: string | undefined
  runtimeOptionNodes: Node[]
}

/**
 * Vue 3 编译器 SFC 模块，处理 defineModel 调用
 * @param ctx 编译上下文
 * @param node 调用节点
 * @param declId
 * @returns
 */
export function processDefineModel(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  if (!isCallOf(node, DEFINE_MODEL)) {
    return false
  }

  ctx.hasDefineModelCall = true

  // 提取 defineModel 的类型参数
  const type =
    (node.typeParameters && node.typeParameters.params[0]) || undefined

  let modelName: string
  let options: Node | undefined
  const arg0 = node.arguments[0] && unwrapTSNode(node.arguments[0])
  const hasName = arg0 && arg0.type === 'StringLiteral'
  // 如果第一个参数是字符串字面量，则将其作为模型名称，第二个参数作为选项
  if (hasName) {
    modelName = arg0.value
    options = node.arguments[1]
  } else {
    // 使用默认名称 modelValue，第一个参数作为选项
    modelName = 'modelValue'
    options = arg0
  }

  // 确保模型名称不重复，如果重复则报错
  if (ctx.modelDecls[modelName]) {
    ctx.error(`duplicate model name ${JSON.stringify(modelName)}`, node)
  }

  let optionsString = options && ctx.getString(options)
  let optionsRemoved = !options
  const runtimeOptionNodes: Node[] = []

  // 处理选项对象
  // 如果存在 options 且是一个对象表达式（ObjectExpression），且没有扩展运算符或计算属性
  if (
    options &&
    options.type === 'ObjectExpression' &&
    !options.properties.some(p => p.type === 'SpreadElement' || p.computed)
  ) {
    let removed = 0

    // 遍历选项对象的属性
    for (let i = options.properties.length - 1; i >= 0; i--) {
      const p = options.properties[i]
      const next = options.properties[i + 1]
      const start = p.start!
      const end = next ? next.start! : options.end! - 1

      if (
        (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') &&
        ((p.key.type === 'Identifier' &&
          (p.key.name === 'get' || p.key.name === 'set')) ||
          (p.key.type === 'StringLiteral' &&
            (p.key.value === 'get' || p.key.value === 'set')))
      ) {
        // remove runtime-only options from prop options to avoid duplicates
        // 对于 get/set：保留在 optionsString 中
        optionsString =
          optionsString.slice(0, start - options.start!) +
          optionsString.slice(end - options.start!)
      } else {
        // remove prop options from runtime options
        // 对于其他属性（type、default、required 等）：这些属于 prop 验证选项，会通过 ctx.s.remove() 从源码中删除，并记录到 runtimeOptionNodes 数组
        removed++
        ctx.s.remove(ctx.startOffset! + start, ctx.startOffset! + end)
        // record prop options for invalid scope var reference check
        runtimeOptionNodes.push(p)
      }
    }

    // 如果所有属性都被移除，则整个选项对象也会被删除
    if (removed === options.properties.length) {
      optionsRemoved = true
      ctx.s.remove(
        ctx.startOffset! + (hasName ? arg0.end! : options.start!),
        ctx.startOffset! + options.end!,
      )
    }
  }

  // 将模型声明信息存储到编译上下文中
  ctx.modelDecls[modelName] = {
    type,
    options: optionsString,
    runtimeOptionNodes,
    identifier:
      declId && declId.type === 'Identifier' ? declId.name : undefined,
  }
  // register binding type
  ctx.bindingMetadata[modelName] = BindingTypes.PROPS

  // defineModel -> useModel
  // 将 defineModel 标识符替换为 useModel 辅助函数
  ctx.s.overwrite(
    ctx.startOffset! + node.callee.start!,
    ctx.startOffset! + node.callee.end!,
    ctx.helper('useModel'),
  )
  // inject arguments
  // 注入额外参数：__props 和模型名称
  ctx.s.appendLeft(
    ctx.startOffset! +
      (node.arguments.length ? node.arguments[0].start! : node.end! - 1),
    `__props, ` +
      (hasName
        ? ``
        : `${JSON.stringify(modelName)}${optionsRemoved ? `` : `, `}`),
  )

  return true
}

/**
 * Vue 3 编译器 SFC 模块，用于生成组件中 defineModel 调用对应的 props 定义
 * @param ctx
 * @returns
 */
export function genModelProps(ctx: ScriptCompileContext): string | undefined {
  if (!ctx.hasDefineModelCall) return

  const isProd = !!ctx.options.isProd
  let modelPropsDecl = ''
  for (const [name, { type, options: runtimeOptions }] of Object.entries(
    ctx.modelDecls,
  )) {
    let skipCheck = false
    let codegenOptions = ``
    let runtimeTypes = type && inferRuntimeType(ctx, type)
    if (runtimeTypes) {
      const hasBoolean = runtimeTypes.includes('Boolean')
      const hasFunction = runtimeTypes.includes('Function')
      const hasUnknownType = runtimeTypes.includes(UNKNOWN_TYPE)

      if (hasUnknownType) {
        if (hasBoolean || hasFunction) {
          runtimeTypes = runtimeTypes.filter(t => t !== UNKNOWN_TYPE)
          skipCheck = true
        } else {
          runtimeTypes = ['null']
        }
      }

      if (!isProd) {
        codegenOptions =
          `type: ${toRuntimeTypeString(runtimeTypes)}` +
          (skipCheck ? ', skipCheck: true' : '')
      } else if (hasBoolean || (runtimeOptions && hasFunction)) {
        // preserve types if contains boolean, or
        // function w/ runtime options that may contain default
        codegenOptions = `type: ${toRuntimeTypeString(runtimeTypes)}`
      } else {
        // able to drop types in production
      }
    }

    let decl: string
    if (codegenOptions && runtimeOptions) {
      decl = ctx.isTS
        ? `{ ${codegenOptions}, ...${runtimeOptions} }`
        : `Object.assign({ ${codegenOptions} }, ${runtimeOptions})`
    } else if (codegenOptions) {
      decl = `{ ${codegenOptions} }`
    } else if (runtimeOptions) {
      decl = runtimeOptions
    } else {
      decl = `{}`
    }
    modelPropsDecl += `\n    ${JSON.stringify(name)}: ${decl},`

    // also generate modifiers prop
    const modifierPropName = JSON.stringify(
      name === 'modelValue' ? `modelModifiers` : `${name}Modifiers`,
    )
    modelPropsDecl += `\n    ${modifierPropName}: {},`
  }
  return `{${modelPropsDecl}\n  }`
}
