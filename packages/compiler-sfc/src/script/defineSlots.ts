import type { LVal, Node } from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'

export const DEFINE_SLOTS = 'defineSlots'

export function processDefineSlots(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  if (!isCallOf(node, DEFINE_SLOTS)) {
    return false
  }
  // 确保组件中只调用一次 defineSlots，如果已经调用过则报错
  if (ctx.hasDefineSlotsCall) {
    ctx.error(`duplicate ${DEFINE_SLOTS}() call`, node)
  }
  ctx.hasDefineSlotsCall = true // 标记为已调用

  // 确保 defineSlots 不接受任何参数，如果提供了参数则报错
  if (node.arguments.length > 0) {
    ctx.error(`${DEFINE_SLOTS}() cannot accept arguments`, node)
  }

  // 转换为 useSlots 辅助函数
  if (declId) {
    // 将 defineSlots() 调用转换为 useSlots() 调用
    ctx.s.overwrite(
      ctx.startOffset! + node.start!,
      ctx.startOffset! + node.end!,
      `${ctx.helper('useSlots')}()`,
    )
  }

  return true
}
