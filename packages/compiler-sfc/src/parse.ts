import {
  type BindingMetadata,
  type CodegenSourceMapGenerator,
  type CompilerError,
  type ElementNode,
  NodeTypes,
  type ParserOptions,
  type RawSourceMap,
  type RootNode,
  type SourceLocation,
  createRoot,
} from '@vue/compiler-core'
import * as CompilerDOM from '@vue/compiler-dom'
import { SourceMapGenerator } from 'source-map-js'
import type { TemplateCompiler } from './compileTemplate'
import { parseCssVars } from './style/cssVars'
import { createCache } from './cache'
import type { ImportBinding } from './compileScript'
import { isImportUsed } from './script/importUsageCheck'
import type { LRUCache } from 'lru-cache'
import { genCacheKey } from '@vue/shared'

export const DEFAULT_FILENAME = 'anonymous.vue'

export interface SFCParseOptions {
  filename?: string
  sourceMap?: boolean
  sourceRoot?: string
  pad?: boolean | 'line' | 'space'
  ignoreEmpty?: boolean
  compiler?: TemplateCompiler
  templateParseOptions?: ParserOptions
}

export interface SFCBlock {
  type: string
  content: string
  attrs: Record<string, string | true>
  loc: SourceLocation
  map?: RawSourceMap
  lang?: string
  src?: string
}

export interface SFCTemplateBlock extends SFCBlock {
  type: 'template'
  ast?: RootNode
}

export interface SFCScriptBlock extends SFCBlock {
  type: 'script'
  setup?: string | boolean
  bindings?: BindingMetadata
  imports?: Record<string, ImportBinding>
  scriptAst?: import('@babel/types').Statement[]
  scriptSetupAst?: import('@babel/types').Statement[]
  warnings?: string[]
  /**
   * Fully resolved dependency file paths (unix slashes) with imported types
   * used in macros, used for HMR cache busting in @vitejs/plugin-vue and
   * vue-loader.
   */
  deps?: string[]
}

export interface SFCStyleBlock extends SFCBlock {
  type: 'style'
  scoped?: boolean
  module?: string | boolean
}

export interface SFCDescriptor {
  filename: string
  source: string
  template: SFCTemplateBlock | null
  script: SFCScriptBlock | null
  scriptSetup: SFCScriptBlock | null
  styles: SFCStyleBlock[]
  customBlocks: SFCBlock[]
  cssVars: string[]
  /**
   * whether the SFC uses :slotted() modifier.
   * this is used as a compiler optimization hint.
   */
  slotted: boolean

  /**
   * compare with an existing descriptor to determine whether HMR should perform
   * a reload vs. re-render.
   *
   * Note: this comparison assumes the prev/next script are already identical,
   * and only checks the special case where <script setup lang="ts"> unused import
   * pruning result changes due to template changes.
   */
  shouldForceReload: (prevImports: Record<string, ImportBinding>) => boolean
}

export interface SFCParseResult {
  descriptor: SFCDescriptor
  errors: (CompilerError | SyntaxError)[]
}

export const parseCache:
  | Map<string, SFCParseResult>
  | LRUCache<string, SFCParseResult> = createCache<SFCParseResult>()

/**
 * 解析 SFC 字符串
 * @param source SFC 字符串
 * @param options 解析选项
 * @returns 解析结果
 */
export function parse(
  source: string,
  options: SFCParseOptions = {},
): SFCParseResult {
  const sourceKey = genCacheKey(source, {
    ...options,
    compiler: { parse: options.compiler?.parse },
  })
  const cache = parseCache.get(sourceKey)
  if (cache) {
    return cache
  }

  const {
    sourceMap = true,
    filename = DEFAULT_FILENAME,
    sourceRoot = '',
    pad = false,
    ignoreEmpty = true,
    compiler = CompilerDOM,
    templateParseOptions = {},
  } = options

  const descriptor: SFCDescriptor = {
    filename,
    source,
    template: null,
    script: null,
    scriptSetup: null,
    styles: [],
    customBlocks: [],
    cssVars: [],
    slotted: false,
    shouldForceReload: prevImports => hmrShouldReload(prevImports, descriptor),
  }

  const errors: (CompilerError | SyntaxError)[] = []
  const ast = compiler.parse(source, {
    parseMode: 'sfc',
    prefixIdentifiers: true,
    ...templateParseOptions,
    onError: e => {
      errors.push(e)
    },
  })
  ast.children.forEach(node => {
    if (node.type !== NodeTypes.ELEMENT) {
      return
    }
    // we only want to keep the nodes that are not empty
    // (when the tag is not a template)
    if (
      ignoreEmpty &&
      node.tag !== 'template' &&
      isEmpty(node) &&
      !hasSrc(node)
    ) {
      return
    }
    switch (node.tag) {
      case 'template':
        if (!descriptor.template) {
          // 创建一个块对象，记录模板的位置、属性等信息
          const templateBlock = (descriptor.template = createBlock(
            node,
            source,
            false,
          ) as SFCTemplateBlock)

          // 将模板的子节点解析为 AST 根节点
          if (!templateBlock.attrs.src) {
            templateBlock.ast = createRoot(node.children, source)
          }

          // warn against 2.x <template functional>
          if (templateBlock.attrs.functional) {
            const err = new SyntaxError(
              `<template functional> is no longer supported in Vue 3, since ` +
                `functional components no longer have significant performance ` +
                `difference from stateful ones. Just use a normal <template> ` +
                `instead.`,
            ) as CompilerError
            err.loc = node.props.find(
              p => p.type === NodeTypes.ATTRIBUTE && p.name === 'functional',
            )!.loc
            errors.push(err)
          }
        } else {
          errors.push(createDuplicateBlockError(node))
        }
        break
      case 'script':
        // 创建一个脚本块对象
        const scriptBlock = createBlock(node, source, pad) as SFCScriptBlock

        // Setup 脚本识别
        const isSetup = !!scriptBlock.attrs.setup

        if (isSetup && !descriptor.scriptSetup) {
          descriptor.scriptSetup = scriptBlock
          break
        }
        if (!isSetup && !descriptor.script) {
          descriptor.script = scriptBlock
          break
        }
        errors.push(createDuplicateBlockError(node, isSetup))
        break

      case 'style':
        const styleBlock = createBlock(node, source, pad) as SFCStyleBlock

        // 检测已废弃的 <style vars> 语法
        if (styleBlock.attrs.vars) {
          errors.push(
            new SyntaxError(
              `<style vars> has been replaced by a new proposal: ` +
                `https://github.com/vuejs/rfcs/pull/231`,
            ),
          )
        }
        descriptor.styles.push(styleBlock)
        break
      default:
        descriptor.customBlocks.push(createBlock(node, source, pad))
        break
    }
  })

  // 至少有一个 <template> 或 <script> 或 <script setup> 模块存在
  if (!descriptor.template && !descriptor.script && !descriptor.scriptSetup) {
    errors.push(
      new SyntaxError(
        `At least one <template> or <script> is required in a single file component. ${descriptor.filename}`,
      ),
    )
  }

  if (descriptor.scriptSetup) {
    // <script setup> 模块不可有 src 属性
    if (descriptor.scriptSetup.src) {
      errors.push(
        new SyntaxError(
          `<script setup> cannot use the "src" attribute because ` +
            `its syntax will be ambiguous outside of the component.`,
        ),
      )
      descriptor.scriptSetup = null
    }
    // <script setup> 存在时，<script> 模块不可有 src 属性
    if (descriptor.script && descriptor.script.src) {
      errors.push(
        new SyntaxError(
          `<script> cannot use the "src" attribute when <script setup> is ` +
            `also present because they must be processed together.`,
        ),
      )
      descriptor.script = null
    }
  }

  // dedent pug/jade templates
  let templateColumnOffset = 0

  // 模板语言为 pug 或 jade 时，进行缩进处理
  if (
    descriptor.template &&
    (descriptor.template.lang === 'pug' || descriptor.template.lang === 'jade')
  ) {
    ;[descriptor.template.content, templateColumnOffset] = dedent(
      descriptor.template.content,
    )
  }

  if (sourceMap) {
    const genMap = (block: SFCBlock | null, columnOffset = 0) => {
      // 确保块不是外部引入的（有 src 属性的块不需要生成 SourceMap）
      if (block && !block.src) {
        block.map = generateSourceMap(
          filename,
          source,
          block.content,
          sourceRoot,
          !pad || block.type === 'template' ? block.loc.start.line - 1 : 0,
          columnOffset,
        )
      }
    }
    // template 块
    genMap(descriptor.template, templateColumnOffset)
    // 脚本块
    genMap(descriptor.script)
    // 样式块
    descriptor.styles.forEach(s => genMap(s))
    // 自定义块
    descriptor.customBlocks.forEach(s => genMap(s))
  }

  // parse CSS vars
  // 解析 CSS 变量的函数，从组件描述符中提取 CSS 变量
  descriptor.cssVars = parseCssVars(descriptor)

  // check if the SFC uses :slotted
  // :slotted 选择器检测
  const slottedRE = /(?:::v-|:)slotted\(/

  descriptor.slotted = descriptor.styles.some(
    // 组件是否使用了 :slotted 选择器
    s => s.scoped && slottedRE.test(s.content),
  )

  const result = {
    descriptor,
    errors,
  }
  parseCache.set(sourceKey, result)
  return result
}

function createDuplicateBlockError(
  node: ElementNode,
  isScriptSetup = false,
): CompilerError {
  const err = new SyntaxError(
    `Single file component can contain only one <${node.tag}${
      isScriptSetup ? ` setup` : ``
    }> element`,
  ) as CompilerError
  err.loc = node.loc
  return err
}

/**
 *  Vue 3 编译器 SFC 模块,用于创建 SFC (Single File Component) 块对象
 * @param node 元素节点
 * @param source 源代码
 * @param pad 是否填充内容
 * @returns 块对象
 */
function createBlock(
  node: ElementNode,
  source: string,
  pad: SFCParseOptions['pad'],
): SFCBlock {
  // 从节点标签获取块类型（如 template、script、style）
  const type = node.tag
  // 获取节点的内部位置信息，用于提取内容
  const loc = node.innerLoc!
  // 初始化属性对象，存储块的属性
  const attrs: Record<string, string | true> = {}
  const block: SFCBlock = {
    type,
    // 从源代码中提取的块内容
    content: source.slice(loc.start.offset, loc.end.offset),
    loc,
    attrs,
  }

  // 处理内容填充，根据 pad 选项添加前导空格
  if (pad) {
    block.content = padContent(source, block, pad) + block.content
  }

  // 处理属性，将属性值存储到块对象的 attrs 中
  node.props.forEach(p => {
    if (p.type === NodeTypes.ATTRIBUTE) {
      const name = p.name
      attrs[name] = p.value ? p.value.content || true : true
      if (name === 'lang') {
        // 设置块语言
        block.lang = p.value && p.value.content
      } else if (name === 'src') {
        // 设置块源文件路径
        block.src = p.value && p.value.content
      } else if (type === 'style') {
        if (name === 'scoped') {
          // 设置块是否为作用域样式
          ;(block as SFCStyleBlock).scoped = true
        } else if (name === 'module') {
          // 设置 module 属性
          ;(block as SFCStyleBlock).module = attrs[name]
        }
      } else if (type === 'script' && name === 'setup') {
        ;(block as SFCScriptBlock).setup = attrs.setup
      }
    }
  })
  return block
}
// 换行符 \n 或者 \r\n
const splitRE = /\r?\n/g
// 匹配空行或注释行的正则表达式
const emptyRE = /^(?:\/\/)?\s*$/
// 匹配任意字符（除了换行符）
const replaceRE = /./g

/**
 * 生成 SourceMap
 * @param filename 源文件名
 * @param source 源代码
 * @param generated 生成的代码
 * @param sourceRoot 源根目录
 * @param lineOffset 行偏移量
 * @param columnOffset 列偏移量
 * @returns SourceMap 对象
 */
function generateSourceMap(
  filename: string,
  source: string,
  generated: string,
  sourceRoot: string,
  lineOffset: number,
  columnOffset: number,
): RawSourceMap {
  // 初始化 SourceMapGenerator
  const map = new SourceMapGenerator({
    file: filename.replace(/\\/g, '/'),
    sourceRoot: sourceRoot.replace(/\\/g, '/'),
  }) as unknown as CodegenSourceMapGenerator

  map.setSourceContent(filename, source)
  map._sources.add(filename)

  // 按换行符将生成的代码分割成行
  generated.split(splitRE).forEach((line, index) => {
    if (!emptyRE.test(line)) {
      const originalLine = index + 1 + lineOffset
      const generatedLine = index + 1
      for (let i = 0; i < line.length; i++) {
        if (!/\s/.test(line[i])) {
          map._mappings.add({
            originalLine,
            originalColumn: i + columnOffset,
            generatedLine,
            generatedColumn: i,
            source: filename,
            name: null,
          })
        }
      }
    }
  })
  return map.toJSON()
}

function padContent(
  content: string,
  block: SFCBlock,
  pad: SFCParseOptions['pad'],
): string {
  content = content.slice(0, block.loc.start.offset)
  if (pad === 'space') {
    return content.replace(replaceRE, ' ')
  } else {
    const offset = content.split(splitRE).length
    const padChar = block.type === 'script' && !block.lang ? '//\n' : '\n'
    return Array(offset).join(padChar)
  }
}

function hasSrc(node: ElementNode) {
  return node.props.some(p => {
    if (p.type !== NodeTypes.ATTRIBUTE) {
      return false
    }
    return p.name === 'src'
  })
}

/**
 * Returns true if the node has no children
 * once the empty text nodes (trimmed content) have been filtered out.
 */
function isEmpty(node: ElementNode) {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (child.type !== NodeTypes.TEXT || child.content.trim() !== '') {
      return false
    }
  }
  return true
}

/**
 * Note: this comparison assumes the prev/next script are already identical,
 * and only checks the special case where <script setup lang="ts"> unused import
 * pruning result changes due to template changes.
 */
export function hmrShouldReload(
  prevImports: Record<string, ImportBinding>,
  next: SFCDescriptor,
): boolean {
  if (
    !next.scriptSetup ||
    (next.scriptSetup.lang !== 'ts' && next.scriptSetup.lang !== 'tsx')
  ) {
    return false
  }

  // for each previous import, check if its used status remain the same based on
  // the next descriptor's template
  for (const key in prevImports) {
    // if an import was previous unused, but now is used, we need to force
    // reload so that the script now includes that import.
    if (!prevImports[key].isUsedInTemplate && isImportUsed(key, next)) {
      return true
    }
  }

  return false
}

/**
 * Dedent a string.
 *
 * This removes any whitespace that is common to all lines in the string from
 * each line in the string.
 */
function dedent(s: string): [string, number] {
  const lines = s.split('\n')
  const minIndent = lines.reduce(function (minIndent, line) {
    if (line.trim() === '') {
      return minIndent
    }
    const indent = line.match(/^\s*/)?.[0]?.length || 0
    return Math.min(indent, minIndent)
  }, Infinity)
  if (minIndent === 0) {
    return [s, minIndent]
  }
  return [
    lines
      .map(function (line) {
        return line.slice(minIndent)
      })
      .join('\n'),
    minIndent,
  ]
}
