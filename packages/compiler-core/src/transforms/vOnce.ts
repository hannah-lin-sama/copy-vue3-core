import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { type ElementNode, type ForNode, type IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

const seen = new WeakSet()

/**
 * 标记元素或组件只渲染一次，之后即使数据发生变化，也不会重新渲染
 * @param node
 * @param context
 * @returns
 */
export const transformOnce: NodeTransform = (node, context) => {
  // 只处理元素节点,查找节点上的 v-once 指令
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    // 检查节点是否已经被处理过,避免重复处理
    if (seen.has(node) || context.inVOnce || context.inSSR) {
      return
    }
    seen.add(node)
    context.inVOnce = true // 标记为 v-once 处理中
    // 注入运行时辅助函数,用于暂时禁用块追踪（Block Tracking）
    context.helper(SET_BLOCK_TRACKING)
    return () => {
      context.inVOnce = false
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      if (cur.codegenNode) {
        cur.codegenNode = context.cache(
          cur.codegenNode,
          true /* isVNode */, // 缓存 VNode 节点
          true /* inVOnce */, // 标记为 v-once 处理中，运行时会在首次渲染后永久复用该 VNode
        )
      }
    }
  }
}
