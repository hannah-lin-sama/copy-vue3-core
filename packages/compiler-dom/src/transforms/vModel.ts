import {
  type DirectiveTransform,
  ElementTypes,
  NodeTypes,
  transformModel as baseTransform,
  findDir,
  findProp,
  hasDynamicKeyVBind,
  isStaticArgOf,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'
import {
  V_MODEL_CHECKBOX,
  V_MODEL_DYNAMIC,
  V_MODEL_RADIO,
  V_MODEL_SELECT,
  V_MODEL_TEXT,
} from '../runtimeHelpers'

/**
 * v-model 指令转换函数
 * @param dir 指令节点
 * @param node 元素节点
 * @param context
 * @returns
 */
export const transformModel: DirectiveTransform = (dir, node, context) => {
  const baseResult = baseTransform(dir, node, context)
  // base transform has errors OR component v-model (only need props)
  // 没有生成 props 或者是组件的 v-model，直接返回核心转换的结果
  if (!baseResult.props.length || node.tagType === ElementTypes.COMPONENT) {
    return baseResult
  }

  // 原生元素的 v-model 不支持参数
  if (dir.arg) {
    context.onError(
      createDOMCompilerError(
        DOMErrorCodes.X_V_MODEL_ARG_ON_ELEMENT,
        dir.arg.loc,
      ),
    )
  }

  // 同时使用了 v-model 和 v-bind:value，会报错
  function checkDuplicatedValue() {
    const value = findDir(node, 'bind')
    if (value && isStaticArgOf(value.arg, 'value')) {
      context.onError(
        createDOMCompilerError(
          DOMErrorCodes.X_V_MODEL_UNNECESSARY_VALUE,
          value.loc,
        ),
      )
    }
  }

  const { tag } = node
  const isCustomElement = context.isCustomElement(tag)

  // 原生原生 input、textarea、select 和自定义元素
  if (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    isCustomElement
  ) {
    // 默认使用 V_MODEL_TEXT 指令（适用于文本输入）
    let directiveToUse = V_MODEL_TEXT
    let isInvalidType = false // 标记无效的输入类型

    // 1、Input 元素和自定义元素处理
    if (tag === 'input' || isCustomElement) {
      const type = findProp(node, `type`)
      if (type) {
        if (type.type === NodeTypes.DIRECTIVE) {
          // 如果 type 是动态绑定（如 :type="foo"），使用 V_MODEL_DYNAMIC 指令
          directiveToUse = V_MODEL_DYNAMIC

          // 如果 type 是静态值，根据值选择相应的指令
        } else if (type.value) {
          switch (type.value.content) {
            case 'radio':
              directiveToUse = V_MODEL_RADIO
              break
            case 'checkbox':
              directiveToUse = V_MODEL_CHECKBOX
              break
            case 'file':
              // file -> 标记为无效类型并报错
              isInvalidType = true
              context.onError(
                createDOMCompilerError(
                  DOMErrorCodes.X_V_MODEL_ON_FILE_INPUT_ELEMENT,
                  dir.loc,
                ),
              )
              break
            default:
              // text type
              // 其他类型 -> 默认为文本类型，使用 V_MODEL_TEXT
              __DEV__ && checkDuplicatedValue()
              break
          }
        }
      } else if (hasDynamicKeyVBind(node)) {
        // element has bindings with dynamic keys, which can possibly contain
        // "type".
        // 当元素有动态键的 v-bind 绑定时，使用 V_MODEL_DYNAMIC 指令
        // 原因：动态键绑定可能包含 type 属性，编译器无法在编译时确定其值，因此需要在运行时动态处理
        directiveToUse = V_MODEL_DYNAMIC
      } else {
        // text type
        __DEV__ && checkDuplicatedValue()
      }
    } else if (tag === 'select') {
      directiveToUse = V_MODEL_SELECT
    } else {
      // textarea
      __DEV__ && checkDuplicatedValue()
    }
    // inject runtime directive
    // by returning the helper symbol via needRuntime
    // the import will replaced a resolveDirective call.
    // 运行时指令注入
    if (!isInvalidType) {
      baseResult.needRuntime = context.helper(directiveToUse)
    }
  } else {
    // 其他元素 -> 报错
    context.onError(
      createDOMCompilerError(
        DOMErrorCodes.X_V_MODEL_ON_INVALID_ELEMENT,
        dir.loc,
      ),
    )
  }

  // native vmodel doesn't need the `modelValue` props since they are also
  // passed to the runtime as `binding.value`. removing it reduces code size.
  // 从转换结果中过滤掉 modelValue 属性
  // 注释解释：原生 vModel 不需要 modelValue 属性，因为它们也会作为 binding.value 传递给运行时，移除它可以减少代码大小。
  baseResult.props = baseResult.props.filter(
    p =>
      !(
        p.key.type === NodeTypes.SIMPLE_EXPRESSION &&
        p.key.content === 'modelValue'
      ),
  )

  return baseResult
}
