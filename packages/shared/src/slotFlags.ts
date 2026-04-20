export enum SlotFlags {
  /**
   * Stable slots that only reference slot props or context state. The slot
   * can fully capture its own dependencies so when passed down the parent won't
   * need to force the child to update.
   * 稳定插槽，只引用插槽 props 或上下文状态，完全捕获自身依赖
   * 父组件不需要强制子组件更新
   */
  STABLE = 1,
  /**
   * Slots that reference scope variables (v-for or an outer slot prop), or
   * has conditional structure (v-if, v-for). The parent will need to force
   * the child to update because the slot does not fully capture its dependencies.
   * 动态插槽，引用作用域变量（v-for 或外部插槽 prop）或有条件结构（v-if, v-for）
   * 父组件需要强制子组件更新
   */
  DYNAMIC = 2,
  /**
   * `<slot/>` being forwarded into a child component. Whether the parent needs
   * to update the child is dependent on what kind of slots the parent itself
   * received. This has to be refined at runtime, when the child's vnode
   * is being created (in `normalizeChildren`)
   * 被转发到子组件的插槽，父组件是否需要更新子组件取决于父组件本身接收的插槽类型
   * 在运行时（normalizeChildren 中）确定具体类型
   */
  FORWARDED = 3,
}

/**
 * Dev only
 */
export const slotFlagsText: Record<SlotFlags, string> = {
  [SlotFlags.STABLE]: 'STABLE',
  [SlotFlags.DYNAMIC]: 'DYNAMIC',
  [SlotFlags.FORWARDED]: 'FORWARDED',
}
