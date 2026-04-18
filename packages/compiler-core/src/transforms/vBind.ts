import type { DirectiveTransform } from '../transform'
import {
  type ExpressionNode,
  NodeTypes,
  createObjectProperty,
  createSimpleExpression,
} from '../ast'
import { ErrorCodes, createCompilerError } from '../errors'
import { camelize } from '@vue/shared'
import { CAMELIZE } from '../runtimeHelpers'

// v-bind without arg is handled directly in ./transformElement.ts due to its affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
export const transformBind: DirectiveTransform = (dir, _node, context) => {
  const { modifiers, loc } = dir
  const arg = dir.arg! // 指令参数（如 v-bind:class 中的 class）

  // 指令的表达式（如 v-bind:class="className" 中的 className）
  let { exp } = dir

  // handle empty expression
  if (exp && exp.type === NodeTypes.SIMPLE_EXPRESSION && !exp.content.trim()) {
    if (!__BROWSER__) {
      // #10280 only error against empty expression in non-browser build
      // because :foo in in-DOM templates will be parsed into :foo="" by the
      // browser
      context.onError(
        createCompilerError(ErrorCodes.X_V_BIND_NO_EXPRESSION, loc),
      )
      return {
        props: [
          createObjectProperty(arg, createSimpleExpression('', true, loc)),
        ],
      }
    } else {
      exp = undefined
    }
  }

  // 参数规范化
  if (arg.type !== NodeTypes.SIMPLE_EXPRESSION) {
    // 非简单表达式参数：在子节点前后添加括号和 || ""，确保参数值为空时不会导致错误
    arg.children.unshift(`(`)
    arg.children.push(`) || ""`)
  } else if (!arg.isStatic) {
    // 非静态简单表达式参数：在内容后添加 || ""，同样处理空值情况
    arg.content = arg.content ? `${arg.content} || ""` : `""`
  }

  // .sync is replaced by v-model:arg
  if (modifiers.some(mod => mod.content === 'camel')) {
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (arg.isStatic) {
        // 静态简单表达式：转为驼峰命名法
        arg.content = camelize(arg.content)
      } else {
        // 非静态简单表达式：在内容前添加 camelize 函数调用
        arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`
      }
    } else {
      // 非简单表达式参数：在子节点前后添加驼峰命名法函数调用
      arg.children.unshift(`${context.helperString(CAMELIZE)}(`)
      arg.children.push(`)`)
    }
  }

  if (!context.inSSR) {
    // .prop 修饰符：添加 . 前缀，表示绑定为 DOM property
    if (modifiers.some(mod => mod.content === 'prop')) {
      injectPrefix(arg, '.')
    }
    // .attr 修饰符：添加 ^ 前缀，表示绑定为 HTML attribute
    if (modifiers.some(mod => mod.content === 'attr')) {
      injectPrefix(arg, '^')
    }
  }

  return {
    props: [createObjectProperty(arg, exp!)],
  }
}

/**
 * 为指令参数添加前缀
 * @param arg 指令参数节点
 * @param prefix 前缀字符串
 */
const injectPrefix = (arg: ExpressionNode, prefix: string) => {
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    if (arg.isStatic) {
      // 静态简单表达式：直接添加前缀
      arg.content = prefix + arg.content
    } else {
      // 动态简单表达式：使用模板字面量添加前缀（`.${attrName}`）
      arg.content = `\`${prefix}\${${arg.content}}\``
    }
  } else {
    // 符合表达式 ['attr', ' + ', 'suffix'] -->（["'^' + (", 'attr', ' + ', 'suffix', ')']）
    arg.children.unshift(`'${prefix}' + (`)
    arg.children.push(`)`)
  }
}
