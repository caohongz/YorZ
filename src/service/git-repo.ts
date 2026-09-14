import { spawn, type SpawnOptions, type StdioOptions } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withHiddenWindowsConsole } from './process.js'

/**
 * 判断目录是否为 git 仓库（存在 `.git` 条目即可，worktree 下 `.git` 是文件）。
 *
 * @param cwd 待判定的目录绝对路径。
 * @returns 是 git 仓库时为 true。
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await stat(join(cwd, '.git'))
    return true
  } catch {
    return false
  }
}

export interface RunGitInitOptions {
  /**
   * 子进程 stdio。CLI 侧沿用 `'inherit'` 让用户直接看到 git 输出；Service 进程内
   * 没有 TTY 可继承，必须显式传 `'ignore'`。
   */
  stdio?: StdioOptions
}

/**
 * 在目标目录执行 `git init`。
 *
 * 经 {@link withHiddenWindowsConsole} 包装，避免 Windows 下弹出空白 cmd 窗口。
 *
 * @param cwd 仓库目录绝对路径。
 * @param opts stdio 等可注入选项；默认 `'inherit'` 以保持 CLI 既有行为。
 * @returns `git init` 退出码为 0 时 resolve，否则 reject。
 */
export async function runGitInit(cwd: string, opts: RunGitInitOptions = {}): Promise<void> {
  const stdio = opts.stdio ?? 'inherit'
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['init'], withHiddenWindowsConsole<SpawnOptions>({ cwd, stdio }))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git init exited with code ${code}`))
    })
  })
}

/**
 * Append `.yorz/tmp` to `<cwd>/.gitignore` when `cwd` is a git repository
 * and the entry isn't already present. Returns `null` when `cwd` is not a
 * git repo (no change attempted).
 */
export async function ensureTmpIgnored(
  cwd: string,
): Promise<{ updated: boolean; path: string } | null> {
  if (!(await isGitRepo(cwd))) return null
  const giPath = join(cwd, '.gitignore')
  let existing = ''
  try {
    existing = await readFile(giPath, 'utf8')
  } catch {
    existing = ''
  }
  if (hasIgnoreEntry(existing, '.yorz/tmp')) {
    return { updated: false, path: giPath }
  }
  const needsNewline = existing.length > 0 && !existing.endsWith('\n')
  const next = `${existing}${needsNewline ? '\n' : ''}.yorz/tmp\n`
  await writeFile(giPath, next, 'utf8')
  return { updated: true, path: giPath }
}

export function hasIgnoreEntry(content: string, target: string): boolean {
  const normalized = target.replace(/\/$/, '')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const cleaned = line.replace(/\/$/, '').replace(/^\//, '')
    if (cleaned === normalized) return true
  }
  return false
}
