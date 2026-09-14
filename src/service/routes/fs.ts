import { Hono } from 'hono'
import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { posix as posixPath, win32 as win32Path } from 'node:path'
import { normalizeAbsPath } from '../path-normalize.js'

/** 单次列举返回的目录条目上限；`node_modules` 这类超大目录会被截断。 */
const MAX_ENTRIES = 1000

/** win32 下「盘符列表」这一虚拟层级的路径表示。 */
export const WIN_DRIVE_ROOT = ''

export interface FsListEntry {
  name: string
  path: string
}

export interface FsListResult {
  /** 归一化后的当前目录绝对路径；win32 盘符列表层为空串。 */
  path: string
  /** 上级目录；已在根（或盘符列表层）时为 null。 */
  parent: string | null
  /** 平台分隔符，前端拼路径必须用它。 */
  sep: string
  /** 仅目录，已按名称升序排序。 */
  entries: FsListEntry[]
  /** 是否因 {@link MAX_ENTRIES} 上限被截断。 */
  truncated: boolean
}

export interface FsRoutesDeps {
  homedir?: () => string
  platform?: NodeJS.Platform
}

/**
 * 只读目录浏览路由，供 GUI 的目录选择器使用。
 *
 * 刻意**不复用** `prepareProjectDir`：后者会 `mkdir .yorz/specs`，而浏览任意目录
 * 时绝不能产生副作用。本路由只做 `isAbsolute` → 归一化 → `stat` 校验。
 *
 * @param deps 平台与 home 目录注入点，便于在非 Windows 上测试 win32 分支。
 * @returns 挂载了 `GET /fs/list` 的 Hono 实例。
 */
export function createFsRoutes(deps: FsRoutesDeps = {}): Hono {
  const platform = deps.platform ?? process.platform
  const homedir = deps.homedir ?? osHomedir
  const isWin = platform === 'win32'
  const p = isWin ? win32Path : posixPath

  const app = new Hono()

  app.get('/fs/list', async (c) => {
    const rawPath = c.req.query('path')
    const showHidden = c.req.query('showHidden') === '1'

    // 缺省回到用户主目录；win32 下显式传空串表示「盘符列表层」。
    const wantsDriveRoot = isWin && rawPath !== undefined && rawPath.trim() === ''
    if (wantsDriveRoot) {
      const drives = await listWindowsDrives()
      return c.json<FsListResult>({
        path: WIN_DRIVE_ROOT,
        parent: null,
        sep: p.sep,
        entries: drives,
        truncated: false,
      })
    }

    const target = rawPath === undefined || !rawPath.trim() ? homedir() : rawPath
    if (!p.isAbsolute(target.trim())) {
      return c.json({ error: 'path must be absolute' }, 400)
    }
    const dir = normalizeAbsPath(target, platform)

    let stats
    try {
      stats = await stat(dir)
    } catch (err) {
      return c.json({ error: describeFsError(err, dir) }, 400)
    }
    if (!stats.isDirectory()) {
      return c.json({ error: `path is not a directory: ${dir}` }, 400)
    }

    let rawEntries
    try {
      rawEntries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      return c.json({ error: describeFsError(err, dir) }, 400)
    }

    const dirs: FsListEntry[] = []
    for (const entry of rawEntries) {
      if (!showHidden && entry.name.startsWith('.')) continue
      const full = p.join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: full })
        continue
      }
      // symlink 需额外 stat 判定；断链不应让整体报错，逐项静默跳过即可。
      if (!entry.isSymbolicLink()) continue
      try {
        const s = await stat(full)
        if (s.isDirectory()) dirs.push({ name: entry.name, path: full })
      } catch {
        // 断链 / 权限受限（Windows `System Volume Information`、macOS `~/Library` 子目录）
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name))
    const truncated = dirs.length > MAX_ENTRIES

    return c.json<FsListResult>({
      path: dir,
      parent: resolveParent(dir, platform),
      sep: p.sep,
      entries: truncated ? dirs.slice(0, MAX_ENTRIES) : dirs,
      truncated,
    })
  })

  return app
}

/**
 * 计算上级目录路径。
 *
 * - POSIX：到 `/` 为止，`/` 的 parent 为 null。
 * - win32 盘符根（`C:\`）：parent 指向盘符列表层（空串）。
 * - win32 UNC（`\\server\share`）：无盘符概念，到 share 根即停（parent 为 null）。
 *
 * @param dir 已归一化的目录绝对路径。
 * @param platform 目标平台。
 * @returns 上级目录；已在根时为 null。
 */
export function resolveParent(dir: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') {
    const parent = posixPath.dirname(dir)
    return parent === dir ? null : parent
  }
  const root = win32Path.parse(dir).root
  if (dir === root) {
    // `C:\` → 盘符列表层；`\\server\share\` → 已到 UNC 根，不再上溯。
    return isUncRoot(root) ? null : WIN_DRIVE_ROOT
  }
  const parent = win32Path.dirname(dir)
  return parent === dir ? null : parent
}

function isUncRoot(root: string): boolean {
  return root.startsWith('\\\\')
}

/**
 * 枚举 win32 可用盘符。
 *
 * 用 `access()` 逐个探测而非派生子进程：`wmic logicaldisk` 已在 Win11 24H2 被移除，
 * PowerShell `Get-PSDrive` 需起子进程且慢；不派生子进程也就天然不会弹空白 cmd 窗口。
 * **跳过 `A:`/`B:`**：对空软驱/光驱做 IO 可能触发 Windows「请插入磁盘」模态框。
 *
 * @returns 可访问的盘符条目，形如 `{ name: 'C:', path: 'C:\\' }`。
 */
async function listWindowsDrives(): Promise<FsListEntry[]> {
  const letters: string[] = []
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    letters.push(String.fromCharCode(code))
  }
  const checked = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`
      try {
        await access(root, constants.R_OK)
        return { name: `${letter}:`, path: root }
      } catch {
        return null
      }
    }),
  )
  return checked.filter((d): d is FsListEntry => d !== null)
}

/**
 * 把 fs 错误码翻成可读提示。
 *
 * Windows `MAX_PATH` 260 字符限制会以 `ENAMETOOLONG` 形式冒出来；这里只做提示，
 * 不做 `\\?\` 前缀改写（会影响 git 等下游行为）。
 */
function describeFsError(err: unknown, dir: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return `path does not exist: ${dir}`
  if (code === 'ENAMETOOLONG') return `path is too long: ${dir}`
  if (code === 'EACCES' || code === 'EPERM') return `permission denied: ${dir}`
  if (code === 'ENOTDIR') return `path is not a directory: ${dir}`
  return `cannot read directory: ${dir}`
}
