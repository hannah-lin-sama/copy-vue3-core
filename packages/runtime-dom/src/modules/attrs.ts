import {
  NOOP,
  includeBooleanAttr,
  isSpecialBooleanAttr,
  isSymbol,
  makeMap,
} from '@vue/shared'
import {
  type ComponentInternalInstance,
  DeprecationTypes,
  compatUtils,
} from '@vue/runtime-core'

export const xlinkNS = 'http://www.w3.org/1999/xlink'

/**
 * 更新 DOM 元素的属性
 * @param el 要操作的 DOM 元素
 * @param key 要设置的属性名
 * @param value 要设置的属性值
 * @param isSVG 是否为 SVG 元素
 * @param instance 组件实例
 * @param isBoolean 属性是否为特殊布尔属
 * @returns
 */
export function patchAttr(
  el: Element,
  key: string,
  value: any,
  isSVG: boolean,
  instance?: ComponentInternalInstance | null,
  isBoolean: boolean = isSpecialBooleanAttr(key),
): void {
  // SVG xlink 属性处理
  if (isSVG && key.startsWith('xlink:')) {
    if (value == null) {
      // 使用 removeAttributeNS 移除命名空间属性
      el.removeAttributeNS(xlinkNS, key.slice(6, key.length))
    } else {
      // 设置命名空间属性
      el.setAttributeNS(xlinkNS, key, value)
    }
  } else {
    if (__COMPAT__ && compatCoerceAttr(el, key, value, instance)) {
      return
    }

    // note we are only checking boolean attributes that don't have a
    // corresponding dom prop of the same name here.
    if (value == null || (isBoolean && !includeBooleanAttr(value))) {
      // 移除属性
      el.removeAttribute(key)
    } else {
      // attribute value is a string https://html.spec.whatwg.org/multipage/dom.html#attributes
      // 设置属性
      el.setAttribute(
        key,
        isBoolean ? '' : isSymbol(value) ? String(value) : value,
      )
    }
  }
}

// 2.x compat
const isEnumeratedAttr = __COMPAT__
  ? /*@__PURE__*/ makeMap('contenteditable,draggable,spellcheck')
  : NOOP

export function compatCoerceAttr(
  el: Element,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance | null = null,
): boolean {
  if (isEnumeratedAttr(key)) {
    const v2CoercedValue =
      value === undefined
        ? null
        : value === null || value === false || value === 'false'
          ? 'false'
          : 'true'
    if (
      v2CoercedValue &&
      compatUtils.softAssertCompatEnabled(
        DeprecationTypes.ATTR_ENUMERATED_COERCION,
        instance,
        key,
        value,
        v2CoercedValue,
      )
    ) {
      el.setAttribute(key, v2CoercedValue)
      return true
    }
  } else if (
    value === false &&
    !(el.tagName === 'INPUT' && key === 'value') &&
    !isSpecialBooleanAttr(key) &&
    compatUtils.isCompatEnabled(DeprecationTypes.ATTR_FALSE_VALUE, instance)
  ) {
    compatUtils.warnDeprecation(
      DeprecationTypes.ATTR_FALSE_VALUE,
      instance,
      key,
    )
    el.removeAttribute(key)
    return true
  }
  return false
}
