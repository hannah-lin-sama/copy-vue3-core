import type { Node } from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'

export const DEFINE_EXPOSE = 'defineExpose'

/**
 * Vue 3 编译器 SFC (Single File Component) 模块中，用于处理组件中的 defineExpose 调用
 * @param ctx
 * @param node
 * @returns
 */
export function processDefineExpose(
  ctx: ScriptCompileContext,
  node: Node,
): boolean {
  if (isCallOf(node, DEFINE_EXPOSE)) {
    // 确保组件中只调用一次 defineExpose，如果已经调用过则报错。
    if (ctx.hasDefineExposeCall) {
      ctx.error(`duplicate ${DEFINE_EXPOSE}() call`, node)
    }
    ctx.hasDefineExposeCall = true
    return true
  }
  return false
}
