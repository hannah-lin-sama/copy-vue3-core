const escapeRE = /["'&<>]/

/**
 * 将 HTML 特殊字符转义为对应 HTML 实体
 * 防止 XSS（跨站脚本）攻击，并确保 HTML 内容能被正确解析
 * @param string
 * @returns
 */
export function escapeHtml(string: unknown): string {
  const str = '' + string

  // 匹配特殊字符“ 双引号、'单引号、 & < 左尖括号、右尖括号 >
  const match = escapeRE.exec(str)

  if (!match) {
    return str
  }

  let html = ''
  let escaped: string
  let index: number
  let lastIndex = 0
  for (index = match.index; index < str.length; index++) {
    switch (str.charCodeAt(index)) {
      case 34: // "
        escaped = '&quot;'
        break
      case 38: // &
        escaped = '&amp;'
        break
      case 39: // '
        escaped = '&#39;'
        break
      case 60: // <
        escaped = '&lt;'
        break
      case 62: // >
        escaped = '&gt;'
        break
      default:
        continue
    }

    if (lastIndex !== index) {
      html += str.slice(lastIndex, index)
    }

    lastIndex = index + 1
    html += escaped
  }

  return lastIndex !== index ? html + str.slice(lastIndex, index) : html
}

// https://www.w3.org/TR/html52/syntax.html#comments
const commentStripRE = /^-?>|<!--|-->|--!>|<!-$/g

export function escapeHtmlComment(src: string): string {
  return src.replace(commentStripRE, '')
}

export const cssVarNameEscapeSymbolsRE: RegExp =
  /[ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g

export function getEscapedCssVarName(
  key: string,
  doubleEscape: boolean,
): string {
  return key.replace(cssVarNameEscapeSymbolsRE, s =>
    doubleEscape ? (s === '"' ? '\\\\\\"' : `\\\\${s}`) : `\\${s}`,
  )
}
