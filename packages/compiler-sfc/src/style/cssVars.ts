import {
  type BindingMetadata,
  NodeTypes,
  type SimpleExpressionNode,
  createRoot,
  createSimpleExpression,
  createTransformContext,
  processExpression,
} from '@vue/compiler-dom'
import type { SFCDescriptor } from '../parse'
import type { PluginCreator } from 'postcss'
import hash from 'hash-sum'
import { getEscapedCssVarName } from '@vue/shared'

export const CSS_VARS_HELPER = `useCssVars`

export function genCssVarsFromList(
  vars: string[],
  id: string,
  isProd: boolean,
  isSSR = false,
): string {
  return `{\n  ${vars
    .map(
      key =>
        // The `:` prefix here is used in `ssrRenderStyle` to distinguish whether
        // a custom property comes from `ssrCssVars`. If it does, we need to reset
        // its value to `initial` on the component instance to avoid unintentionally
        // inheriting the same property value from a different instance of the same
        // component in the outer scope.
        `"${isSSR ? `:--` : ``}${genVarName(id, key, isProd, isSSR)}": (${key})`,
    )
    .join(',\n  ')}\n}`
}

/**
 * 生成 CSS 变量名
 * @param id  组件的唯一标识符
 * @param raw 原始的 CSS 变量绑定表达式
 * @param isProd
 * @param isSSR
 * @returns
 */
function genVarName(
  id: string,
  raw: string,
  isProd: boolean,
  isSSR = false,
): string {
  if (isProd) {
    // hash must not start with a digit to comply with CSS custom property naming rules
    // 检查哈希值是否以数字开头，如果是，在前面添加 "v"（符合 CSS 自定义属性命名规则）
    return hash(id + raw).replace(/^\d/, r => `v${r}`)
  } else {
    // escape ASCII Punctuation & Symbols
    // #7823 need to double-escape in SSR because the attributes are rendered
    // into an HTML string
    return `${id}-${getEscapedCssVarName(raw, isSSR)}`
  }
}

/**
 * 标准化 CSS 变量绑定表达式，主要功能是去除表达式两端的空白字符和可能存在的引号
 * @param exp
 * @returns
 */
function normalizeExpression(exp: string) {
  exp = exp.trim()
  if (
    (exp[0] === `'` && exp[exp.length - 1] === `'`) ||
    (exp[0] === `"` && exp[exp.length - 1] === `"`)
  ) {
    return exp.slice(1, -1)
  }
  return exp
}

const vBindRE = /v-bind\s*\(/g

/**
 * 解析 Vue 单文件组件 (SFC) 中使用 v-bind() 语法定义的 CSS 变量
 * @param sfc SFC 描述符
 * @returns CSS 变量列表
 */
export function parseCssVars(sfc: SFCDescriptor): string[] {
  const vars: string[] = []
  sfc.styles.forEach(style => {
    let match
    // ignore v-bind() in comments, eg /* ... */
    // and // (Less, Sass and Stylus all support the use of // to comment)
    // 移除样式内容中的注释
    const content = style.content.replace(/\/\*([\s\S]*?)\*\/|\/\/.*/g, '')
    // 匹配 v-bind() 语法
    while ((match = vBindRE.exec(content))) {
      // 计算绑定表达式的开始位置
      const start = match.index + match[0].length
      // 解析绑定表达式的结束位置
      const end = lexBinding(content, start)
      if (end !== null) {
        // 提取绑定表达式并标准化
        const variable = normalizeExpression(content.slice(start, end))
        if (!vars.includes(variable)) {
          vars.push(variable)
        }
      }
    }
  })
  return vars
}

enum LexerState {
  inParens,
  inSingleQuoteString,
  inDoubleQuoteString,
}

/**
 * 解析 CSS 中 v-bind() 表达式的结束位置。
 * 它能够正确处理嵌套括号和字符串中的括号，确保找到正确的表达式边界
 * @param content 要解析的 CSS 内容
 * @param start 开始解析的位置（v-bind( 之后的位置）
 * @returns
 */
function lexBinding(content: string, start: number): number | null {
  // 设置初始状态为 LexerState.inParens（在括号内）
  let state: LexerState = LexerState.inParens
  let parenDepth = 0 // 括号深度

  for (let i = start; i < content.length; i++) {
    const char = content.charAt(i)
    switch (state) {
      case LexerState.inParens:
        if (char === `'`) {
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          state = LexerState.inDoubleQuoteString
        } else if (char === `(`) {
          // 遇到左括号 (：增加括号深度
          parenDepth++
        } else if (char === `)`) {
          // 遇到右括号 )：
          // 如果括号深度大于 0，减少括号深度
          // 如果括号深度为 0，返回当前位置（找到表达式结束）
          if (parenDepth > 0) {
            parenDepth--
          } else {
            return i
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          state = LexerState.inParens
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          state = LexerState.inParens
        }
        break
    }
  }
  return null
}

// for compileStyle
export interface CssVarsPluginOptions {
  id: string
  isProd: boolean
}

/**
 * 将 CSS 中的 v-bind() 表达式重写为 CSS 变量引用
 * @param opts
 * @returns
 */
export const cssVarsPlugin: PluginCreator<CssVarsPluginOptions> = opts => {
  const { id, isProd } = opts!
  return {
    postcssPlugin: 'vue-sfc-vars',
    // 处理 CSS 声明
    Declaration(decl) {
      // rewrite CSS variables
      const value = decl.value
      // 检查值中是否包含 v-bind() 表达式
      if (vBindRE.test(value)) {
        vBindRE.lastIndex = 0
        let transformed = ''
        let lastIndex = 0
        let match
        // 使用 while 循环匹配所有 v-bind() 表达式
        while ((match = vBindRE.exec(value))) {
          const start = match.index + match[0].length
          const end = lexBinding(value, start)
          if (end !== null) {
            // 提取绑定表达式并标准化
            const variable = normalizeExpression(value.slice(start, end))
            transformed +=
              value.slice(lastIndex, match.index) +
              `var(--${genVarName(id, variable, isProd)})`
            lastIndex = end + 1
          }
        }
        // 生成的格式为 var(--变量名)
        decl.value = transformed + value.slice(lastIndex)
      }
    },
  }
}
cssVarsPlugin.postcss = true

/**
 * 生成 CSS 变量处理的代码
 * @param vars CSS 变量列表
 * @param bindings 绑定元数据
 * @param id 组件 ID
 * @param isProd 是否为生产环境
 * @returns
 */
export function genCssVarsCode(
  vars: string[],
  bindings: BindingMetadata,
  id: string,
  isProd: boolean,
) {
  const varsExp = genCssVarsFromList(vars, id, isProd)
  const exp = createSimpleExpression(varsExp, false)
  const context = createTransformContext(createRoot([]), {
    prefixIdentifiers: true,
    inline: true,
    bindingMetadata: bindings.__isScriptSetup === false ? undefined : bindings,
  })
  const transformed = processExpression(exp, context)
  const transformedString =
    transformed.type === NodeTypes.SIMPLE_EXPRESSION
      ? transformed.content
      : transformed.children
          .map(c => {
            return typeof c === 'string'
              ? c
              : (c as SimpleExpressionNode).content
          })
          .join('')

  return `_${CSS_VARS_HELPER}(_ctx => (${transformedString}))`
}

// <script setup> already gets the calls injected as part of the transform
// this is only for single normal <script>
export function genNormalScriptCssVarsCode(
  cssVars: string[],
  bindings: BindingMetadata,
  id: string,
  isProd: boolean,
  defaultVar: string,
): string {
  return (
    `\nimport { ${CSS_VARS_HELPER} as _${CSS_VARS_HELPER} } from 'vue'\n` +
    `const __injectCSSVars__ = () => {\n${genCssVarsCode(
      cssVars,
      bindings,
      id,
      isProd,
    )}}\n` +
    `const __setup__ = ${defaultVar}.setup\n` +
    `${defaultVar}.setup = __setup__\n` +
    `  ? (props, ctx) => { __injectCSSVars__();return __setup__(props, ctx) }\n` +
    `  : __injectCSSVars__\n`
  )
}
