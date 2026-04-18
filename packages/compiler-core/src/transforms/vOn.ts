import type { DirectiveTransform, DirectiveTransformResult } from '../transform'
import {
  type DirectiveNode,
  ElementTypes,
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
} from '../ast'
import { camelize, toHandlerKey } from '@vue/shared'
import { ErrorCodes, createCompilerError } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { hasScopeRef, isFnExpression, isMemberExpression } from '../utils'
import { TO_HANDLER_KEY } from '../runtimeHelpers'

export interface VOnDirectiveNode extends DirectiveNode {
  // v-on without arg is handled directly in ./transformElement.ts due to its affecting
  // codegen for the entire props object. This transform here is only for v-on
  // *with* args.
  arg: ExpressionNode
  // exp is guaranteed to be a simple expression here because v-on w/ arg is
  // skipped by transformExpression as a special case.
  exp: SimpleExpressionNode | undefined
}

/**
 * 处理 v-on 指令
 * @param dir v-on 指令的 AST 节点
 * @param node 当前元素节点的 AST
 * @param context 编译上下文
 * @param augmentor 可选的增强器函数
 * @returns
 */
export const transformOn: DirectiveTransform = (
  dir,
  node,
  context,
  augmentor,
) => {
  const { loc, modifiers, arg } = dir as VOnDirectiveNode

  // 如果 v-on 既没有表达式，也没有任何修饰符（例如 <button @click></button>），则报错
  if (!dir.exp && !modifiers.length) {
    context.onError(createCompilerError(ErrorCodes.X_V_ON_NO_EXPRESSION, loc))
  }
  let eventName: ExpressionNode

  // 构建运行时事件名 eventName
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    if (arg.isStatic) {
      let rawName = arg.content // 从指令参数中获取原始事件名称

      // 在开发模式下，检查是否以 vnode 开头，如果是则报错（vnode 钩子已被弃用）
      if (__DEV__ && rawName.startsWith('vnode')) {
        context.onError(createCompilerError(ErrorCodes.X_VNODE_HOOKS, arg.loc))
      }

      // Vue 命名空间转换：如果事件名以 vue: 开头，转换为 vnode- 前缀形式
      if (rawName.startsWith('vue:')) {
        rawName = `vnode-${rawName.slice(4)}`
      }
      const eventString =
        // 不是元素节点（如组件）
        node.tagType !== ElementTypes.ELEMENT ||
        // 事件名以 vnode 开头
        rawName.startsWith('vnode') ||
        // 事件名不包含大写字母
        !/[A-Z]/.test(rawName)
          ? // for non-element and vnode lifecycle event listeners, auto convert
            // it to camelCase. See issue #2249
            // 将事件名转换为驼峰式并添加 on 前缀（如 click → onClick）
            toHandlerKey(camelize(rawName))
          : // preserve case for plain element listeners that have uppercase
            // letters, as these may be custom elements' custom events
            // 对于普通元素且包含大写字母的事件名，保留原始大小写，添加 on: 前缀（如 MyEvent → on:MyEvent）
            `on:${rawName}`
      // 创建一个静态表达式节点作为事件名
      eventName = createSimpleExpression(eventString, true, arg.loc)
    } else {
      // #2388
      // 创建复合表达式节点
      // 当事件名是动态的，编译器无法在编译时确定事件名，只能在运行时根据事件名动态绑定事件
      eventName = createCompoundExpression([
        `${context.helperString(TO_HANDLER_KEY)}(`,
        arg,
        `)`,
      ])
    }
  } else {
    // already a compound expression.
    eventName = arg
    eventName.children.unshift(`${context.helperString(TO_HANDLER_KEY)}(`)
    eventName.children.push(`)`)
  }

  // 处理事件处理器表达式 exp
  // handler processing
  let exp: ExpressionNode | undefined = dir.exp as
    | SimpleExpressionNode
    | undefined
  if (exp && !exp.content.trim()) {
    exp = undefined
  }
  // context.cacheHandler,全局缓存开关，由编译器选项控制
  let shouldCache: boolean = context.cacheHandlers && !exp && !context.inVOnce
  if (exp) {
    // 判断表达式是否是成员表达式
    const isMemberExp = isMemberExpression(exp, context)
    // 判断表达式是否是内联语句（既不是成员表达式也不是函数表达式）
    const isInlineStatement = !(isMemberExp || isFnExpression(exp, context))
    // 判断表达式是否包含多个语句（通过检查是否有分号）
    const hasMultipleStatements = exp.content.includes(`;`)

    // process the expression since it's been skipped
    // 非浏览器环境，启用标识符前缀
    if (!__BROWSER__ && context.prefixIdentifiers) {
      // 对于内联语句，临时添加 $event 到作用域中
      isInlineStatement && context.addIdentifiers(`$event`)

      // 处理表达式后，再移除 $event
      exp = dir.exp = processExpression(
        exp,
        context,
        false,
        hasMultipleStatements,
      )
      isInlineStatement && context.removeIdentifiers(`$event`)
      // with scope analysis, the function is hoistable if it has no reference
      // to scope variables.
      shouldCache =
        context.cacheHandlers && // 全局缓存开关
        // unnecessary to cache inside v-once
        // 不在 v-once 内
        !context.inVOnce &&
        // runtime constants don't need to be cached
        // (this is analyzed by compileScript in SFC <script setup>)
        // 非运行时常量
        !(exp.type === NodeTypes.SIMPLE_EXPRESSION && exp.constType > 0) &&
        // #1541 bail if this is a member exp handler passed to a component -
        // we need to use the original function to preserve arity,
        // e.g. <transition> relies on checking cb.length to determine
        // transition end handling. Inline function is ok since its arity
        // is preserved even when cached.
        // 非组件成员表达式
        !(isMemberExp && node.tagType === ElementTypes.COMPONENT) &&
        // bail if the function references closure variables (v-for, v-slot)
        // it must be passed fresh to avoid stale values.
        // 无作用域引用
        !hasScopeRef(exp, context.identifiers)
      // If the expression is optimizable and is a member expression pointing
      // to a function, turn it into invocation (and wrap in an arrow function
      // below) so that it always accesses the latest value when called - thus
      // avoiding the need to be patched.
      if (shouldCache && isMemberExp) {
        if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          // 单表达式：obj.method → obj.method && obj.method(...args)
          exp.content = `${exp.content} && ${exp.content}(...args)`
        } else {
          exp.children = [...exp.children, ` && `, ...exp.children, `(...args)`]
        }
      }
    }

    // 在开发模式且浏览器环境下验证事件处理器表达式的有效性
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        exp as SimpleExpressionNode,
        context,
        false,
        hasMultipleStatements,
      )
    }

    // 将内联语句或需要缓存的成员表达式包装成函数表达式
    if (isInlineStatement || (shouldCache && isMemberExp)) {
      // wrap inline statement in a function expression
      exp = createCompoundExpression([
        `${
          isInlineStatement
            ? !__BROWSER__ && context.isTS
              ? `($event: any)`
              : `$event`
            : `${
                // TypeScript 环境：添加 //@ts-ignore 注释（避免类型检查错误）
                !__BROWSER__ && context.isTS ? `\n//@ts-ignore\n` : ``
              }(...args)` // 所有环境：(...args)（接收任意参数）

          // 多语句：使用大括号 {} 包裹，（如 { count++; console.log(count); }）
          // 单语句：使用小括号 () 包裹（如 (count++)）
        } => ${hasMultipleStatements ? `{` : `(`}`,
        exp,
        hasMultipleStatements ? `}` : `)`,
      ])
    }
  }

  // 生成转换结果
  let ret: DirectiveTransformResult = {
    props: [
      // { type, key, value ,loc}
      createObjectProperty(
        eventName,
        exp || createSimpleExpression(`() => {}`, false, loc),
      ),
    ],
  }

  // 应用增强器与缓存
  // apply extended compiler augmentor
  if (augmentor) {
    ret = augmentor(ret)
  }

  if (shouldCache) {
    // cache handlers so that it's always the same handler being passed down.
    // this avoids unnecessary re-renders when users use inline handlers on
    // components.
    ret.props[0].value = context.cache(ret.props[0].value)
  }

  // mark the key as handler for props normalization check
  // 标记为事件处理器
  ret.props.forEach(p => (p.key.isHandlerKey = true))
  return ret
}
