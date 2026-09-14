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
 * 判断「新建文件夹」输入的名称是否可用。
 *
 * 只做即时可用性判断（用于禁用提交按钮），故意宽松：不知道后端跑在哪个平台，
 * Windows 保留名/保留字符一类的权威校验交给 `POST /api/fs/mkdir`。
 *
 * @param raw 原始输入（允许首尾空白）。
 * @returns 非空、不含路径分隔符、不是 `.` / `..` 时为 true。
 */
export function isValidDirName(raw: string): boolean {
  const value = raw.trim()
  if (!value) return false
  if (value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\')) return false
  return true
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
