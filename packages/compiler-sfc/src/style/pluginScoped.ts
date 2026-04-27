import {
  type AtRule,
  type Container,
  type Document,
  type PluginCreator,
  Rule,
} from 'postcss'
import selectorParser from 'postcss-selector-parser'
import { warn } from '../warn'

const animationNameRE = /^(?:-\w+-)?animation-name$/
const animationRE = /^(?:-\w+-)?animation$/
const keyframesRE = /^(?:-\w+-)?keyframes$/

const scopedPlugin: PluginCreator<string> = (id = '') => {
  const keyframes = Object.create(null)
  const shortId = id.replace(/^data-v-/, '')

  return {
    postcssPlugin: 'vue-sfc-scoped',
    // 处理 CSS 规则并为其添加作用域标识符
    Rule(rule) {
      processRule(id, rule)
    },
    AtRule(node) {
      if (keyframesRE.test(node.name) && !node.params.endsWith(`-${shortId}`)) {
        // register keyframes
        keyframes[node.params] = node.params = node.params + '-' + shortId
      }
    },
    OnceExit(root) {
      if (Object.keys(keyframes).length) {
        // If keyframes are found in this <style>, find and rewrite animation names
        // in declarations.
        // Caveat: this only works for keyframes and animation rules in the same
        // <style> element.
        // individual animation-name declaration
        root.walkDecls(decl => {
          if (animationNameRE.test(decl.prop)) {
            decl.value = decl.value
              .split(',')
              .map(v => keyframes[v.trim()] || v.trim())
              .join(',')
          }
          // shorthand
          if (animationRE.test(decl.prop)) {
            decl.value = decl.value
              .split(',')
              .map(v => {
                const vals = v.trim().split(/\s+/)
                const i = vals.findIndex(val => keyframes[val])
                if (i !== -1) {
                  vals.splice(i, 1, keyframes[vals[i]])
                  return vals.join(' ')
                } else {
                  return v
                }
              })
              .join(',')
          }
        })
      }
    },
  }
}

const processedRules = new WeakSet<Rule>()

function processRule(id: string, rule: Rule) {
  // 如果规则已经处理过，或者是一个 @keyframes 规则，直接返回
  if (
    processedRules.has(rule) ||
    (rule.parent &&
      rule.parent.type === 'atrule' &&
      keyframesRE.test((rule.parent as AtRule).name))
  ) {
    return
  }
  processedRules.add(rule) // 标记为已处理
  let deep = false
  let parent: Document | Container | undefined = rule.parent

  // 检查规则是否在深层选择器（如 ::v-deep）内部
  while (parent && parent.type !== 'root') {
    if ((parent as any).__deep) {
      deep = true
      break
    }
    parent = parent.parent
  }

  // 重写选择器，添加作用域标识符
  rule.selector = selectorParser(selectorRoot => {
    selectorRoot.each(selector => {
      rewriteSelector(id, rule, selector, selectorRoot, deep)
    })
  }).processSync(rule.selector)
}

/**
 *
 * @param id 组件的作用域标识符
 * @param rule Rule 类型，当前处理的 CSS 规则
 * @param selector 当前处理的选择器
 * @param selectorRoot 选择器的根节点
 * @param deep 是否为深层选择器
 * @param slotted 是否为插槽选择器
 */
function rewriteSelector(
  id: string,
  rule: Rule,
  selector: selectorParser.Selector,
  selectorRoot: selectorParser.Root,
  deep: boolean,
  slotted = false,
) {
  let node: selectorParser.Node | null = null
  let shouldInject = !deep
  // find the last child node to insert attribute selector
  selector.each(n => {
    // DEPRECATED ">>>" and "/deep/" combinator
    // 处理废弃的组合器：
    // 处理 >>> 和 /deep/ 组合器，将其替换为空格，并发出警告
    if (
      n.type === 'combinator' &&
      (n.value === '>>>' || n.value === '/deep/')
    ) {
      n.value = ' '
      n.spaces.before = n.spaces.after = ''
      warn(
        `the >>> and /deep/ combinators have been deprecated. ` +
          `Use :deep() instead.`,
      )
      return false
    }

    // 处理伪类选择器
    if (n.type === 'pseudo') {
      const { value } = n
      // deep: inject [id] attribute at the node before the ::v-deep
      // combinator.
      //  ::v-deep 伪类处理
      if (value === ':deep' || value === '::v-deep') {
        ;(rule as any).__deep = true // 标记为深层选择器
        if (n.nodes.length) {
          // .foo ::v-deep(.bar) -> .foo[xxxxxxx] .bar
          // replace the current node with ::v-deep's inner selector
          let last: selectorParser.Selector['nodes'][0] = n
          n.nodes[0].each(ss => {
            selector.insertAfter(last, ss)
            last = ss
          })
          // insert a space combinator before if it doesn't already have one
          const prev = selector.at(selector.index(n) - 1)
          if (!prev || !isSpaceCombinator(prev)) {
            selector.insertAfter(
              n,
              selectorParser.combinator({
                value: ' ',
              }),
            )
          }
          selector.removeChild(n)
        } else {
          // DEPRECATED usage
          // .foo ::v-deep .bar -> .foo[xxxxxxx] .bar
          warn(
            `${value} usage as a combinator has been deprecated. ` +
              `Use :deep(<inner-selector>) instead of ${value} <inner-selector>.`,
          )

          const prev = selector.at(selector.index(n) - 1)
          if (prev && isSpaceCombinator(prev)) {
            selector.removeChild(prev)
          }
          selector.removeChild(n)
        }
        return false
      }

      // slot: use selector inside `::v-slotted` and inject [id + '-s']
      // instead.
      // ::v-slotted(.foo) -> .foo[xxxxxxx-s]
      // ::v-slotted 伪类处理
      if (value === ':slotted' || value === '::v-slotted') {
        rewriteSelector(
          id,
          rule,
          n.nodes[0],
          selectorRoot,
          deep,
          true /* slotted */,
        )
        let last: selectorParser.Selector['nodes'][0] = n
        n.nodes[0].each(ss => {
          selector.insertAfter(last, ss)
          last = ss
        })
        // selector.insertAfter(n, n.nodes[0])
        selector.removeChild(n)
        // since slotted attribute already scopes the selector there's no
        // need for the non-slot attribute.
        shouldInject = false
        return false
      }

      // global: replace with inner selector and do not inject [id].
      // ::v-global(.foo) -> .foo
      // ::v-global 伪类处理
      if (value === ':global' || value === '::v-global') {
        // 直接用 ::v-global 内部的选择器替换整个选择器
        selector.replaceWith(n.nodes[0])
        return false
      }
    }

    // 处理通用选择器（*）的逻辑
    if (n.type === 'universal') {
      const prev = selector.at(selector.index(n) - 1)
      const next = selector.at(selector.index(n) + 1)
      // * ... {}
      // 处理无前置节点的情况
      if (!prev) {
        // 情况 1：有后置节点（* .foo {}）：
        // * .foo {} -> .foo[xxxxxxx] {}
        if (next) {
          if (next.type === 'combinator' && next.value === ' ') {
            selector.removeChild(next)
          }
          selector.removeChild(n)
          return
        } else {
          // 情况 2：无后置节点（* {}）：
          // * {} -> [xxxxxxx] {}
          node = selectorParser.combinator({
            value: '',
          })
          selector.insertBefore(n, node)
          selector.removeChild(n)
          return false
        }
      }
      // 处理有前置节点的情况（.foo *）
      // .foo * -> .foo[xxxxxxx] *
      if (node) return
    }

    if (
      (n.type !== 'pseudo' && n.type !== 'combinator') ||
      (n.type === 'pseudo' &&
        (n.value === ':is' || n.value === ':where') &&
        !node)
    ) {
      node = n
    }
  })

  if (rule.nodes.some(node => node.type === 'rule')) {
    const deep = (rule as any).__deep
    if (!deep) {
      extractAndWrapNodes(rule)
      const atruleNodes = rule.nodes.filter(node => node.type === 'atrule')
      for (const atnode of atruleNodes) {
        extractAndWrapNodes(atnode)
      }
    }
    shouldInject = deep
  }

  if (node) {
    const { type, value } = node as selectorParser.Node
    if (type === 'pseudo' && (value === ':is' || value === ':where')) {
      ;(node as selectorParser.Pseudo).nodes.forEach(value =>
        rewriteSelector(id, rule, value, selectorRoot, deep, slotted),
      )
      shouldInject = false
    }
  }

  if (node) {
    ;(node as selectorParser.Node).spaces.after = ''
  } else {
    // For deep selectors & standalone pseudo selectors,
    // the attribute selectors are prepended rather than appended.
    // So all leading spaces must be eliminated to avoid problems.
    selector.first.spaces.before = ''
  }

  if (shouldInject) {
    // 处理需要注入 [id] 的情况
    const idToAdd = slotted ? id + '-s' : id
    selector.insertAfter(
      // If node is null it means we need to inject [id] at the start
      // insertAfter can handle `null` here
      node as any,
      selectorParser.attribute({
        attribute: idToAdd,
        value: idToAdd,
        raws: {},
        quoteMark: `"`,
      }),
    )
  }
}

function isSpaceCombinator(node: selectorParser.Node) {
  return node.type === 'combinator' && /^\s+$/.test(node.value)
}

function extractAndWrapNodes(parentNode: Rule | AtRule) {
  if (!parentNode.nodes) return
  const nodes = parentNode.nodes.filter(
    node => node.type === 'decl' || node.type === 'comment',
  )
  if (nodes.length) {
    for (const node of nodes) {
      parentNode.removeChild(node)
    }
    const wrappedRule = new Rule({
      nodes: nodes,
      selector: '&',
    })
    parentNode.prepend(wrappedRule)
  }
}

scopedPlugin.postcss = true
export default scopedPlugin
