import type { CodegenOptions } from './options'
import {
  type ArrayExpression,
  type AssignmentExpression,
  type CacheExpression,
  type CallExpression,
  type CommentNode,
  type CompoundExpressionNode,
  type ConditionalExpression,
  type ExpressionNode,
  type FunctionExpression,
  type IfStatement,
  type InterpolationNode,
  type JSChildNode,
  NodeTypes,
  type ObjectExpression,
  type Position,
  type ReturnStatement,
  type RootNode,
  type SSRCodegenNode,
  type SequenceExpression,
  type SimpleExpressionNode,
  type TemplateChildNode,
  type TemplateLiteral,
  type TextNode,
  type VNodeCall,
  getVNodeBlockHelper,
  getVNodeHelper,
  locStub,
} from './ast'
import { SourceMapGenerator } from 'source-map-js'
import {
  advancePositionWithMutation,
  assert,
  isSimpleIdentifier,
  toValidAssetId,
} from './utils'
import {
  PatchFlagNames,
  type PatchFlags,
  isArray,
  isString,
  isSymbol,
} from '@vue/shared'
import {
  CREATE_COMMENT,
  CREATE_ELEMENT_VNODE,
  CREATE_STATIC,
  CREATE_TEXT,
  CREATE_VNODE,
  OPEN_BLOCK,
  RESOLVE_COMPONENT,
  RESOLVE_DIRECTIVE,
  RESOLVE_FILTER,
  SET_BLOCK_TRACKING,
  TO_DISPLAY_STRING,
  WITH_CTX,
  WITH_DIRECTIVES,
  helperNameMap,
} from './runtimeHelpers'
import type { ImportItem } from './transform'

/**
 * The `SourceMapGenerator` type from `source-map-js` is a bit incomplete as it
 * misses `toJSON()`. We also need to add types for internal properties which we
 * need to access for better performance.
 *
 * Since TS 5.3, dts generation starts to strangely include broken triple slash
 * references for source-map-js, so we are inlining all source map related types
 * here to to workaround that.
 */
export interface CodegenSourceMapGenerator {
  setSourceContent(sourceFile: string, sourceContent: string): void
  // SourceMapGenerator has this method but the types do not include it
  toJSON(): RawSourceMap
  _sources: Set<string>
  _names: Set<string>
  _mappings: {
    add(mapping: MappingItem): void
  }
}

export interface RawSourceMap {
  file?: string
  sourceRoot?: string
  version: string
  sources: string[]
  names: string[]
  sourcesContent?: string[]
  mappings: string
}

interface MappingItem {
  source: string
  generatedLine: number
  generatedColumn: number
  originalLine: number
  originalColumn: number
  name: string | null
}

const PURE_ANNOTATION = `/*@__PURE__*/`

const aliasHelper = (s: symbol) => `${helperNameMap[s]}: _${helperNameMap[s]}`

type CodegenNode = TemplateChildNode | JSChildNode | SSRCodegenNode

export interface CodegenResult {
  code: string
  preamble: string
  ast: RootNode
  map?: RawSourceMap
}

enum NewlineType {
  Start = 0,
  End = -1,
  None = -2,
  Unknown = -3,
}

export interface CodegenContext extends Omit<
  Required<CodegenOptions>,
  'bindingMetadata' | 'inline'
> {
  source: string
  code: string
  line: number
  column: number
  offset: number
  indentLevel: number
  pure: boolean
  map?: CodegenSourceMapGenerator
  helper(key: symbol): string
  push(code: string, newlineIndex?: number, node?: CodegenNode): void
  indent(): void
  deindent(withoutNewLine?: boolean): void
  newline(): void
}

function createCodegenContext(
  ast: RootNode,
  {
    mode = 'function',
    prefixIdentifiers = mode === 'module',
    sourceMap = false,
    filename = `template.vue.html`,
    scopeId = null,
    optimizeImports = false,
    runtimeGlobalName = `Vue`,
    runtimeModuleName = `vue`,
    ssrRuntimeModuleName = 'vue/server-renderer',
    ssr = false,
    isTS = false,
    inSSR = false,
  }: CodegenOptions,
): CodegenContext {
  const context: CodegenContext = {
    mode,
    prefixIdentifiers,
    sourceMap,
    filename,
    scopeId,
    optimizeImports,
    runtimeGlobalName,
    runtimeModuleName,
    ssrRuntimeModuleName,
    ssr,
    isTS,
    inSSR,
    source: ast.source,
    code: ``,
    column: 1,
    line: 1,
    offset: 0,
    indentLevel: 0,
    pure: false,
    map: undefined,
    helper(key) {
      return `_${helperNameMap[key]}`
    },
    push(code, newlineIndex = NewlineType.None, node) {
      context.code += code
      if (!__BROWSER__ && context.map) {
        if (node) {
          let name
          if (node.type === NodeTypes.SIMPLE_EXPRESSION && !node.isStatic) {
            const content = node.content.replace(/^_ctx\./, '')
            if (content !== node.content && isSimpleIdentifier(content)) {
              name = content
            }
          }
          if (node.loc.source) {
            addMapping(node.loc.start, name)
          }
        }
        if (newlineIndex === NewlineType.Unknown) {
          // multiple newlines, full iteration
          advancePositionWithMutation(context, code)
        } else {
          // fast paths
          context.offset += code.length
          if (newlineIndex === NewlineType.None) {
            // no newlines; fast path to avoid newline detection
            if (__TEST__ && code.includes('\n')) {
              throw new Error(
                `CodegenContext.push() called newlineIndex: none, but contains` +
                  `newlines: ${code.replace(/\n/g, '\\n')}`,
              )
            }
            context.column += code.length
          } else {
            // single newline at known index
            if (newlineIndex === NewlineType.End) {
              newlineIndex = code.length - 1
            }
            if (
              __TEST__ &&
              (code.charAt(newlineIndex) !== '\n' ||
                code.slice(0, newlineIndex).includes('\n') ||
                code.slice(newlineIndex + 1).includes('\n'))
            ) {
              throw new Error(
                `CodegenContext.push() called with newlineIndex: ${newlineIndex} ` +
                  `but does not conform: ${code.replace(/\n/g, '\\n')}`,
              )
            }
            context.line++
            context.column = code.length - newlineIndex
          }
        }
        if (node && node.loc !== locStub && node.loc.source) {
          addMapping(node.loc.end)
        }
      }
    },
    indent() {
      newline(++context.indentLevel)
    },
    deindent(withoutNewLine = false) {
      if (withoutNewLine) {
        --context.indentLevel
      } else {
        newline(--context.indentLevel)
      }
    },
    newline() {
      newline(context.indentLevel)
    },
  }

  function newline(n: number) {
    context.push('\n' + `  `.repeat(n), NewlineType.Start)
  }

  function addMapping(loc: Position, name: string | null = null) {
    // we use the private property to directly add the mapping
    // because the addMapping() implementation in source-map-js has a bunch of
    // unnecessary arg and validation checks that are pure overhead in our case.
    const { _names, _mappings } = context.map!
    if (name !== null && !_names.has(name)) _names.add(name)
    _mappings.add({
      originalLine: loc.line,
      originalColumn: loc.column - 1, // source-map column is 0 based
      generatedLine: context.line,
      generatedColumn: context.column - 1,
      source: filename,
      name,
    })
  }

  if (!__BROWSER__ && sourceMap) {
    // lazy require source-map implementation, only in non-browser builds
    context.map =
      new SourceMapGenerator() as unknown as CodegenSourceMapGenerator
    context.map.setSourceContent(filename, context.source)
    context.map._sources.add(filename)
  }

  return context
}

/**
 * 生成代码
 * @param ast 根节点
 * @param options 选项选项
 * @returns 代码生成结果
 */
export function generate(
  ast: RootNode,
  options: CodegenOptions & {
    onContextCreated?: (context: CodegenContext) => void
  } = {},
): CodegenResult {
  // 创建上下文
  const context = createCodegenContext(ast, options)
  if (options.onContextCreated) options.onContextCreated(context)
  const {
    mode,
    push,
    prefixIdentifiers,
    indent,
    deindent,
    newline,
    scopeId,
    ssr,
  } = context

  const helpers = Array.from(ast.helpers)
  const hasHelpers = helpers.length > 0
  const useWithBlock = !prefixIdentifiers && mode !== 'module' // 是否使用 with 块
  const genScopeId = !__BROWSER__ && scopeId != null && mode === 'module' // 是否生成作用域 ID
  const isSetupInlined = !__BROWSER__ && !!options.inline // 是否内联 setup 函数

  // preambles
  // in setup() inline mode, the preamble is generated in a sub context
  // and returned separately.
  const preambleContext = isSetupInlined
    ? // 如果是内联 setup 模式，创建新的上下文
      createCodegenContext(ast, options)
    : context

  if (!__BROWSER__ && mode === 'module') {
    // 模块模式：调用 genModulePreamble 生成模块前缀
    genModulePreamble(ast, preambleContext, genScopeId, isSetupInlined)
  } else {
    // 其他模式：调用 genFunctionPreamble 生成函数前缀
    genFunctionPreamble(ast, preambleContext)
  }
  // enter render function
  // 函数名称
  const functionName = ssr ? `ssrRender` : `render`
  // 函数参数
  const args = ssr ? ['_ctx', '_push', '_parent', '_attrs'] : ['_ctx', '_cache']
  if (!__BROWSER__ && options.bindingMetadata && !options.inline) {
    // binding optimization args
    args.push('$props', '$setup', '$data', '$options')
  }
  // 生成函数签名，支持 TypeScript 类型
  const signature =
    !__BROWSER__ && options.isTS
      ? args.map(arg => `${arg}: any`).join(',')
      : args.join(', ')

  if (isSetupInlined) {
    push(`(${signature}) => {`)
  } else {
    push(`function ${functionName}(${signature}) {`)
  }
  indent()

  if (useWithBlock) {
    push(`with (_ctx) {`)
    indent()
    // function mode const declarations should be inside with block
    // also they should be renamed to avoid collision with user properties
    if (hasHelpers) {
      push(
        `const { ${helpers.map(aliasHelper).join(', ')} } = _Vue\n`,
        NewlineType.End,
      )
      newline()
    }
  }

  // generate asset resolution statements
  if (ast.components.length) {
    // 生成组件资源解析语句
    genAssets(ast.components, 'component', context)
    if (ast.directives.length || ast.temps > 0) {
      newline()
    }
  }
  if (ast.directives.length) {
    // 生成指令资源解析语句
    genAssets(ast.directives, 'directive', context)
    if (ast.temps > 0) {
      newline()
    }
  }
  if (__COMPAT__ && ast.filters && ast.filters.length) {
    // 在兼容模式下生成过滤器资源解析语句
    newline()
    genAssets(ast.filters, 'filter', context)
    newline()
  }

  // 生成临时变量声明，用于代码生成过程中的临时存储
  if (ast.temps > 0) {
    push(`let `)
    for (let i = 0; i < ast.temps; i++) {
      push(`${i > 0 ? `, ` : ``}_temp${i}`)
    }
  }
  if (ast.components.length || ast.directives.length || ast.temps) {
    push(`\n`, NewlineType.Start)
    newline()
  }

  // generate the VNode tree expression
  // 在非 SSR 模式下生成 return 语句
  if (!ssr) {
    push(`return `)
  }
  // 调用 genNode 生成 VNode 树表达式
  if (ast.codegenNode) {
    genNode(ast.codegenNode, context)
  } else {
    push(`null`)
  }

  if (useWithBlock) {
    deindent()
    push(`}`)
  }

  deindent()
  push(`}`)

  return {
    ast,
    code: context.code,
    preamble: isSetupInlined ? preambleContext.code : ``,
    map: context.map ? context.map.toJSON() : undefined,
  }
}

/**
 * 生成渲染函数的前置代码
 * @param ast
 * @param context
 */
function genFunctionPreamble(ast: RootNode, context: CodegenContext) {
  const {
    ssr,
    prefixIdentifiers,
    push,
    newline,
    runtimeModuleName,
    runtimeGlobalName,
    ssrRuntimeModuleName,
  } = context

  // 生成 Vue 绑定
  // 在非浏览器环境且是 SSR 时，使用 require 导入 Vue
  // 其他情况使用全局 Vue 变量
  const VueBinding =
    !__BROWSER__ && ssr
      ? `require(${JSON.stringify(runtimeModuleName)})`
      : runtimeGlobalName
  // Generate const declaration for helpers
  // In prefix mode, we place the const declaration at top so it's done
  // only once; But if we not prefixing, we place the declaration inside the
  // with block so it doesn't incur the `in` check cost for every helper access.
  // 生成 Helpers 常量声明
  const helpers = Array.from(ast.helpers)
  if (helpers.length > 0) {
    // 前缀模式：在函数顶部生成一次常量声明
    if (!__BROWSER__ && prefixIdentifiers) {
      push(
        `const { ${helpers.map(aliasHelper).join(', ')} } = ${VueBinding}\n`,
        NewlineType.End,
      )
    } else {
      // "with" mode.
      // save Vue in a separate variable to avoid collision
      // with 模式：
      // 保存 Vue 到单独变量避免冲突
      // 为静态内容生成必要的 helpers 声明
      push(`const _Vue = ${VueBinding}\n`, NewlineType.End)
      // in "with" mode, helpers are declared inside the with block to avoid
      // has check cost, but hoists are lifted out of the function - we need
      // to provide the helper here.
      if (ast.hoists.length) {
        const staticHelpers = [
          CREATE_VNODE,
          CREATE_ELEMENT_VNODE,
          CREATE_COMMENT,
          CREATE_TEXT,
          CREATE_STATIC,
        ]
          .filter(helper => helpers.includes(helper))
          .map(aliasHelper)
          .join(', ')
        push(`const { ${staticHelpers} } = _Vue\n`, NewlineType.End)
      }
    }
  }
  // generate variables for ssr helpers
  if (!__BROWSER__ && ast.ssrHelpers && ast.ssrHelpers.length) {
    // ssr guarantees prefixIdentifier: true
    // 在非浏览器环境且存在 SSR helpers 时生成
    push(
      `const { ${ast.ssrHelpers
        .map(aliasHelper)
        .join(', ')} } = require("${ssrRuntimeModuleName}")\n`,
      NewlineType.End,
    )
  }
  // 调用 genHoists 处理被提升的静态内容
  genHoists(ast.hoists, context)
  newline()
  push(`return `)
}

/**
 * 生成模块的前置代码
 * @param ast
 * @param context
 * @param genScopeId
 * @param inline
 */
function genModulePreamble(
  ast: RootNode,
  context: CodegenContext,
  genScopeId: boolean,
  inline?: boolean,
) {
  const {
    push,
    newline,
    optimizeImports,
    runtimeModuleName,
    ssrRuntimeModuleName,
  } = context

  // generate import statements for helpers
  // 生成辅助函数导入
  if (ast.helpers.size) {
    const helpers = Array.from(ast.helpers)
    if (optimizeImports) {
      // when bundled with webpack with code-split, calling an import binding
      // as a function leads to it being wrapped with `Object(a.b)` or `(0,a.b)`,
      // incurring both payload size increase and potential perf overhead.
      // therefore we assign the imports to variables (which is a constant ~50b
      // cost per-component instead of scaling with template size)
      // 优化模式：先导入，再绑定到变量，避免 webpack code-split 时的性能开销
      push(
        `import { ${helpers
          .map(s => helperNameMap[s])
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`,
        NewlineType.End,
      )
      push(
        `\n// Binding optimization for webpack code-split\nconst ${helpers
          .map(s => `_${helperNameMap[s]} = ${helperNameMap[s]}`)
          .join(', ')}\n`,
        NewlineType.End,
      )
    } else {
      // 常规模式：直接使用 as 别名导入
      push(
        `import { ${helpers
          .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`,
        NewlineType.End,
      )
    }
  }

  // 生成 SSR 辅助函数导入
  if (ast.ssrHelpers && ast.ssrHelpers.length) {
    push(
      `import { ${ast.ssrHelpers
        .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
        .join(', ')} } from "${ssrRuntimeModuleName}"\n`,
      NewlineType.End,
    )
  }

  // 处理模板中的导入
  if (ast.imports.length) {
    genImports(ast.imports, context)
    newline()
  }

  // 生成静态内容提升代码
  genHoists(ast.hoists, context)
  newline()

  if (!inline) {
    push(`export `)
  }
}

/**
 *
 * @param assets
 * @param type
 * @param param2
 */
function genAssets(
  assets: string[],
  type: 'component' | 'directive' | 'filter',
  { helper, push, newline, isTS }: CodegenContext,
) {
  const resolver = helper(
    __COMPAT__ && type === 'filter'
      ? RESOLVE_FILTER
      : type === 'component'
        ? RESOLVE_COMPONENT
        : RESOLVE_DIRECTIVE,
  )
  for (let i = 0; i < assets.length; i++) {
    let id = assets[i]
    // potential component implicit self-reference inferred from SFC filename
    const maybeSelfReference = id.endsWith('__self')
    if (maybeSelfReference) {
      id = id.slice(0, -6)
    }
    push(
      `const ${toValidAssetId(id, type)} = ${resolver}(${JSON.stringify(id)}${
        maybeSelfReference ? `, true` : ``
      })${isTS ? `!` : ``}`,
    )
    if (i < assets.length - 1) {
      newline()
    }
  }
}

/**
 * 将模板中的静态内容（如静态元素、静态文本等）提升到渲染函数外部，作为常量存储，避免在每次渲染时重复创建相同的静态内容，从而提高性能。
 * @param hoists
 * @param hoists 节点数组，包含代码生成节点或 null 值
 * @param context
 * @returns
 */
function genHoists(hoists: (JSChildNode | null)[], context: CodegenContext) {
  // 如果 hoists 数组为空，直接返回，不生成任何代码
  if (!hoists.length) {
    return
  }
  context.pure = true // 设置纯函数标记
  const { push, newline } = context
  newline() // 添加一个换行，提高生成代码的可读性

  // 遍历 hoists 数组
  for (let i = 0; i < hoists.length; i++) {
    const exp = hoists[i]
    if (exp) {
      // 生成常量声明，变量名为 _hoisted_${i + 1}（从 1 开始编号）
      push(`const _hoisted_${i + 1} = `)
      // 调用 genNode 函数生成表达式的代码
      genNode(exp, context)
      newline()
    }
  }

  // 生成完提升代码后，重置 context.pure = false，恢复默认状态
  context.pure = false
}

/**
 * 生成 ES 模块的 import 语句
 * @param importsOptions 导入项数组，每个元素包含导入表达式和路径
 * @param context
 * @returns
 */
function genImports(importsOptions: ImportItem[], context: CodegenContext) {
  if (!importsOptions.length) {
    return
  }
  importsOptions.forEach(imports => {
    context.push(`import `) // 输出 import 关键字
    // 调用 genNode 函数生成导入表达式（如 { ref, reactive } 或 * as Vue）
    genNode(imports.exp, context)
    // 输出 from '${imports.path}'，包含模块路径
    context.push(` from '${imports.path}'`)
    // 调用 newline 方法添加换行
    context.newline()
  })
}

function isText(n: string | CodegenNode) {
  return (
    isString(n) ||
    n.type === NodeTypes.SIMPLE_EXPRESSION ||
    n.type === NodeTypes.TEXT ||
    n.type === NodeTypes.INTERPOLATION ||
    n.type === NodeTypes.COMPOUND_EXPRESSION
  )
}

/**
 * 将节点数组转换为 JavaScript 数组字面量代码
 * @param nodes 节点数组，包含字符串、代码生成节点或模板子节点数组
 * @param context
 */
function genNodeListAsArray(
  nodes: (string | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext,
) {
  const multilines =
    // 如果节点数量大于 3，使用多行格式
    nodes.length > 3 ||
    // 在非浏览器环境或开发模式下，如果有任何节点是数组或非文本节点，也使用多行格式
    ((!__BROWSER__ || __DEV__) && nodes.some(n => isArray(n) || !isText(n)))
  context.push(`[`)
  // 缩进处理：如果使用多行格式，增加缩进
  multilines && context.indent()
  // 生成元素：调用 genNodeList 函数生成数组元素的代码
  genNodeList(nodes, context, multilines)
  // 缩进恢复：如果使用多行格式，减少缩进
  multilines && context.deindent()
  context.push(`]`)
}

/**
 * 生成节点列表的代码
 * @param nodes 节点数组，包含字符串、符号、代码生成节点或模板子节点数组
 * @param context
 * @param multilines  表示是否在多行显示
 * @param comma  表示是否添加逗号分隔符
 */
function genNodeList(
  nodes: (string | symbol | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext,
  multilines: boolean = false,
  comma: boolean = true,
) {
  const { push, newline } = context
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (isString(node)) {
      // 字符串：直接使用 push 方法添加到上下文
      push(node, NewlineType.Unknown)
    } else if (isArray(node)) {
      genNodeListAsArray(node, context)
    } else {
      genNode(node, context)
    }
    // 如果不是最后一个节点
    if (i < nodes.length - 1) {
      if (multilines) {
        // 添加逗号并换行
        comma && push(',')
        newline()
      } else {
        // 添加逗号和空格
        comma && push(', ')
      }
    }
  }
}

/**
 * 根据不同类型的 AST 节点生成相应的 JavaScript 代
 * @param node 要生成代码的节点，可以是 CodegenNode、symbol 或 string
 * @param context
 * @returns
 */
function genNode(node: CodegenNode | symbol | string, context: CodegenContext) {
  // 字符串处理：如果节点是字符串，直接推入上下文
  if (isString(node)) {
    context.push(node, NewlineType.Unknown)
    return
  }
  // 如果节点是符号，使用 context.helper 方法获取相应的辅助函数名称并推入上下文
  if (isSymbol(node)) {
    context.push(context.helper(node))
    return
  }
  switch (node.type) {
    // 模板相关节点
    // 元素、条件、循环节点：这些节点在转换阶段会生成 codegenNode，递归调用 genNode 处理 codegenNode
    case NodeTypes.ELEMENT:
    case NodeTypes.IF:
    case NodeTypes.FOR:
      __DEV__ &&
        assert(
          node.codegenNode != null,
          `Codegen node is missing for element/if/for node. ` +
            `Apply appropriate transforms first.`,
        )
      genNode(node.codegenNode!, context)
      break
    case NodeTypes.TEXT:
      // 文本节点：调用 genText 生成文本代码
      genText(node, context)
      break
    case NodeTypes.SIMPLE_EXPRESSION:
      // 表达式节点：调用 genExpression 生成表达式代码
      genExpression(node, context)
      break
    case NodeTypes.INTERPOLATION:
      // 插值节点：调用 genInterpolation 生成插值代码
      genInterpolation(node, context)
      break
    case NodeTypes.TEXT_CALL:
      // 文本调用节点：递归调用 genNode 处理 codegenNode
      genNode(node.codegenNode, context)
      break
    case NodeTypes.COMPOUND_EXPRESSION:
      // 复合表达式节点：调用 genCompoundExpression 生成复合表达式代码
      genCompoundExpression(node, context)
      break
    case NodeTypes.COMMENT:
      // 注释节点：调用 genComment 生成注释代码
      genComment(node, context)
      break

    // VNode 相关节点
    case NodeTypes.VNODE_CALL:
      // VNode 调用节点：调用 genVNodeCall 生成 VNode 创建代码，这是生成虚拟 DOM 节点的核心
      genVNodeCall(node, context)
      break

    // JavaScript 相关节点
    case NodeTypes.JS_CALL_EXPRESSION:
      // 函数调用表达式：调用 genCallExpression 生成函数调用代码
      genCallExpression(node, context)
      break
    case NodeTypes.JS_OBJECT_EXPRESSION:
      // 对象表达式：调用 genObjectExpression 生成对象字面量代码
      genObjectExpression(node, context)
      break
    case NodeTypes.JS_ARRAY_EXPRESSION:
      // 数组表达式：调用 genArrayExpression 生成数组字面量代码
      genArrayExpression(node, context)
      break
    case NodeTypes.JS_FUNCTION_EXPRESSION:
      // 函数表达式：调用 genFunctionExpression 生成函数表达式代码
      genFunctionExpression(node, context)
      break
    case NodeTypes.JS_CONDITIONAL_EXPRESSION:
      // 条件表达式：调用 genConditionalExpression 生成条件表达式代码
      genConditionalExpression(node, context)
      break
    case NodeTypes.JS_CACHE_EXPRESSION:
      // 缓存表达式：调用 genCacheExpression 生成缓存表达式代码
      genCacheExpression(node, context)
      break
    case NodeTypes.JS_BLOCK_STATEMENT:
      // 块语句：调用 genNodeList 生成块语句代码
      genNodeList(node.body, context, true, false)
      break

    // SSR 相关节点
    // SSR only types
    case NodeTypes.JS_TEMPLATE_LITERAL:
      // 模板字面量：在非浏览器环境下调用 genTemplateLiteral 生成模板字面量代码
      !__BROWSER__ && genTemplateLiteral(node, context)
      break
    case NodeTypes.JS_IF_STATEMENT:
      // if 语句：在非浏览器环境下调用 genIfStatement 生成 if 语句代码
      !__BROWSER__ && genIfStatement(node, context)
      break
    case NodeTypes.JS_ASSIGNMENT_EXPRESSION:
      // if 语句：在非浏览器环境下调用 genIfStatement 生成 if 语句代码
      !__BROWSER__ && genAssignmentExpression(node, context)
      break
    case NodeTypes.JS_SEQUENCE_EXPRESSION:
      // 序列表达式：在非浏览器环境下调用 genSequenceExpression 生成序列表达式代码
      !__BROWSER__ && genSequenceExpression(node, context)
      break
    case NodeTypes.JS_RETURN_STATEMENT:
      // return 语句：在非浏览器环境下调用 genReturnStatement 生成 return 语句代码
      !__BROWSER__ && genReturnStatement(node, context)
      break

    /* v8 ignore start */
    case NodeTypes.IF_BRANCH:
      // IF_BRANCH 节点：不处理，因为它已经在 IF 节点的处理中被处理
      // noop
      break
    default:
      if (__DEV__) {
        assert(false, `unhandled codegen node type: ${(node as any).type}`)
        // 默认情况：在开发模式下，断言并提示未处理的节点类型
        // make sure we exhaust all possible types
        const exhaustiveCheck: never = node
        return exhaustiveCheck
      }
    /* v8 ignore stop */
  }
}

/**
 * 生成文本节点的代码
 * @param node 文本节点或简单表达式节点
 * @param context
 * @returns
 */
function genText(
  node: TextNode | SimpleExpressionNode,
  context: CodegenContext,
) {
  context.push(JSON.stringify(node.content), NewlineType.Unknown, node)
}

/**
 * 生成简单表达式节点的 JavaScript 代码
 * @param node 简单表达式节点，包含表达式的内容和是否为静态的标志
 * @param context
 */
function genExpression(node: SimpleExpressionNode, context: CodegenContext) {
  const { content, isStatic } = node
  context.push(
    // 如果是静态表达式，使用 JSON.stringify(content) 转换为字符串
    // 如果不是静态表达式，直接使用 content
    isStatic ? JSON.stringify(content) : content,
    NewlineType.Unknown,
    node,
  )
}

/**
 * 生成插值表达式的 JavaScript 代码
 * @param node 插值节点，包含插值的内容
 * @param context
 */
function genInterpolation(node: InterpolationNode, context: CodegenContext) {
  const { push, helper, pure } = context

  // 如果 pure 为 true，推送 PURE_ANNOTATION（纯函数注解）
  if (pure) push(PURE_ANNOTATION)
  // 推送 TO_DISPLAY_STRING 辅助函数的调用开始
  push(`${helper(TO_DISPLAY_STRING)}(`)
  genNode(node.content, context) // 插值内容的代码
  push(`)`)
}

/**
 * 生成复合表达式节点的 JavaScript 代码
 * @param node 复合表达式节点，包含多个子节点
 * @param context
 */
function genCompoundExpression(
  node: CompoundExpressionNode,
  context: CodegenContext,
) {
  for (let i = 0; i < node.children!.length; i++) {
    const child = node.children![i]
    if (isString(child)) {
      // 如果是字符串，直接将其推送到代码生成上下文
      context.push(child, NewlineType.Unknown)
    } else {
      genNode(child, context)
    }
  }
}

/**
 * 生成作为对象属性键的表达式的 JavaScript 代码
 * @param node 表达式节点，可以是复合表达式、静态表达式或非静态表达式
 * @param context
 */
function genExpressionAsPropertyKey(
  node: ExpressionNode,
  context: CodegenContext,
) {
  const { push } = context

  // 如果是复合表达式，用方括号包裹并调用 genCompoundExpression 处理
  if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
    push(`[`)
    genCompoundExpression(node, context)
    push(`]`)

    // 如果是静态表达式，根据内容是否为简单标识符来决定是否添加引号
  } else if (node.isStatic) {
    // only quote keys if necessary
    const text = isSimpleIdentifier(node.content)
      ? node.content
      : JSON.stringify(node.content)
    push(text, NewlineType.None, node)

    // 如果是非静态表达式，用方括号包裹
  } else {
    push(`[${node.content}]`, NewlineType.Unknown, node)
  }
}

/**
 * 生成注释节点的 JavaScript 代码
 * @param node 注释节点，包含注释的内容
 * @param context
 */
function genComment(node: CommentNode, context: CodegenContext) {
  const { push, helper, pure } = context

  // 如果 pure 为 true，推送 PURE_ANNOTATION（纯函数注解）
  if (pure) {
    push(PURE_ANNOTATION)
  }

  // 推送 CREATE_COMMENT 辅助函数的调用，参数为注释内容的字符串化结果
  push(
    `${helper(CREATE_COMMENT)}(${JSON.stringify(node.content)})`,
    NewlineType.Unknown,
    node,
  )
}

/**
 * 生成创建虚拟 DOM 节点的函数调用代码
 * @param node
 * @param context
 */
function genVNodeCall(node: VNodeCall, context: CodegenContext) {
  const { push, helper, pure } = context
  const {
    tag,
    props,
    children,
    patchFlag,
    dynamicProps,
    directives,
    isBlock,
    disableTracking,
    isComponent,
  } = node

  // add dev annotations to patch flags
  let patchFlagString // 补丁标志
  if (patchFlag) {
    if (__DEV__) {
      if (patchFlag < 0) {
        // 对于特殊标志（负数），直接使用名称
        // special flags (negative and mutually exclusive)
        patchFlagString = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
      } else {
        // 对于位掩码标志，解析出所有包含的标志名称
        // bitwise flags
        const flagNames = Object.keys(PatchFlagNames)
          .map(Number)
          .filter(n => n > 0 && patchFlag & n)
          .map(n => PatchFlagNames[n as PatchFlags])
          .join(`, `)
        patchFlagString = patchFlag + ` /* ${flagNames} */`
      }
    } else {
      // 生产模式：直接使用数字字符串，减少代码体积
      patchFlagString = String(patchFlag)
    }
  }

  // 如果节点有指令，生成 withDirectives( 调用，用于处理指令
  if (directives) {
    push(helper(WITH_DIRECTIVES) + `(`)
  }
  if (isBlock) {
    // 如果是块节点，生成 openBlock() 调用，用于虚拟 DOM 的块跟踪
    // 如果需要禁用跟踪，传递 true 参数
    push(`(${helper(OPEN_BLOCK)}(${disableTracking ? `true` : ``}), `)
  }
  if (pure) {
    // 如果是纯函数，添加纯函数注释 /*#__PURE__*/，用于 Tree Shaking
    push(PURE_ANNOTATION)
  }
  const callHelper: symbol = isBlock
    ? // 块节点：使用 getVNodeBlockHelper
      getVNodeBlockHelper(context.inSSR, isComponent)
    : // 非块节点：使用 getVNodeHelper
      getVNodeHelper(context.inSSR, isComponent)

  push(helper(callHelper) + `(`, NewlineType.None, node)
  genNodeList(
    genNullableArgs([tag, props, children, patchFlagString, dynamicProps]),
    context,
  )
  push(`)`)
  if (isBlock) {
    // 如果是块节点，添加结束括号
    push(`)`)
  }
  if (directives) {
    // 如果有指令，生成指令参数并添加结束括号
    push(`, `)
    genNode(directives, context)
    push(`)`)
  }
}

/**
 *
 * @param args 任意类型的参数数组，通常是 VNode 创建函数的参数
 * @returns
 */
function genNullableArgs(args: any[]): CallExpression['arguments'] {
  let i = args.length
  // 从数组末尾开始遍历
  while (i--) {
    // 找到第一个非 null 且非 undefined 的元素位置
    if (args[i] != null) break
  }
  return args.slice(0, i + 1).map(arg => arg || `null`)
}

/**
 * 生成函数调用表达式的 JavaScript 代码
 * @param node 调用表达式节点，包含调用者和参数列表
 * @param context
 * @returns
 */
function genCallExpression(node: CallExpression, context: CodegenContext) {
  const { push, helper, pure } = context

  // 如果 node.callee 是字符串，直接使用
  // 否则，调用 helper 函数获取辅助函数的名称
  const callee = isString(node.callee) ? node.callee : helper(node.callee)
  if (pure) {
    push(PURE_ANNOTATION)
  }
  push(callee + `(`, NewlineType.None, node)
  genNodeList(node.arguments, context) // 调用 genNodeList 生成参数列表的代码
  push(`)`)
}

/**
 * 生成对象表达式的 JavaScript 代码
 * @param node 象表达式节点，包含对象的属性列表
 * @param context
 * @returns
 */
function genObjectExpression(node: ObjectExpression, context: CodegenContext) {
  const { push, indent, deindent, newline } = context
  const { properties } = node
  if (!properties.length) {
    push(`{}`, NewlineType.None, node)
    return
  }
  const multilines =
    properties.length > 1 ||
    ((!__BROWSER__ || __DEV__) &&
      properties.some(p => p.value.type !== NodeTypes.SIMPLE_EXPRESSION))
  push(multilines ? `{` : `{ `)
  multilines && indent()
  for (let i = 0; i < properties.length; i++) {
    const { key, value } = properties[i]
    // key
    genExpressionAsPropertyKey(key, context)
    push(`: `)
    // value
    genNode(value, context)
    if (i < properties.length - 1) {
      // will only reach this if it's multilines
      push(`,`)
      newline()
    }
  }
  multilines && deindent()
  push(multilines ? `}` : ` }`)
}

function genArrayExpression(node: ArrayExpression, context: CodegenContext) {
  genNodeListAsArray(node.elements as CodegenNode[], context)
}

function genFunctionExpression(
  node: FunctionExpression,
  context: CodegenContext,
) {
  const { push, indent, deindent } = context
  const { params, returns, body, newline, isSlot } = node
  if (isSlot) {
    // wrap slot functions with owner context
    push(`_${helperNameMap[WITH_CTX]}(`)
  }
  push(`(`, NewlineType.None, node)
  if (isArray(params)) {
    genNodeList(params, context)
  } else if (params) {
    genNode(params, context)
  }
  push(`) => `)
  if (newline || body) {
    push(`{`)
    indent()
  }
  if (returns) {
    if (newline) {
      push(`return `)
    }
    if (isArray(returns)) {
      genNodeListAsArray(returns, context)
    } else {
      genNode(returns, context)
    }
  } else if (body) {
    genNode(body, context)
  }
  if (newline || body) {
    deindent()
    push(`}`)
  }
  if (isSlot) {
    if (__COMPAT__ && node.isNonScopedSlot) {
      push(`, undefined, true`)
    }
    push(`)`)
  }
}

function genConditionalExpression(
  node: ConditionalExpression,
  context: CodegenContext,
) {
  const { test, consequent, alternate, newline: needNewline } = node
  const { push, indent, deindent, newline } = context
  if (test.type === NodeTypes.SIMPLE_EXPRESSION) {
    const needsParens = !isSimpleIdentifier(test.content)
    needsParens && push(`(`)
    genExpression(test, context)
    needsParens && push(`)`)
  } else {
    push(`(`)
    genNode(test, context)
    push(`)`)
  }
  needNewline && indent()
  context.indentLevel++
  needNewline || push(` `)
  push(`? `)
  genNode(consequent, context)
  context.indentLevel--
  needNewline && newline()
  needNewline || push(` `)
  push(`: `)
  const isNested = alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
  if (!isNested) {
    context.indentLevel++
  }
  genNode(alternate, context)
  if (!isNested) {
    context.indentLevel--
  }
  needNewline && deindent(true /* without newline */)
}

function genCacheExpression(node: CacheExpression, context: CodegenContext) {
  const { push, helper, indent, deindent, newline } = context
  const { needPauseTracking, needArraySpread } = node
  if (needArraySpread) {
    push(`[...(`)
  }
  push(`_cache[${node.index}] || (`)
  if (needPauseTracking) {
    indent()
    push(`${helper(SET_BLOCK_TRACKING)}(-1`)
    if (node.inVOnce) push(`, true`)
    push(`),`)
    newline()
    push(`(`)
  }
  push(`_cache[${node.index}] = `)
  genNode(node.value, context)
  if (needPauseTracking) {
    push(`).cacheIndex = ${node.index},`)
    newline()
    push(`${helper(SET_BLOCK_TRACKING)}(1),`)
    newline()
    push(`_cache[${node.index}]`)
    deindent()
  }
  push(`)`)
  if (needArraySpread) {
    push(`)]`)
  }
}

function genTemplateLiteral(node: TemplateLiteral, context: CodegenContext) {
  const { push, indent, deindent } = context
  push('`')
  const l = node.elements.length
  const multilines = l > 3
  for (let i = 0; i < l; i++) {
    const e = node.elements[i]
    if (isString(e)) {
      push(e.replace(/(`|\$|\\)/g, '\\$1'), NewlineType.Unknown)
    } else {
      push('${')
      if (multilines) indent()
      genNode(e, context)
      if (multilines) deindent()
      push('}')
    }
  }
  push('`')
}

function genIfStatement(node: IfStatement, context: CodegenContext) {
  const { push, indent, deindent } = context
  const { test, consequent, alternate } = node
  push(`if (`)
  genNode(test, context)
  push(`) {`)
  indent()
  genNode(consequent, context)
  deindent()
  push(`}`)
  if (alternate) {
    push(` else `)
    if (alternate.type === NodeTypes.JS_IF_STATEMENT) {
      genIfStatement(alternate, context)
    } else {
      push(`{`)
      indent()
      genNode(alternate, context)
      deindent()
      push(`}`)
    }
  }
}

function genAssignmentExpression(
  node: AssignmentExpression,
  context: CodegenContext,
) {
  genNode(node.left, context)
  context.push(` = `)
  genNode(node.right, context)
}

function genSequenceExpression(
  node: SequenceExpression,
  context: CodegenContext,
) {
  context.push(`(`)
  genNodeList(node.expressions, context)
  context.push(`)`)
}

/**
 * 生成 JavaScript 中的 return 语句代码
 * @param param0 语句节点
 * @param context
 */
function genReturnStatement(
  { returns }: ReturnStatement,
  context: CodegenContext,
) {
  // 向上下文推送 return 字符串
  context.push(`return `)
  if (isArray(returns)) {
    // 如果是数组，调用 genNodeListAsArray 生成数组形式的返回值
    genNodeListAsArray(returns, context)
  } else {
    // 如果不是数组，调用 genNode 生成单个表达式的返回值
    genNode(returns, context)
  }
}
