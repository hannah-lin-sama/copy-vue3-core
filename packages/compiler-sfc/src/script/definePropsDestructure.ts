import type {
  BlockStatement,
  Expression,
  Identifier,
  Node,
  ObjectPattern,
  Program,
  VariableDeclaration,
} from '@babel/types'
import { walk } from 'estree-walker'
import {
  BindingTypes,
  TS_NODE_TYPES,
  extractIdentifiers,
  isFunctionType,
  isInDestructureAssignment,
  isReferencedIdentifier,
  isStaticProperty,
  unwrapTSNode,
  walkFunctionParams,
} from '@vue/compiler-dom'
import { genPropsAccessExp } from '@vue/shared'
import { isCallOf, resolveObjectKey } from './utils'
import type { ScriptCompileContext } from './context'
import { DEFINE_PROPS } from './defineProps'

/**
 * 处理 defineProps 解构
 * @param ctx
 * @param declId
 * @returns
 */
export function processPropsDestructure(
  ctx: ScriptCompileContext,
  declId: ObjectPattern,
): void {
  if (ctx.options.propsDestructure === 'error') {
    // 如果禁止且设置为 'error'，抛出错误
    ctx.error(`Props destructure is explicitly prohibited via config.`, declId)
  } else if (ctx.options.propsDestructure === false) {
    return
  }

  // 解构声明
  ctx.propsDestructureDecl = declId

  // 注册绑定
  const registerBinding = (
    key: string, // 键值
    local: string, // 本地名称
    defaultValue?: Expression,
  ) => {
    ctx.propsDestructuredBindings[key] = { local, default: defaultValue }

    // 当解构时使用了重命名（如 { foo: myFoo }），local 与 key 不同
    if (local !== key) {
      // 将本地变量名 myFoo 标记为 PROPS_ALIASED，表示它是一个 prop 的别名
      ctx.bindingMetadata[local] = BindingTypes.PROPS_ALIASED

      /**
       * 为什么需要 __propsAliases 映射？
        1、模板编译优化：当模板中使用 myFoo 时，编译器需要知道它实际是 props.foo，以便正确生成渲染函数代码。
        2、响应式追踪：确保别名变量也能正确追踪 prop 的变化（因为最终访问的是同一个 prop）。
        3、类型推导：在 TypeScript 环境下，维护映射有助于保持类型安全。 
       */
      // 建立反向映射：在 __propsAliases 对象中记录 myFoo → 'foo'
      ;(ctx.bindingMetadata.__propsAliases ||
        (ctx.bindingMetadata.__propsAliases = {}))[local] = key
    }
  }

  // 遍历对象的属性
  for (const prop of declId.properties) {
    // 普通属性
    if (prop.type === 'ObjectProperty') {
      // 获取属性键（支持计算属性）
      const propKey = resolveObjectKey(prop.key, prop.computed)

      // 不支持计算属性键
      if (!propKey) {
        ctx.error(
          `${DEFINE_PROPS}() destructure cannot use computed key.`,
          prop.key,
        )
      }

      // 处理默认值
      if (prop.value.type === 'AssignmentPattern') {
        // default value { foo = 123 }
        const { left, right } = prop.value
        // 不支持嵌套模式
        if (left.type !== 'Identifier') {
          ctx.error(
            `${DEFINE_PROPS}() destructure does not support nested patterns.`,
            left,
          )
        }
        registerBinding(propKey, left.name, right)

        // 处理简单解构
      } else if (prop.value.type === 'Identifier') {
        // simple destructure
        registerBinding(propKey, prop.value.name)
      } else {
        ctx.error(
          `${DEFINE_PROPS}() destructure does not support nested patterns.`,
          prop.value,
        )
      }

      // 剩余参数
    } else {
      // rest spread
      // 获取该标识符的名称字符串（例如 ...reset 那么name便是 reset）
      ctx.propsDestructureRestId = (prop.argument as Identifier).name
      // register binding
      // 绑定响应常量，便于在模板中使用
      ctx.bindingMetadata[ctx.propsDestructureRestId] =
        BindingTypes.SETUP_REACTIVE_CONST
    }
  }
}

/**
 * true -> prop binding
 * false -> local binding
 * 用于转换 <script setup> 中解构的 props
 */
type Scope = Record<string, boolean>

export function transformDestructuredProps(
  ctx: ScriptCompileContext,
  vueImportAliases: Record<string, string>,
): void {
  // 如果禁止解构，直接返回
  if (ctx.options.propsDestructure === false) {
    return
  }

  const rootScope: Scope = Object.create(null) // 根作用域
  const scopeStack: Scope[] = [rootScope] // 作用域栈
  let currentScope: Scope = rootScope // 当前作用域
  // 排除的标识符
  const excludedIds = new WeakSet<Identifier>()
  const parentStack: Node[] = [] // 父节点栈
  // 本地绑定到公有props的映射
  const propsLocalToPublicMap: Record<string, string> = Object.create(null)

  for (const key in ctx.propsDestructuredBindings) {
    const { local } = ctx.propsDestructuredBindings[key]
    rootScope[local] = true
    propsLocalToPublicMap[local] = key
  }

  /**
   * 推送作用域到栈
   */
  function pushScope() {
    scopeStack.push((currentScope = Object.create(currentScope)))
  }

  /**
   * 弹出作用域栈
   */
  function popScope() {
    scopeStack.pop()
    currentScope = scopeStack[scopeStack.length - 1] || null
  }

  /**
   * 注册本地绑定
   * @param id 本地绑定的标识符
   */
  function registerLocalBinding(id: Identifier) {
    excludedIds.add(id)
    if (currentScope) {
      currentScope[id.name] = false
    } else {
      ctx.error(
        'registerBinding called without active scope, something is wrong.',
        id,
      )
    }
  }

  /**
   * 遍历作用域
   * @param node 节点
   * @param isRoot 是否是根节点
   */
  function walkScope(node: Program | BlockStatement, isRoot = false) {
    for (const stmt of node.body) {
      // 处理变量声明
      if (stmt.type === 'VariableDeclaration') {
        walkVariableDeclaration(stmt, isRoot)

        // 处理函数声明和类声明
      } else if (
        stmt.type === 'FunctionDeclaration' ||
        stmt.type === 'ClassDeclaration'
      ) {
        // 声明语句或没有id
        if (stmt.declare || !stmt.id) continue
        registerLocalBinding(stmt.id)

        // 处理导出命名声明
      } else if (
        stmt.type === 'ExportNamedDeclaration' &&
        stmt.declaration &&
        stmt.declaration.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.declaration, isRoot)

        // 处理标签语句、
      } else if (
        stmt.type === 'LabeledStatement' &&
        stmt.body.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.body, isRoot)
      }
    }
  }

  /**
   * 遍历变量声明
   * @param stmt 变量声明
   * @param isRoot 是否是根节点
   */
  function walkVariableDeclaration(stmt: VariableDeclaration, isRoot = false) {
    if (stmt.declare) {
      return
    }
    for (const decl of stmt.declarations) {
      const isDefineProps =
        isRoot && decl.init && isCallOf(unwrapTSNode(decl.init), 'defineProps')
      for (const id of extractIdentifiers(decl.id)) {
        if (isDefineProps) {
          // for defineProps destructure, only exclude them since they
          // are already passed in as knownProps
          excludedIds.add(id)
        } else {
          registerLocalBinding(id)
        }
      }
    }
  }

  /**
   * 重写标识符
   * @param id 标识符
   * @param parent id 标识符的父节点
   * @param parentStack 父节点栈
   * @param parentStack 父节点栈
   */
  function rewriteId(id: Identifier, parent: Node, parentStack: Node[]) {
    if (
      (parent.type === 'AssignmentExpression' && id === parent.left) ||
      parent.type === 'UpdateExpression'
    ) {
      ctx.error(`Cannot assign to destructured props as they are readonly.`, id)
    }

    if (isStaticProperty(parent) && parent.shorthand) {
      // let binding used in a property shorthand
      // skip for destructure patterns
      if (
        !(parent as any).inPattern ||
        isInDestructureAssignment(parent, parentStack)
      ) {
        // { prop } -> { prop: __props.prop }
        ctx.s.appendLeft(
          id.end! + ctx.startOffset!,
          `: ${genPropsAccessExp(propsLocalToPublicMap[id.name])}`,
        )
      }
    } else {
      // x --> __props.x
      ctx.s.overwrite(
        id.start! + ctx.startOffset!,
        id.end! + ctx.startOffset!,
        genPropsAccessExp(propsLocalToPublicMap[id.name]),
      )
    }
  }

  /**
   * 检查使用
   * @param node 节点
   * @param method 方法名
   * @param alias 别名
   */
  function checkUsage(node: Node, method: string, alias = method) {
    if (isCallOf(node, alias)) {
      const arg = unwrapTSNode(node.arguments[0])
      if (arg.type === 'Identifier' && currentScope[arg.name]) {
        ctx.error(
          `"${arg.name}" is a destructured prop and should not be passed directly to ${method}(). ` +
            `Pass a getter () => ${arg.name} instead.`,
          arg,
        )
      }
    }
  }

  // check root scope first
  const ast = ctx.scriptSetupAst!
  walkScope(ast, true)
  walk(ast, {
    enter(node: Node, parent: Node | null) {
      parent && parentStack.push(parent)

      // skip type nodes
      if (
        parent &&
        parent.type.startsWith('TS') &&
        !TS_NODE_TYPES.includes(parent.type)
      ) {
        return this.skip()
      }

      checkUsage(node, 'watch', vueImportAliases.watch)
      checkUsage(node, 'toRef', vueImportAliases.toRef)

      // function scopes
      if (isFunctionType(node)) {
        pushScope()
        walkFunctionParams(node, registerLocalBinding)
        if (node.body.type === 'BlockStatement') {
          walkScope(node.body)
        }
        return
      }

      // catch param
      if (node.type === 'CatchClause') {
        pushScope()
        if (node.param && node.param.type === 'Identifier') {
          registerLocalBinding(node.param)
        }
        walkScope(node.body)
        return
      }

      // for loops: loop variable should be scoped to the loop
      if (
        node.type === 'ForOfStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'ForStatement'
      ) {
        pushScope()
        const varDecl = node.type === 'ForStatement' ? node.init : node.left
        if (varDecl && varDecl.type === 'VariableDeclaration') {
          walkVariableDeclaration(varDecl)
        }
        if (node.body.type === 'BlockStatement') {
          walkScope(node.body)
        }
        return
      }

      // non-function block scopes
      if (node.type === 'BlockStatement' && !isFunctionType(parent!)) {
        pushScope()
        walkScope(node)
        return
      }

      if (node.type === 'Identifier') {
        if (
          isReferencedIdentifier(node, parent!, parentStack) &&
          !excludedIds.has(node)
        ) {
          if (currentScope[node.name]) {
            rewriteId(node, parent!, parentStack)
          }
        }
      }
    },
    leave(node: Node, parent: Node | null) {
      parent && parentStack.pop()
      if (
        (node.type === 'BlockStatement' && !isFunctionType(parent!)) ||
        isFunctionType(node) ||
        node.type === 'CatchClause' ||
        node.type === 'ForOfStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'ForStatement'
      ) {
        popScope()
      }
    },
  })
}
