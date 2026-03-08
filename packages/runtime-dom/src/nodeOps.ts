import { warn } from '@vue/runtime-core'
import type { RendererOptions } from '@vue/runtime-core'
import type {
  TrustedHTML,
  TrustedTypePolicy,
  TrustedTypesWindow,
} from 'trusted-types/lib'

let policy: Pick<TrustedTypePolicy, 'name' | 'createHTML'> | undefined =
  undefined

const tt =
  typeof window !== 'undefined' &&
  (window as unknown as TrustedTypesWindow).trustedTypes

if (tt) {
  try {
    policy = /*@__PURE__*/ tt.createPolicy('vue', {
      createHTML: val => val,
    })
  } catch (e: unknown) {
    // `createPolicy` throws a TypeError if the name is a duplicate
    // and the CSP trusted-types directive is not using `allow-duplicates`.
    // So we have to catch that error.
    __DEV__ && warn(`Error creating trusted types policy: ${e}`)
  }
}

// __UNSAFE__
// Reason: potentially setting innerHTML.
// This function merely perform a type-level trusted type conversion
// for use in `innerHTML` assignment, etc.
// Be careful of whatever value passed to this function.
export const unsafeToTrustedHTML: (value: string) => TrustedHTML | string =
  policy ? val => policy.createHTML(val) : val => val

export const svgNS = 'http://www.w3.org/2000/svg'
export const mathmlNS = 'http://www.w3.org/1998/Math/MathML'

const doc = (typeof document !== 'undefined' ? document : null) as Document

const templateContainer = doc && /*@__PURE__*/ doc.createElement('template')

// 节点操作方法集合，用于 DOM 操作
export const nodeOps: Omit<RendererOptions<Node, Element>, 'patchProp'> = {
  insert: (child, parent, anchor) => {
    // 插入子节点到父节点中，锚点为 anchor 或 null
    parent.insertBefore(child, anchor || null)
  },

  remove: child => {
    const parent = child.parentNode
    if (parent) {
      // 从父节点中移除子节点ß
      parent.removeChild(child)
    }
  },

  createElement: (tag, namespace, is, props): Element => {
    const el =
      namespace === 'svg'
        ? doc.createElementNS(svgNS, tag)
        : namespace === 'mathml'
          ? doc.createElementNS(mathmlNS, tag)
          : is
            ? doc.createElement(tag, { is })
            : doc.createElement(tag)

    if (tag === 'select' && props && props.multiple != null) {
      // 处理 select 元素的 multiple 属性
      ;(el as HTMLSelectElement).setAttribute('multiple', props.multiple)
    }

    return el
  },
  // 创建文本节点
  createText: text => doc.createTextNode(text),
  // 创建注释节点
  createComment: text => doc.createComment(text),

  setText: (node, text) => {
    node.nodeValue = text // 设置文本节点的文本内容
  },

  setElementText: (el, text) => {
    el.textContent = text // 设置元素的文本内容
  },

  parentNode: node => node.parentNode as Element | null, // 获取节点的父节点

  nextSibling: node => node.nextSibling, // 获取节点的下一个兄弟节点

  querySelector: selector => doc.querySelector(selector), // 查询选择器

  setScopeId(el, id) {
    el.setAttribute(id, '') // 设置元素的作用域 ID 属性
  },

  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  insertStaticContent(content, parent, anchor, namespace, start, end) {
    // <parent> before | first ... last | anchor </parent>
    const before = anchor ? anchor.previousSibling : parent.lastChild
    // #5308 can only take cached path if:
    // - has a single root node
    // - nextSibling info is still available
    if (start && (start === end || start.nextSibling)) {
      // cached
      while (true) {
        parent.insertBefore(start!.cloneNode(true), anchor)
        if (start === end || !(start = start!.nextSibling)) break
      }
    } else {
      // fresh insert
      templateContainer.innerHTML = unsafeToTrustedHTML(
        namespace === 'svg'
          ? `<svg>${content}</svg>`
          : namespace === 'mathml'
            ? `<math>${content}</math>`
            : content,
      ) as string

      const template = templateContainer.content
      if (namespace === 'svg' || namespace === 'mathml') {
        // remove outer svg/math wrapper
        const wrapper = template.firstChild!
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild)
        }
        template.removeChild(wrapper)
      }
      parent.insertBefore(template, anchor)
    }
    return [
      // first
      before ? before.nextSibling! : parent.firstChild!,
      // last
      anchor ? anchor.previousSibling! : parent.lastChild!,
    ]
  },
}
