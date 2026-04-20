import {
  type AttributeNode,
  ConstantTypes,
  type DirectiveNode,
  type ElementNode,
  ElementTypes,
  type ForParseResult,
  Namespaces,
  NodeTypes,
  type RootNode,
  type SimpleExpressionNode,
  type SourceLocation,
  type TemplateChildNode,
  createRoot,
  createSimpleExpression,
} from './ast'
import type { ParserOptions } from './options'
import Tokenizer, {
  CharCodes,
  ParseMode,
  QuoteType,
  Sequences,
  State,
  isWhitespace,
  toCharCodes,
} from './tokenizer'
import {
  type CompilerCompatOptions,
  CompilerDeprecationTypes,
  checkCompatEnabled,
  isCompatEnabled,
  warnDeprecation,
} from './compat/compatConfig'
import { NO, extend } from '@vue/shared'
import {
  ErrorCodes,
  createCompilerError,
  defaultOnError,
  defaultOnWarn,
} from './errors'
import {
  forAliasRE,
  isAllWhitespace,
  isCoreComponent,
  isSimpleIdentifier,
  isStaticArgOf,
  isVPre,
} from './utils'
import { decodeHTML } from 'entities/decode'
import {
  type ParserOptions as BabelOptions,
  parse,
  parseExpression,
} from '@babel/parser'

type OptionalOptions =
  | 'decodeEntities'
  | 'whitespace'
  | 'isNativeTag'
  | 'isBuiltInComponent'
  | 'expressionPlugins'
  | keyof CompilerCompatOptions

export type MergedParserOptions = Omit<
  Required<ParserOptions>,
  OptionalOptions
> &
  Pick<ParserOptions, OptionalOptions>

export const defaultParserOptions: MergedParserOptions = {
  parseMode: 'base', // 解析模式，可选值：'base'、'html'、'sfc'
  ns: Namespaces.HTML, // 默认命名空间，控制解析规则
  delimiters: [`{{`, `}}`], // 插值表达式的分隔符
  getNamespace: () => Namespaces.HTML, // 根据标签名获取命名空间的函数
  isVoidTag: NO, // 判断是否为 void 标签的函数
  isPreTag: NO, // 判断是否为 pre 标签的函数
  isIgnoreNewlineTag: NO, // 判断是否为忽略换行的标签的函数
  isCustomElement: NO, // 判断是否为自定义元素的函数
  onError: defaultOnError, // 错误处理函数
  onWarn: defaultOnWarn, // 警告处理函数
  comments: __DEV__, // 是否保留注释，默认仅在开发环境保留
  prefixIdentifiers: false, // 是否为标识符添加前缀，默认不添加
}

let currentOptions: MergedParserOptions = defaultParserOptions
let currentRoot: RootNode | null = null

// parser state
let currentInput = ''
let currentOpenTag: ElementNode | null = null
let currentProp: AttributeNode | DirectiveNode | null = null
let currentAttrValue = ''
let currentAttrStartIndex = -1
let currentAttrEndIndex = -1
let inPre = 0
let inVPre = false
let currentVPreBoundary: ElementNode | null = null
const stack: ElementNode[] = []

const tokenizer = new Tokenizer(stack, {
  onerr: emitError,

  ontext(start, end) {
    onText(getSlice(start, end), start, end)
  },

  ontextentity(char, start, end) {
    onText(char, start, end)
  },

  oninterpolation(start, end) {
    if (inVPre) {
      return onText(getSlice(start, end), start, end)
    }
    let innerStart = start + tokenizer.delimiterOpen.length
    let innerEnd = end - tokenizer.delimiterClose.length
    while (isWhitespace(currentInput.charCodeAt(innerStart))) {
      innerStart++
    }
    while (isWhitespace(currentInput.charCodeAt(innerEnd - 1))) {
      innerEnd--
    }
    let exp = getSlice(innerStart, innerEnd)
    // decode entities for backwards compat
    if (exp.includes('&')) {
      if (__BROWSER__) {
        exp = currentOptions.decodeEntities!(exp, false)
      } else {
        exp = decodeHTML(exp)
      }
    }
    addNode({
      type: NodeTypes.INTERPOLATION,
      content: createExp(exp, false, getLoc(innerStart, innerEnd)),
      loc: getLoc(start, end),
    })
  },

  onopentagname(start, end) {
    const name = getSlice(start, end)
    currentOpenTag = {
      type: NodeTypes.ELEMENT,
      tag: name,
      ns: currentOptions.getNamespace(name, stack[0], currentOptions.ns),
      tagType: ElementTypes.ELEMENT, // will be refined on tag close
      props: [],
      children: [],
      loc: getLoc(start - 1, end),
      codegenNode: undefined,
    }
  },

  onopentagend(end) {
    endOpenTag(end)
  },

  onclosetag(start, end) {
    const name = getSlice(start, end)
    if (!currentOptions.isVoidTag(name)) {
      let found = false
      for (let i = 0; i < stack.length; i++) {
        const e = stack[i]
        if (e.tag.toLowerCase() === name.toLowerCase()) {
          found = true
          if (i > 0) {
            emitError(ErrorCodes.X_MISSING_END_TAG, stack[0].loc.start.offset)
          }
          for (let j = 0; j <= i; j++) {
            const el = stack.shift()!
            onCloseTag(el, end, j < i)
          }
          break
        }
      }
      if (!found) {
        emitError(ErrorCodes.X_INVALID_END_TAG, backTrack(start, CharCodes.Lt))
      }
    }
  },

  onselfclosingtag(end) {
    const name = currentOpenTag!.tag
    currentOpenTag!.isSelfClosing = true
    endOpenTag(end)
    if (stack[0] && stack[0].tag === name) {
      onCloseTag(stack.shift()!, end)
    }
  },

  /**
   * 处理普通 HTML 属性的名称解析
   * @param start 属性名称的起始位置
   * @param end 属性名称的结束位置
   */
  onattribname(start, end) {
    // plain attribute
    currentProp = {
      type: NodeTypes.ATTRIBUTE, // 表示这是一个普通 HTML 属性
      name: getSlice(start, end), // 从输入字符串中提取属性名
      // 设置属性名的位置信息
      nameLoc: getLoc(start, end),
      value: undefined, // 初始化属性值为 undefined
      // 设置整个属性的位置信息
      loc: getLoc(start),
    }
  },

  /**
   * 用于处理指令名称的解析和处理
   * @param start 指令名称的起始位置
   * @param end 指令名称的结束位置
   */
  ondirname(start, end) {
    // 从输入字符串中提取原始指令名称
    const raw = getSlice(start, end)
    const name =
      raw === '.' || raw === ':'
        ? // . 和 : 简写为 bind 指令
          'bind'
        : raw === '@'
          ? // @ 简写为 on 指令
            'on'
          : raw === '#'
            ? // # 简写为 slot 指令
              'slot'
            : // 其他情况（如 v-if）则去掉前缀 v- 得到指令名称
              raw.slice(2)

    // 在非 VPre 模式下，如果指令名称为空，发出错误
    if (!inVPre && name === '') {
      emitError(ErrorCodes.X_MISSING_DIRECTIVE_NAME, start)
    }

    // 在 VPre 模式或指令名称为空时
    if (inVPre || name === '') {
      // 创建普通属性节点，将指令视为普通 HTML 属性
      currentProp = {
        type: NodeTypes.ATTRIBUTE,
        name: raw,
        nameLoc: getLoc(start, end),
        value: undefined,
        loc: getLoc(start),
      }

      // 在非 VPre 模式且指令名称非空时
    } else {
      // 创建指令节点，设置指令名称、原始名称、表达式、参数和修饰符
      currentProp = {
        type: NodeTypes.DIRECTIVE,
        name,
        rawName: raw,
        exp: undefined,
        arg: undefined,
        modifiers: raw === '.' ? [createSimpleExpression('prop')] : [],
        loc: getLoc(start),
      }
      if (name === 'pre') {
        // 启用 VPre 模式
        inVPre = tokenizer.inVPre = true
        // 记录当前 VPre 模式的边界标签
        currentVPreBoundary = currentOpenTag
        // convert dirs before this one to attributes
        // 获取当前开放标签的属性列表
        const props = currentOpenTag!.props
        for (let i = 0; i < props.length; i++) {
          if (props[i].type === NodeTypes.DIRECTIVE) {
            // 将指令转换为普通属性
            props[i] = dirToAttr(props[i] as DirectiveNode)
          }
        }
      }
    }
  },

  /**
   * 处理指令参数的解析和处理
   * @param start 指令参数的起始位置
   * @param end 指令参数的结束位置
   * @returns
   */
  ondirarg(start, end) {
    if (start === end) return

    // 从输入字符串中提取指令参数的内容
    const arg = getSlice(start, end)

    // 如果在 VPre 模式下，且当前属性不是 v-pre 指令
    if (inVPre && !isVPre(currentProp!)) {
      // 将参数追加到属性名后面（例如，v-bind:class 变为 v-bind:class）
      ;(currentProp as AttributeNode).name += arg
      // 更新属性名的位置信息
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else {
      // 检查参数是否为静态（不以 [ 开头）
      const isStatic = arg[0] !== `[`

      // 创建表达式节点作为指令的参数
      ;(currentProp as DirectiveNode).arg = createExp(
        // 如果是静态参数（如 class），直接使用参数内容
        // 如果是动态参数（如 [dynamicArg]），去掉括号后使用内容
        isStatic ? arg : arg.slice(1, -1),
        isStatic,
        getLoc(start, end),
        isStatic ? ConstantTypes.CAN_STRINGIFY : ConstantTypes.NOT_CONSTANT,
      )
    }
  },

  /**
   * 处理指令修饰符的解析和处理
   * @param start 指令修饰符的起始位置
   * @param end 指令修饰符的结束位置
   * @returns
   */
  ondirmodifier(start, end) {
    // 从输入字符串中提取修饰符的内容
    const mod = getSlice(start, end)

    // 1、Vpre模式
    if (inVPre && !isVPre(currentProp!)) {
      // 将修饰符追加到属性名后面（例如，v-on:click.stop 变为 v-on:click.stop）
      ;(currentProp as AttributeNode).name += '.' + mod
      // 更新属性名的位置信息
      setLocEnd((currentProp as AttributeNode).nameLoc, end)

      //2、Slot 指令特殊处理
    } else if ((currentProp as DirectiveNode).name === 'slot') {
      // slot has no modifiers, special case for edge cases like
      // https://github.com/vuejs/language-tools/issues/2710
      const arg = (currentProp as DirectiveNode).arg
      if (arg) {
        // slot 指令没有修饰符，这是一个特殊处理，用于处理边缘情况
        // 如果有参数，将修饰符追加到参数内容后面
        ;(arg as SimpleExpressionNode).content += '.' + mod
        // 更新参数的位置信息
        setLocEnd(arg.loc, end)
      }
    } else {
      // 创建一个简单表达式节点表示修饰符
      const exp = createSimpleExpression(mod, true, getLoc(start, end))
      // 将修饰符添加到指令的 modifiers 数组中
      ;(currentProp as DirectiveNode).modifiers.push(exp)
    }
  },

  /**
   * 处理 HTML 属性值的数据部分
   * @param start 属性值的起始位置
   * @param end 属性值的结束位置
   */
  onattribdata(start, end) {
    // 从输入字符串中提取属性值的一部分
    // 将提取的内容追加到 currentAttrValue 变量中
    currentAttrValue += getSlice(start, end)

    // 如果 currentAttrStartIndex 小于 0（表示还没有记录起始位置）
    // 将其设置为当前数据的起始位置 start
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    currentAttrEndIndex = end // 更新属性值的结束位置
  },

  /**
   * 处理 HTML 属性值中的实体引用（entity references）
   * @param char 实体引用解码后的字符（如 &amp; 解码为 &）
   * @param start 实体引用的起始位置
   * @param end 实体引用的结束位置
   */
  onattribentity(char, start, end) {
    // 将解码后的字符追加到当前属性值中
    currentAttrValue += char
    // 如果 currentAttrStartIndex 小于 0（表示还没有记录起始位置）
    // 将其设置为当前数据的起始位置 start
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    currentAttrEndIndex = end // 更新属性值的结束位置
  },

  /**
   * 用于处理属性名解析结束时的逻辑
   * @param end 属性名的结束位置
   */
  onattribnameend(end) {
    // 获取当前属性的起始位置
    const start = currentProp!.loc.start.offset
    // 从输入字符串中提取完整的属性名
    const name = getSlice(start, end)

    if (currentProp!.type === NodeTypes.DIRECTIVE) {
      // 置指令的 rawName 属性为完整的属性名
      currentProp!.rawName = name
    }
    // check duplicate attrs
    // 检查当前开放标签的属性列表中是否已存在相同名称的属性
    // 编译器的重复属性检测逻辑是基于 rawName 进行比较的
    if (
      currentOpenTag!.props.some(
        p => (p.type === NodeTypes.DIRECTIVE ? p.rawName : p.name) === name,
      )
    ) {
      emitError(ErrorCodes.DUPLICATE_ATTRIBUTE, start)
    }
  },

  /**
   *
   * @param quote
   * @param end
   */
  onattribend(quote, end) {
    if (currentOpenTag && currentProp) {
      // finalize end pos
      setLocEnd(currentProp.loc, end)

      if (quote !== QuoteType.NoValue) {
        if (__BROWSER__ && currentAttrValue.includes('&')) {
          currentAttrValue = currentOptions.decodeEntities!(
            currentAttrValue,
            true,
          )
        }

        if (currentProp.type === NodeTypes.ATTRIBUTE) {
          // assign value

          // condense whitespaces in class
          if (currentProp!.name === 'class') {
            currentAttrValue = condense(currentAttrValue).trim()
          }

          if (quote === QuoteType.Unquoted && !currentAttrValue) {
            emitError(ErrorCodes.MISSING_ATTRIBUTE_VALUE, end)
          }

          currentProp!.value = {
            type: NodeTypes.TEXT,
            content: currentAttrValue,
            loc:
              quote === QuoteType.Unquoted
                ? getLoc(currentAttrStartIndex, currentAttrEndIndex)
                : getLoc(currentAttrStartIndex - 1, currentAttrEndIndex + 1),
          }
          if (
            tokenizer.inSFCRoot &&
            currentOpenTag.tag === 'template' &&
            currentProp.name === 'lang' &&
            currentAttrValue &&
            currentAttrValue !== 'html'
          ) {
            // SFC root template with preprocessor lang, force tokenizer to
            // RCDATA mode
            tokenizer.enterRCDATA(toCharCodes(`</template`), 0)
          }
        } else {
          // directive
          let expParseMode = ExpParseMode.Normal
          if (!__BROWSER__) {
            if (currentProp.name === 'for') {
              expParseMode = ExpParseMode.Skip
            } else if (currentProp.name === 'slot') {
              expParseMode = ExpParseMode.Params
            } else if (
              currentProp.name === 'on' &&
              currentAttrValue.includes(';')
            ) {
              expParseMode = ExpParseMode.Statements
            }
          }
          currentProp.exp = createExp(
            currentAttrValue,
            false,
            getLoc(currentAttrStartIndex, currentAttrEndIndex),
            ConstantTypes.NOT_CONSTANT,
            expParseMode,
          )
          if (currentProp.name === 'for') {
            currentProp.forParseResult = parseForExpression(currentProp.exp)
          }
          // 2.x compat v-bind:foo.sync -> v-model:foo
          let syncIndex = -1
          if (
            __COMPAT__ &&
            currentProp.name === 'bind' &&
            (syncIndex = currentProp.modifiers.findIndex(
              mod => mod.content === 'sync',
            )) > -1 &&
            checkCompatEnabled(
              CompilerDeprecationTypes.COMPILER_V_BIND_SYNC,
              currentOptions,
              currentProp.loc,
              currentProp.arg!.loc.source,
            )
          ) {
            currentProp.name = 'model'
            currentProp.modifiers.splice(syncIndex, 1)
          }
        }
      }
      if (
        currentProp.type !== NodeTypes.DIRECTIVE ||
        currentProp.name !== 'pre'
      ) {
        currentOpenTag.props.push(currentProp)
      }
    }
    currentAttrValue = ''
    currentAttrStartIndex = currentAttrEndIndex = -1
  },

  /**
   * 处理 HTML 注释的解析
   * @param start 注释的起始索引
   * @param end 注释的结束索引
   */
  oncomment(start, end) {
    // 配置保留注释节点
    if (currentOptions.comments) {
      addNode({
        type: NodeTypes.COMMENT,
        content: getSlice(start, end),
        loc: getLoc(start - 4, end + 3),
      })
    }
  },

  /**
   *
   */
  onend() {
    const end = currentInput.length
    // EOF ERRORS
    if ((__DEV__ || !__BROWSER__) && tokenizer.state !== State.Text) {
      switch (tokenizer.state) {
        case State.BeforeTagName:
        case State.BeforeClosingTagName:
          emitError(ErrorCodes.EOF_BEFORE_TAG_NAME, end)
          break
        case State.Interpolation:
        case State.InterpolationClose:
          emitError(
            ErrorCodes.X_MISSING_INTERPOLATION_END,
            tokenizer.sectionStart,
          )
          break
        case State.InCommentLike:
          if (tokenizer.currentSequence === Sequences.CdataEnd) {
            emitError(ErrorCodes.EOF_IN_CDATA, end)
          } else {
            emitError(ErrorCodes.EOF_IN_COMMENT, end)
          }
          break
        case State.InTagName:
        case State.InSelfClosingTag:
        case State.InClosingTagName:
        case State.BeforeAttrName:
        case State.InAttrName:
        case State.InDirName:
        case State.InDirArg:
        case State.InDirDynamicArg:
        case State.InDirModifier:
        case State.AfterAttrName:
        case State.BeforeAttrValue:
        case State.InAttrValueDq: // "
        case State.InAttrValueSq: // '
        case State.InAttrValueNq:
          emitError(ErrorCodes.EOF_IN_TAG, end)
          break
        default:
          // console.log(tokenizer.state)
          break
      }
    }
    for (let index = 0; index < stack.length; index++) {
      onCloseTag(stack[index], end - 1)
      emitError(ErrorCodes.X_MISSING_END_TAG, stack[index].loc.start.offset)
    }
  },

  /**
   * 用于处理 CDATA 部分的解析。
   * CDATA（Character Data）是一种在 XML 和 HTML 中用于包含不应被解析器解析的原始文本的方法。
   * @param start
   * @param end
   */
  oncdata(start, end) {
    // 1、处理非 HTML 命名空间
    if (stack[0].ns !== Namespaces.HTML) {
      // 调用 onText 函数处理 CDATA 内容
      onText(getSlice(start, end), start, end)

      // 2、处理 HTML 命名空间
    } else {
      emitError(ErrorCodes.CDATA_IN_HTML_CONTENT, start - 9)
    }
  },

  onprocessinginstruction(start) {
    // ignore as we do not have runtime handling for this, only check error
    if ((stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML) {
      emitError(
        ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
        start - 1,
      )
    }
  },
})

// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

function parseForExpression(
  input: SimpleExpressionNode,
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  const [, LHS, RHS] = inMatch

  const createAliasExpression = (
    content: string,
    offset: number,
    asParam = false,
  ) => {
    const start = loc.start.offset + offset
    const end = start + content.length
    return createExp(
      content,
      false,
      getLoc(start, end),
      ConstantTypes.NOT_CONSTANT,
      asParam ? ExpParseMode.Params : ExpParseMode.Normal,
    )
  }

  const result: ForParseResult = {
    source: createAliasExpression(RHS.trim(), exp.indexOf(RHS, LHS.length)),
    value: undefined,
    key: undefined,
    index: undefined,
    finalized: false,
  }

  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  const iteratorMatch = valueContent.match(forIteratorRE)
  if (iteratorMatch) {
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(keyContent, keyOffset, true)
    }

    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        result.index = createAliasExpression(
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length,
          ),
          true,
        )
      }
    }
  }

  if (valueContent) {
    result.value = createAliasExpression(valueContent, trimmedOffset, true)
  }

  return result
}

function getSlice(start: number, end: number) {
  return currentInput.slice(start, end)
}

function endOpenTag(end: number) {
  if (tokenizer.inSFCRoot) {
    // in SFC mode, generate locations for root-level tags' inner content.
    currentOpenTag!.innerLoc = getLoc(end + 1, end + 1)
  }
  addNode(currentOpenTag!)
  const { tag, ns } = currentOpenTag!
  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre++
  }
  if (currentOptions.isVoidTag(tag)) {
    onCloseTag(currentOpenTag!, end)
  } else {
    stack.unshift(currentOpenTag!)
    if (ns === Namespaces.SVG || ns === Namespaces.MATH_ML) {
      tokenizer.inXML = true
    }
  }
  currentOpenTag = null
}

/**
 * 处理 HTML 文本内容的解析和添加
 * @param content
 * @param start
 * @param end
 */
function onText(content: string, start: number, end: number) {
  if (__BROWSER__) {
    const tag = stack[0] && stack[0].tag
    // 检查当前标签是否不是 script 或 style 标签，且文本内容包含实体字符
    if (tag !== 'script' && tag !== 'style' && content.includes('&')) {
      // 解码实体字符
      content = currentOptions.decodeEntities!(content, false)
    }
  }
  const parent = stack[0] || currentRoot
  const lastNode = parent.children[parent.children.length - 1]
  if (lastNode && lastNode.type === NodeTypes.TEXT) {
    // merge
    lastNode.content += content
    setLocEnd(lastNode.loc, end)
  } else {
    parent.children.push({
      type: NodeTypes.TEXT,
      content,
      loc: getLoc(start, end),
    })
  }
}

function onCloseTag(el: ElementNode, end: number, isImplied = false) {
  // attach end position
  if (isImplied) {
    // implied close, end should be backtracked to close
    setLocEnd(el.loc, backTrack(end, CharCodes.Lt))
  } else {
    setLocEnd(el.loc, lookAhead(end, CharCodes.Gt) + 1)
  }

  if (tokenizer.inSFCRoot) {
    // SFC root tag, resolve inner end
    if (el.children.length) {
      el.innerLoc!.end = extend({}, el.children[el.children.length - 1].loc.end)
    } else {
      el.innerLoc!.end = extend({}, el.innerLoc!.start)
    }
    el.innerLoc!.source = getSlice(
      el.innerLoc!.start.offset,
      el.innerLoc!.end.offset,
    )
  }

  // refine element type
  const { tag, ns, children } = el
  if (!inVPre) {
    if (tag === 'slot') {
      el.tagType = ElementTypes.SLOT
    } else if (isFragmentTemplate(el)) {
      el.tagType = ElementTypes.TEMPLATE
    } else if (isComponent(el)) {
      el.tagType = ElementTypes.COMPONENT
    }
  }

  // whitespace management
  if (!tokenizer.inRCDATA) {
    el.children = condenseWhitespace(children)
  }

  if (ns === Namespaces.HTML && currentOptions.isIgnoreNewlineTag(tag)) {
    // remove leading newline for <textarea> and <pre> per html spec
    // https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-inbody
    const first = children[0]
    if (first && first.type === NodeTypes.TEXT) {
      first.content = first.content.replace(/^\r?\n/, '')
    }
  }

  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre--
  }
  if (currentVPreBoundary === el) {
    inVPre = tokenizer.inVPre = false
    currentVPreBoundary = null
  }
  if (
    tokenizer.inXML &&
    (stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML
  ) {
    tokenizer.inXML = false
  }

  // 2.x compat / deprecation checks
  if (__COMPAT__) {
    const props = el.props
    if (
      __DEV__ &&
      isCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
        currentOptions,
      )
    ) {
      let hasIf = false
      let hasFor = false
      for (let i = 0; i < props.length; i++) {
        const p = props[i]
        if (p.type === NodeTypes.DIRECTIVE) {
          if (p.name === 'if') {
            hasIf = true
          } else if (p.name === 'for') {
            hasFor = true
          }
        }
        if (hasIf && hasFor) {
          warnDeprecation(
            CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
            currentOptions,
            el.loc,
          )
          break
        }
      }
    }

    if (
      !tokenizer.inSFCRoot &&
      isCompatEnabled(
        CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
        currentOptions,
      ) &&
      el.tag === 'template' &&
      !isFragmentTemplate(el)
    ) {
      __DEV__ &&
        warnDeprecation(
          CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
          currentOptions,
          el.loc,
        )
      // unwrap
      const parent = stack[0] || currentRoot
      const index = parent.children.indexOf(el)
      parent.children.splice(index, 1, ...el.children)
    }

    const inlineTemplateProp = props.find(
      p => p.type === NodeTypes.ATTRIBUTE && p.name === 'inline-template',
    ) as AttributeNode
    if (
      inlineTemplateProp &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE,
        currentOptions,
        inlineTemplateProp.loc,
      ) &&
      el.children.length
    ) {
      inlineTemplateProp.value = {
        type: NodeTypes.TEXT,
        content: getSlice(
          el.children[0].loc.start.offset,
          el.children[el.children.length - 1].loc.end.offset,
        ),
        loc: inlineTemplateProp.loc,
      }
    }
  }
}

function lookAhead(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i < currentInput.length - 1) i++
  return i
}

function backTrack(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i >= 0) i--
  return i
}

const specialTemplateDir = new Set(['if', 'else', 'else-if', 'for', 'slot'])
function isFragmentTemplate({ tag, props }: ElementNode): boolean {
  if (tag === 'template') {
    for (let i = 0; i < props.length; i++) {
      if (
        props[i].type === NodeTypes.DIRECTIVE &&
        specialTemplateDir.has((props[i] as DirectiveNode).name)
      ) {
        return true
      }
    }
  }
  return false
}

function isComponent({ tag, props }: ElementNode): boolean {
  if (currentOptions.isCustomElement(tag)) {
    return false
  }
  if (
    tag === 'component' ||
    isUpperCase(tag.charCodeAt(0)) ||
    isCoreComponent(tag) ||
    (currentOptions.isBuiltInComponent &&
      currentOptions.isBuiltInComponent(tag)) ||
    (currentOptions.isNativeTag && !currentOptions.isNativeTag(tag))
  ) {
    return true
  }
  // at this point the tag should be a native tag, but check for potential "is"
  // casting
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.name === 'is' && p.value) {
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
          __COMPAT__ &&
          checkCompatEnabled(
            CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
            currentOptions,
            p.loc,
          )
        ) {
          return true
        }
      }
    } else if (
      __COMPAT__ &&
      // :is on plain element - only treat as component in compat mode
      p.name === 'bind' &&
      isStaticArgOf(p.arg, 'is') &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
        currentOptions,
        p.loc,
      )
    ) {
      return true
    }
  }
  return false
}

function isUpperCase(c: number) {
  return c > 64 && c < 91
}

const windowsNewlineRE = /\r\n/g
function condenseWhitespace(nodes: TemplateChildNode[]): TemplateChildNode[] {
  const shouldCondense = currentOptions.whitespace !== 'preserve'
  let removedWhitespace = false
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type === NodeTypes.TEXT) {
      if (!inPre) {
        if (isAllWhitespace(node.content)) {
          const prev = nodes[i - 1] && nodes[i - 1].type
          const next = nodes[i + 1] && nodes[i + 1].type
          // Remove if:
          // - the whitespace is the first or last node, or:
          // - (condense mode) the whitespace is between two comments, or:
          // - (condense mode) the whitespace is between comment and element, or:
          // - (condense mode) the whitespace is between two elements AND contains newline
          if (
            !prev ||
            !next ||
            (shouldCondense &&
              ((prev === NodeTypes.COMMENT &&
                (next === NodeTypes.COMMENT || next === NodeTypes.ELEMENT)) ||
                (prev === NodeTypes.ELEMENT &&
                  (next === NodeTypes.COMMENT ||
                    (next === NodeTypes.ELEMENT &&
                      hasNewlineChar(node.content))))))
          ) {
            removedWhitespace = true
            nodes[i] = null as any
          } else {
            // Otherwise, the whitespace is condensed into a single space
            node.content = ' '
          }
        } else if (shouldCondense) {
          // in condense mode, consecutive whitespaces in text are condensed
          // down to a single space.
          node.content = condense(node.content)
        }
      } else {
        // #6410 normalize windows newlines in <pre>:
        // in SSR, browsers normalize server-rendered \r\n into a single \n
        // in the DOM
        node.content = node.content.replace(windowsNewlineRE, '\n')
      }
    }
  }
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

function hasNewlineChar(str: string) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === CharCodes.NewLine || c === CharCodes.CarriageReturn) {
      return true
    }
  }
  return false
}

function condense(str: string) {
  let ret = ''
  let prevCharIsWhitespace = false
  for (let i = 0; i < str.length; i++) {
    if (isWhitespace(str.charCodeAt(i))) {
      if (!prevCharIsWhitespace) {
        ret += ' '
        prevCharIsWhitespace = true
      }
    } else {
      ret += str[i]
      prevCharIsWhitespace = false
    }
  }
  return ret
}

function addNode(node: TemplateChildNode) {
  ;(stack[0] || currentRoot).children.push(node)
}

function getLoc(start: number, end?: number): SourceLocation {
  return {
    start: tokenizer.getPos(start),
    // @ts-expect-error allow late attachment
    end: end == null ? end : tokenizer.getPos(end),
    // @ts-expect-error allow late attachment
    source: end == null ? end : getSlice(start, end),
  }
}

export function cloneLoc(loc: SourceLocation): SourceLocation {
  return getLoc(loc.start.offset, loc.end.offset)
}

function setLocEnd(loc: SourceLocation, end: number) {
  loc.end = tokenizer.getPos(end)
  loc.source = getSlice(loc.start.offset, end)
}

/**
 * 将指令节点（DirectiveNode）转换为普通属性节点（AttributeNode）
 * @param dir
 * @returns
 */
function dirToAttr(dir: DirectiveNode): AttributeNode {
  const attr: AttributeNode = {
    type: NodeTypes.ATTRIBUTE,
    name: dir.rawName!, // 使用指令的原始名称作为属性名
    nameLoc: getLoc(
      dir.loc.start.offset,
      dir.loc.start.offset + dir.rawName!.length,
    ),
    value: undefined,
    loc: dir.loc,
  }

  // 处理指令表达式
  if (dir.exp) {
    // account for quotes
    // 调整表达式的位置信息，考虑引号的影响
    const loc = dir.exp.loc
    if (loc.end.offset < dir.loc.end.offset) {
      loc.start.offset--
      loc.start.column--
      loc.end.offset++
      loc.end.column++
    }
    // 创建文本节点作为属性值，内容为表达式的内容
    attr.value = {
      type: NodeTypes.TEXT,
      content: (dir.exp as SimpleExpressionNode).content,
      loc,
    }
  }
  return attr
}

enum ExpParseMode {
  Normal,
  Params,
  Statements,
  Skip,
}

function createExp(
  content: SimpleExpressionNode['content'],
  isStatic: SimpleExpressionNode['isStatic'] = false,
  loc: SourceLocation,
  constType: ConstantTypes = ConstantTypes.NOT_CONSTANT,
  parseMode = ExpParseMode.Normal,
) {
  const exp = createSimpleExpression(content, isStatic, loc, constType)
  if (
    !__BROWSER__ &&
    !isStatic &&
    currentOptions.prefixIdentifiers &&
    parseMode !== ExpParseMode.Skip &&
    content.trim()
  ) {
    if (isSimpleIdentifier(content)) {
      exp.ast = null // fast path
      return exp
    }
    try {
      const plugins = currentOptions.expressionPlugins
      const options: BabelOptions = {
        plugins: plugins ? [...plugins, 'typescript'] : ['typescript'],
      }
      if (parseMode === ExpParseMode.Statements) {
        // v-on with multi-inline-statements, pad 1 char
        exp.ast = parse(` ${content} `, options).program
      } else if (parseMode === ExpParseMode.Params) {
        exp.ast = parseExpression(`(${content})=>{}`, options)
      } else {
        // normal exp, wrap with parens
        exp.ast = parseExpression(`(${content})`, options)
      }
    } catch (e: any) {
      exp.ast = false // indicate an error
      emitError(ErrorCodes.X_INVALID_EXPRESSION, loc.start.offset, e.message)
    }
  }
  return exp
}

function emitError(code: ErrorCodes, index: number, message?: string) {
  currentOptions.onError(
    createCompilerError(code, getLoc(index, index), undefined, message),
  )
}

function reset() {
  tokenizer.reset()
  currentOpenTag = null
  currentProp = null
  currentAttrValue = ''
  currentAttrStartIndex = -1
  currentAttrEndIndex = -1
  stack.length = 0
}

/**
 * 解析 HTML 字符串为 AST
 * @param input 要解析的 HTML 字符串
 * @param options 解析选项
 * @returns AST 节点
 */
export function baseParse(input: string, options?: ParserOptions): RootNode {
  reset() // 重置解析器的内部状态，确保每次解析都是从干净的状态开始
  currentInput = input
  currentOptions = extend({}, defaultParserOptions)

  if (options) {
    let key: keyof ParserOptions
    for (key in options) {
      if (options[key] != null) {
        // @ts-expect-error
        // 应用用户提供的选项，覆盖默认值
        currentOptions[key] = options[key]
      }
    }
  }

  if (__DEV__) {
    if (!__BROWSER__ && currentOptions.decodeEntities) {
      // 在非浏览器环境中，decodeEntities 选项会被忽略
      console.warn(
        `[@vue/compiler-core] decodeEntities option is passed but will be ` +
          `ignored in non-browser builds.`,
      )
    } else if (__BROWSER__ && !__TEST__ && !currentOptions.decodeEntities) {
      // 在浏览器环境中，decodeEntities 选项是必需的
      throw new Error(
        `[@vue/compiler-core] decodeEntities option is required in browser builds.`,
      )
    }
  }

  // 设置词法分析器的解析模式（HTML、SFC 或 BASE
  tokenizer.mode =
    currentOptions.parseMode === 'html'
      ? ParseMode.HTML
      : currentOptions.parseMode === 'sfc'
        ? ParseMode.SFC
        : ParseMode.BASE

  // 设置是否在 XML 模式下解析（SVG 或 MathML 命名空间）
  tokenizer.inXML =
    currentOptions.ns === Namespaces.SVG ||
    currentOptions.ns === Namespaces.MATH_ML

  // 配置自定义分隔符（如果提供）
  const delimiters = options && options.delimiters
  if (delimiters) {
    tokenizer.delimiterOpen = toCharCodes(delimiters[0])
    tokenizer.delimiterClose = toCharCodes(delimiters[1])
  }

  // 创建根节点并存储为当前根节点
  const root = (currentRoot = createRoot([], input))

  // 调用词法分析器解析输入字符串，生成 AST
  tokenizer.parse(currentInput)
  root.loc = getLoc(0, input.length) // 设置根节点的位置信息

  // 处理根节点子节点中的空白字符，优化 AST 结构
  root.children = condenseWhitespace(root.children)
  currentRoot = null // 清理当前根节点引用
  return root
}
