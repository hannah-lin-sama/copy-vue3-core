import { type ElementWithTransition, vtcKey } from '../components/Transition'

// compiler should normalize class + :class bindings on the same element
// into a single binding ['staticClass', dynamic]
/**
 * 更新 DOM 元素的 class 属性
 * @param el  要操作的 DOM 元素
 * @param value 新的类名字符串，或 null（表示移除类）
 * @param isSVG  布尔值，指示元素是否为 SVG 元素
 */
export function patchClass(
  el: Element,
  value: string | null,
  isSVG: boolean,
): void {
  // directly setting className should be faster than setAttribute in theory
  // if this is an element during a transition, take the temporary transition
  // classes into account.
  // 检查元素是否有过渡类（通过 vtcKey 访问）
  const transitionClasses = (el as ElementWithTransition)[vtcKey]
  if (transitionClasses) {
    value = (
      value ? [value, ...transitionClasses] : [...transitionClasses]
    ).join(' ')
  }
  if (value == null) {
    el.removeAttribute('class')
  } else if (isSVG) {
    el.setAttribute('class', value)
  } else {
    el.className = value
  }
}
