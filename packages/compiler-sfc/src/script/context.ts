import type { CallExpression, Node, ObjectPattern, Program } from '@babel/types'
import type { SFCDescriptor } from '../parse'
import { generateCodeFrame, isArray } from '@vue/shared'
import { type ParserPlugin, parse as babelParse } from '@babel/parser'
import type { ImportBinding, SFCScriptCompileOptions } from '../compileScript'
import type { PropsDestructureBindings } from './defineProps'
import type { ModelDecl } from './defineModel'
import type { BindingMetadata } from '../../../compiler-core/src'
import MagicString from 'magic-string'
import type { TypeScope } from './resolveType'
import { warn } from '../warn'
import { isJS, isTS } from './utils'

export class ScriptCompileContext {
  isJS: boolean
  isTS: boolean
  // 是否为自定义元素模式（通过 customElement 选项决定）
  isCE = false

  scriptAst: Program | null // 普通 <script> 块的 AST
  scriptSetupAst: Program | null // <script setup> 块的 AST

  // 完整的组件源码字符串
  source: string = this.descriptor.source
  // 文件名
  filename: string = this.descriptor.filename
  // MagicString 实例，允许在原始源码上进行精确的字符串替换、插入、删除操作，最终生成编译后的代码
  s: MagicString = new MagicString(this.source)
  // <script setup> 块在源码中的起止偏移量（用于定位和提取内容）
  startOffset: number | undefined =
    this.descriptor.scriptSetup?.loc.start.offset
  endOffset: number | undefined = this.descriptor.scriptSetup?.loc.end.offset

  // import / type analysis
  // TypeScript 作用域对象
  scope?: TypeScope
  globalScopes?: TypeScope[]
  // 记录用户导入的模块信息（本地绑定名、源路径、是否为类型导入等）
  userImports: Record<string, ImportBinding> = Object.create(null)

  // macros presence check
  hasDefinePropsCall = false // 是否调用了 defineProps
  hasDefineEmitCall = false // 是否调用了 defineEmits
  hasDefineExposeCall = false // 是否调用了 defineExpose
  hasDefaultExportName = false // 是否导出了默认名称
  hasDefaultExportRender = false // 是否导出了默认渲染函数
  hasDefineOptionsCall = false // 是否调用了 defineOptions
  hasDefineSlotsCall = false // 是否调用了 defineSlots
  hasDefineModelCall = false // 是否调用了 defineModel

  // defineProps
  propsCall: CallExpression | undefined // 调用 defineProps 的节点表达式
  propsDecl: Node | undefined // defineProps 的节点声明
  propsRuntimeDecl: Node | undefined // defineProps 的运行时节点声明
  propsTypeDecl: Node | undefined // defineProps 的类型节点声明
  propsDestructureDecl: ObjectPattern | undefined // defineProps 的解构节点声明
  // defineProps 的解构绑定对象
  propsDestructuredBindings: PropsDestructureBindings = Object.create(null)
  // defineProps 的解构剩余参数绑定对象
  propsDestructureRestId: string | undefined // defineProps 的解构剩余参数绑定对象
  // defineProps 的运行时默认值节点
  propsRuntimeDefaults: Node | undefined

  // defineEmits
  emitsRuntimeDecl: Node | undefined // defineEmits 的运行时节点声明
  emitsTypeDecl: Node | undefined // defineEmits 的类型节点声明
  emitDecl: Node | undefined // defineEmits 的节点声明

  // defineModel
  // defineModel 的节点声明
  modelDecls: Record<string, ModelDecl> = Object.create(null)

  // defineOptions
  // defineOptions 的运行时节点声明
  optionsRuntimeDecl: Node | undefined

  // codegen
  // 存储变量绑定类型
  bindingMetadata: BindingMetadata = {}
  // 存储需要注入的运行时辅助函数名
  helperImports: Set<string> = new Set()
  helper(key: string): string {
    this.helperImports.add(key)
    return `_${key}`
  }

  /**
   * to be exposed on compiled script block for HMR cache busting
   * 用于 HMR 缓存失效时记录依赖的文件路径
   */
  deps?: Set<string>

  /**
   * cache for resolved fs
   * 可选的虚拟文件系统
   */
  fs?: NonNullable<SFCScriptCompileOptions['fs']>

  constructor(
    public descriptor: SFCDescriptor,
    public options: Partial<SFCScriptCompileOptions>,
  ) {
    // 解构script和scriptSetup
    const { script, scriptSetup } = descriptor
    // 获取script和scriptSetup的lang属性
    const scriptLang = script && script.lang
    const scriptSetupLang = scriptSetup && scriptSetup.lang

    // 判断是否为JS或TS文件
    this.isJS = isJS(scriptLang, scriptSetupLang)
    this.isTS = isTS(scriptLang, scriptSetupLang)

    // 判断是否为自定义元素模式
    const customElement = options.customElement
    const filename = this.descriptor.filename
    if (customElement) {
      this.isCE =
        typeof customElement === 'boolean'
          ? customElement
          : customElement(filename)
    }
    // resolve parser plugins
    const plugins: ParserPlugin[] = resolveParserPlugins(
      (scriptLang || scriptSetupLang)!,
      options.babelParserPlugins,
    )

    function parse(input: string, offset: number): Program {
      try {
        return babelParse(input, {
          plugins,
          sourceType: 'module',
        }).program
      } catch (e: any) {
        e.message = `[vue/compiler-sfc] ${e.message}\n\n${
          descriptor.filename
        }\n${generateCodeFrame(
          descriptor.source,
          e.pos + offset,
          e.pos + offset + 1,
        )}`
        throw e
      }
    }

    this.scriptAst =
      descriptor.script &&
      parse(descriptor.script.content, descriptor.script.loc.start.offset)

    this.scriptSetupAst =
      descriptor.scriptSetup &&
      parse(descriptor.scriptSetup!.content, this.startOffset!)
  }

  /**
   * 获取节点的字符串内容
   * @param node 节点
   * @param scriptSetup 是否为 setup 函数
   * @returns 字符串内容
   */
  getString(node: Node, scriptSetup = true): string {
    const block = scriptSetup
      ? this.descriptor.scriptSetup!
      : this.descriptor.script!
    return block.content.slice(node.start!, node.end!)
  }

  /**
   * 警告
   * @param msg 警告消息
   * @param node 节点
   * @param scope 类型范围
   */
  warn(msg: string, node: Node, scope?: TypeScope): void {
    warn(generateError(msg, node, this, scope))
  }

  /**
   * 错误
   * @param msg 错误消息
   * @param node 节点
   * @param scope 类型范围
   */
  error(msg: string, node: Node, scope?: TypeScope): never {
    throw new Error(
      `[@vue/compiler-sfc] ${generateError(msg, node, this, scope)}`,
    )
  }
}

function generateError(
  msg: string,
  node: Node,
  ctx: ScriptCompileContext,
  scope?: TypeScope,
) {
  const offset = scope ? scope.offset : ctx.startOffset!
  return `${msg}\n\n${(scope || ctx.descriptor).filename}\n${generateCodeFrame(
    (scope || ctx.descriptor).source,
    node.start! + offset,
    node.end! + offset,
  )}`
}

/**
 * 根据脚本语言类型和用户配置，解析并返回适合的 Babel 解析器插件数组
 * @param lang 脚本语言类型
 * @param userPlugins 用户提供的 Babel 解析器插件数组（可选）
 * @param dts 是否为 TypeScript 声明文件模式（默认为 false）
 * @returns 解析器插件数组
 */
export function resolveParserPlugins(
  lang: string,
  userPlugins?: ParserPlugin[],
  dts = false,
): ParserPlugin[] {
  const plugins: ParserPlugin[] = []
  if (
    !userPlugins ||
    !userPlugins.some(
      p =>
        p === 'importAssertions' ||
        p === 'importAttributes' ||
        (isArray(p) && p[0] === 'importAttributes'),
    )
  ) {
    // 添加 importAttributes 插件，用于支持 ES 模块的导入断言功能
    plugins.push('importAttributes')
  }
  if (lang === 'jsx' || lang === 'tsx' || lang === 'mtsx') {
    // 添加 jsx 插件
    plugins.push('jsx')
  } else if (userPlugins) {
    // If don't match the case of adding jsx
    // should remove the jsx from user options
    userPlugins = userPlugins.filter(p => p !== 'jsx')
  }
  if (
    lang === 'ts' ||
    lang === 'mts' ||
    lang === 'tsx' ||
    lang === 'cts' ||
    lang === 'mtsx'
  ) {
    // 添加 typescript 插件
    // 添加 explicitResourceManagement 插件，用于支持 using 声明等新特性
    plugins.push(['typescript', { dts }], 'explicitResourceManagement')
    if (!userPlugins || !userPlugins.includes('decorators')) {
      // 添加 decorators-legacy 插件,用于支持装饰器语法
      plugins.push('decorators-legacy')
    }
  }
  if (userPlugins) {
    plugins.push(...userPlugins)
  }
  return plugins
}
