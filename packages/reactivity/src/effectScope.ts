import type { ReactiveEffect } from './effect'
import { warn } from './warning'

// 当前活跃的 EffectScope 实例
export let activeEffectScope: EffectScope | undefined

export class EffectScope {
  /**
   * @internal
   * 标记作用域是否激活
   */
  private _active = true
  /**
   * @internal track `on` calls, allow `on` call multiple times
   * 跟踪 on 调用次数，用于支持多次调用 on 方法
   */
  private _on = 0
  /**
   * @internal
   * 存储作用域内创建的所有 ReactiveEffect 实例
   */
  effects: ReactiveEffect[] = []
  /**
   * @internal
   * 存储作用域的清理函数
   */
  cleanups: (() => void)[] = []

  // 标记作用域是否暂停
  private _isPaused = false

  /**
   * only assigned by undetached scope
   * 指向父作用域（仅非分离作用域）
   * @internal
   */
  parent: EffectScope | undefined
  /**
   * record undetached scopes
   * 存储子作用域（仅非分离作用域）
   * @internal
   */
  scopes: EffectScope[] | undefined
  /**
   * track a child scope's index in its parent's scopes array for optimized
   * removal
   * 在父作用域的 scopes 数组中的索引，用于优化移除操作
   * @internal
   */
  private index: number | undefined

  readonly __v_skip = true // 跳过对该对象的响应式处理
  // TODO isolatedDeclarations ReactiveFlags.SKIP

  constructor(public detached = false) {
    // 设置父作用域为当前活跃作用域
    this.parent = activeEffectScope

    // 不是分离作用域、有活跃作用域
    if (!detached && activeEffectScope) {
      // 将当前作用域添加到父作用域的 scopes 数组中
      // 记录在父作用域中的索引
      this.index =
        (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this,
        ) - 1 /// 需要减1，因为数组索引从0开始
    }
  }

  get active(): boolean {
    return this._active
  }

  pause(): void {
    if (this._active) {
      this._isPaused = true
      let i, l
      if (this.scopes) {
        for (i = 0, l = this.scopes.length; i < l; i++) {
          this.scopes[i].pause()
        }
      }
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].pause()
      }
    }
  }

  /**
   * Resumes the effect scope, including all child scopes and effects.
   */
  resume(): void {
    if (this._active) {
      if (this._isPaused) {
        this._isPaused = false
        let i, l
        if (this.scopes) {
          for (i = 0, l = this.scopes.length; i < l; i++) {
            this.scopes[i].resume()
          }
        }
        for (i = 0, l = this.effects.length; i < l; i++) {
          this.effects[i].resume()
        }
      }
    }
  }

  run<T>(fn: () => T): T | undefined {
    if (this._active) {
      const currentEffectScope = activeEffectScope
      try {
        // 设置当前活跃作用域为当前作用域
        activeEffectScope = this
        return fn()
      } finally {
        // 恢复当前活跃作用域
        activeEffectScope = currentEffectScope
      }
    } else if (__DEV__) {
      warn(`cannot run an inactive effect scope.`)
    }
  }

  // 指向上一个作用域（仅非分离作用域）
  prevScope: EffectScope | undefined
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  on(): void {
    // 增加 on 调用次数
    if (++this._on === 1) {
      // 如果是第一次调用 on 方法，将当前作用域设置为 prevScope
      this.prevScope = activeEffectScope
      activeEffectScope = this
    }
  }

  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  off(): void {
    // 减少 on 调用次数
    // 如果是最后一次调用 on 方法，将 prevScope 设置为当前活跃域
    if (this._on > 0 && --this._on === 0) {
      activeEffectScope = this.prevScope
      this.prevScope = undefined
    }
  }

  stop(fromParent?: boolean): void {
    if (this._active) {
      this._active = false
      let i, l
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].stop()
      }
      this.effects.length = 0

      for (i = 0, l = this.cleanups.length; i < l; i++) {
        this.cleanups[i]()
      }
      this.cleanups.length = 0

      if (this.scopes) {
        for (i = 0, l = this.scopes.length; i < l; i++) {
          this.scopes[i].stop(true)
        }
        this.scopes.length = 0
      }

      // nested scope, dereference from parent to avoid memory leaks
      if (!this.detached && this.parent && !fromParent) {
        // optimized O(1) removal
        const last = this.parent.scopes!.pop()
        if (last && last !== this) {
          this.parent.scopes![this.index!] = last
          last.index = this.index!
        }
      }
      this.parent = undefined
    }
  }
}

/**
 * Creates an effect scope object which can capture the reactive effects (i.e.
 * computed and watchers) created within it so that these effects can be
 * disposed together. For detailed use cases of this API, please consult its
 * corresponding {@link https://github.com/vuejs/rfcs/blob/master/active-rfcs/0041-reactivity-effect-scope.md | RFC}.
 *
 * @param detached - Can be used to create a "detached" effect scope.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#effectscope}
 */
export function effectScope(detached?: boolean): EffectScope {
  // detached 为 false：新创建的作用域会成为当前活跃作用域的子作用域
  // detached 为 true：新创建的作用域是一个独立的、分离的作用域，不会成为当前活跃作用域的子作用域
  return new EffectScope(detached)
}

/**
 * Returns the current active effect scope if there is one.
 * 获取当前活跃的 EffectScope 实例
 *
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#getcurrentscope}
 */
export function getCurrentScope(): EffectScope | undefined {
  return activeEffectScope
}

/**
 * Registers a dispose callback on the current active effect scope. The
 * callback will be invoked when the associated effect scope is stopped.
 *
 * @param fn - The callback function to attach to the scope's cleanup.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#onscopedispose}
 */
export function onScopeDispose(fn: () => void, failSilently = false): void {
  if (activeEffectScope) {
    activeEffectScope.cleanups.push(fn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onScopeDispose() is called when there is no active effect scope` +
        ` to be associated with.`,
    )
  }
}
