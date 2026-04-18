import { NodeOpTypes, type TestElement, logNodeOp } from './nodeOps'
import { isOn } from '@vue/shared'

export function patchProp(
  el: TestElement,
  key: string,
  prevValue: any,
  nextValue: any,
): void {
  logNodeOp({
    type: NodeOpTypes.PATCH,
    targetNode: el,
    propKey: key,
    propPrevValue: prevValue,
    propNextValue: nextValue,
  })
  el.props[key] = nextValue
  if (isOn(key)) {
    // 如果键名的第三个字符是 :（如 on:click），则从第四个字符开始截取事件名
    // 否则（如 onClick），从第三个字符开始截取并转换为小写
    const event = key[2] === ':' ? key.slice(3) : key.slice(2).toLowerCase()
    // 存储事件监听器
    ;(el.eventListeners || (el.eventListeners = {}))[event] = nextValue
  }
}
