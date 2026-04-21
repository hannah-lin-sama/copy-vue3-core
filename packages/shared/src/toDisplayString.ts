// enums are compiled away via custom transform so no real dependency here
import { ReactiveFlags } from '@vue/reactivity'
import {
  isArray,
  isFunction,
  isMap,
  isObject,
  isPlainObject,
  isSet,
  isString,
  isSymbol,
  objectToString,
} from './general'

// can't use isRef here since @vue/shared has no deps
const isRef = (val: any): val is { value: unknown } => {
  return !!(val && val[ReactiveFlags.IS_REF] === true)
}

/**
 * For converting {{ interpolation }} values to displayed strings.
 * @private
 */
export const toDisplayString = (val: unknown): string => {
  return isString(val)
    ? val
    : val == null
      ? ''
      : isArray(val) ||
          (isObject(val) &&
            (val.toString === objectToString || !isFunction(val.toString)))
        ? isRef(val) // 递归处理其 value 属性
          ? toDisplayString(val.value)
          : // 使用 JSON.stringify 转换，带有 replacer 和 2 个空格的缩进
            JSON.stringify(val, replacer, 2)
        : String(val)
}

const replacer = (_key: string, val: unknown): any => {
  if (isRef(val)) {
    return replacer(_key, val.value)
  } else if (isMap(val)) {
    return {
      // 键名为 Map(size)，其中 size 是 Map 的大小
      [`Map(${val.size})`]: [...val.entries()].reduce(
        (entries, [key, val], i) => {
          // 键名格式为 key =>，其中 key 是经过 stringifySymbol 处理的键
          entries[stringifySymbol(key, i) + ' =>'] = val
          return entries
        },
        {} as Record<string, any>,
      ),
    }
  } else if (isSet(val)) {
    return {
      // 键名为 Set(size)，其中 size 是 Set 的大小
      [`Set(${val.size})`]: [...val.values()].map(v => stringifySymbol(v)),
    }
  } else if (isSymbol(val)) {
    return stringifySymbol(val)
  } else if (isObject(val) && !isArray(val) && !isPlainObject(val)) {
    // native elements
    return String(val)
  }
  return val
}

const stringifySymbol = (v: unknown, i: number | string = ''): any =>
  // Symbol.description in es2019+ so we need to cast here to pass
  // the lib: es2016 check
  //  Symbol.description 是 ES2019+ 的特性
  // 如果是 Symbol，获取其 description 属性，否则使用 i 作为默认值
  isSymbol(v) ? `Symbol(${(v as any).description ?? i})` : v
