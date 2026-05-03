import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

// 识别 JavaScript 内置 Symbol 属性的常量集合
const builtInSymbols = new Set(
  /*@__PURE__*/
  // 获取 Symbol 构造函数的所有可枚举属性名
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    // 过滤出真正的 Symbol 类型
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

// 基础响应式处理函数，其实就是proxy的处理函数
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false, // 标识是否只读的
    protected readonly _isShallow = false, // 标识是否浅层处理模式
  ) {}

  get(target: Target, key: string | symbol, receiver: object): any {
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly,
      isShallow = this._isShallow

    // 一. 特殊标志处理
    if (key === ReactiveFlags.IS_REACTIVE) {
      // 只有非只读的代理才是响应式的
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      // 返回是否只读的
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      // 返回是否浅层的
      return isShallow
    } else if (key === ReactiveFlags.RAW) {
      // 从响应式代理对象中安全地获取原始对象
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap // 存储浅层只读响应式对象的映射
              : readonlyMap // 存储只读响应式对象的映射
            : isShallow
              ? shallowReactiveMap // 存储浅层响应式对象的映射
              : reactiveMap
          ) // 存储普通响应式对象的映射
            .get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the receiver is a user proxy of the reactive proxy
        // 检查 target 和 receiver 的原型是否相同
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      return
    }

    // 二. 数组和特殊方法处理
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      let fn: Function | undefined
      // arrayInstrumentations 是一个对象，存储了被 Vue 重写的数组方法
      // 当访问数组的这些方法时，返回重写后的版本，而不是原生方法
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn // 找到重写后的数组方法，直接返回
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    // 三. 使用 Reflect.get：安全地获取属性值
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      isRef(target) ? target : receiver,
    )
    // 四. 内置符号和不可追踪键处理
    // 内置符号：对于内置符号，直接返回结果
    // 不可追踪键：对于不可追踪的键（如 __proto__、__v_isRef 等），直接返回结果
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    if (isShallow) {
      return res
    }
    // Ref 解包：自动解包 Ref 对象的值
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      const value = targetIsArray && isIntegerKey(key) ? res : res.value
      return isReadonly && isObject(value) ? readonly(value) : value
    }
    // 深度响应式转换：如果是对象，递归转换为响应式代理
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

// 可变响应式处理函数，其实就是proxy的处理函数
class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  /**
   * 拦截对象属性的设置操作（即 obj[key] = value）
   * @param target
   * @param key
   * @param value
   * @param receiver
   * @returns
   */
  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = target[key]

    // 是否数组操作且键为整数
    const isArrayWithIntegerKey = isArray(target) && isIntegerKey(key)

    // 非浅层
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly(oldValue) // 旧值是否只读
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue) // 将旧值转为原始值
        value = toRaw(value) // 将新值转为原始值
      }

      // 非数组、旧值是响应式 Ref、新值不是响应式 Ref
      if (!isArrayWithIntegerKey && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          if (__DEV__) {
            // 如果旧值是只读的，发出警告并返回（不允许修改）
            warn(
              `Set operation on key "${String(key)}" failed: target is readonly.`,
              target[key],
            )
          }
          return true
        } else {
          // 直接修改 ref.value，触发响应式更新
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 判断属性是否已存在
    // 对于数组：检查索引是否小于数组长度（判断是否是新增元素）
    const hadKey = isArrayWithIntegerKey
      ? Number(key) < target.length
      : hasOwn(target, key)

    const result = Reflect.set(
      target,
      key,
      value,
      isRef(target) ? target : receiver,
    )
    // don't trigger if target is something up in the prototype chain of original
    // 确保只在目标对象本身上设置属性时才触发更新（避免原型链上的属性设置触发更新）
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 新增属性
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 属性值改变
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      // 删除属性
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      // 追踪依赖
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    // 追踪依赖
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

// 只读响应式处理函数，其实就是proxy的处理函数
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    // 只读响应式处理函数，不能设置属性
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    // 只读响应式处理函数，不能删除属性
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler() // 非浅层的

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true) // 浅层的
