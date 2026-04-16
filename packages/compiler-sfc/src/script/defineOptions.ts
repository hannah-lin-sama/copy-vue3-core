import type { Node } from '@babel/types'
import { unwrapTSNode } from '@vue/compiler-dom'
import type { ScriptCompileContext } from './context'
import { isCallOf } from './utils'
import { DEFINE_PROPS } from './defineProps'
import { DEFINE_EMITS } from './defineEmits'
import { DEFINE_EXPOSE } from './defineExpose'
import { DEFINE_SLOTS } from './defineSlots'

export const DEFINE_OPTIONS = 'defineOptions'

/**
 * Vue 3 编译器 SFC (Single File Component) 模块中，用于处理组件中的 defineOptions 调用
 * @param ctx
 * @param node
 * @returns
 */
export function processDefineOptions(
  ctx: ScriptCompileContext,
  node: Node,
): boolean {
  if (!isCallOf(node, DEFINE_OPTIONS)) {
    return false
  }

  // 确保组件中只调用一次 defineOptions，如果已经调用过则报错
  if (ctx.hasDefineOptionsCall) {
    ctx.error(`duplicate ${DEFINE_OPTIONS}() call`, node)
  }

  // defineOptions 不接受类型参数，如果提供了类型参数则报错
  if (node.typeParameters) {
    ctx.error(`${DEFINE_OPTIONS}() cannot accept type arguments`, node)
  }

  // defineOptions 没有参数，则直接返回 true
  if (!node.arguments[0]) return true

  ctx.hasDefineOptionsCall = true // 标记为已调用

  // 将其第一个参数（处理 TypeScript 节点后）存储为运行时声明
  ctx.optionsRuntimeDecl = unwrapTSNode(node.arguments[0])

  let propsOption = undefined
  let emitsOption = undefined
  let exposeOption = undefined
  let slotsOption = undefined
  // 遍历 defineOptions 中的属性，查找 props、emits、expose、slots 选项
  if (ctx.optionsRuntimeDecl.type === 'ObjectExpression') {
    for (const prop of ctx.optionsRuntimeDecl.properties) {
      if (
        (prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod') &&
        prop.key.type === 'Identifier'
      ) {
        switch (prop.key.name) {
          case 'props':
            propsOption = prop
            break

          case 'emits':
            emitsOption = prop
            break

          case 'expose':
            exposeOption = prop
            break

          case 'slots':
            slotsOption = prop
            break
        }
      }
    }
  }

  // defineOptions 不能用于声明 props、emits、expose、slots 选项
  if (propsOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare props. Use ${DEFINE_PROPS}() instead.`,
      propsOption,
    )
  }
  if (emitsOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare emits. Use ${DEFINE_EMITS}() instead.`,
      emitsOption,
    )
  }
  if (exposeOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare expose. Use ${DEFINE_EXPOSE}() instead.`,
      exposeOption,
    )
  }
  if (slotsOption) {
    ctx.error(
      `${DEFINE_OPTIONS}() cannot be used to declare slots. Use ${DEFINE_SLOTS}() instead.`,
      slotsOption,
    )
  }

  return true
}
