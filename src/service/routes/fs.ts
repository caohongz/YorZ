import { Hono } from 'hono'
import { constants } from 'node:fs'
import { access, mkdir, readdir, stat } from 'node:fs/promises'
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
  /**
   * 服务端用户主目录（已归一化），任何分支都回填。
   *
   * 浏览器拿不到服务端 home，而 win32 的缺省落点是盘符列表层——没有这个字段，
   * Windows 上「主目录」就彻底失去入口。
   */
  home: string
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
    const home = normalizeAbsPath(homedir(), platform)

    // 落点语义：POSIX 缺省/空串回主目录；win32 缺省/空串一律停在「盘符列表层」。
    const blank = rawPath === undefined || rawPath.trim() === ''
    if (isWin && blank) {
      const drives = await listWindowsDrives()
      return c.json<FsListResult>({
        path: WIN_DRIVE_ROOT,
        parent: null,
        sep: p.sep,
        home,
        entries: drives,
        truncated: false,
      })
    }

    const target = blank ? home : rawPath
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
      home,
      entries: truncated ? dirs.slice(0, MAX_ENTRIES) : dirs,
      truncated,
    })
  })

  /**
   * 在已存在的父目录下新建**单层**空目录。
   *
   * 这是 fs 路由唯一的写端点：不带 `recursive`，因此既不会一次建多级，也不会对
   * 已存在的目录静默成功（`EEXIST` 会如实冒出来）。名称走白名单校验，杜绝
   * `..`、路径分隔符与 Windows 保留名。
   */
  app.post('/fs/mkdir', async (c) => {
    let body: { parent?: unknown; name?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'invalid json body' }, 400)
    }

    const rawParent = typeof body.parent === 'string' ? body.parent : ''
    const rawName = typeof body.name === 'string' ? body.name : ''

    // 盘符列表层（空串）不是真实目录，不能在「此电脑」层建目录。
    if (!rawParent.trim() || !p.isAbsolute(rawParent.trim())) {
      return c.json({ error: 'parent must be an absolute directory path' }, 400)
    }
    const nameError = validateDirName(rawName, platform)
    if (nameError) return c.json({ error: nameError }, 400)

    const parent = normalizeAbsPath(rawParent, platform)
    try {
      const stats = await stat(parent)
      if (!stats.isDirectory()) {
        return c.json({ error: `path is not a directory: ${parent}` }, 400)
      }
    } catch (err) {
      return c.json({ error: describeFsError(err, parent) }, 400)
    }

    const target = p.join(parent, rawName.trim())
    try {
      await mkdir(target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'EEXIST') return c.json({ error: `already exists: ${target}` }, 409)
      if (code === 'EACCES' || code === 'EPERM') {
        return c.json({ error: `permission denied: ${target}` }, 403)
      }
      return c.json({ error: describeFsError(err, target) }, 400)
    }

    return c.json({ path: normalizeAbsPath(target, platform) }, 201)
  })

  return app
}

/** win32 保留设备名：`CON.txt` 这类带扩展名的形式同样被系统拒绝。 */
const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 校验用户输入的新目录名。
 *
 * 只接受「单层目录名」：任何分隔符、`.` / `..`、控制字符一律拒绝，避免经由
 * 名称逃逸出父目录。win32 额外拒绝保留字符、保留设备名与尾随点号/空格
 * （后者会被系统静默裁掉，导致实际创建的目录名与用户输入不一致）。
 *
 * @param name 原始输入（允许首尾空白，内部按 trim 后判定）。
 * @param platform 目标平台。
 * @returns 合法返回 `null`，否则返回可读错误原因。
 */
export function validateDirName(name: string, platform: NodeJS.Platform): string | null {
  const value = name.trim()
  if (!value) return 'name must not be empty'
  if (value.length > 255) return 'name is too long'
  if (value === '.' || value === '..') return 'name must not be "." or ".."'
  if (value.includes('/') || value.includes('\\')) {
    return 'name must not contain a path separator'
  }
  // 控制字符：部分文件系统会接受，但在 UI / 路径拼接里几乎必然出问题。
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'name must not contain control characters'
  if (platform === 'win32') {
    if (/[<>:"|?*]/.test(value)) return 'name must not contain <>:"|?* on Windows'
    if (WIN_RESERVED_NAME.test(value)) return `"${value}" is a reserved name on Windows`
    if (/[. ]$/.test(value)) return 'name must not end with a dot or space on Windows'
  }
  return null
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
