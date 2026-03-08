import {
  type ComponentInternalInstance,
  type ComponentOptions,
  type ConcreteComponent,
  type SetupContext,
  currentInstance,
  getComponentName,
  getCurrentInstance,
} from '../component'
import {
  Comment,
  type VNode,
  type VNodeProps,
  cloneVNode,
  invokeVNodeHook,
  isSameVNodeType,
  isVNode,
} from '../vnode'
import { warn } from '../warning'
import {
  injectHook,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  onUpdated,
} from '../apiLifecycle'
import {
  ShapeFlags,
  invokeArrayFns,
  isArray,
  isRegExp,
  isString,
  remove,
} from '@vue/shared'
import { watch } from '../apiWatch'
import {
  type ElementNamespace,
  MoveType,
  type RendererElement,
  type RendererInternals,
  type RendererNode,
  invalidateMount,
  queuePostRenderEffect,
} from '../renderer'
import { setTransitionHooks } from './BaseTransition'
import type { ComponentRenderContext } from '../componentPublicInstance'
import { devtoolsComponentAdded } from '../devtools'
import { isAsyncWrapper } from '../apiAsyncComponent'
import { isSuspense } from './Suspense'
import { LifecycleHooks } from '../enums'

type MatchPattern = string | RegExp | (string | RegExp)[]

export interface KeepAliveProps {
  include?: MatchPattern
  exclude?: MatchPattern
  max?: number | string
}

type CacheKey = PropertyKey | ConcreteComponent
type Cache = Map<CacheKey, VNode>
type Keys = Set<CacheKey>

// KeepAlive 组件的核心上下文类型
export interface KeepAliveContext extends ComponentRenderContext {
  //  Vue 渲染器的「内部接口」，包含渲染器的核心 DOM 操作能力（如 createElement、insert、remove、patch 等）
  renderer: RendererInternals
  // 激活缓存组件方法
  activate: (
    vnode: VNode, // 要激活的缓存组件 VNode（
    container: RendererElement, // 组件要挂载到的 DOM 容器
    anchor: RendererNode | null, // 插入锚点（如 null 表示插入到容器末尾，或指定某个 DOM 节点作为参考）
    namespace: ElementNamespace, // 元素命名空间
    optimized: boolean, // 是否启用编译优化（Vue 3 模板编译的优化标记，影响 VNode patch 逻辑）
  ) => void
  // 失活缓存组件方法
  deactivate: (vnode: VNode) => void
}

// 判断是否是 KeepAlive 组件
export const isKeepAlive = (vnode: VNode): boolean =>
  (vnode.type as any).__isKeepAlive

// KeepAlive 组件的实现
const KeepAliveImpl: ComponentOptions = {
  name: `KeepAlive`,

  // Marker for special handling inside the renderer. We are not using a ===
  // check directly on KeepAlive in the renderer, because importing it directly
  // would prevent it from being tree-shaken.
  __isKeepAlive: true, // 标识 KeepAlive 组件

  props: {
    // 包含的组件
    include: [String, RegExp, Array],
    // 排除的组件
    exclude: [String, RegExp, Array],
    // 最大缓存数量
    max: [String, Number],
  },

  // KeepAlive 组件的 setup 函数
  // setup 函数的执行时机：每个 KeepAlive 组件实例被创建时，都会独立执行一次 setup 函数
  setup(props: KeepAliveProps, { slots }: SetupContext) {
    // 获取当前组件实例
    const instance = getCurrentInstance()!
    // KeepAlive communicates with the instantiated renderer via the
    // ctx where the renderer passes in its internals,
    // and the KeepAlive instance exposes activate/deactivate implementations.
    // The whole point of this is to avoid importing KeepAlive directly in the
    // renderer to facilitate tree-shaking.
    // 从实例的上下文获取 KeepAlive 上下文
    const sharedContext = instance.ctx as KeepAliveContext

    // if the internal renderer is not registered, it indicates that this is server-side rendering,
    // for KeepAlive, we just need to render its children
    // 服务器端渲染时，直接返回子组件
    if (__SSR__ && !sharedContext.renderer) {
      return () => {
        const children = slots.default && slots.default()
        return children && children.length === 1 ? children[0] : children
      }
    }

    /**
     * 组件内部定义 cache 、keys
     * 不同位置使用的 KeepAlive 组件是「独立实例」，各自拥有专属的 cache 和 keys，不会共用同一份内存
     */
    // 缓存已激活的组件实例
    const cache: Cache = new Map()
    // 缓存已激活组件的 key
    const keys: Keys = new Set()

    // 当前激活的组件实例（只记录组件或suspense节点）
    let current: VNode | null = null

    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      ;(instance as any).__v_cache = cache
    }

    const parentSuspense = instance.suspense // 父组件的 Suspense 实例

    const {
      renderer: {
        p: patch, // 渲染函数
        m: move, // 移动组件实例到新位置
        um: _unmount, // 卸载组件实例
        o: { createElement }, // 创建元素节点
      },
    } = sharedContext

    // 组件实例的隐藏容器节点（用于暂存失活组件实例）
    const storageContainer = createElement('div')

    // 激活组件实例
    sharedContext.activate = (
      vnode, // 要激活的组件
      container, // 目标容器（页面可见的 DOM 容器）
      anchor, // 插入锚点（组件将插入到该节点之前）
      namespace, // 命名空间
      optimized, // 是否启用优化模式
    ) => {
      const instance = vnode.component! // 获取组件实例
      // 将组件从隐藏容器移动到目标容器（页面可见位置）
      move(vnode, container, anchor, MoveType.ENTER, parentSuspense)
      // in case props have changed
      // 补丁更新：处理激活时的 props 变化等
      patch(
        instance.vnode,
        vnode,
        container,
        anchor,
        instance,
        parentSuspense,
        namespace,
        vnode.slotScopeIds,
        optimized,
      )

      // 处理缓存组件「激活（activate）」的核心逻辑
      /**
       * 为什么延迟执行？
       * 激活逻辑依赖 DOM 已挂载的状态（比如 onVnodeMounted 钩子需要访问已插入页面的 DOM 节点），必须在渲染器完成 DOM 插入后执行。
       */
      queuePostRenderEffect(() => {
        instance.isDeactivated = false // 恢复组件激活状态标记

        // 触发组件 activated 生命周期钩子
        /**
         * 为什么激活钩子是数组而非单个函数？
         * instance.a（activated 钩子）本质是一个函数数组，而非单个函数。
         * 在 Vue 中，可以在一个组件里多次注册同一个生命周期钩子
         */
        if (instance.a) {
          invokeArrayFns(instance.a)
        }
        // 模拟触发 VNode 的 onVnodeMounted 钩子
        const vnodeHook = vnode.props && vnode.props.onVnodeMounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
      }, parentSuspense)

      if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
        // Update components tree
        devtoolsComponentAdded(instance)
      }
    }

    // 停用组件实例
    sharedContext.deactivate = (vnode: VNode) => {
      const instance = vnode.component!
      invalidateMount(instance.m)
      invalidateMount(instance.a)

      /**
       * 将组件从页面容器移动到隐藏容器（暂存）
       * 无锚点，直接移到容器末尾
       */
      move(vnode, storageContainer, null, MoveType.LEAVE, parentSuspense)

      // 异步渲染完成后，调用 deactivated 生命周期钩子
      // 将失活逻辑加入「渲染后副作用队列」，保证在「组件 DOM 已从页面移除、渲染完成后」执行
      /**
       * 为什么延迟执行？
       * 失活逻辑依赖 DOM 已移除的状态，需在渲染器完成 DOM 操作后执行，避免钩子内操作到仍在页面中的 DOM。
       */
      queuePostRenderEffect(() => {
        //  触发组件 deactivated 生命周期钩子
        if (instance.da) {
          invokeArrayFns(instance.da)
        }
        // 触发 vnode 的 onVnodeUnmounted 钩子（模拟卸载行为，实际未卸载）
        const vnodeHook = vnode.props && vnode.props.onVnodeUnmounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
        instance.isDeactivated = true // 标记组件为失活状态
      }, parentSuspense)

      if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
        // Update components tree
        devtoolsComponentAdded(instance)
      }

      // for e2e test
      if (__DEV__ && __BROWSER__) {
        ;(instance as any).__keepAliveStorageContainer = storageContainer
      }
    }

    // 卸载组件实例
    function unmount(vnode: VNode) {
      // reset the shapeFlag so it can be properly unmounted
      resetShapeFlag(vnode)
      _unmount(vnode, instance, parentSuspense, true)
    }

    // 修剪缓存，根据 filter 函数过滤出需要保留的组件实例
    function pruneCache(filter: (name: string) => boolean) {
      cache.forEach((vnode, key) => {
        // for async components, name check should be based in its loaded
        // inner component if available
        const name = getComponentName(
          isAsyncWrapper(vnode)
            ? (vnode.type as ComponentOptions).__asyncResolved || {}
            : (vnode.type as ConcreteComponent),
        )
        if (name && !filter(name)) {
          pruneCacheEntry(key)
        }
      })
    }

    // 修剪缓存中的指定组件实例
    function pruneCacheEntry(key: CacheKey) {
      const cached = cache.get(key) as VNode
      // 情况1：缓存存在，且不是当前激活的节点 → 执行卸载
      if (cached && (!current || !isSameVNodeType(cached, current))) {
        unmount(cached)

        // 情况2：缓存存在，且是当前激活的节点 → 重置缓存标记
      } else if (current) {
        // current active instance should no longer be kept-alive.
        // we can't unmount it now but it might be later, so reset its flag now.
        resetShapeFlag(current)
      }
      cache.delete(key) // 从缓存容器中移除该 key
      keys.delete(key) // 从 LRU 集合中移除该 key
    }

    // 监听 include/exclude 变化，修剪缓存
    // prune cache on include/exclude prop change
    watch(
      () => [props.include, props.exclude],
      ([include, exclude]) => {
        // include变化 → 清理「不在新include中的组件
        include && pruneCache(name => matches(include, name))
        // exclude变化 → 清理「在新exclude中的组件
        exclude && pruneCache(name => !matches(exclude, name))
      },
      // prune post-render after `current` has been updated
      { flush: 'post', deep: true },
    )

    // cache sub tree after render
    // 缓存子树，用于后续激活
    let pendingCacheKey: CacheKey | null = null

    // 处理「组件子树缓存」
    const cacheSubtree = () => {
      // fix #1621, the pendingCacheKey could be 0
      if (pendingCacheKey != null) {
        // if KeepAlive child is a Suspense, it needs to be cached after Suspense resolves
        // avoid caching vnode that not been mounted
        // 若 KeepAlive 子节点是 Suspense → 需等 Suspense 解析完成后再缓存
        if (isSuspense(instance.subTree.type)) {
          // 把缓存操作加入「Suspense 解析完成后的渲染后队列」
          queuePostRenderEffect(() => {
            // 存入缓存：key → Suspense 内部的真实子组件 VNode
            cache.set(pendingCacheKey!, getInnerChild(instance.subTree))
          }, instance.subTree.suspense)
        } else {
          // 非 Suspense 节点 → 直接缓存子树的真实组件 VNode
          cache.set(pendingCacheKey, getInnerChild(instance.subTree))
        }
      }
    }
    // 组件挂载时缓存子树
    onMounted(cacheSubtree)
    // 组件更新时缓存子树
    onUpdated(cacheSubtree)

    // 组件卸载前，移除缓存中的子树
    // onBeforeUnmount：Vue 生命周期钩子，在组件即将被卸载时执行（此时组件仍在 DOM 中，可访问实例 / 缓存）
    /**
     * 在 KeepAlive 组件自身被卸载时，清理其管理的所有缓存组件
     * 对「当前激活的缓存组件」仅触发失活钩子，对「非激活的缓存组件」直接执行卸载，避免内存泄漏。
     */
    onBeforeUnmount(() => {
      // cache：当前 KeepAlive 实例的缓存容器（Map 类型，key -> 组件 VNode）
      cache.forEach(cached => {
        // subTree：KeepAlive 组件渲染的子树（即其默认插槽中的内容）
        const { subTree, suspense } = instance
        const vnode = getInnerChild(subTree)

        // 处理当前激活的缓存组件：仅触发失活钩子，不卸载
        if (cached.type === vnode.type && cached.key === vnode.key) {
          // current instance will be unmounted as part of keep-alive's unmount
          resetShapeFlag(vnode) // 重置 VNode 的形状标记，避免后续渲染异常
          // but invoke its deactivated hook here
          const da = vnode.component!.da
          // 触发 deactivated 钩子（延迟执行，保证时机正确）
          da && queuePostRenderEffect(da, suspense)
          return
        }
        // 处理非激活的缓存组件：直接执行卸载
        unmount(cached)
      })
    })

    // 渲染逻辑（setup 返回的渲染函数）
    return () => {
      pendingCacheKey = null

      // 若没有默认插槽内容，重置缓存相关状态
      if (!slots.default) {
        return (current = null)
      }

      const children = slots.default() // 取默认插槽的子节点
      const rawVNode = children[0] // 取第一个子节点

      // 多节点场景：不缓存，直接返回所有子节点
      // Vue3 官方的 KeepAlive 组件本身只支持包裹单个直接子节点，如果检测到多个直接子节点，会直接跳过缓存逻辑、按普通方式渲染
      if (children.length > 1) {
        if (__DEV__) {
          warn(`KeepAlive should contain exactly one component child.`)
        }
        current = null
        return children

        // 非组件/Suspense节点：不缓存，直接返回该节点
        // 如元素节点、文本节点等
      } else if (
        !isVNode(rawVNode) ||
        (!(rawVNode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) &&
          !(rawVNode.shapeFlag & ShapeFlags.SUSPENSE))
      ) {
        current = null
        return rawVNode
      }

      // Vue3 的 KeepAlive 组件仅针对「组件节点（Component VNode）」和「Suspense 节点」 做缓存

      let vnode = getInnerChild(rawVNode)
      // #6028 Suspense ssContent maybe a comment VNode, should avoid caching it
      if (vnode.type === Comment) {
        // 注释节点，不缓存
        current = null
        return vnode // 直接返回注释节点，不做缓存
      }

      const comp = vnode.type as ConcreteComponent

      // for async components, name check should be based in its loaded
      // inner component if available
      // 获取组件名（如组件的name选项）
      const name = getComponentName(
        isAsyncWrapper(vnode)
          ? (vnode.type as ComponentOptions).__asyncResolved || {}
          : comp,
      )

      const { include, exclude, max } = props

      // 不满足缓存条件：标记为「不应缓存」，并返回原始节点
      if (
        (include && (!name || !matches(include, name))) || // 不在include中
        (exclude && name && matches(exclude, name)) // 在exclude中
      ) {
        // #11717
        vnode.shapeFlag &= ~ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE // 标记为「不应缓存」
        current = vnode // 记录当前组件，用于后续激活时对比
        return rawVNode // 直接返回原始节点，不做缓存
      }

      // 生成缓存 key（优先用 vnode.key，否则用组件类型）
      const key = vnode.key == null ? comp : vnode.key
      const cachedVNode = cache.get(key)

      // clone vnode if it's reused because we are going to mutate it
      if (vnode.el) {
        vnode = cloneVNode(vnode)
        if (rawVNode.shapeFlag & ShapeFlags.SUSPENSE) {
          rawVNode.ssContent = vnode
        }
      }
      // #1511 it's possible for the returned vnode to be cloned due to attr
      // fallthrough or scopeId, so the vnode here may not be the final vnode
      // that is mounted. Instead of caching it directly, we store the pending
      // key and cache `instance.subTree` (the normalized vnode) in
      // mounted/updated hooks.
      pendingCacheKey = key // 缓存

      // 复用缓存实例
      if (cachedVNode) {
        // copy over mounted state
        vnode.el = cachedVNode.el
        vnode.component = cachedVNode.component
        if (vnode.transition) {
          // recursively update transition hooks on subTree
          setTransitionHooks(vnode, vnode.transition!)
        }
        // avoid vnode being mounted as fresh
        // 标记为「已缓存」，避免重新挂载
        vnode.shapeFlag |= ShapeFlags.COMPONENT_KEPT_ALIVE
        // make this key the freshest
        keys.delete(key) // 从旧键列表中移除
        keys.add(key) // 添加到最新键列表
      } else {
        keys.add(key) // 新增Key到LRU集合
        // 超出max限制：淘汰最久未使用的缓存
        // prune oldest entry
        if (max && keys.size > parseInt(max as string, 10)) {
          pruneCacheEntry(keys.values().next().value!)
        }
      }
      // avoid vnode being unmounted
      vnode.shapeFlag |= ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE // 标记为需要缓存

      current = vnode
      return isSuspense(rawVNode.type) ? rawVNode : vnode
    }
  },
}

const decorate = (t: typeof KeepAliveImpl) => {
  t.__isBuiltIn = true
  return t
}

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
export const KeepAlive = (__COMPAT__
  ? /*@__PURE__*/ decorate(KeepAliveImpl)
  : KeepAliveImpl) as any as {
  __isKeepAlive: true
  new (): {
    $props: VNodeProps & KeepAliveProps
    $slots: {
      default(): VNode[]
    }
  }
}

function matches(pattern: MatchPattern, name: string): boolean {
  if (isArray(pattern)) {
    return pattern.some((p: string | RegExp) => matches(p, name))
  } else if (isString(pattern)) {
    return pattern.split(',').includes(name)
  } else if (isRegExp(pattern)) {
    pattern.lastIndex = 0
    return pattern.test(name)
  }
  /* v8 ignore next */
  return false
}

export function onActivated(
  hook: Function,
  target?: ComponentInternalInstance | null,
): void {
  // 注册 KeepAlive 组件激活时的钩子函数
  registerKeepAliveHook(hook, LifecycleHooks.ACTIVATED, target)
}

export function onDeactivated(
  hook: Function,
  target?: ComponentInternalInstance | null,
): void {
  // 注册 KeepAlive 组件停用时的钩子函数
  registerKeepAliveHook(hook, LifecycleHooks.DEACTIVATED, target)
}

/**
 * 为 KeepAlive 组件定制的生命周期钩子注册逻辑
 * @param hook 要注册的钩子函数
 * @param type 钩子类型（激活或停用）
 * @param target 目标组件实例（默认当前实例）
 */
function registerKeepAliveHook(
  hook: Function & { __wdc?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance | null = currentInstance,
) {
  // cache the deactivate branch check wrapper for injected hooks so the same
  // hook can be properly deduped by the scheduler. "__wdc" stands for "with
  // deactivation check".
  // 包装钩子：添加「失活状态检查」
  const wrappedHook =
    // hook.__wdc	缓存「带失活检查的包装钩子」
    // 给原始 hook 添加 __wdc 属性，缓存包装后的钩子，避免多次包装（保证同一个钩子只处理一次）
    hook.__wdc ||
    (hook.__wdc = () => {
      // only fire the hook if the target instance is NOT in a deactivated branch.
      let current: ComponentInternalInstance | null = target
      while (current) {
        // 检测是否在失活分支 → 直接返回
        if (current.isDeactivated) {
          return
        }
        current = current.parent // 向上遍历父节点，检查整个分支
      }
      // 只有整个分支都处于激活状态，才执行原始 hook()
      return hook()
    })

  // 插入队列尾部（默认，按注册顺序执行）
  injectHook(type, wrappedHook, target)
  // In addition to registering it on the target instance, we walk up the parent
  // chain and register it on all ancestor instances that are keep-alive roots.
  // This avoids the need to walk the entire component tree when invoking these
  // hooks, and more importantly, avoids the need to track child components in
  // arrays.
  if (target) {
    let current = target.parent
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current)
      }
      current = current.parent
    }
  }
}

function injectToKeepAliveRoot(
  hook: Function & { __weh?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance,
  keepAliveRoot: ComponentInternalInstance,
) {
  // injectHook wraps the original for error handling, so make sure to remove
  // the wrapped version.
  const injected = injectHook(type, hook, keepAliveRoot, true /* prepend */)
  onUnmounted(() => {
    remove(keepAliveRoot[type]!, injected)
  }, target)
}

function resetShapeFlag(vnode: VNode) {
  // bitwise operations to remove keep alive flags
  vnode.shapeFlag &= ~ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE // 移除缓存标记
  vnode.shapeFlag &= ~ShapeFlags.COMPONENT_KEPT_ALIVE // 移除已缓存标记
}

function getInnerChild(vnode: VNode) {
  // 如果是 Suspense 节点 → 返回 Suspense 内部的真实子组件 VNode
  // 否则 → 返回原始 VNode
  return vnode.shapeFlag & ShapeFlags.SUSPENSE ? vnode.ssContent! : vnode
}
