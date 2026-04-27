import { getCurrentInstance, warn } from '@vue/runtime-core'
import { EMPTY_OBJ } from '@vue/shared'

/**
 * 获取 CSS 模块
 * @param name CSS 模块名称
 * @returns
 */
export function useCssModule(name = '$style'): Record<string, string> {
  if (!__GLOBAL__) {
    const instance = getCurrentInstance()!

    // 不在 setup() 中调用，发出警告并返回空对象
    if (!instance) {
      __DEV__ && warn(`useCssModule must be called inside setup()`)
      return EMPTY_OBJ
    }
    const modules = instance.type.__cssModules
    // 没有 CSS 模块，发出警告并返回空对象
    if (!modules) {
      __DEV__ && warn(`Current instance does not have CSS modules injected.`)
      return EMPTY_OBJ
    }
    const mod = modules[name]
    // 如果指定名称的模块不存在，发出警告
    if (!mod) {
      __DEV__ &&
        warn(`Current instance does not have CSS module named "${name}".`)
      return EMPTY_OBJ
    }
    return mod as Record<string, string>
  } else {
    // 全局构建不支持 useCssModule()
    /* v8 ignore start */
    if (__DEV__) {
      warn(`useCssModule() is not supported in the global build.`)
    }
    return EMPTY_OBJ
    /* v8 ignore stop */
  }
}
