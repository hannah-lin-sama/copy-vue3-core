import type { NodeTransform, TransformContext } from '../transform'
import {
  type CallExpression,
  type ExpressionNode,
  NodeTypes,
  type SlotOutletNode,
  createCallExpression,
  createFunctionExpression,
  createSimpleExpression,
} from '../ast'
import { isSlotOutlet, isStaticArgOf, isStaticExp } from '../utils'
import { type PropsExpression, buildProps } from './transformElement'
import { ErrorCodes, createCompilerError } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'
import { camelize } from '@vue/shared'
import { processExpression } from './transformExpression'

/**
 * 处理插槽出口节点
 * @param node 节点
 * @param context 上下文
 */
export const transformSlotOutlet: NodeTransform = (node, context) => {
  if (isSlotOutlet(node)) {
    const { children, loc } = node

    // 插槽名称、插槽属性
    const { slotName, slotProps } = processSlotOutlet(node, context)

    // 插槽出口调用参数
    const slotArgs: CallExpression['arguments'] = [
      // $slots 对象：用于访问插槽内容
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
      slotName,
      '{}', // 插槽属性
      'undefined', // 默认插槽内容
      'true', //作用域ID
    ]
    let expectedLen = 2

    if (slotProps) {
      slotArgs[2] = slotProps
      expectedLen = 3
    }

    if (children.length) {
      slotArgs[3] = createFunctionExpression([], children, false, false, loc)
      expectedLen = 4
    }

    if (context.scopeId && !context.slotted) {
      expectedLen = 5
    }
    // 移除未使用的参数，只保留需要的参数
    slotArgs.splice(expectedLen) // remove unused arguments

    node.codegenNode = createCallExpression(
      context.helper(RENDER_SLOT),
      slotArgs,
      loc,
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

export function processSlotOutlet(
  node: SlotOutletNode,
  context: TransformContext,
): SlotOutletProcessResult {
  let slotName: string | ExpressionNode = `"default"`
  let slotProps: PropsExpression | undefined = undefined

  const nonNameProps = []
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.value) {
        if (p.name === 'name') {
          slotName = JSON.stringify(p.value.content)
        } else {
          p.name = camelize(p.name)
          nonNameProps.push(p)
        }
      }
    } else {
      if (p.name === 'bind' && isStaticArgOf(p.arg, 'name')) {
        if (p.exp) {
          slotName = p.exp
        } else if (p.arg && p.arg.type === NodeTypes.SIMPLE_EXPRESSION) {
          const name = camelize(p.arg.content)
          slotName = p.exp = createSimpleExpression(name, false, p.arg.loc)
          if (!__BROWSER__) {
            slotName = p.exp = processExpression(p.exp, context)
          }
        }
      } else {
        if (p.name === 'bind' && p.arg && isStaticExp(p.arg)) {
          p.arg.content = camelize(p.arg.content)
        }
        nonNameProps.push(p)
      }
    }
  }

  if (nonNameProps.length > 0) {
    const { props, directives } = buildProps(
      node,
      context,
      nonNameProps,
      false,
      false,
    )
    slotProps = props

    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc,
        ),
      )
    }
  }

  return {
    slotName,
    slotProps,
  }
}
