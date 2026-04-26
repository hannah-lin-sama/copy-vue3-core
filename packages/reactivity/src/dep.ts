import { extend, isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import { type TrackOpTypes, TriggerOpTypes } from './constants'
import {
  type DebuggerEventExtraInfo,
  EffectFlags,
  type Subscriber,
  activeSub,
  endBatch,
  shouldTrack,
  startBatch,
} from './effect'

/**
 * Incremented every time a reactive change happens
 * This is used to give computed a fast path to avoid re-compute when nothing
 * has changed.
 */
export let globalVersion = 0

/**
 * Represents a link between a source (Dep) and a subscriber (Effect or Computed).
 * Deps and subs have a many-to-many relationship - each link between a
 * dep and a sub is represented by a Link instance.
 *
 * A Link is also a node in two doubly-linked lists - one for the associated
 * sub to track all its deps, and one for the associated dep to track all its
 * subs.
 * 用于建立订阅者（Subscriber）和依赖（Dep）之间的双向关联
 * @internal
 */
export class Link {
  /**
   * - Before each effect run, all previous dep links' version are reset to -1
   * - During the run, a link's version is synced with the source dep on access
   * - After the run, links with version -1 (that were never used) are cleaned
   *   up
   * 存储依赖的版本号，用于跟踪依赖是否发生变化
   */
  version: number

  /**
   * Pointers for doubly-linked lists
   */
  nextDep?: Link
  prevDep?: Link
  nextSub?: Link
  prevSub?: Link
  prevActiveLink?: Link // 存储之前的活动链接

  constructor(
    public sub: Subscriber, // 作为当前实例的sub
    public dep: Dep, // 作为当前实例的dep
  ) {
    this.version = dep.version // 初始化为当前依赖的版本号
    this.nextDep =
      this.prevDep =
      this.nextSub =
      this.prevSub =
      this.prevActiveLink =
        undefined
  }
}

/**
 * @internal
 */
export class Dep {
  version = 0
  /**
   * Link between this dep and the current active effect
   * 当前活动的链接，连接当前活动的 effect
   */
  activeLink?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (tail)
   * 订阅者链表的尾部指针
   */
  subs?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (head)
   * DEV only, for invoking onTrigger hooks in correct order
   * 订阅者链表的头部指针（仅开发环境）
   */
  subsHead?: Link

  /**
   * For object property deps cleanup
   * 用于对象属性依赖的清理
   */
  map?: KeyToDepMap = undefined
  // 依赖的键
  key?: unknown = undefined

  /**
   * Subscriber counter
   * 订阅者计数器
   */
  sc: number = 0

  /**
   * @internal
   * 标记，用于跳过某些处理
   */
  readonly __v_skip = true
  // TODO isolatedDeclarations ReactiveFlags.SKIP

  constructor(public computed?: ComputedRefImpl | undefined) {
    // 接收一个参数 computed,做为实例的属性

    if (__DEV__) {
      this.subsHead = undefined
    }
  }

  // 示例：当执行 computed.value会触发依赖收集
  // 示例：当执行 ref.value 会触发依赖收集
  // 建立当前活动的副作用（activeSub）与当前依赖（Dep）之间的双向链接，
  track(debugInfo?: DebuggerEventExtraInfo): Link | undefined {
    // 当满足以下任一条件时，会直接返回，不进行依赖追踪
    // 1、没有活动的订阅者
    // 2、不跟踪依赖
    // 3、订阅者是否为当前依赖关联的计算属性。
    //    作用：防止计算属性的循环依赖。场景：当计算属性的 getter 函数访问自身时，避免形成循环依赖。
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return
    }

    let link = this.activeLink // 当前活动 link

    // 没有活动link、或 活动link 不是当前订阅者
    // 作用：确保只为当前订阅者建立链接，避免重复或错误的链接
    if (link === undefined || link.sub !== activeSub) {
      // 创建新的 Link 实例
      link = this.activeLink = new Link(activeSub, this)

      // add the link to the activeEffect as a dep (as tail)
      // 将 link 添加到 订阅者的依赖链表
      if (!activeSub.deps) {
        // 1、此时链表中只有一个节点，头尾指向同一个 link
        activeSub.deps = activeSub.depsTail = link
      } else {
        // 2、如果链表中已经有节点，将 link 添加到链表尾尾
        link.prevDep = activeSub.depsTail
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link
      }

      // 将链接添加到依赖者的订阅者链表
      addSub(link)

      // link 版本-1 ，说明这是第一次访问依赖，需要同步版本号
    } else if (link.version === -1) {
      // reused from last run - already a sub, just sync version
      link.version = this.version

      // If this dep has a next, it means it's not at the tail - move it to the
      // tail. This ensures the effect's dep list is in the order they are
      // accessed during evaluation.
      if (link.nextDep) {
        const next = link.nextDep
        next.prevDep = link.prevDep
        if (link.prevDep) {
          link.prevDep.nextDep = next
        }

        link.prevDep = activeSub.depsTail
        link.nextDep = undefined
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link

        // this was the head - point to the new head
        if (activeSub.deps === link) {
          activeSub.deps = next
        }
      }
    }

    if (__DEV__ && activeSub.onTrack) {
      activeSub.onTrack(
        extend(
          {
            effect: activeSub,
          },
          debugInfo,
        ),
      )
    }

    return link
  }

  // 触发依赖更新
  trigger(debugInfo?: DebuggerEventExtraInfo): void {
    this.version++ // 增加依赖的版本号
    globalVersion++ // 增加全局版本号
    // 通知订阅者
    this.notify(debugInfo)
  }

  notify(debugInfo?: DebuggerEventExtraInfo): void {
    // 开始批处理
    startBatch()
    try {
      if (__DEV__) {
        // subs are notified and batched in reverse-order and then invoked in
        // original order at the end of the batch, but onTrigger hooks should
        // be invoked in original order here.
        for (let head = this.subsHead; head; head = head.nextSub) {
          if (head.sub.onTrigger && !(head.sub.flags & EffectFlags.NOTIFIED)) {
            head.sub.onTrigger(
              extend(
                {
                  effect: head.sub,
                },
                debugInfo,
              ),
            )
          }
        }
      }
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          // if notify() returns `true`, this is a computed. Also call notify
          // on its dep - it's called here instead of inside computed's notify
          // in order to reduce call stack depth.
          ;(link.sub as ComputedRefImpl).dep.notify()
        }
      }
    } finally {
      endBatch()
    }
  }
}

function addSub(link: Link) {
  link.dep.sc++ // 增加依赖的订阅者数量

  // 确保只有正在追踪依赖的订阅者才会被添加到依赖的订阅者列表中
  if (link.sub.flags & EffectFlags.TRACKING) {
    // 1、如果订阅者是计算属性
    const computed = link.dep.computed
    // computed getting its first subscriber
    // enable tracking + lazily subscribe to all its deps
    // 首次订阅检查：检查是否是计算属性的第一个订阅者（!link.dep.subs）
    if (computed && !link.dep.subs) {
      // 启用计算属性的依赖追踪
      // 保计算属性会重新计算
      computed.flags |= EffectFlags.TRACKING | EffectFlags.DIRTY

      // 懒订阅：遍历计算属性的所有依赖，为每个依赖添加订阅
      for (let l = computed.deps; l; l = l.nextDep) {
        addSub(l)
      }
    }

    // 获取当前尾部：获取依赖订阅者链表的当前尾部
    const currentTail = link.dep.subs

    // 当前链接不是链表尾部
    if (currentTail !== link) {
      link.prevSub = currentTail
      if (currentTail) currentTail.nextSub = link
    }

    if (__DEV__ && link.dep.subsHead === undefined) {
      link.dep.subsHead = link
    }

    // 更新尾部指针：将依赖的 subs（订阅者链表尾部）设置为当前链接
    link.dep.subs = link
  }
}

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
// depsMap：Map，键为属性 key（或特殊迭代器 key），值为 Dep（即 Set<ReactiveEffect>）。
type KeyToDepMap = Map<any, Dep>

// 全局 WeakMap，键为原始对象 target，值为 depsMap。
export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

export const ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Object iterate' : '',
)
export const MAP_KEY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Map keys iterate' : '',
)
export const ARRAY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Array iterate' : '',
)

/**
 * Tracks access to a reactive property.
 * 追踪响应式对象的依赖。
 * 当访问响应式对象的属性时，该函数会被调用，记录当前活跃的订阅者与被访问属性之间的依赖关系。
 *
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property. 原始对象
 * @param type - Defines the type of access to the reactive property. 追踪操作的类型
 * @param key - Identifier of the reactive property to track. 被读取的属性名（可能是字符串、Symbol、数组索引等）
 */
export function track(target: object, type: TrackOpTypes, key: unknown): void {
  // 前置条件：是否需要收集依赖
  // - shouldTrack：全局标志，控制是否允许追踪依赖。
  // - activeSub：当前正在执行的 ReactiveEffect 实例（副作用）
  if (shouldTrack && activeSub) {
    // targetMap：全局 Map，存储所有响应式对象的依赖映射
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      // 如果该 target 第一次被追踪，则创建一个新的 Map 并存入 targetMap。
      targetMap.set(target, (depsMap = new Map()))
    }

    // 获取或创建依赖对象
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = new Dep()))
      dep.map = depsMap // 存储依赖映射表，用于触发依赖时快速查找
      dep.key = key // 存储属性名，用于触发依赖时快速查找
    }
    if (__DEV__) {
      dep.track({
        target,
        type,
        key,
      })
    } else {
      // 收集依赖
      dep.track()
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.

 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object, // 原始对象（未被代理的原对象）
  type: TriggerOpTypes, // 操作类型：SET | ADD | DELETE | CLEAR
  key?: unknown, // 被修改的属性名
  newValue?: unknown, // 新值
  oldValue?: unknown, // 旧值
  oldTarget?: Map<unknown, unknown> | Set<unknown>, // 用于集合（Map/Set）的旧对象
): void {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    // 如果 target 从未被追踪过（没有 depsMap），则仅增加全局版本号
    globalVersion++
    return
  }

  const run = (dep: Dep | undefined) => {
    if (dep) {
      if (__DEV__) {
        dep.trigger({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        })
      } else {
        // 触发依赖，进行通知
        dep.trigger()
      }
    }
  }

  // 批处理期间会收集需要执行的 effect，最后统一执行。
  // 开始批处理
  startBatch()

  // 1、清空集合，如 Map.clear() / Set.clear()
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(run)
  } else {
    const targetIsArray = isArray(target)
    const isArrayIndex = targetIsArray && isIntegerKey(key)

    // 2、处理数组的 length 属性变化（特殊逻辑）
    if (targetIsArray && key === 'length') {
      const newLength = Number(newValue)
      depsMap.forEach((dep, key) => {
        if (
          key === 'length' ||
          key === ARRAY_ITERATE_KEY ||
          (!isSymbol(key) && key >= newLength)
        ) {
          run(dep)
        }
      })
    } else {
      // schedule runs for SET | ADD | DELETE
      // 如果 key 是具体的属性名（不是 undefined），则触发该属性对应的依赖。
      // 或者存在一个无 key 的依赖（void 0），也需要触发
      // 例如 watchEffect 中直接读取整个 reactive 对象，依赖会挂在 void 0 上。
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key))
      }

      // schedule ARRAY_ITERATE for any numeric key change (length is handled above)
      // 如果当前 key 是数组索引（key 为整数），还需要触发数组迭代器依赖
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY))
      }

      // also run for iteration key on ADD | DELETE | Map.SET
      switch (type) {
        // 添加新属性
        case TriggerOpTypes.ADD:
          if (!targetIsArray) {
            // 非数组时：触发 ITERATE_KEY（因为 for...in 循环会新增键）
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              // 如果是 Map：触发 MAP_KEY_ITERATE_KEY（Map.keys() 迭代器）
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          } else if (isArrayIndex) {
            // new index added to array -> length changes
            // 如果是数组且是数组索引（添加新索引）：触发 length 的依赖（因为数组长度增加了）
            run(depsMap.get('length'))
          }
          break
        // 删除属性
        case TriggerOpTypes.DELETE:
          if (!targetIsArray) {
            // 非数组时：触发 ITERATE_KEY
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              // 如果是 Map：触发 MAP_KEY_ITERATE_KEY
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          }
          break
        // 设置属性值
        case TriggerOpTypes.SET:
          if (isMap(target)) {
            // 仅当是 Map 时：触发 ITERATE_KEY
            // 因为 Map 的 forEach 或 entries 迭代器需要知道值变化
            run(depsMap.get(ITERATE_KEY))
          }
          break
      }
    }
  }

  endBatch()
}

export function getDepFromReactive(
  object: any,
  key: string | number | symbol,
): Dep | undefined {
  const depMap = targetMap.get(object)
  return depMap && depMap.get(key)
}
