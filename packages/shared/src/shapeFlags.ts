export enum ShapeFlags {
  // 普通 HTML 元素
  ELEMENT = 1,
  // 函数式组件
  FUNCTIONAL_COMPONENT = 1 << 1,
  // 有状态组件
  STATEFUL_COMPONENT = 1 << 2,
  // 子节点为文本
  TEXT_CHILDREN = 1 << 3,
  // 子节点为数组
  ARRAY_CHILDREN = 1 << 4,
  // 子节点为插槽
  SLOTS_CHILDREN = 1 << 5,
  // Teleport 组件
  TELEPORT = 1 << 6,
  // Suspense 组件
  SUSPENSE = 1 << 7,
  // 组件应该被保持激活状态
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8,
  // 组件已被保持激活状态
  COMPONENT_KEPT_ALIVE = 1 << 9,
  // 所有组件类型（函数式 + 有状态）
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT,
}
