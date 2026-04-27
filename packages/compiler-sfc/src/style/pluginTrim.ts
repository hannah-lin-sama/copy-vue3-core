import type { PluginCreator } from 'postcss'

/**
 * 处理 CSS 根节点时执行一次性的操作。
 * 具体来说，这个函数的功能是标准化 CSS 规则和 @规则周围的空白，确保它们前后都只有一个换行符
 * @returns
 */
const trimPlugin: PluginCreator<{}> = () => {
  return {
    postcssPlugin: 'vue-sfc-trim',
    Once(root) {
      // 遍历 CSS 根节点下的所有节点
      root.walk(({ type, raws }) => {
        // 检查节点类型是否为 rule（规则，如 .class { ... }）或 atrule（@规则，如 @media { ... }）
        if (type === 'rule' || type === 'atrule') {
          // 设置为单个换行符 '\n'
          if (raws.before) raws.before = '\n'
          // 设置为单个换行符 '\n'
          if ('after' in raws && raws.after) raws.after = '\n'
        }
      })
    },
  }
}

trimPlugin.postcss = true
export default trimPlugin
