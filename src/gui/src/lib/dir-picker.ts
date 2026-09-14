/**
 * 目录选择器的纯路径逻辑。
 *
 * 浏览器端没有 `node:path` 可用，且后端可能运行在 Windows 上——所有拼接都必须
 * 使用后端 `GET /api/fs/list` 返回的 `sep`，禁止硬编码 `/`。
 */

export interface BreadcrumbSegment {
  /** 展示用的短名；根段展示为 `/` 或 `C:`。 */
  label: string
  /** 点击该段应跳转到的绝对路径。 */
  path: string
}

/**
 * 把绝对路径拆成可逐级点击回退的面包屑。
 *
 * @param path 绝对路径；win32 盘符列表层传空串。
 * @param sep 后端返回的平台分隔符。
 * @returns 从根到当前目录的面包屑段；空串返回空数组。
 */
export function splitBreadcrumb(path: string, sep: string): BreadcrumbSegment[] {
  if (!path) return []

  if (sep === '\\') {
    const unc = /^\\\\([^\\]+)\\([^\\]+)(.*)$/.exec(path)
    if (unc) {
      const root = `\\\\${unc[1]}\\${unc[2]}`
      return [{ label: root, path: root }, ...appendSegments(root, unc[3] ?? '', sep)]
    }
    const drive = /^([A-Za-z]:)\\?(.*)$/.exec(path)
    if (drive) {
      const letter = drive[1]!
      return [
        { label: letter, path: `${letter}\\` },
        ...appendSegments(`${letter}\\`, drive[2] ?? '', sep),
      ]
    }
    return []
  }

  return [{ label: sep, path: sep }, ...appendSegments(sep, path.slice(1), sep)]
}

/**
 * 拼出子目录的绝对路径。
 *
 * @param parent 父目录绝对路径。
 * @param name 子目录名。
 * @param sep 后端返回的平台分隔符。
 * @returns 子目录绝对路径；父目录已以分隔符结尾（盘符根 `C:\`、POSIX 根 `/`）时不重复插入。
 */
export function joinDir(parent: string, name: string, sep: string): string {
  if (!parent) return name
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

/**
 * 判断用户手输/粘贴的字符串是否为绝对路径。
 *
 * 同时接受 POSIX（`/foo`）、win32 盘符（`C:\foo`、`c:/foo`）与 UNC（`\\server\share`），
 * 因为前端不知道后端跑在哪个平台，宽松放行、由后端做权威校验。
 *
 * @param raw 原始输入。
 * @returns 形如绝对路径时为 true。
 */
export function isAbsolutePathInput(raw: string): boolean {
  const value = raw.trim()
  if (!value) return false
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

function appendSegments(root: string, rest: string, sep: string): BreadcrumbSegment[] {
  const parts = rest.split(sep).filter(Boolean)
  const out: BreadcrumbSegment[] = []
  let current = root
  for (const part of parts) {
    current = joinDir(current, part, sep)
    out.push({ label: part, path: current })
  }
  return out
}
