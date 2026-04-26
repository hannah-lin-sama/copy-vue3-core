// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export enum TrackOpTypes {
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate',
}

export enum TriggerOpTypes {
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear',
}

export enum ReactiveFlags {
  // 标记对象应被响应式系统跳过，不进行响应式转换
  SKIP = '__v_skip',
  // 标记对象是响应式的
  IS_REACTIVE = '__v_isReactive',
  // 标记对象是只读的
  IS_READONLY = '__v_isReadonly',
  // 标记对象是浅层响应式的
  IS_SHALLOW = '__v_isShallow',
  // 指向原始对象（未代理的对象）
  RAW = '__v_raw',
  // 标记对象是一个 Ref
  IS_REF = '__v_isRef',
}
