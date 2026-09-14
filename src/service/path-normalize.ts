import { posix as posixPath, win32 as win32Path } from 'node:path'

/**
 * 把绝对路径归一化成可作为「项目身份」的唯一形态。
 *
 * win32 上同一个目录能写成 `C:\Repo`、`c:/repo`、`C:\.\Repo\` 等多种字面量，
 * 而 `generateProjectId` 直接 hash 原始字符串、`addProject` 按字符串去重，
 * 于是同一目录会被注册成多个项目。这里在**入口**统一：`resolve` 折叠
 * `.`/`..` 并把 `/` 换成 `\`，再把盘符大写，保证 GUI 点选与 CLI 手输殊途同归。
 *
 * POSIX 保持大小写敏感（`/Repo` 与 `/repo` 是两个目录），只做 `resolve`。
 *
 * @param input 待归一化的路径；相对路径会基于 `cwd` 解析。
 * @param platform 目标平台；默认当前运行平台，测试可显式注入。
 * @param cwd 相对路径的解析基准，默认 `process.cwd()`。
 * @returns 归一化后的绝对路径。
 */
export function normalizeAbsPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string {
  const trimmed = input.trim()
  if (platform !== 'win32') return posixPath.resolve(cwd, trimmed)

  // UNC（`\\server\share`）没有盘符，resolve 已能正确保留前导双反斜杠。
  const resolved = win32Path.resolve(cwd, trimmed)
  return upperDriveLetter(resolved)
}

/**
 * 判断两个绝对路径是否指向同一目录。
 *
 * win32 文件系统大小写不敏感，`C:\Repo` 与 `c:\repo` 是同一个目录；POSIX 下
 * 大小写敏感，必须逐字符比较。
 *
 * @param a 左侧路径。
 * @param b 右侧路径。
 * @param platform 目标平台；默认当前运行平台，测试可显式注入。
 * @returns 两者指向同一目录时为 true。
 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return a === b
  return a.toLowerCase() === b.toLowerCase()
}

/** `c:\foo` → `C:\foo`；非盘符开头（含 UNC）原样返回。 */
function upperDriveLetter(p: string): string {
  if (/^[a-z]:/.test(p)) return p[0]!.toUpperCase() + p.slice(1)
  return p
}
