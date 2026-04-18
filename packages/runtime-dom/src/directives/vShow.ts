import type { ObjectDirective } from '@vue/runtime-core'

export const vShowOriginalDisplay: unique symbol = Symbol('_vod')
export const vShowHidden: unique symbol = Symbol('_vsh')

export interface VShowElement extends HTMLElement {
  // _vod = vue original display
  [vShowOriginalDisplay]: string
  [vShowHidden]: boolean
}

/**
 * v-show 指令
 */
export const vShow: ObjectDirective<VShowElement> & { name: 'show' } = {
  // used for prop mismatch check during hydration
  name: 'show',
  /**
   * 挂载前处理
   * @param el
   * @param param1
   * @param param2
   */
  beforeMount(el, { value }, { transition }) {
    // 将元素的原始 display 值存储在 el[vShowOriginalDisplay] 中
    el[vShowOriginalDisplay] =
      el.style.display === 'none' ? '' : el.style.display

    if (transition && value) {
      // 执行 transition.beforeEnter(el)
      transition.beforeEnter(el)
    } else {
      // 设置显示状态
      setDisplay(el, value)
    }
  },
  /**
   * 挂载后处理
   * @param el
   * @param param1
   * @param param2
   */
  mounted(el, { value }, { transition }) {
    if (transition && value) {
      // 执行 transition.enter(el) 触发进入过渡
      transition.enter(el)
    }
  },
  updated(el, { value, oldValue }, { transition }) {
    if (!value === !oldValue) return
    // 过渡效果处理
    if (transition) {
      if (value) {
        // 显示元素
        transition.beforeEnter(el)
        setDisplay(el, true)
        transition.enter(el)
      } else {
        // 隐藏元素
        transition.leave(el, () => {
          setDisplay(el, false)
        })
      }
      // 无过渡效果时，直接设置显示状态
    } else {
      setDisplay(el, value)
    }
  },
  /**
   * 卸载前处理
   * @param el
   * @param param1
   */
  beforeUnmount(el, { value }) {
    setDisplay(el, value)
  },
}

/**
 * 设置元素的显示状态
 * @param el 元素
 * @param value 显示状态
 */
function setDisplay(el: VShowElement, value: unknown): void {
  el.style.display = value ? el[vShowOriginalDisplay] : 'none'
  el[vShowHidden] = !value
}

// SSR vnode transforms, only used when user includes client-oriented render
// function in SSR
export function initVShowForSSR(): void {
  vShow.getSSRProps = ({ value }) => {
    if (!value) {
      return { style: { display: 'none' } }
    }
  }
}
