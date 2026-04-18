import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import {
  ElementTypes,
  type MemoExpression,
  NodeTypes,
  type PlainElementNode,
  convertToBlock,
  createCallExpression,
  createFunctionExpression,
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

const seen = new WeakSet()

/**
 * Vue 3 编译器中处理 v-memo 指令的节点转换器。
 * v-memo 指令用于优化渲染性能，通过指定依赖项数组，当依赖项未变化时跳过该节点及其子树的渲染。
 * @param node 当前处理的 AST 节点
 * @param context
 * @returns
 */
export const transformMemo: NodeTransform = (node, context) => {
  // 处理元素节点
  if (node.type === NodeTypes.ELEMENT) {
    const dir = findDir(node, 'memo') // 查找节点上的 v-memo 指令
    // 没有v-memo指令,或者节点已经被处理过,或者在SSR模式下,则直接返回
    if (!dir || seen.has(node) || context.inSSR) {
      return
    }
    seen.add(node) // 标记节点为已处理
    return () => {
      // 获取节点的代码生成节点
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode

      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // non-component sub tree should be turned into a block
        if (node.tagType !== ElementTypes.COMPONENT) {
          // 非组件子树，转为块
          convertToBlock(codegenNode, context)
        }
        // 创建 WITH_MEMO 调用表达式
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!, // v-memo 指令的表达式（依赖项数组）
          // 创建一个函数表达式，包含原始的代码生成节点
          createFunctionExpression(undefined, codegenNode),
          `_cache`,
          String(context.cached.length), // 缓存索引
        ]) as MemoExpression
        // 增加缓存计数
        context.cached.push(null)
      }
    }
  }
}
