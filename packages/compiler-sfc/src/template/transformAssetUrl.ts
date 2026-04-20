import path from 'path'
import {
  ConstantTypes,
  type ExpressionNode,
  type NodeTransform,
  NodeTypes,
  type SimpleExpressionNode,
  type SourceLocation,
  type TransformContext,
  createSimpleExpression,
} from '@vue/compiler-core'
import {
  isDataUrl,
  isExternalUrl,
  isRelativeUrl,
  parseUrl,
} from './templateUtils'
import { isArray } from '@vue/shared'

export interface AssetURLTagConfig {
  [name: string]: string[]
}

export interface AssetURLOptions {
  /**
   * If base is provided, instead of transforming relative asset urls into
   * imports, they will be directly rewritten to absolute urls.
   * 指定基础 URL
   * 如果提供了 base，相对资产 URL 不会被转换为导入，而是直接重写为绝对 URL
   */
  base?: string | null
  /**
   * If true, also processes absolute urls.
   * 控制是否处理绝对 URL
   * 如果为 true，不仅处理相对 URL，还会处理绝对 URL
   */
  includeAbsolute?: boolean
  // 指定需要处理资产 URL 的标签和属性配置
  // 自定义哪些标签的哪些属性需要处理资产 URL
  tags?: AssetURLTagConfig
}

// 定义模板中资产 URL 的默认处理方式
export const defaultAssetUrlOptions: Required<AssetURLOptions> = {
  // 默认不设置基础 URL，相对资产 URL 会被转换为 ES 模块导入
  base: null,
  // 默认只处理相对 URL，不处理绝对 URL
  includeAbsolute: false,
  tags: {
    video: ['src', 'poster'], // 视频源和封面图
    source: ['src'], // 媒体源
    img: ['src'], // 图片源
    image: ['xlink:href', 'href'], // SVG 图片源
    use: ['xlink:href', 'href'], // SVG 复用元素
  },
}

export const normalizeOptions = (
  options: AssetURLOptions | AssetURLTagConfig,
): Required<AssetURLOptions> => {
  // 检查 options 对象的键是否有值为数组的情况
  if (Object.keys(options).some(key => isArray((options as any)[key]))) {
    // legacy option format which directly passes in tags config
    // 如果有，认为是旧的选项格式（直接传入 tags 配置）
    return {
      ...defaultAssetUrlOptions,
      tags: options as any,
    }
  }
  return {
    ...defaultAssetUrlOptions,
    ...options,
  }
}

export const createAssetUrlTransformWithOptions = (
  options: Required<AssetURLOptions>,
): NodeTransform => {
  return (node, context) =>
    (transformAssetUrl as Function)(node, context, options)
}

/**
 * A `@vue/compiler-core` plugin that transforms relative asset urls into
 * either imports or absolute urls.
 *
 * ``` js
 * // Before
 * createVNode('img', { src: './logo.png' })
 *
 * // After
 * import _imports_0 from './logo.png'
 * createVNode('img', { src: _imports_0 })
 * ```
 */
export const transformAssetUrl: NodeTransform = (
  node,
  context,
  options: AssetURLOptions = defaultAssetUrlOptions,
) => {
  if (node.type === NodeTypes.ELEMENT) {
    // 只处理元素类型节点，且节点必须有属性
    if (!node.props.length) {
      return
    }

    const tags = options.tags || defaultAssetUrlOptions.tags
    const attrs = tags[node.tag] // 获取当前标签的属性配置
    const wildCardAttrs = tags['*'] // 通配符属性配置
    if (!attrs && !wildCardAttrs) {
      return
    }

    // 合并当前标签的属性配置和通配符属性配置
    const assetAttrs = (attrs || []).concat(wildCardAttrs || [])
    // 遍历元素节点的所有属性
    node.props.forEach((attr, index) => {
      // 过滤
      if (
        attr.type !== NodeTypes.ATTRIBUTE ||
        !assetAttrs.includes(attr.name) ||
        !attr.value ||
        isExternalUrl(attr.value.content) ||
        isDataUrl(attr.value.content) ||
        attr.value.content[0] === '#' ||
        (!options.includeAbsolute && !isRelativeUrl(attr.value.content))
      ) {
        return
      }

      const url = parseUrl(attr.value.content)

      // 当配置了 base 且 URL 是相对路径时
      if (options.base && attr.value.content[0] === '.') {
        // explicit base - directly rewrite relative urls into absolute url
        // to avoid generating extra imports
        // Allow for full hostnames provided in options.base
        const base = parseUrl(options.base)
        const protocol = base.protocol || ''
        const host = base.host ? protocol + '//' + base.host : ''
        const basePath = base.path || '/'

        // when packaged in the browser, path will be using the posix-
        // only version provided by rollup-plugin-node-builtins.
        attr.value.content =
          host +
          (path.posix || path).join(basePath, url.path + (url.hash || ''))
        return
      }

      // 导入表达式转换
      // otherwise, transform the url into an import.
      // this assumes a bundler will resolve the import into the correct
      // absolute url (e.g. webpack file-loader)
      const exp = getImportsExpressionExp(url.path, url.hash, attr.loc, context)
      node.props[index] = {
        type: NodeTypes.DIRECTIVE,
        name: 'bind',
        arg: createSimpleExpression(attr.name, true, attr.loc),
        exp,
        modifiers: [],
        loc: attr.loc,
      }
    })
  }
}

/**
 * 生成资源导入表达式
 * @param path
 * @param hash
 * @param loc
 * @param context
 * @returns
 */
function getImportsExpressionExp(
  path: string | null,
  hash: string | null,
  loc: SourceLocation,
  context: TransformContext,
): ExpressionNode {
  if (path) {
    let name: string
    let exp: SimpleExpressionNode

    // 检查是否已经导入过相同路径的资源
    const existingIndex = context.imports.findIndex(i => i.path === path)
    if (existingIndex > -1) {
      // 如果已导入，使用已有的导入名称和表达式
      name = `_imports_${existingIndex}`
      exp = context.imports[existingIndex].exp as SimpleExpressionNode
    } else {
      // 创建新的导入名称和表达式，并将其添加到上下文的导入列表中
      name = `_imports_${context.imports.length}`
      exp = createSimpleExpression(
        name,
        false,
        loc,
        ConstantTypes.CAN_STRINGIFY,
      )

      // We need to ensure the path is not encoded (to %2F),
      // so we decode it back in case it is encoded
      context.imports.push({
        exp,
        // 对路径进行解码，确保路径不被编码（如 %2F）
        path: decodeURIComponent(path),
      })
    }

    // 如果没有哈希部分，直接返回导入表达式
    if (!hash) {
      return exp
    }

    // 如果有哈希部分，创建一个拼接哈希的表达式
    const hashExp = `${name} + '${hash}'`
    const finalExp = createSimpleExpression(
      hashExp,
      false,
      loc,
      ConstantTypes.CAN_STRINGIFY,
    )

    if (!context.hoistStatic) {
      return finalExp
    }

    // 检查是否已经提升过相同的表达式
    const existingHoistIndex = context.hoists.findIndex(h => {
      return (
        h &&
        h.type === NodeTypes.SIMPLE_EXPRESSION &&
        !h.isStatic &&
        h.content === hashExp
      )
    })

    // 如果已提升，使用已有的提升变量
    if (existingHoistIndex > -1) {
      return createSimpleExpression(
        `_hoisted_${existingHoistIndex + 1}`,
        false,
        loc,
        ConstantTypes.CAN_STRINGIFY,
      )
    }
    // 如果未提升，将表达式提升到渲染函数外部，并返回提升后的变量
    return context.hoist(finalExp)
  } else {
    // 如果没有提供路径，返回空字符串表达式
    return createSimpleExpression(`''`, false, loc, ConstantTypes.CAN_STRINGIFY)
  }
}
