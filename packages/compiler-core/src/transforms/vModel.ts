import type { DirectiveTransform } from '../transform'
import {
  ConstantTypes,
  ElementTypes,
  type ExpressionNode,
  NodeTypes,
  type Property,
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
} from '../ast'
import { ErrorCodes, createCompilerError } from '../errors'
import {
  hasScopeRef,
  isMemberExpression,
  isSimpleIdentifier,
  isStaticExp,
} from '../utils'
import { IS_REF } from '../runtimeHelpers'
import { BindingTypes } from '../options'
import { camelize } from '@vue/shared'

/**
 * 将模板中的 v-model 指令转换为组件的 modelValue 属性和 onUpdate:modelValue 事件处理器
 * @param dir 指令节点
 * @param node 当前元素节点
 * @param context 编译上下文
 * @returns
 */
export const transformModel: DirectiveTransform = (dir, node, context) => {
  const { exp, arg } = dir

  // 没有表达式，报错
  if (!exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_NO_EXPRESSION, dir.loc),
    )
    return createTransformProps()
  }

  // we assume v-model directives are always parsed
  // (not artificially created by a transform)
  const rawExp = exp.loc.source.trim()
  const expString =
    exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : rawExp

  // im SFC <script setup> inline mode, the exp may have been transformed into
  // _unref(exp)
  const bindingType = context.bindingMetadata[rawExp]

  // check props
  if (
    bindingType === BindingTypes.PROPS || // 组件的原始 props
    bindingType === BindingTypes.PROPS_ALIASED // 组件的别名 props
  ) {
    context.onError(createCompilerError(ErrorCodes.X_V_MODEL_ON_PROPS, exp.loc))
    return createTransformProps()
  }

  // const bindings are not writable.
  // 常量绑定不是可写式的，报错
  if (
    bindingType === BindingTypes.LITERAL_CONST || // 字面量常量，如 const x = 1 中的 x
    bindingType === BindingTypes.SETUP_CONST // <script setup> 中的常量
  ) {
    context.onError(createCompilerError(ErrorCodes.X_V_MODEL_ON_CONST, exp.loc))
    return createTransformProps()
  }

  // 为什么需要检测 ref？ref 是 Vue 3 中的响应式引用，需要通过 .value 访问和修改
  const maybeRef =
    !__BROWSER__ &&
    context.inline &&
    (bindingType === BindingTypes.SETUP_LET || // script setup> 中的 let 变量
      bindingType === BindingTypes.SETUP_REF || // <script setup> 中的 ref
      bindingType === BindingTypes.SETUP_MAYBE_REF) // <script setup> 中可能是 ref 的变量

  // 表达式为空 或者 表达式不是成员表达式且不是 maybeRef，报错
  if (!expString.trim() || (!isMemberExpression(exp, context) && !maybeRef)) {
    // 报错，提示必须是javascript表达式
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_MALFORMED_EXPRESSION, exp.loc),
    )
    return createTransformProps()
  }

  if (
    !__BROWSER__ && // 非浏览器环境（编译时）
    context.prefixIdentifiers && // 是否需要为标识符添加前缀
    isSimpleIdentifier(expString) &&
    context.identifiers[expString]
  ) {
    //报错，v-model 绑定到作用域变量的错误
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_ON_SCOPE_VARIABLE, exp.loc),
    )
    return createTransformProps()
  }

  // 生成属性名：如果有参数则使用参数，否则使用 modelValue
  const propName = arg ? arg : createSimpleExpression('modelValue', true)
  // 生成事件名：如果有参数则使用 onUpdate:参数名，否则使用 onUpdate:modelValue
  const eventName = arg
    ? isStaticExp(arg)
      ? `onUpdate:${camelize(arg.content)}`
      : createCompoundExpression(['"onUpdate:" + ', arg])
    : `onUpdate:modelValue`

  // 赋值表达式
  let assignmentExp: ExpressionNode
  const eventArg = context.isTS ? `($event: any)` : `$event`
  if (maybeRef) {
    if (bindingType === BindingTypes.SETUP_REF) {
      // v-model used on known ref.
      // 如果是已知的 ref：直接设置 .value
      assignmentExp = createCompoundExpression([
        `${eventArg} => ((`,
        createSimpleExpression(rawExp, false, exp.loc),
        `).value = $event)`,
      ])
    } else {
      // v-model used on a potentially ref binding in <script setup> inline mode.
      // the assignment needs to check whether the binding is actually a ref.
      const altAssignment =
        bindingType === BindingTypes.SETUP_LET ? `${rawExp} = $event` : `null`
      assignmentExp = createCompoundExpression([
        `${eventArg} => (${context.helperString(IS_REF)}(${rawExp}) ? (`,
        createSimpleExpression(rawExp, false, exp.loc),
        `).value = $event : ${altAssignment})`,
      ])
    }
  } else {
    assignmentExp = createCompoundExpression([
      `${eventArg} => ((`,
      exp,
      `) = $event)`,
    ])
  }

  // 生成两个属性：modelValue 和 onUpdate:modelValue
  const props = [
    // modelValue: foo
    createObjectProperty(propName, dir.exp!),
    // "onUpdate:modelValue": $event => (foo = $event)
    createObjectProperty(eventName, assignmentExp),
  ]

  // cache v-model handler if applicable (when it doesn't refer any scope vars)
  // 事件处理器缓存
  if (
    !__BROWSER__ &&
    context.prefixIdentifiers &&
    !context.inVOnce &&
    context.cacheHandlers &&
    !hasScopeRef(exp, context.identifiers)
  ) {
    props[1].value = context.cache(props[1].value)
  }

  // modelModifiers: { foo: true, "bar-baz": true }
  // 修饰符处理，组件修饰符
  // 原生元素的修饰符由运行时直接处理，不需要生成这些 prop。
  if (dir.modifiers.length && node.tagType === ElementTypes.COMPONENT) {
    // 生成对象字符串，例如 "capitalize: true, trim: true"
    const modifiers = dir.modifiers
      .map(m => m.content)
      .map(m => (isSimpleIdentifier(m) ? m : JSON.stringify(m)) + `: true`)
      .join(`, `)
    // 确定 prop 名称（modifiersKey）
    const modifiersKey = arg
      ? isStaticExp(arg)
        ? `${arg.content}Modifiers`
        : createCompoundExpression([arg, ' + "Modifiers"'])
      : `modelModifiers`
    props.push(
      createObjectProperty(
        modifiersKey,
        createSimpleExpression(
          `{ ${modifiers} }`,
          false,
          dir.loc,
          ConstantTypes.CAN_CACHE,
        ),
      ),
    )
  }

  return createTransformProps(props)
}

function createTransformProps(props: Property[] = []) {
  return { props }
}
