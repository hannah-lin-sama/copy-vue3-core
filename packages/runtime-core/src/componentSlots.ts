import { type ComponentInternalInstance, currentInstance } from './component'
import {
  type VNode,
  type VNodeChild,
  type VNodeNormalizedChildren,
  normalizeVNode,
} from './vnode'
import {
  EMPTY_OBJ,
  type IfAny,
  type Prettify,
  ShapeFlags,
  SlotFlags,
  def,
  isArray,
  isFunction,
} from '@vue/shared'
import { warn } from './warning'
import { isKeepAlive } from './components/KeepAlive'
import {
  type ContextualRenderFn,
  currentRenderingInstance,
  withCtx,
} from './componentRenderContext'
import { isHmrUpdating } from './hmr'
import { DeprecationTypes, isCompatEnabled } from './compat/compatConfig'
import { TriggerOpTypes, trigger } from '@vue/reactivity'
import { createInternalObject } from './internalObject'

export type Slot<T extends any = any> = (
  ...args: IfAny<T, any[], [T] | (T extends undefined ? [] : never)>
) => VNode[]

export type InternalSlots = {
  [name: string]: Slot | undefined
}

export type Slots = Readonly<InternalSlots>

declare const SlotSymbol: unique symbol
export type SlotsType<T extends Record<string, any> = Record<string, any>> = {
  [SlotSymbol]?: T
}

export type StrictUnwrapSlotsType<
  S extends SlotsType,
  T = NonNullable<S[typeof SlotSymbol]>,
> = [keyof S] extends [never] ? Slots : Readonly<T> & T

export type UnwrapSlotsType<
  S extends SlotsType,
  T = NonNullable<S[typeof SlotSymbol]>,
> = [keyof S] extends [never]
  ? Slots
  : Readonly<
      Prettify<{
        [K in keyof T]: NonNullable<T[K]> extends (...args: any[]) => any
          ? T[K]
          : Slot<T[K]>
      }>
    >

export type RawSlots = {
  // 允许插槽对象包含任意名称的插槽
  // 支持命名插槽，如 default、header、footer 等
  [name: string]: unknown
  // manual render fn hint to skip forced children updates
  // 手动渲染函数的提示，用于跳过强制子节点更新
  // 使用场景：当开发者手动编写渲染函数时，可通过设置此属性告诉 Vue 插槽内容是稳定的，不需要每次都更新，从而优化性能
  $stable?: boolean
  /**
   * for tracking slot owner instance. This is attached during
   * normalizeChildren when the component vnode is created.
   * 跟踪插槽的所有者实例
   * @internal
   */
  _ctx?: ComponentInternalInstance | null
  /**
   * indicates compiler generated slots
   * we use a reserved property instead of a vnode patchFlag because the slots
   * object may be directly passed down to a child component in a manual
   * render function, and the optimization hint need to be on the slot object
   * itself to be preserved.
   * 表示编译器生成的插槽
   * @internal
   */
  _?: SlotFlags
}

// 判断一个键是否是插槽对象的内部键
const isInternalKey = (key: string) =>
  // _ 表示编译器生成的插槽标志，用于运行时优化
  // _ctx 跟踪插槽的所有者实例，确保插槽能够访问正确的组件上下文
  // $stable 手动渲染函数的提示，用于跳过强制子节点更新，优化性能
  key === '_' || key === '_ctx' || key === '$stable'

/**
 * 标准化插槽值
 * @param value
 * @returns
 */
const normalizeSlotValue = (value: unknown): VNode[] =>
  // 如果输入是数组，对数组中的每个元素调用 normalizeVNode
  isArray(value)
    ? value.map(normalizeVNode)
    : // 如果输入不是数组，将其作为单个元素，用 normalizeVNode 处理后放入数组
      [normalizeVNode(value as VNodeChild)]

/**
 * 标准化插槽
 * @param key
 * @param rawSlot
 * @param ctx
 * @returns
 */
const normalizeSlot = (
  key: string,
  rawSlot: Function,
  ctx: ComponentInternalInstance | null | undefined,
): Slot => {
  // 检查原始插槽函数是否已经被标准化（通过检查 _n 属性）
  if ((rawSlot as any)._n) {
    // 如果已经标准化，直接返回
    return rawSlot as Slot
  }

  // 用 withCtx 包裹插槽函数，确保在渲染时能够访问正确的组件上下文
  const normalized = withCtx((...args: any[]) => {
    // 在开发环境下，检查插槽是否在渲染函数内部调用
    if (
      __DEV__ &&
      currentInstance &&
      !(ctx === null && currentRenderingInstance) &&
      !(ctx && ctx.root !== currentInstance.root)
    ) {
      // 如果不是，发出警告，因为这样无法正确跟踪依赖
      warn(
        `Slot "${key}" invoked outside of the render function: ` +
          `this will not track dependencies used in the slot. ` +
          `Invoke the slot function inside the render function instead.`,
      )
    }
    // 标准化
    return normalizeSlotValue(rawSlot(...args))
  }, ctx) as Slot
  // NOT a compiled slot
  // 标记非编译插槽
  // 标记标准化后的插槽函数不是编译生成的
  ;(normalized as ContextualRenderFn)._c = false
  return normalized
}

/**
 * 标准化对象形式的插槽
 * @param rawSlots
 * @param slots
 * @param instance
 */
const normalizeObjectSlots = (
  rawSlots: RawSlots,
  slots: InternalSlots,
  instance: ComponentInternalInstance,
) => {
  // 从原始插槽对象中获取插槽的上下文实例
  const ctx = rawSlots._ctx

  // 遍历原始插槽对象中的所有键
  for (const key in rawSlots) {
    // 跳过内部键（如 _、_ctx、$stable），这些键有特殊用途，不是真正的插槽
    if (isInternalKey(key)) continue

    // 获取当前键对应的值
    const value = rawSlots[key]

    // 1、处理函数类型插槽
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx)

      // 2、处理非函数类型插槽
    } else if (value != null) {
      // 在开发环境下发出警告，建议使用函数插槽以获得更好的性能
      if (
        __DEV__ &&
        !(
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance)
        )
      ) {
        warn(
          `Non-function value encountered for slot "${key}". ` +
            `Prefer function slots for better performance.`,
        )
      }
      const normalized = normalizeSlotValue(value)
      slots[key] = () => normalized
    }
  }
}

/**
 * 标准化非对象形式的默认插槽
 * @param instance
 * @param children
 */
const normalizeVNodeSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren,
) => {
  // 在开发环境下，检查是否为 KeepAlive 组件或兼容模式
  // 如果不是，发出警告，建议使用函数插槽以获得更好的性能
  if (
    __DEV__ &&
    !isKeepAlive(instance.vnode) &&
    !(__COMPAT__ && isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, instance))
  ) {
    warn(
      `Non-function value encountered for default slot. ` +
        `Prefer function slots for better performance.`,
    )
  }
  const normalized = normalizeSlotValue(children)
  // 设置默认插槽
  instance.slots.default = () => normalized
}

/**
 * 将传入的插槽对象（children）赋值到组件的内部插槽对象（slots）中
 * @param slots
 * @param children
 * @param optimized
 */
const assignSlots = (
  slots: InternalSlots,
  children: Slots,
  optimized: boolean,
) => {
  for (const key in children) {
    // #2893
    // when rendering the optimized slots by manually written render function,
    // do not copy the `slots._` compiler flag so that `renderSlot` creates
    // slot Fragment with BAIL patchFlag to force full updates
    // 优化模式、非内部键，直接赋值插槽值
    if (optimized || !isInternalKey(key)) {
      slots[key] = children[key]
    }
  }
}

/**
 * 初始化组件实例的插槽
 * @param instance
 * @param children
 * @param optimized
 */
export const initSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren,
  optimized: boolean,
): void => {
  // 创建内部插槽对象
  const slots = (instance.slots = createInternalObject())

  // 子节点是为插槽对象
  if (instance.vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._ // 获取插槽对象的编译标记 _
    if (type) {
      // 使用 assignSlots 直接赋值，并在优化模式下设置 _ 为不可枚举
      assignSlots(slots, children as Slots, optimized)
      // make compiler marker non-enumerable
      if (optimized) {
        def(slots, '_', type, true)
      }
    } else {
      // 使用 normalizeObjectSlots 标准化插槽对象
      normalizeObjectSlots(children as RawSlots, slots, instance)
    }
    // 如果子节点存在但不是插槽对象，使用 normalizeVNodeSlots 将其转换为默认插槽
  } else if (children) {
    normalizeVNodeSlots(instance, children)
  }
}

/**
 * 更新组件实例的插槽
 * @param instance
 * @param children
 * @param optimized
 */
export const updateSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren,
  optimized: boolean,
): void => {
  const { vnode, slots } = instance
  let needDeletionCheck = true // 表示需要检查并删除过期的插槽
  let deletionComparisonTarget = EMPTY_OBJ

  // 处理插槽对象类型的子节点
  if (vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._ // 获取插槽对象的编译标记 _
    if (type) {
      // compiled slots.
      if (__DEV__ && isHmrUpdating) {
        // 在开发环境且热更新时，强制更新插槽并触发响应式更新
        // Parent was HMR updated so slot content may have changed.
        // force update slots and mark instance for hmr as well
        assignSlots(slots, children as Slots, optimized)
        trigger(instance, TriggerOpTypes.SET, '$slots')

        // 如果是优化模式且插槽类型为 STABLE，则不需要更新，也不需要检查过期插槽
      } else if (optimized && type === SlotFlags.STABLE) {
        // compiled AND stable.
        // no need to update, and skip stale slots removal.
        needDeletionCheck = false
      } else {
        // compiled but dynamic (v-if/v-for on slots) - update slots, but skip
        // normalization.
        // 其他情况（编译生成但动态的插槽），更新插槽但跳过标准化
        assignSlots(slots, children as Slots, optimized)
      }
    } else {
      // 处理非编译生成的插槽
      // 如果插槽对象有 $stable 属性且为 true，则不需要检查过期插槽
      needDeletionCheck = !(children as RawSlots).$stable
      // 标准化插槽对象
      normalizeObjectSlots(children as RawSlots, slots, instance)
    }
    deletionComparisonTarget = children as RawSlots
  } else if (children) {
    // non slot object children (direct value) passed to a component
    normalizeVNodeSlots(instance, children)
    deletionComparisonTarget = { default: 1 } // 表示只有默认插槽有效
  }

  // delete stale slots
  // 删除过期插槽
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && deletionComparisonTarget[key] == null) {
        delete slots[key]
      }
    }
  }
}
