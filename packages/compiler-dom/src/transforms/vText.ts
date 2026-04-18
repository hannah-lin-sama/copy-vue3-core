import {
  type DirectiveTransform,
  TO_DISPLAY_STRING,
  createCallExpression,
  createObjectProperty,
  createSimpleExpression,
  getConstantType,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

/**
 * 处理 v-text 指令的转换器函数。
 * v-text 指令用于设置元素的文本内容，相当于设置元素的 textContent 属性。
 * @param dir 指令节点，包含 v-text 指令的信息
 * @param node 当前元素节点
 * @param context 编译上下文
 * @returns
 */
export const transformVText: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir

  // 检查是否存在表达式，如果不存在则报错
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_TEXT_NO_EXPRESSION, loc),
    )
  }

  // v-text 指令不能与子节点共存，如果存在子节点则报错并清空子节点
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_TEXT_WITH_CHILDREN, loc),
    )
    node.children.length = 0
  }
  return {
    props: [
      createObjectProperty(
        createSimpleExpression(`textContent`, true),
        exp
          ? getConstantType(exp, context) > 0
            ? // 如果是常量，直接使用 exp
              exp
            : // 转换为字符串
              createCallExpression(
                context.helperString(TO_DISPLAY_STRING),
                [exp],
                loc,
              )
          : // 如果没有表达式，使用空字符串
            createSimpleExpression('', true),
      ),
    ],
  }
}
