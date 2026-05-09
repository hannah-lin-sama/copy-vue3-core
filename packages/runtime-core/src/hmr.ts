/* eslint-disable no-restricted-globals */
import {
  type ClassComponent,
  type ComponentInternalInstance,
  type ComponentOptions,
  type ConcreteComponent,
  type InternalRenderFunction,
  isClassComponent,
} from './component'
import { SchedulerJobFlags, queueJob, queuePostFlushCb } from './scheduler'
import { extend, getGlobalThis } from '@vue/shared'

type HMRComponent = ComponentOptions | ClassComponent

export let isHmrUpdating = false

export const hmrDirtyComponents: Map<
  ConcreteComponent,
  Set<ComponentInternalInstance>
> = new Map<ConcreteComponent, Set<ComponentInternalInstance>>()

export interface HMRRuntime {
  createRecord: typeof createRecord
  rerender: typeof rerender
  reload: typeof reload
}

// Expose the HMR runtime on the global object
// This makes it entirely tree-shakable without polluting the exports and makes
// it easier to be used in toolings like vue-loader
// Note: for a component to be eligible for HMR it also needs the __hmrId option
// to be set so that its instances can be registered / removed.
if (__DEV__) {
  getGlobalThis().__VUE_HMR_RUNTIME__ = {
    createRecord: tryWrap(createRecord),
    rerender: tryWrap(rerender),
    reload: tryWrap(reload),
  } as HMRRuntime
}

const map: Map<
  string, // 组件的 HMR 唯一标识符
  {
    // the initial component definition is recorded on import - this allows us
    // to apply hot updates to the component even when there are no actively
    // rendered instance.
    initialDef: ComponentOptions // 组件的初始定义对象
    instances: Set<ComponentInternalInstance> // 该组件的所有活跃实例
  }
> = new Map()

/**
 * 注册组件实例到 HMR 系统中
 * @param instance
 */
export function registerHMR(instance: ComponentInternalInstance): void {
  // 从组件类型中获取 __hmrId 属性，这是一个唯一标识符，用于标识组件
  const id = instance.type.__hmrId!
  let record = map.get(id)
  if (!record) {
    // 调用 createRecord 函数创建一个新记录
    createRecord(id, instance.type as HMRComponent)
    record = map.get(id)!
  }
  // 将当前组件实例添加到记录的 instances 集合中
  record.instances.add(instance)
}

export function unregisterHMR(instance: ComponentInternalInstance): void {
  map.get(instance.type.__hmrId!)!.instances.delete(instance)
}

function createRecord(id: string, initialDef: HMRComponent): boolean {
  if (map.has(id)) {
    return false
  }
  map.set(id, {
    initialDef: normalizeClassComponent(initialDef),
    instances: new Set(),
  })
  return true
}

function normalizeClassComponent(component: HMRComponent): ComponentOptions {
  return isClassComponent(component) ? component.__vccOpts : component
}

/**
 * 更新组件的渲染函数并重新渲染组件实例
 * @param id 组件的 HMR ID，类型为 string
 * @param newRender 可选的新渲染函数，类型为 Function
 * @returns
 */
function rerender(id: string, newRender?: Function): void {
  const record = map.get(id)
  // 防御性检查：确保组件记录存在，避免空指针异常
  if (!record) {
    return
  }

  // update initial record (for not-yet-rendered component)
  // 更新初始记录的 render 方法，确保尚未渲染的组件也能使用新的渲染函数
  record.initialDef.render = newRender

  // Create a snapshot which avoids the set being mutated during updates
  ;[...record.instances].forEach(instance => {
    if (newRender) {
      // 新实例的 render 方法
      instance.render = newRender as InternalRenderFunction
      // 更新组件类型定义的 render 方法，确保一致性
      normalizeClassComponent(instance.type as HMRComponent).render = newRender
    }
    // 清空实例的渲染缓存
    instance.renderCache = []
    // this flag forces child components with slot content to update
    isHmrUpdating = true
    // #13771 don't update if the job is already disposed
    if (!(instance.job.flags! & SchedulerJobFlags.DISPOSED)) {
      // 强制重新渲染
      instance.update()
    }
    isHmrUpdating = false
  })
}

/**
 * 在开发过程中更新组件定义并重新渲染组件，而无需完全刷新页面
 * @param id 组件的 HMR ID
 * @param newComp 新的组件定义
 * @returns
 */
function reload(id: string, newComp: HMRComponent): void {
  // 获取组件记录：从 map 中获取组件的记录
  const record = map.get(id)
  if (!record) return

  // 标准化新组件：将新组件定义标准化为类组件格式
  newComp = normalizeClassComponent(newComp)
  // update initial def (for not-yet-rendered components)
  // 更新初始定义：更新初始组件定义，确保未渲染的组件也能使用新定义
  updateComponentDef(record.initialDef, newComp)

  // create a snapshot which avoids the set being mutated during updates
  // 创建实例快照
  const instances = [...record.instances]

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i]
    const oldComp = normalizeClassComponent(instance.type as HMRComponent)

    // 从 hmrDirtyComponents 中获取脏实例集合
    let dirtyInstances = hmrDirtyComponents.get(oldComp)
    if (!dirtyInstances) {
      // 1. Update existing comp definition to match new one
      if (oldComp !== record.initialDef) {
        // 更新组件定义
        updateComponentDef(oldComp, newComp)
      }
      // 2. mark definition dirty. This forces the renderer to replace the
      // component on patch.
      // 标记组件定义为脏，强制渲染器在 patch 时替换组件
      hmrDirtyComponents.set(oldComp, (dirtyInstances = new Set()))
    }
    // 将当前实例添加到脏实例集合中
    dirtyInstances.add(instance)

    // 3. invalidate options resolution cache
    // 清除缓存
    instance.appContext.propsCache.delete(instance.type as any)
    instance.appContext.emitsCache.delete(instance.type as any)
    instance.appContext.optionsCache.delete(instance.type as any)

    // 4. actually update
    // 如果是自定义元素，调用 ceReload 方法更新样式
    if (instance.ceReload) {
      // custom element
      dirtyInstances.add(instance)
      instance.ceReload((newComp as any).styles)
      dirtyInstances.delete(instance)
    } else if (instance.parent) {
      // 4. Force the parent instance to re-render. This will cause all updated
      // components to be unmounted and re-mounted. Queue the update so that we
      // don't end up forcing the same parent to re-render multiple times.
      queueJob(() => {
        // vite-plugin-vue/issues/599
        // don't update if the job is already disposed
        if (!(instance.job.flags! & SchedulerJobFlags.DISPOSED)) {
          isHmrUpdating = true
          instance.parent!.update()
          isHmrUpdating = false
          // #6930, #11248 avoid infinite recursion
          dirtyInstances.delete(instance)
        }
      })
    } else if (instance.appContext.reload) {
      // root instance mounted via createApp() has a reload method
      instance.appContext.reload()
    } else if (typeof window !== 'undefined') {
      // root instance inside tree created via raw render(). Force reload.
      // 强制刷新页面
      window.location.reload()
    } else {
      console.warn(
        '[HMR] Root or manually mounted instance modified. Full reload required.',
      )
    }

    // update custom element child style
    if (instance.root.ce && instance !== instance.root) {
      instance.root.ce._removeChildStyle(oldComp)
    }
  }

  // 5. make sure to cleanup dirty hmr components after update
  queuePostFlushCb(() => {
    hmrDirtyComponents.clear()
  })
}

function updateComponentDef(
  oldComp: ComponentOptions,
  newComp: ComponentOptions,
) {
  extend(oldComp, newComp)
  for (const key in oldComp) {
    // 删除旧组件中存在但新组件中不存在的属性（__file 除外）
    if (key !== '__file' && !(key in newComp)) {
      delete oldComp[key]
    }
  }
}

function tryWrap(fn: (id: string, arg: any) => any): Function {
  return (id: string, arg: any) => {
    try {
      return fn(id, arg)
    } catch (e: any) {
      console.error(e)
      console.warn(
        `[HMR] Something went wrong during Vue component hot-reload. ` +
          `Full reload required.`,
      )
    }
  }
}
