import {
  type DirectiveTransform,
  createObjectProperty,
  createSimpleExpression,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

/**
 * v-html 指令用于设置元素的 HTML 内容，相当于设置元素的 innerHTML 属性
 * @param dir 指令
 * @param node 当前元素节点
 * @param context
 * @returns
 */
export const transformVHtml: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir

  // 没有表达式时，报错
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_NO_EXPRESSION, loc),
    )
  }

  // 存在子节点时，报错并清空子节点
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_WITH_CHILDREN, loc),
    )
    node.children.length = 0
  }
  return {
    props: [
      createObjectProperty(
        createSimpleExpression(`innerHTML`, true, loc),
        exp || createSimpleExpression('', true),
      ),
    ],
  }
}
