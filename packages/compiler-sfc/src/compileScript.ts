import {
  BindingTypes,
  UNREF,
  isFunctionType,
  unwrapTSNode,
  walkIdentifiers,
} from '@vue/compiler-dom'
import {
  DEFAULT_FILENAME,
  type SFCDescriptor,
  type SFCScriptBlock,
} from './parse'
import type { ParserPlugin } from '@babel/parser'
import { generateCodeFrame } from '@vue/shared'
import type {
  ArrayPattern,
  CallExpression,
  Declaration,
  ExportSpecifier,
  Identifier,
  LVal,
  Node,
  ObjectPattern,
  Statement,
} from '@babel/types'
import { walk } from 'estree-walker'
import {
  type RawSourceMap,
  SourceMapConsumer,
  SourceMapGenerator,
} from 'source-map-js'
import {
  normalScriptDefaultVar,
  processNormalScript,
} from './script/normalScript'
import { CSS_VARS_HELPER, genCssVarsCode } from './style/cssVars'
import {
  type SFCTemplateCompileOptions,
  compileTemplate,
} from './compileTemplate'
import { warnOnce } from './warn'
import { transformDestructuredProps } from './script/definePropsDestructure'
import { ScriptCompileContext } from './script/context'
import {
  DEFINE_PROPS,
  WITH_DEFAULTS,
  genRuntimeProps,
  processDefineProps,
} from './script/defineProps'
import {
  DEFINE_EMITS,
  genRuntimeEmits,
  processDefineEmits,
} from './script/defineEmits'
import { DEFINE_EXPOSE, processDefineExpose } from './script/defineExpose'
import { DEFINE_OPTIONS, processDefineOptions } from './script/defineOptions'
import { DEFINE_SLOTS, processDefineSlots } from './script/defineSlots'
import { DEFINE_MODEL, processDefineModel } from './script/defineModel'
import {
  getImportedName,
  isCallOf,
  isJS,
  isLiteralNode,
  isTS,
} from './script/utils'
import { analyzeScriptBindings } from './script/analyzeScriptBindings'
import {
  isImportUsed,
  resolveTemplateVModelIdentifiers,
} from './script/importUsageCheck'
import { processAwait } from './script/topLevelAwait'

export interface SFCScriptCompileOptions {
  /**
   * Scope ID for prefixing injected CSS variables.
   * This must be consistent with the `id` passed to `compileStyle`.
   * 用于为注入的 CSS 变量添加前缀的作用域 ID，必须与传递给 compileStyle 的 id 一致
   */
  id: string
  /**
   * Production mode. Used to determine whether to generate hashed CSS variables
   * 生产模式标志，用于确定是否生成哈希的 CSS 变量
   * 在生产环境中，Vue 会使用哈希值来确保 CSS 变量的唯一性。
   */
  isProd?: boolean
  /**
   * Enable/disable source map. Defaults to true.
   */
  sourceMap?: boolean
  /**
   * https://babeljs.io/docs/en/babel-parser#plugins
   *  配置 Babel 解析器插件
   */
  babelParserPlugins?: ParserPlugin[]
  /**
   * A list of files to parse for global types to be made available for type
   * resolving in SFC macros. The list must be fully resolved file system paths.
   * 用于解析 SFC 宏中类型的全局类型文件列表，必须是完全解析的文件系统路径。
   */
  globalTypeFiles?: string[]
  /**
   * Compile the template and inline the resulting render function
   * directly inside setup().
   * - Only affects `<script setup>`
   * - This should only be used in production because it prevents the template
   * from being hot-reloaded separately from component state.
   * 编译模板并将生成的渲染函数直接内联到 setup() 中。这仅影响 <script setup>，并且建议仅在生产环境中使用，因为它会阻止模板与组件状态分开热重载。
   */
  inlineTemplate?: boolean
  /**
   * Generate the final component as a variable instead of default export.
   * This is useful in e.g. @vitejs/plugin-vue where the script needs to be
   * placed inside the main module.
   * 将最终组件生成为变量而不是默认导出。
   * 这在例如 @vitejs/plugin-vue 中很有用，因为脚本需要放置在主模块内部。
   */
  genDefaultAs?: string
  /**
   * Options for template compilation when inlining. Note these are options that
   * would normally be passed to `compiler-sfc`'s own `compileTemplate()`, not
   * options passed to `compiler-dom`.
   *  内联时模板编译的选项
   */
  templateOptions?: Partial<SFCTemplateCompileOptions>
  /**
   * Hoist <script setup> static constants.
   * - Only enables when one `<script setup>` exists.
   * 提升 <script setup> 中的静态常量
   * @default true
   */
  hoistStatic?: boolean
  /**
   * Set to `false` to disable reactive destructure for `defineProps` (pre-3.5
   * behavior), or set to `'error'` to throw hard error on props destructures.
   * 控制 defineProps 的反应式解构行为
   * - `false` 禁用反应式解构，与 3.5 之前的版本行为相同
   * - `'error'` 抛出错误，当 props 解构失败时
   * @default true
   */
  propsDestructure?: boolean | 'error'
  /**
   * File system access methods to be used when resolving types
   * imported in SFC macros. Defaults to ts.sys in Node.js, can be overwritten
   * to use a virtual file system for use in browsers (e.g. in REPLs)
   *  用于解析 SFC 宏中导入的类型时使用的文件系统访问方法
   */
  fs?: {
    fileExists(file: string): boolean
    readFile(file: string): string | undefined
    realpath?(file: string): string
  }
  /**
   * Transform Vue SFCs into custom elements.
   */
  customElement?: boolean | ((filename: string) => boolean)
}

// 导入绑定的详细信息
export interface ImportBinding {
  isType: boolean // 是否类型导入
  imported: string // 导入的原始名称
  local: string // 本地使用的名称
  source: string // 导入的文件路径
  isFromSetup: boolean // 是否从 <script setup> 导入
  isUsedInTemplate: boolean // 是否在模板中使用
}

const MACROS = [
  DEFINE_PROPS,
  DEFINE_EMITS,
  DEFINE_EXPOSE,
  DEFINE_OPTIONS,
  DEFINE_SLOTS,
  DEFINE_MODEL,
  WITH_DEFAULTS,
]

/**
 * Compile `<script setup>`
 * It requires the whole SFC descriptor because we need to handle and merge
 * normal `<script>` + `<script setup>` if both are present.
 *  Vue 3 编译器 SFC 模块，用于编译组件中的 <script> 和 <script setup> 标签
 */
export function compileScript(
  sfc: SFCDescriptor,
  options: SFCScriptCompileOptions,
): SFCScriptBlock {
  if (!options.id) {
    warnOnce(
      `compileScript now requires passing the \`id\` option.\n` +
        `Upgrade your vite or vue-loader version for compatibility with ` +
        `the latest experimental proposals.`,
    )
  }

  const { script, scriptSetup, source, filename } = sfc
  const hoistStatic = options.hoistStatic !== false && !script

  // 从 id 中提取 scopeId，用于生成 CSS 变量
  const scopeId = options.id ? options.id.replace(/^data-v-/, '') : ''
  const scriptLang = script && script.lang
  const scriptSetupLang = scriptSetup && scriptSetup.lang

  // js、jsx、ts、tsx
  const isJSOrTS =
    isJS(scriptLang, scriptSetupLang) || isTS(scriptLang, scriptSetupLang)

  // <script> 和 <script setup> 标签的 lang 属性要相同
  if (script && scriptSetup && scriptLang !== scriptSetupLang) {
    throw new Error(
      `[@vue/compiler-sfc] <script> and <script setup> must have the same ` +
        `language type.`,
    )
  }

  if (!scriptSetup) {
    // 没有 <script> 也没有 <script setup>，compileScript 会抛出错误
    if (!script) {
      throw new Error(`[@vue/compiler-sfc] SFC contains no <script> tags.`)
    }

    // normal <script> only
    // 脚本语言不是 JS 或 TS，则直接返回原始脚本块，不做处理
    if (script.lang && !isJSOrTS) {
      // do not process non js/ts script blocks
      return script
    }

    // 创建编译上下文并处理普通 <script> 标签
    const ctx = new ScriptCompileContext(sfc, options)
    return processNormalScript(ctx, scopeId)
  }

  // <script setup> only
  // 当 <script setup> 有语言属性且不是 JS/TS 时，直接返回原始脚本块，不做处理
  if (scriptSetupLang && !isJSOrTS) {
    // do not process non js/ts script blocks
    return scriptSetup
  }

  // 脚本编译上下文,利用Babel解析脚本AST
  const ctx = new ScriptCompileContext(sfc, options)

  // metadata that needs to be returned
  // const ctx.bindingMetadata: BindingMetadata = {}
  // 记录普通 <script> 中的变量绑定类型
  const scriptBindings: Record<string, BindingTypes> = Object.create(null)
  // 记录 <script setup> 中的变量绑定类型
  const setupBindings: Record<string, BindingTypes> = Object.create(null)

  // 存储 <script> 中的默认导出节点
  let defaultExport: Node | undefined
  let hasAwait = false // 标记脚本中是否使用了 await 关键字
  let hasInlinedSsrRenderFn = false // 标记是否内联了 SSR 渲染函数

  // string offsets
  // <script setup> 块的起始偏移量
  const startOffset = ctx.startOffset!
  // <script setup> 块的结束偏移量
  const endOffset = ctx.endOffset!
  // 普通 <script> 块的起始偏移量（如果存在）
  const scriptStartOffset = script && script.loc.start.offset
  // 普通 <script> 块的结束偏移量（如果存在）
  const scriptEndOffset = script && script.loc.end.offset

  /**
   * 指定的语句节点及其相关注释提升到代码的开头位置
   * @param node
   */
  function hoistNode(node: Statement) {
    const start = node.start! + startOffset
    let end = node.end! + startOffset
    // locate comment
    // 节点的尾随注释
    if (node.trailingComments && node.trailingComments.length > 0) {
      const lastCommentNode =
        node.trailingComments[node.trailingComments.length - 1]
      end = lastCommentNode.end! + startOffset
    }
    // locate the end of whitespace between this statement and the next
    while (end <= source.length) {
      // 查找下一个非空格字符
      if (!/\s/.test(source.charAt(end))) {
        break
      }
      end++
    }

    // 将节点从当前位置移动到位置 0（代码开头
    ctx.s.move(start, end, 0)
  }

  /**
   * 注册用户导入
   * @param source 导入源
   * @param local 本地名称
   * @param imported 导入名称
   * @param isType 是否为类型导入
   * @param isFromSetup 是否从 <script setup> 导入
   * @param needTemplateUsageCheck 是否需要检查模板使用
   */
  function registerUserImport(
    source: string,
    local: string,
    imported: string,
    isType: boolean,
    isFromSetup: boolean,
    needTemplateUsageCheck: boolean,
  ) {
    // template usage check is only needed in non-inline mode, so we can skip
    // the work if inlineTemplate is true.
    let isUsedInTemplate = needTemplateUsageCheck
    if (
      needTemplateUsageCheck &&
      ctx.isTS &&
      sfc.template &&
      !sfc.template.src &&
      !sfc.template.lang
    ) {
      isUsedInTemplate = isImportUsed(local, sfc)
    }

    // 记录用户导入
    // 存储在 ctx.userImports 中，键为 local（本地名称）
    ctx.userImports[local] = {
      isType,
      imported,
      local,
      source,
      isFromSetup,
      isUsedInTemplate,
    }
  }

  /**
   * 检查宏函数参数中是否引用了 setup 作用域的变量
   * @param node AST 节点，代表宏函数的参数
   * @param method 字符串，代表宏函数的名称
   * @returns
   */
  function checkInvalidScopeReference(node: Node | undefined, method: string) {
    if (!node) return

    // 遍历宏函数参数中的所有标识符
    walkIdentifiers(node, id => {
      const binding = setupBindings[id.name]
      // 检查是否引用了 setup 作用域的变量
      // 且该变量不是字面量常量
      if (binding && binding !== BindingTypes.LITERAL_CONST) {
        ctx.error(
          `\`${method}()\` in <script setup> cannot reference locally ` +
            `declared variables because it will be hoisted outside of the ` +
            `setup() function. If your component options require initialization ` +
            `in the module scope, use a separate normal <script> to export ` +
            `the options instead.`,
          id,
        )
      }
    })
  }

  // 脚本 AST 节点
  const scriptAst = ctx.scriptAst
  // 脚本 setup AST 节点
  const scriptSetupAst = ctx.scriptSetupAst!

  // 1.1 walk import declarations of <script>
  if (scriptAst) {
    for (const node of scriptAst.body) {
      // 导入声明节点
      if (node.type === 'ImportDeclaration') {
        // record imports for dedupe
        for (const specifier of node.specifiers) {
          // 提取导入名称
          const imported = getImportedName(specifier)
          registerUserImport(
            // 导入源：node.source.value，如 'vue'、'./components/Button' 等
            node.source.value,
            // 本地名称：specifier.local.name，导入后在本地使用的名称
            specifier.local.name,
            imported,
            // 是否类型导入
            node.importKind === 'type' ||
              (specifier.type === 'ImportSpecifier' &&
                specifier.importKind === 'type'),
            // 是否默认导入
            // 否，这里是命名导入
            false,
            // 是否需要生成渲染函数
            !options.inlineTemplate,
          )
        }
      }
    }
  }

  // 1.2 walk import declarations of <script setup>
  // 处理 <script setup> 标签中的导入声明
  for (const node of scriptSetupAst.body) {
    if (node.type === 'ImportDeclaration') {
      // import declarations are moved to top
      // 将导入声明节点提升到模块顶部的函数
      // 确保所有导入声明都在模块的最前面，符合 ES 模块的规范
      hoistNode(node)

      // dedupe imports
      let removed = 0
      const removeSpecifier = (i: number) => {
        const removeLeft = i > removed
        removed++
        const current = node.specifiers[i]
        const next = node.specifiers[i + 1]
        ctx.s.remove(
          removeLeft
            ? node.specifiers[i - 1].end! + startOffset
            : current.start! + startOffset,
          next && !removeLeft
            ? next.start! + startOffset
            : current.end! + startOffset,
        )
      }

      for (let i = 0; i < node.specifiers.length; i++) {
        const specifier = node.specifiers[i]
        const local = specifier.local.name
        const imported = getImportedName(specifier)
        const source = node.source.value
        // 检查是否已存在相同本地名称的导入
        const existing = ctx.userImports[local]

        if (source === 'vue' && MACROS.includes(imported)) {
          // 如果导入的是宏且本地名称与宏名称相同，发出警告
          if (local === imported) {
            warnOnce(
              `\`${imported}\` is a compiler macro and no longer needs to be imported.`,
            )
          } else {
            // 如果导入的是宏但本地名称与宏名称不同，报错
            ctx.error(
              `\`${imported}\` is a compiler macro and cannot be aliased to ` +
                `a different name.`,
              specifier,
            )
          }
          // 移除宏的导入声明，因为它们不需要手动导入
          removeSpecifier(i)
        } else if (existing) {
          // 如果导入源和导入名称都相同，移除重复的导入
          if (existing.source === source && existing.imported === imported) {
            // already imported in <script setup>, dedupe
            removeSpecifier(i)
          } else {
            // 如果本地名称相同但导入源或导入名称不同，报错
            ctx.error(
              `different imports aliased to same local name.`,
              specifier,
            )
          }
        } else {
          // 注册用户导入
          registerUserImport(
            source,
            local,
            imported,
            node.importKind === 'type' ||
              (specifier.type === 'ImportSpecifier' &&
                specifier.importKind === 'type'),
            true, // 默认导入
            !options.inlineTemplate,
          )
        }
      }
      // 如果所有导入声明都被移除，移除导入声明节点
      if (node.specifiers.length && removed === node.specifiers.length) {
        ctx.s.remove(node.start! + startOffset, node.end! + startOffset)
      }
    }
  }

  // 1.3 resolve possible user import alias of `ref` and `reactive`
  const vueImportAliases: Record<string, string> = {}
  for (const key in ctx.userImports) {
    const { source, imported, local } = ctx.userImports[key]
    // 如果导入源是 'vue'，则将导入名称映射到本地名称
    if (source === 'vue') vueImportAliases[imported] = local
  }

  // 2.1 process normal <script> body
  if (script && scriptAst) {
    for (const node of scriptAst.body) {
      // 默认导出声明
      if (node.type === 'ExportDefaultDeclaration') {
        // export default
        defaultExport = node

        // check if user has manually specified `name` or 'render` option in
        // export default
        // if has name, skip name inference
        // if has render and no template, generate return object instead of
        // empty render function (#4980)
        let optionProperties

        // 处理直接对象字面量 export default { ... }
        if (defaultExport.declaration.type === 'ObjectExpression') {
          optionProperties = defaultExport.declaration.properties

          // 处理函数调用：export default createApp({ ... })
        } else if (
          defaultExport.declaration.type === 'CallExpression' &&
          defaultExport.declaration.arguments[0] &&
          defaultExport.declaration.arguments[0].type === 'ObjectExpression'
        ) {
          optionProperties = defaultExport.declaration.arguments[0].properties
        }

        // name 和 render 选项检查
        if (optionProperties) {
          for (const p of optionProperties) {
            if (
              p.type === 'ObjectProperty' &&
              p.key.type === 'Identifier' &&
              p.key.name === 'name'
            ) {
              ctx.hasDefaultExportName = true
            }
            if (
              (p.type === 'ObjectMethod' || p.type === 'ObjectProperty') &&
              p.key.type === 'Identifier' &&
              p.key.name === 'render'
            ) {
              // TODO warn when we provide a better way to do it?
              ctx.hasDefaultExportRender = true
            }
          }
        }

        // 语法转换
        // export default { ... } --> const __default__ = { ... }
        const start = node.start! + scriptStartOffset!
        const end = node.declaration.start! + scriptStartOffset!

        ctx.s.overwrite(start, end, `const ${normalScriptDefaultVar} = `)

        // 命名导出
      } else if (node.type === 'ExportNamedDeclaration') {
        // 找 exported.name === 'default' 的说明符
        const defaultSpecifier = node.specifiers.find(
          s =>
            s.exported.type === 'Identifier' && s.exported.name === 'default',
        ) as ExportSpecifier

        if (defaultSpecifier) {
          defaultExport = node
          // 1. remove specifier
          if (node.specifiers.length > 1) {
            // 如果有多个说明符，只移除 default 说明符，保留其他说明符
            ctx.s.remove(
              defaultSpecifier.start! + scriptStartOffset!,
              defaultSpecifier.end! + scriptStartOffset!,
            )
          } else {
            // 如果只有一个说明符且是 default，移除整个导出声明
            ctx.s.remove(
              node.start! + scriptStartOffset!,
              node.end! + scriptStartOffset!,
            )
          }
          if (node.source) {
            // export { x as default } from './x'
            // rewrite to `import { x as __default__ } from './x'` and
            // add to top
            ctx.s.prepend(
              `import { ${defaultSpecifier.local.name} as ${normalScriptDefaultVar} } from '${node.source.value}'\n`,
            )
          } else {
            // export { x as default }
            // rewrite to `const __default__ = x` and move to end
            ctx.s.appendLeft(
              scriptEndOffset!,
              `\nconst ${normalScriptDefaultVar} = ${defaultSpecifier.local.name}\n`,
            )
          }
        }
        if (node.declaration) {
          walkDeclaration(
            'script', // 表示当前处理的是脚本部分
            node.declaration, // 要处理的声明节点
            scriptBindings, // 脚本绑定信息
            vueImportAliases, // Vue 导入别名信息
            hoistStatic, // 是否提升静态节点的标志
          )
        }
      } else if (
        // 变量声明（如 const x = 1）
        (node.type === 'VariableDeclaration' ||
          // 函数声明（如 function x() {}）
          node.type === 'FunctionDeclaration' ||
          // 类声明（如 class X {}）
          node.type === 'ClassDeclaration' ||
          // TypeScript 枚举声明（如 enum X { A, B }）
          node.type === 'TSEnumDeclaration') &&
        // 排除 TypeScript 的声明语句（如 declare const x: string）
        !node.declare
      ) {
        walkDeclaration(
          'script',
          node,
          scriptBindings,
          vueImportAliases,
          hoistStatic,
        )
      }
    }

    // <script> after <script setup>
    // we need to move the block up so that `const __default__` is
    // declared before being used in the actual component definition
    if (scriptStartOffset! > startOffset) {
      // if content doesn't end with newline, add one
      if (!/\n$/.test(script.content.trim())) {
        ctx.s.appendLeft(scriptEndOffset!, `\n`)
      }
      ctx.s.move(scriptStartOffset!, scriptEndOffset!, 0)
    }
  }

  // 2.2 process <script setup> body
  for (const node of scriptSetupAst.body) {
    if (node.type === 'ExpressionStatement') {
      const expr = unwrapTSNode(node.expression)
      // process `defineProps` and `defineEmit(s)` calls
      // 处理 defineProps、defineEmits、defineOptions、defineSlots 等函数调用
      if (
        processDefineProps(ctx, expr) ||
        processDefineEmits(ctx, expr) ||
        processDefineOptions(ctx, expr) ||
        processDefineSlots(ctx, expr)
      ) {
        // 移除 defineProps、defineEmits、defineOptions、defineSlots 等函数调用的表达式
        ctx.s.remove(node.start! + startOffset, node.end! + startOffset)

        // 处理 defineExpose 函数调用
      } else if (processDefineExpose(ctx, expr)) {
        // defineExpose({}) -> expose({})
        const callee = (expr as CallExpression).callee
        ctx.s.overwrite(
          callee.start! + startOffset,
          callee.end! + startOffset,
          '__expose',
        )
      } else {
        // 处理 defineModel 函数调用
        processDefineModel(ctx, expr)
      }
    }

    if (node.type === 'VariableDeclaration' && !node.declare) {
      const total = node.declarations.length
      let left = total
      let lastNonRemoved: number | undefined

      // 遍历变量声明语句中的每个声明
      for (let i = 0; i < total; i++) {
        const decl = node.declarations[i]
        const init = decl.init && unwrapTSNode(decl.init)
        if (init) {
          // defineOptions 没有返回值，不能赋值
          if (processDefineOptions(ctx, init)) {
            ctx.error(
              `${DEFINE_OPTIONS}() has no returning value, it cannot be assigned.`,
              node,
            )
          }

          // defineProps
          const isDefineProps = processDefineProps(ctx, init, decl.id as LVal)
          // 如果有 props 解构的剩余参数，将其标记为 SETUP_REACTIVE_CONST 类型的绑定
          if (ctx.propsDestructureRestId) {
            setupBindings[ctx.propsDestructureRestId] =
              BindingTypes.SETUP_REACTIVE_CONST
          }

          // defineEmits
          const isDefineEmits =
            // 处理 defineEmits 宏
            !isDefineProps && processDefineEmits(ctx, init, decl.id as LVal)
          !isDefineEmits &&
            //  处理 defineSlots 宏
            // decl.id：变量标识符（Identifier），即声明的变量名
            (processDefineSlots(ctx, init, decl.id as LVal) ||
              // 处理 defineModel 宏
              processDefineModel(ctx, init, decl.id as LVal))

          if (
            isDefineProps &&
            !ctx.propsDestructureRestId &&
            ctx.propsDestructureDecl
          ) {
            if (left === 1) {
              // 如果是唯一的声明，移除整个变量声明语句
              ctx.s.remove(node.start! + startOffset, node.end! + startOffset)
            } else {
              let start = decl.start! + startOffset
              let end = decl.end! + startOffset
              if (i === total - 1) {
                // last one, locate the end of the last one that is not removed
                // if we arrive at this branch, there must have been a
                // non-removed decl before us, so lastNonRemoved is non-null.
                // 否则，移除当前声明及其前后的分隔符
                start = node.declarations[lastNonRemoved!].end! + startOffset
              } else {
                // not the last one, locate the start of the next
                end = node.declarations[i + 1].start! + startOffset
              }
              ctx.s.remove(start, end)
              left--
            }
          } else if (isDefineEmits) {
            // 将 defineEmits() 调用替换为 __emit
            ctx.s.overwrite(
              startOffset + init.start!,
              startOffset + init.end!,
              '__emit',
            )
          } else {
            // 记录为最后一个非移除的声明索引
            lastNonRemoved = i
          }
        }
      }
    }

    let isAllLiteral = false
    // walk declarations to record declared bindings
    if (
      (node.type === 'VariableDeclaration' ||
        node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration' ||
        node.type === 'TSEnumDeclaration') &&
      !node.declare
    ) {
      isAllLiteral = walkDeclaration(
        'scriptSetup',
        node,
        setupBindings,
        vueImportAliases,
        hoistStatic,
        !!ctx.propsDestructureDecl,
      )
    }

    // hoist literal constants
    if (hoistStatic && isAllLiteral) {
      hoistNode(node)
    }

    // walk statements & named exports / variable declarations for top level
    // await
    if (
      (node.type === 'VariableDeclaration' && !node.declare) ||
      node.type.endsWith('Statement')
    ) {
      const scope: Statement[][] = [scriptSetupAst.body]
      walk(node, {
        enter(child: Node, parent: Node | null) {
          // 当遇到函数类型节点时，跳过其内部遍历
          // 原因？函数内部的 await 表达式由函数自身处理，不需要外部遍历器处理
          if (isFunctionType(child)) {
            this.skip()
          }
          // 当遇到块语句时，将其 body 推入作用域栈
          if (child.type === 'BlockStatement') {
            scope.push(child.body)
          }
          if (child.type === 'AwaitExpression') {
            hasAwait = true // 标记为存在 await 表达式
            // if the await expression is an expression statement and
            // - is in the root scope
            // - or is not the first statement in a nested block scope
            // then it needs a semicolon before the generated code.
            const currentScope = scope[scope.length - 1]
            const needsSemi = currentScope.some((n, i) => {
              return (
                // 在根作用域 (scope.length === 1)
                // 不是嵌套块作用域的第一条语句 (i > 0)
                (scope.length === 1 || i > 0) &&
                // 当前 await 表达式是一个表达式语句
                n.type === 'ExpressionStatement' &&
                n.start === child.start
              )
            })
            processAwait(
              ctx,
              child,
              needsSemi,
              parent!.type === 'ExpressionStatement',
            )
          }
        },
        exit(node: Node) {
          if (node.type === 'BlockStatement') scope.pop()
        },
      })
    }

    // 检查 <script setup> 中是否包含 ES 模块导出语句。如果检测到导出语句，会抛出编译错误
    if (
      (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportDefaultDeclaration'
    ) {
      ctx.error(
        `<script setup> cannot contain ES module exports. ` +
          `If you are using a previous version of <script setup>, please ` +
          `consult the updated RFC at https://github.com/vuejs/rfcs/pull/227.`,
        node,
      )
    }

    if (ctx.isTS) {
      // move all Type declarations to outer scope
      if (
        // TypeScript 类型节点：如 TSInterfaceDeclaration（接口）、TSTypeAliasDeclaration（类型别名）等
        node.type.startsWith('TS') ||
        // 类型导出，如 export type { User }
        (node.type === 'ExportNamedDeclaration' &&
          node.exportKind === 'type') ||
        // 声明式变量，如 declare const API_URL: string
        (node.type === 'VariableDeclaration' && node.declare)
      ) {
        // 特殊处理：排除枚举
        // 原因：TypeScript 枚举在编译后会生成运行时代码（JavaScript 对象），不是纯类型声明
        if (node.type !== 'TSEnumDeclaration') {
          // 将符合条件的类型声明节点移动到代码顶部
          hoistNode(node)
        }
      }
    }
  }

  // 3 props destructure transform
  if (ctx.propsDestructureDecl) {
    transformDestructuredProps(ctx, vueImportAliases)
  }

  // 4. check macro args to make sure it doesn't reference setup scope
  // variables
  // 用于检查宏函数参数中是否引用了 setup 作用域的变量
  checkInvalidScopeReference(ctx.propsRuntimeDecl, DEFINE_PROPS)
  checkInvalidScopeReference(ctx.propsRuntimeDefaults, DEFINE_PROPS)
  checkInvalidScopeReference(ctx.propsDestructureDecl, DEFINE_PROPS)
  checkInvalidScopeReference(ctx.emitsRuntimeDecl, DEFINE_EMITS)
  checkInvalidScopeReference(ctx.optionsRuntimeDecl, DEFINE_OPTIONS)
  for (const { runtimeOptionNodes } of Object.values(ctx.modelDecls)) {
    for (const node of runtimeOptionNodes) {
      checkInvalidScopeReference(node, DEFINE_MODEL)
    }
  }

  // 5. remove non-script content
  // 移除非脚本内容，如模板、样式等
  if (script) {
    if (startOffset < scriptStartOffset!) {
      // <script setup> before <script>
      ctx.s.remove(0, startOffset)
      ctx.s.remove(endOffset, scriptStartOffset!)
      ctx.s.remove(scriptEndOffset!, source.length)
    } else {
      // <script> before <script setup>
      ctx.s.remove(0, scriptStartOffset!)
      ctx.s.remove(scriptEndOffset!, startOffset)
      ctx.s.remove(endOffset, source.length)
    }
  } else {
    // only <script setup>
    ctx.s.remove(0, startOffset)
    ctx.s.remove(endOffset, source.length)
  }

  // 6. analyze binding metadata
  // `defineProps` & `defineModel` also register props bindings
  if (scriptAst) {
    Object.assign(ctx.bindingMetadata, analyzeScriptBindings(scriptAst.body))
  }
  for (const [key, { isType, imported, source }] of Object.entries(
    ctx.userImports,
  )) {
    if (isType) continue
    ctx.bindingMetadata[key] =
      imported === '*' ||
      (imported === 'default' && source.endsWith('.vue')) ||
      source === 'vue'
        ? BindingTypes.SETUP_CONST
        : BindingTypes.SETUP_MAYBE_REF
  }
  for (const key in scriptBindings) {
    ctx.bindingMetadata[key] = scriptBindings[key]
  }
  for (const key in setupBindings) {
    ctx.bindingMetadata[key] = setupBindings[key]
  }

  // #11265, https://github.com/vitejs/rolldown-vite/issues/432
  // 6.1 demote `const foo = reactive()` to `let` when used as v-model target.
  // In non-inline template compilation, v-model assigns via `$setup.foo = $event`,
  // which requires a SETUP_LET binding (getter + setter) to keep script state in sync.
  // In inline mode, it generates `foo = $event`, which also requires `let`.
  if (sfc.template && !sfc.template.src && sfc.template.ast) {
    const vModelIds = resolveTemplateVModelIdentifiers(sfc)
    if (vModelIds.size) {
      const toDemote = new Set<string>()
      for (const id of vModelIds) {
        if (setupBindings[id] === BindingTypes.SETUP_REACTIVE_CONST) {
          toDemote.add(id)
        }
      }

      if (toDemote.size) {
        for (const node of scriptSetupAst.body) {
          if (
            node.type === 'VariableDeclaration' &&
            node.kind === 'const' &&
            !node.declare
          ) {
            const demotedInDecl: string[] = []
            for (const decl of node.declarations) {
              if (decl.id.type === 'Identifier' && toDemote.has(decl.id.name)) {
                demotedInDecl.push(decl.id.name)
              }
            }
            if (demotedInDecl.length) {
              ctx.s.overwrite(
                node.start! + startOffset,
                node.start! + startOffset + 'const'.length,
                'let',
              )
              for (const id of demotedInDecl) {
                setupBindings[id] = BindingTypes.SETUP_LET
                ctx.bindingMetadata[id] = BindingTypes.SETUP_LET
                warnOnce(
                  `\`v-model\` cannot update a \`const\` reactive binding \`${id}\`. ` +
                    `The compiler has transformed it to \`let\` to make the update work.`,
                )
              }
            }
          }
        }
      }
    }
  }

  // 7. inject `useCssVars` calls
  if (
    sfc.cssVars.length &&
    // no need to do this when targeting SSR
    !options.templateOptions?.ssr
  ) {
    ctx.helperImports.add(CSS_VARS_HELPER)
    ctx.helperImports.add('unref')
    ctx.s.prependLeft(
      startOffset,
      `\n${genCssVarsCode(
        sfc.cssVars,
        ctx.bindingMetadata,
        scopeId,
        !!options.isProd,
      )}\n`,
    )
  }

  // 8. finalize setup() argument signature
  let args = `__props`
  if (ctx.propsTypeDecl) {
    // mark as any and only cast on assignment
    // since the user defined complex types may be incompatible with the
    // inferred type from generated runtime declarations
    args += `: any`
  }
  // inject user assignment of props
  // we use a default __props so that template expressions referencing props
  // can use it directly
  if (ctx.propsDecl) {
    if (ctx.propsDestructureRestId) {
      ctx.s.overwrite(
        startOffset + ctx.propsCall!.start!,
        startOffset + ctx.propsCall!.end!,
        `${ctx.helper(`createPropsRestProxy`)}(__props, ${JSON.stringify(
          Object.keys(ctx.propsDestructuredBindings),
        )})`,
      )
      ctx.s.overwrite(
        startOffset + ctx.propsDestructureDecl!.start!,
        startOffset + ctx.propsDestructureDecl!.end!,
        ctx.propsDestructureRestId,
      )
    } else if (!ctx.propsDestructureDecl) {
      ctx.s.overwrite(
        startOffset + ctx.propsCall!.start!,
        startOffset + ctx.propsCall!.end!,
        '__props',
      )
    }
  }

  // inject temp variables for async context preservation
  // 处理组件脚本中的异步操作
  if (hasAwait) {
    const any = ctx.isTS ? `: any` : ``
    ctx.s.prependLeft(startOffset, `\nlet __temp${any}, __restore${any}\n`)
  }

  const destructureElements =
    // ctx.hasDefineExposeCall：组件使用了 defineExpose 宏
    // !options.inlineTemplate：模板不是内联的（即使用单独的 <template> 块）
    ctx.hasDefineExposeCall || !options.inlineTemplate
      ? [`expose: __expose`]
      : []

  // 组件使用了 defineEmits 宏
  if (ctx.emitDecl) {
    destructureElements.push(`emit: __emit`)
  }
  // 如果解构元素数组不为空，将其作为对象解构添加到 args 中
  // 生成的代码形式为：, { expose: __expose, emit: __emit }
  if (destructureElements.length) {
    args += `, { ${destructureElements.join(', ')} }`
  }

  let templateMap
  // 9. generate return statement
  let returned
  // ensure props bindings register before compile template in inline mode
  const propsDecl = genRuntimeProps(ctx)
  if (
    !options.inlineTemplate ||
    (!sfc.template && ctx.hasDefaultExportRender)
  ) {
    // non-inline mode, or has manual render in normal <script>
    // return bindings from script and script setup
    const allBindings: Record<string, any> = {
      ...scriptBindings,
      ...setupBindings,
    }
    for (const key in ctx.userImports) {
      if (
        !ctx.userImports[key].isType &&
        ctx.userImports[key].isUsedInTemplate
      ) {
        allBindings[key] = true
      }
    }
    returned = `{ `
    for (const key in allBindings) {
      if (
        allBindings[key] === true &&
        ctx.userImports[key].source !== 'vue' &&
        !ctx.userImports[key].source.endsWith('.vue')
      ) {
        // generate getter for import bindings
        // skip vue imports since we know they will never change
        returned += `get ${key}() { return ${key} }, `
      } else if (ctx.bindingMetadata[key] === BindingTypes.SETUP_LET) {
        // local let binding, also add setter
        const setArg = key === 'v' ? `_v` : `v`
        returned +=
          `get ${key}() { return ${key} }, ` +
          `set ${key}(${setArg}) { ${key} = ${setArg} }, `
      } else {
        returned += `${key}, `
      }
    }
    returned = returned.replace(/, $/, '') + ` }`
  } else {
    // inline mode
    if (sfc.template && !sfc.template.src) {
      if (options.templateOptions && options.templateOptions.ssr) {
        hasInlinedSsrRenderFn = true
      }
      // inline render function mode - we are going to compile the template and
      // inline it right here
      const { code, ast, preamble, tips, errors, map } = compileTemplate({
        filename,
        ast: sfc.template.ast,
        source: sfc.template.content,
        inMap: sfc.template.map,
        ...options.templateOptions,
        id: scopeId,
        scoped: sfc.styles.some(s => s.scoped),
        isProd: options.isProd,
        ssrCssVars: sfc.cssVars,
        compilerOptions: {
          ...(options.templateOptions &&
            options.templateOptions.compilerOptions),
          inline: true,
          isTS: ctx.isTS,
          bindingMetadata: ctx.bindingMetadata,
        },
      })
      templateMap = map
      if (tips.length) {
        tips.forEach(warnOnce)
      }
      const err = errors[0]
      if (typeof err === 'string') {
        throw new Error(err)
      } else if (err) {
        if (err.loc) {
          err.message +=
            `\n\n` +
            sfc.filename +
            '\n' +
            generateCodeFrame(
              source,
              err.loc.start.offset,
              err.loc.end.offset,
            ) +
            `\n`
        }
        throw err
      }
      if (preamble) {
        ctx.s.prepend(preamble)
      }
      // avoid duplicated unref import
      // as this may get injected by the render function preamble OR the
      // css vars codegen
      if (ast && ast.helpers.has(UNREF)) {
        ctx.helperImports.delete('unref')
      }
      returned = code
    } else {
      returned = `() => {}`
    }
  }

  if (!options.inlineTemplate && !__TEST__) {
    // in non-inline mode, the `__isScriptSetup: true` flag is used by
    // componentPublicInstance proxy to allow properties that start with $ or _
    ctx.s.appendRight(
      endOffset,
      `\nconst __returned__ = ${returned}\n` +
        `Object.defineProperty(__returned__, '__isScriptSetup', { enumerable: false, value: true })\n` +
        `return __returned__` +
        `\n}\n\n`,
    )
  } else {
    ctx.s.appendRight(endOffset, `\nreturn ${returned}\n}\n\n`)
  }

  // 10. finalize default export
  const genDefaultAs = options.genDefaultAs
    ? `const ${options.genDefaultAs} =`
    : `export default`

  let runtimeOptions = ``

  if (!ctx.hasDefaultExportName && filename && filename !== DEFAULT_FILENAME) {
    const match = filename.match(/([^/\\]+)\.\w+$/)
    if (match) {
      runtimeOptions += `\n  __name: '${match[1]}',`
    }
  }
  if (hasInlinedSsrRenderFn) {
    runtimeOptions += `\n  __ssrInlineRender: true,`
  }

  if (propsDecl) runtimeOptions += `\n  props: ${propsDecl},`

  const emitsDecl = genRuntimeEmits(ctx)
  if (emitsDecl) runtimeOptions += `\n  emits: ${emitsDecl},`

  let definedOptions = ''
  if (ctx.optionsRuntimeDecl) {
    definedOptions = scriptSetup.content
      .slice(ctx.optionsRuntimeDecl.start!, ctx.optionsRuntimeDecl.end!)
      .trim()
  }

  // <script setup> components are closed by default. If the user did not
  // explicitly call `defineExpose`, call expose() with no args.
  const exposeCall =
    ctx.hasDefineExposeCall || options.inlineTemplate ? `` : `  __expose();\n`
  // wrap setup code with function.
  if (ctx.isTS) {
    // for TS, make sure the exported type is still valid type with
    // correct props information
    // we have to use object spread for types to be merged properly
    // user's TS setting should compile it down to proper targets
    // export default defineComponent({ ...__default__, ... })
    const def =
      (defaultExport ? `\n  ...${normalScriptDefaultVar},` : ``) +
      (definedOptions ? `\n  ...${definedOptions},` : '')
    ctx.s.prependLeft(
      startOffset,
      `\n${genDefaultAs} /*@__PURE__*/${ctx.helper(
        `defineComponent`,
      )}({${def}${runtimeOptions}\n  ${
        hasAwait ? `async ` : ``
      }setup(${args}) {\n${exposeCall}`,
    )
    ctx.s.appendRight(endOffset, `})`)
  } else {
    if (defaultExport || definedOptions) {
      // without TS, can't rely on rest spread, so we use Object.assign
      // export default Object.assign(__default__, { ... })
      ctx.s.prependLeft(
        startOffset,
        `\n${genDefaultAs} /*@__PURE__*/Object.assign(${
          defaultExport ? `${normalScriptDefaultVar}, ` : ''
        }${definedOptions ? `${definedOptions}, ` : ''}{${runtimeOptions}\n  ` +
          `${hasAwait ? `async ` : ``}setup(${args}) {\n${exposeCall}`,
      )
      ctx.s.appendRight(endOffset, `})`)
    } else {
      ctx.s.prependLeft(
        startOffset,
        `\n${genDefaultAs} {${runtimeOptions}\n  ` +
          `${hasAwait ? `async ` : ``}setup(${args}) {\n${exposeCall}`,
      )
      ctx.s.appendRight(endOffset, `}`)
    }
  }

  // 11. finalize Vue helper imports
  if (ctx.helperImports.size > 0) {
    const runtimeModuleName =
      options.templateOptions?.compilerOptions?.runtimeModuleName

    // 生成导入语句
    const importSrc = runtimeModuleName
      ? JSON.stringify(runtimeModuleName)
      : `'vue'`
    ctx.s.prepend(
      `import { ${[...ctx.helperImports]
        .map(h => `${h} as _${h}`)
        .join(', ')} } from ${importSrc}\n`,
    )
  }

  // 获取编译后的代码内容
  const content = ctx.s.toString()
  let map =
    options.sourceMap !== false
      ? // 生成 source map
        (ctx.s.generateMap({
          source: filename,
          hires: true,
          includeContent: true,
        }) as unknown as RawSourceMap)
      : undefined
  // merge source maps of the script setup and template in inline mode
  if (templateMap && map) {
    const offset = content.indexOf(returned)
    const templateLineOffset =
      content.slice(0, offset).split(/\r?\n/).length - 1
    // 合并 source map
    map = mergeSourceMaps(map, templateMap, templateLineOffset)
  }
  return {
    ...scriptSetup,
    bindings: ctx.bindingMetadata,
    imports: ctx.userImports,
    content,
    map,
    scriptAst: scriptAst?.body,
    scriptSetupAst: scriptSetupAst?.body,
    deps: ctx.deps ? [...ctx.deps] : undefined,
  }
}

/**
 * 将变量名与其绑定类型注册到绑定记录中
 * @param bindings 存储变量名到绑定类型的映射对象
 * @param node 变量声明节点
 * @param type 变量的绑定类型
 */
function registerBinding(
  bindings: Record<string, BindingTypes>,
  node: Identifier,
  type: BindingTypes,
) {
  bindings[node.name] = type
}

/**
 * 用于分析和处理组件中的声明语句，确定变量的绑定类型
 * @param from  声明来源 'script' 或 'scriptSetup'
 * @param node 声明节点
 * @param bindings 存储变量绑定类型的对象
 * @param userImportAliases 用户导入的别名映射
 * @param hoistStatic 是否提升静态内容
 * @param isPropsDestructureEnabled 是否启用 props 解构
 * @returns
 */
function walkDeclaration(
  from: 'script' | 'scriptSetup',
  node: Declaration,
  bindings: Record<string, BindingTypes>,
  userImportAliases: Record<string, string>,
  hoistStatic: boolean,
  isPropsDestructureEnabled = false,
): boolean {
  let isAllLiteral = false

  // 1、变量声明
  if (node.type === 'VariableDeclaration') {
    const isConst = node.kind === 'const'

    // 是否所有声明都是字面量常量
    isAllLiteral =
      isConst &&
      node.declarations.every(
        decl => decl.id.type === 'Identifier' && isStaticNode(decl.init!),
      )

    // export const foo = ...
    for (const { id, init: _init } of node.declarations) {
      const init = _init && unwrapTSNode(_init)
      const isConstMacroCall =
        isConst &&
        isCallOf(
          init,
          c =>
            c === DEFINE_PROPS ||
            c === DEFINE_EMITS ||
            c === WITH_DEFAULTS ||
            c === DEFINE_SLOTS,
        )
      if (id.type === 'Identifier') {
        let bindingType
        const userReactiveBinding = userImportAliases['reactive']
        if (
          (hoistStatic || from === 'script') &&
          (isAllLiteral || (isConst && isStaticNode(init!)))
        ) {
          bindingType = BindingTypes.LITERAL_CONST
        } else if (isCallOf(init, userReactiveBinding)) {
          // treat reactive() calls as let since it's meant to be mutable
          bindingType = isConst
            ? BindingTypes.SETUP_REACTIVE_CONST
            : BindingTypes.SETUP_LET
        } else if (
          // if a declaration is a const literal, we can mark it so that
          // the generated render fn code doesn't need to unref() it
          isConstMacroCall ||
          (isConst && canNeverBeRef(init!, userReactiveBinding))
        ) {
          bindingType = isCallOf(init, DEFINE_PROPS)
            ? BindingTypes.SETUP_REACTIVE_CONST
            : BindingTypes.SETUP_CONST
        } else if (isConst) {
          // 检查变量的初始值 init 是否是特定函数的调用
          if (
            isCallOf(
              init,
              m =>
                m === userImportAliases['ref'] ||
                m === userImportAliases['computed'] ||
                m === userImportAliases['shallowRef'] ||
                m === userImportAliases['customRef'] ||
                m === userImportAliases['toRef'] ||
                m === userImportAliases['useTemplateRef'] ||
                m === DEFINE_MODEL,
            )
          ) {
            bindingType = BindingTypes.SETUP_REF
          } else {
            bindingType = BindingTypes.SETUP_MAYBE_REF
          }
        } else {
          bindingType = BindingTypes.SETUP_LET
        }
        registerBinding(bindings, id, bindingType)

        // 解构模式
      } else {
        if (isCallOf(init, DEFINE_PROPS) && isPropsDestructureEnabled) {
          continue
        }
        if (id.type === 'ObjectPattern') {
          walkObjectPattern(id, bindings, isConst, isConstMacroCall)
        } else if (id.type === 'ArrayPattern') {
          walkArrayPattern(id, bindings, isConst, isConstMacroCall)
        }
      }
    }

    // 2、枚举声明
  } else if (node.type === 'TSEnumDeclaration') {
    isAllLiteral = node.members.every(
      member => !member.initializer || isStaticNode(member.initializer),
    )
    bindings[node.id!.name] = isAllLiteral
      ? BindingTypes.LITERAL_CONST
      : BindingTypes.SETUP_CONST

    // 3、 函数声明、类声明
  } else if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'ClassDeclaration'
  ) {
    // export function foo() {} / export class Foo {}
    // export declarations must be named.
    bindings[node.id!.name] = BindingTypes.SETUP_CONST
  }

  return isAllLiteral
}

function walkObjectPattern(
  node: ObjectPattern,
  bindings: Record<string, BindingTypes>,
  isConst: boolean,
  isDefineCall = false,
) {
  for (const p of node.properties) {
    if (p.type === 'ObjectProperty') {
      // 简写形式：如 const { x } = ...（key 和 value 相同）
      if (p.key.type === 'Identifier' && p.key === p.value) {
        // shorthand: const { x } = ...
        const type = isDefineCall
          ? // 来自 define 调用的常量，如 defineProps、defineEmits 的返回值
            BindingTypes.SETUP_CONST
          : isConst
            ? // const 声明的变量，可能是 ref
              BindingTypes.SETUP_MAYBE_REF
            : // let 声明的变量
              BindingTypes.SETUP_LET
        registerBinding(bindings, p.key, type)
      } else {
        // 调用 walkPattern 处理 p.value
        walkPattern(p.value, bindings, isConst, isDefineCall)
      }
    } else {
      // ...rest
      // argument can only be identifier when destructuring
      const type = isConst ? BindingTypes.SETUP_CONST : BindingTypes.SETUP_LET
      registerBinding(bindings, p.argument as Identifier, type)
    }
  }
}

function walkArrayPattern(
  node: ArrayPattern,
  bindings: Record<string, BindingTypes>,
  isConst: boolean,
  isDefineCall = false,
) {
  for (const e of node.elements) {
    e && walkPattern(e, bindings, isConst, isDefineCall)
  }
}

/**
 * 遍历和分析不同类型的模式节点（如标识符、对象解构、数组解构等
 * @param node
 * @param bindings
 * @param isConst
 * @param isDefineCall
 */
function walkPattern(
  node: Node,
  bindings: Record<string, BindingTypes>,
  isConst: boolean,
  isDefineCall = false,
) {
  if (node.type === 'Identifier') {
    const type = isDefineCall
      ? BindingTypes.SETUP_CONST
      : isConst
        ? BindingTypes.SETUP_MAYBE_REF
        : BindingTypes.SETUP_LET
    registerBinding(bindings, node, type)
  } else if (node.type === 'RestElement') {
    // argument can only be identifier when destructuring
    const type = isConst ? BindingTypes.SETUP_CONST : BindingTypes.SETUP_LET
    registerBinding(bindings, node.argument as Identifier, type)
  } else if (node.type === 'ObjectPattern') {
    walkObjectPattern(node, bindings, isConst)
  } else if (node.type === 'ArrayPattern') {
    walkArrayPattern(node, bindings, isConst)
  } else if (node.type === 'AssignmentPattern') {
    if (node.left.type === 'Identifier') {
      const type = isDefineCall
        ? BindingTypes.SETUP_CONST
        : isConst
          ? BindingTypes.SETUP_MAYBE_REF
          : BindingTypes.SETUP_LET
      registerBinding(bindings, node.left, type)
    } else {
      walkPattern(node.left, bindings, isConst)
    }
  }
}

function canNeverBeRef(node: Node, userReactiveImport?: string): boolean {
  if (isCallOf(node, userReactiveImport)) {
    return true
  }
  switch (node.type) {
    case 'UnaryExpression':
    case 'BinaryExpression':
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'UpdateExpression':
    case 'ClassExpression':
    case 'TaggedTemplateExpression':
      return true
    case 'SequenceExpression':
      return canNeverBeRef(
        node.expressions[node.expressions.length - 1],
        userReactiveImport,
      )
    default:
      if (isLiteralNode(node)) {
        return true
      }
      return false
  }
}

/**
 * 判断节点是否为静态节点
 * @param node 要判断的节点
 * @returns
 */
function isStaticNode(node: Node): boolean {
  // 先去TS节点的包装
  node = unwrapTSNode(node)

  switch (node.type) {
    // 一元表达式
    case 'UnaryExpression': // void 0, !true
      return isStaticNode(node.argument)

    // 逻辑表达式、二元表达式
    case 'LogicalExpression': // 1 > 2
    case 'BinaryExpression': // 1 + 2
      return isStaticNode(node.left) && isStaticNode(node.right)

    // 条件表达式
    case 'ConditionalExpression': {
      // 1 ? 2 : 3
      return (
        isStaticNode(node.test) &&
        isStaticNode(node.consequent) &&
        isStaticNode(node.alternate)
      )
    }

    // 序列表达式、模板字面值
    case 'SequenceExpression': // (1, 2)
    case 'TemplateLiteral': // `foo${1}`
      return node.expressions.every(expr => isStaticNode(expr))

    // 括号表达式
    case 'ParenthesizedExpression': // (1)
      return isStaticNode(node.expression)

    // 字面值
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
      return true
  }
  return false
}

/**
 * 合并脚本部分和模板部分的源映射（source map）
 * 源映射是一种用于将编译后代码映射回原始源代码的技术，便于调试。
 * @param scriptMap 脚本部分的源映射对象
 * @param templateMap 模板部分的源映射对象
 * @param templateLineOffset 模板部分的行偏移量，用于调整映射关系
 * @returns 合并后的源映射对象
 */
export function mergeSourceMaps(
  scriptMap: RawSourceMap,
  templateMap: RawSourceMap,
  templateLineOffset: number,
): RawSourceMap {
  // 创建一个新的 SourceMapGenerator 实例，用于生成合并后的源映射
  const generator = new SourceMapGenerator()

  const addMapping = (map: RawSourceMap, lineOffset = 0) => {
    // 创建消费者：为每个源映射创建一个 SourceMapConsumer
    const consumer = new SourceMapConsumer(map)

    ;(consumer as any).sources.forEach((sourceFile: string) => {
      // 将源映射中的所有源文件添加到生成器中
      ;(generator as any)._sources.add(sourceFile)

      const sourceContent = consumer.sourceContentFor(sourceFile)

      if (sourceContent != null) {
        // 如果源文件有内容，将其设置到生成器中
        generator.setSourceContent(sourceFile, sourceContent)
      }
    })
    consumer.eachMapping(m => {
      if (m.originalLine == null) return

      // 添加映射：遍历源映射中的每个映射，调整行偏移量后添加到生成器中
      generator.addMapping({
        generated: {
          line: m.generatedLine + lineOffset,
          column: m.generatedColumn,
        },
        original: {
          line: m.originalLine,
          column: m.originalColumn!,
        },
        source: m.source,
        name: m.name,
      })
    })
  }

  // 先添加脚本部分的源映射（无偏移）
  addMapping(scriptMap)
  // 再添加模板部分的源映射（带行偏移）
  addMapping(templateMap, templateLineOffset)
  ;(generator as any)._sourceRoot = scriptMap.sourceRoot
  ;(generator as any)._file = scriptMap.file

  // 将生成器转换为 JSON 格式并返回
  return (generator as any).toJSON()
}
