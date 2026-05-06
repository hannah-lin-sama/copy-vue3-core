import type { SuspenseBoundary } from './components/Suspense'
import type {
  VNode,
  VNodeNormalizedRef,
  VNodeNormalizedRefAtom,
  VNodeRef,
} from './vnode'
import {
  EMPTY_OBJ,
  NO,
  ShapeFlags,
  hasOwn,
  isArray,
  isFunction,
  isString,
  remove,
} from '@vue/shared'
import { isAsyncWrapper } from './apiAsyncComponent'
import { warn } from './warning'
import { isRef, toRaw } from '@vue/reactivity'
import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { type SchedulerJob, SchedulerJobFlags } from './scheduler'
import { queuePostRenderEffect } from './renderer'
import { type ComponentOptions, getComponentPublicInstance } from './component'
import { isTemplateRefKey, knownTemplateRefs } from './helpers/useTemplateRef'

// 存储待处理的模板引用设置任务
const pendingSetRefMap = new WeakMap<VNodeNormalizedRef, SchedulerJob>()
/**
 * Function for handling a template ref
 * 设置、更新或卸载模板引用。它支持多种类型的 ref（字符串、函数、ref 对象）
 */
export function setRef(
  rawRef: VNodeNormalizedRef, // 当前 VNode 的 ref 信息
  oldRawRef: VNodeNormalizedRef | null, // 旧 VNode 的 ref 信息
  parentSuspense: SuspenseBoundary | null, // 父级 Suspense 边界
  vnode: VNode, // 当前 VNode
  isUnmount = false, // 是否为卸载操作
): void {
  if (isArray(rawRef)) {
    rawRef.forEach((r, i) =>
      setRef(
        r,
        oldRawRef && (isArray(oldRawRef) ? oldRawRef[i] : oldRawRef),
        parentSuspense,
        vnode,
        isUnmount,
      ),
    )
    return
  }

  // 异步组件的处理
  if (isAsyncWrapper(vnode) && !isUnmount) {
    // #4999 if an async component already resolved and cached by KeepAlive,
    // we need to set the ref to inner component
    // 特殊情况：如果异步组件已解析并被 KeepAlive 缓存，需要将 ref 设置到内部组件
    if (
      vnode.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE &&
      (vnode.type as ComponentOptions).__asyncResolved &&
      vnode.component!.subTree.component
    ) {
      setRef(rawRef, oldRawRef, parentSuspense, vnode.component!.subTree)
    }

    // otherwise, nothing needs to be done because the template ref
    // is forwarded to inner component
    return
  }

  const refValue =
    vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT
      ? // 对于有状态组件，获取其公共实例
        getComponentPublicInstance(vnode.component!)
      : // 对于普通元素，获取其 DOM 元素
        vnode.el
  const value = isUnmount ? null : refValue

  const { i: owner, r: ref } = rawRef
  if (__DEV__ && !owner) {
    warn(
      `Missing ref owner context. ref cannot be used on hoisted vnodes. ` +
        `A vnode with ref must be created inside the render function.`,
    )
    return
  }
  const oldRef = oldRawRef && (oldRawRef as VNodeNormalizedRefAtom).r
  const refs = owner.refs === EMPTY_OBJ ? (owner.refs = {}) : owner.refs
  const setupState = owner.setupState
  const rawSetupState = toRaw(setupState)

  // 检查是否可以设置 setup ref
  const canSetSetupRef =
    setupState === EMPTY_OBJ
      ? NO
      : (key: string) => {
          if (__DEV__) {
            if (hasOwn(rawSetupState, key) && !isRef(rawSetupState[key])) {
              // 提示模板引用被用在非 ref 值上，在生产构建中不会工作
              warn(
                `Template ref "${key}" used on a non-ref value. ` +
                  `It will not work in the production build.`,
              )
            }

            if (knownTemplateRefs.has(rawSetupState[key] as any)) {
              return false
            }
          }

          // skip setting up ref if the key is from useTemplateRef
          if (isTemplateRefKey(refs, key)) {
            return false
          }

          return hasOwn(rawSetupState, key)
        }

  // 检查是否可以设置 ref
  const canSetRef = (ref: VNodeRef, key?: string) => {
    // 条件：
    // ref 不在 knownTemplateRefs 中
    // 如果有 key，检查 key 是否来自 useTemplateRef
    if (__DEV__ && knownTemplateRefs.has(ref as any)) {
      return false
    }
    if (key && isTemplateRefKey(refs, key)) {
      return false
    }
    return true
  }

  // dynamic ref changed. unset old ref
  // 当旧引用存在且与新引用不同时，执行更新逻辑
  if (oldRef != null && oldRef !== ref) {
    // 取消之前可能存在的待处理的引用设置任务
    // 原因：当引用发生变化时，需要确保之前的设置操作不会执行，避免状态不一致
    invalidatePendingSetRef(oldRawRef!)
    // 1、字符串引用的处理
    if (isString(oldRef)) {
      refs[oldRef] = null
      if (canSetSetupRef(oldRef)) {
        setupState[oldRef] = null
      }
      // 2、ref 对象的处理
    } else if (isRef(oldRef)) {
      // this type assertion is valid since `oldRef` has already been asserted to be non-null
      const oldRawRefAtom = oldRawRef as VNodeNormalizedRefAtom
      if (canSetRef(oldRef, oldRawRefAtom.k)) {
        oldRef.value = null
      }
      if (oldRawRefAtom.k) refs[oldRawRefAtom.k] = null
    }
  }

  if (isFunction(ref)) {
    callWithErrorHandling(ref, owner, ErrorCodes.FUNCTION_REF, [value, refs])
  } else {
    const _isString = isString(ref)
    const _isRef = isRef(ref)

    if (_isString || _isRef) {
      const doSet = () => {
        if (rawRef.f) {
          const existing = _isString
            ? canSetSetupRef(ref)
              ? setupState[ref]
              : refs[ref]
            : canSetRef(ref) || !rawRef.k
              ? ref.value
              : refs[rawRef.k]
          if (isUnmount) {
            isArray(existing) && remove(existing, refValue)
          } else {
            if (!isArray(existing)) {
              if (_isString) {
                refs[ref] = [refValue]
                if (canSetSetupRef(ref)) {
                  setupState[ref] = refs[ref]
                }
              } else {
                const newVal = [refValue]
                if (canSetRef(ref, rawRef.k)) {
                  ref.value = newVal
                }
                if (rawRef.k) refs[rawRef.k] = newVal
              }
            } else if (!existing.includes(refValue)) {
              existing.push(refValue)
            }
          }
        } else if (_isString) {
          refs[ref] = value
          if (canSetSetupRef(ref)) {
            setupState[ref] = value
          }
        } else if (_isRef) {
          if (canSetRef(ref, rawRef.k)) {
            ref.value = value
          }
          if (rawRef.k) refs[rawRef.k] = value
        } else if (__DEV__) {
          warn('Invalid template ref type:', ref, `(${typeof ref})`)
        }
      }
      if (value) {
        // #1789: for non-null values, set them after render
        // null values means this is unmount and it should not overwrite another
        // ref with the same key
        const job: SchedulerJob = () => {
          doSet()
          pendingSetRefMap.delete(rawRef)
        }
        job.id = -1
        pendingSetRefMap.set(rawRef, job)
        queuePostRenderEffect(job, parentSuspense)
      } else {
        invalidatePendingSetRef(rawRef)
        doSet()
      }
    } else if (__DEV__) {
      warn('Invalid template ref type:', ref, `(${typeof ref})`)
    }
  }
}

function invalidatePendingSetRef(rawRef: VNodeNormalizedRef) {
  const pendingSetRef = pendingSetRefMap.get(rawRef)
  if (pendingSetRef) {
    pendingSetRef.flags! |= SchedulerJobFlags.DISPOSED // 标记为已处置
    pendingSetRefMap.delete(rawRef) // 从映射中删除，释放内存
  }
}
