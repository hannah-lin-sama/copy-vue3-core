import { camelize } from '@vue/shared'
import {
  NodeTypes,
  type SimpleExpressionNode,
  createSimpleExpression,
} from '../ast'
import type { NodeTransform } from '../transform'
import { ErrorCodes, createCompilerError } from '../errors'
import { validFirstIdentCharRE } from '../utils'

/**
 * 处理 v-bind 的简写形式（如 :prop）
 * @param node 当前元素节点
 * @param context
 */
export const transformVBindShorthand: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT) {
    for (const prop of node.props) {
      // same-name shorthand - :arg is expanded to :arg="arg"
      if (
        prop.type === NodeTypes.DIRECTIVE && // 指令节点
        prop.name === 'bind' && // 指令名称为 bind
        // 没有表达式，或者在浏览器环境中表达式为空
        (!prop.exp ||
          // #13930 :foo in in-DOM templates will be parsed into :foo="" by browser
          (__BROWSER__ &&
            prop.exp.type === NodeTypes.SIMPLE_EXPRESSION &&
            !prop.exp.content.trim())) &&
        prop.arg // 有参数
      ) {
        // 如果参数不是简单表达式或不是静态的，报错并设置空表达式
        const arg = prop.arg
        if (arg.type !== NodeTypes.SIMPLE_EXPRESSION || !arg.isStatic) {
          // only simple expression is allowed for same-name shorthand
          context.onError(
            createCompilerError(
              ErrorCodes.X_V_BIND_INVALID_SAME_NAME_ARGUMENT,
              arg.loc,
            ),
          )
          prop.exp = createSimpleExpression('', true, arg.loc)
        } else {
          // 将参数内容转换为驼峰形式
          const propName = camelize((arg as SimpleExpressionNode).content)
          if (
            validFirstIdentCharRE.test(propName[0]) ||
            // allow hyphen first char for https://github.com/vuejs/language-tools/pull/3424
            propName[0] === '-'
          ) {
            prop.exp = createSimpleExpression(propName, false, arg.loc)
          }
        }
      }
    }
  }
}
