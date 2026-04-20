import { NOOP, hyphenate, isArray, isFunction } from '@vue/shared'
import {
  type ComponentInternalInstance,
  ErrorCodes,
  callWithAsyncErrorHandling,
  warn,
} from '@vue/runtime-core'

interface Invoker extends EventListener {
  value: EventValue
  attached: number
}

type EventValue = Function | Function[]

export function addEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions,
): void {
  el.addEventListener(event, handler, options)
}

export function removeEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions,
): void {
  el.removeEventListener(event, handler, options)
}

const veiKey: unique symbol = Symbol('_vei')

/**
 * 管理 DOM 元素的事件监听器。它负责处理事件监听器的添加、更新和移除
 * @param el DOM 元素，带有 veiKey 属性用于存储事件调用器
 * @param rawName 原始事件名称，如 onClick
 * @param prevValue 之前的事件处理函数
 * @param nextValue 新的事件处理函数
 * @param instance 组件内部实例，用于错误处理
 */
export function patchEvent(
  el: Element & { [veiKey]?: Record<string, Invoker | undefined> },
  rawName: string,
  prevValue: EventValue | null,
  nextValue: EventValue | unknown,
  instance: ComponentInternalInstance | null = null,
): void {
  // vei = vue event invokers
  // 获取或创建调用器存储：在元素上获取或创建 veiKey 属性，用于存储事件调用器
  const invokers = el[veiKey] || (el[veiKey] = {})
  const existingInvoker = invokers[rawName] // 获取现有的事件调用器

  // 更新现有事件处理函数
  if (nextValue && existingInvoker) {
    // patch
    existingInvoker.value = __DEV__
      ? sanitizeEventValue(nextValue, rawName)
      : (nextValue as EventValue)
  } else {
    // 使用 parseName 解析原始事件名称，获取事件名和选项对象
    const [name, options] = parseName(rawName)
    if (nextValue) {
      // add
      const invoker = (invokers[rawName] = createInvoker(
        __DEV__
          ? sanitizeEventValue(nextValue, rawName)
          : (nextValue as EventValue),
        instance,
      ))
      addEventListener(el, name, invoker, options)
    } else if (existingInvoker) {
      // remove
      removeEventListener(el, name, existingInvoker, options)
      invokers[rawName] = undefined
    }
  }
}

const optionsModifierRE = /(?:Once|Passive|Capture)$/

/**
 * 解析 Vue 模板中的事件名称，将其转换为浏览器原生的事件名称和事件监听器选项
 * @param name Vue 模板中的事件名称，如 onClick、onKeyDown:prevent 等
 * @returns
 */
function parseName(name: string): [string, EventListenerOptions | undefined] {
  let options: EventListenerOptions | undefined
  if (optionsModifierRE.test(name)) {
    options = {}
    let m
    while ((m = name.match(optionsModifierRE))) {
      // 移除选项修饰符，如 Once、Passive、Capture 等
      name = name.slice(0, name.length - m[0].length)
      // 将选项修饰符转换为小写并添加到选项对象中
      ;(options as any)[m[0].toLowerCase()] = true
    }
  }
  // 获取事件名称
  const event = name[2] === ':' ? name.slice(3) : hyphenate(name.slice(2))
  return [event, options]
}

// To avoid the overhead of repeatedly calling Date.now(), we cache
// and use the same timestamp for all event listeners attached in the same tick.
let cachedNow: number = 0
const p = /*@__PURE__*/ Promise.resolve()
const getNow = () =>
  cachedNow || (p.then(() => (cachedNow = 0)), (cachedNow = Date.now()))

/**
 * 创建事件处理器的调用器
 * @param initialValue 事件处理函数的值
 * @param instance 组件内部实例，用于错误处理
 * @returns
 */
function createInvoker(
  initialValue: EventValue,
  instance: ComponentInternalInstance | null,
) {
  const invoker: Invoker = (e: Event & { _vts?: number }) => {
    // async edge case vuejs/vue#6566
    // inner click event triggers patch, event handler
    // attached to outer element during patch, and triggered again. This
    // happens because browsers fire microtask ticks between event propagation.
    // this no longer happens for templates in Vue 3, but could still be
    // theoretically possible for hand-written render functions.
    // the solution: we save the timestamp when a handler is attached,
    // and also attach the timestamp to any event that was handled by vue
    // for the first time (to avoid inconsistent event timestamp implementations
    // or events fired from iframes, e.g. #2513)
    // The handler would only fire if the event passed to it was fired
    // AFTER it was attached.
    if (!e._vts) {
      // 事件对象没有 _vts（Vue 时间戳）属性，设置
      e._vts = Date.now()
    } else if (e._vts <= invoker.attached) {
      // 时间戳早于或等于调用器的附加时间
      return
    }
    // 包装事件处理函数的执行
    callWithAsyncErrorHandling(
      // 处理事件的立即停止传播
      patchStopImmediatePropagation(e, invoker.value),
      instance,
      ErrorCodes.NATIVE_EVENT_HANDLER,
      [e],
    )
  }
  invoker.value = initialValue // 设置初始值
  invoker.attached = getNow() // 设置附加时间
  return invoker
}

function sanitizeEventValue(value: unknown, propName: string): EventValue {
  if (isFunction(value) || isArray(value)) {
    return value as EventValue
  }
  warn(
    `Wrong type passed as event handler to ${propName} - did you forget @ or : ` +
      `in front of your prop?\nExpected function or array of functions, received type ${typeof value}.`,
  )
  return NOOP
}

function patchStopImmediatePropagation(
  e: Event,
  value: EventValue,
): EventValue {
  if (isArray(value)) {
    // 保存原生的立即停止事件传播方法
    const originalStop = e.stopImmediatePropagation

    // 重写 stopImmediatePropagation 方法，添加停止传播的标志
    e.stopImmediatePropagation = () => {
      originalStop.call(e) // 调用原生的立即停止事件传播方法
      ;(e as any)._stopped = true // 标记事件已停止传播
    }
    return (value as Function[]).map(
      // 对每个事件处理函数进行包装，检查 _stopped 标志，只有当未停止时才执行
      fn => (e: Event) => !(e as any)._stopped && fn && fn(e),
    )
  } else {
    return value
  }
}
