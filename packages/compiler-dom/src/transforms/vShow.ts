import type { DirectiveTransform } from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'
import { V_SHOW } from '../runtimeHelpers'

/**
 * 在编译阶段处理 v-show 指令，生成相应的编译结果，为运行时的 vShow 指令实现做准备。
 * @param dir 指令节点，包含 v-show 指令的信息
 * @param node 当前元素节点
 * @param context 编译上下文
 * @returns
 */
export const transformShow: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir

  // 检查是否存在表达式，如果不存在则报错
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_SHOW_NO_EXPRESSION, loc),
    )
  }

  return {
    props: [], // 表示 v-show 指令不需要生成额外的 props
    // 标记需要运行时辅助函数 V_SHOW
    needRuntime: context.helper(V_SHOW),
  }
}
