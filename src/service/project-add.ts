import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { addProject, prepareProjectDir, type GlobalProjectEntry } from './global-config.js'
import { ensureTmpIgnored, isGitRepo, runGitInit } from './git-repo.js'
import { normalizeAbsPath } from './path-normalize.js'

export interface AddProjectWithGitOptions {
  /** 目标目录；绝对路径，或配合 `cwd` 的相对路径。 */
  path: string
  /** 相对路径解析基准，默认 `process.cwd()`。 */
  cwd?: string
  /** 覆盖全局配置文件位置，主要供测试注入。 */
  globalConfigPath?: string
  /** 目标不是 git 仓库时，是否授权自动执行 `git init`。 */
  gitInit?: boolean
  /** 测试注入点：跑 `git init`。 */
  runGitInit?: (cwd: string) => Promise<void>
  /** 平台注入点，影响路径归一化；默认当前运行平台。 */
  platform?: NodeJS.Platform
}

export interface AddProjectWithGitResult {
  entry: GlobalProjectEntry
  created: boolean
  gitInitialized: boolean
  gitignore: { updated: boolean; path: string } | null
}

/** 目标目录不是 git 仓库、且调用方未授权 `git init` 时抛出。抛出时不产生任何副作用。 */
export class NeedGitInitError extends Error {
  readonly path: string

  constructor(absPath: string) {
    super(`target directory is not a git repository: ${absPath}`)
    this.name = 'NeedGitInitError'
    this.path = absPath
  }
}

/**
 * 注册一个项目，语义与 CLI `yorz add` 的非交互部分完全一致：
 * git 仓库检查 → （按需）`git init` → 建 `.yorz/specs` → 写 `.gitignore` → 落全局配置。
 *
 * **执行顺序刻意把 git 检查提到 `prepareProjectDir` 之前**：后者会 `mkdir .yorz/specs`，
 * 若先建目录再发现不是 git 仓库并报错，会在用户机器上留下脏目录。GUI 下用户会反复
 * 试路径，每试错一次就脏一个目录，因此非 git 且未授权时必须零副作用地抛 {@link NeedGitInitError}。
 *
 * @param opts 目标路径与 git 授权、测试注入点。
 * @returns 注册结果；`created: false` 表示该路径此前已注册（幂等）。
 * @throws {NeedGitInitError} 目标非 git 仓库且 `gitInit` 未置位。
 */
export async function addProjectWithGit(
  opts: AddProjectWithGitOptions,
): Promise<AddProjectWithGitResult> {
  const platform = opts.platform ?? process.platform
  if (typeof opts.path !== 'string' || !opts.path.trim()) {
    throw new Error('path required')
  }
  const abs = normalizeAbsPath(opts.path, platform, opts.cwd)
  if (!existsSync(abs)) {
    throw new Error(`path does not exist: ${abs}`)
  }
  const stats = await stat(abs)
  if (!stats.isDirectory()) {
    throw new Error(`path is not a directory: ${abs}`)
  }

  let gitInitialized = false
  if (!(await isGitRepo(abs))) {
    if (!opts.gitInit) throw new NeedGitInitError(abs)
    // Service 进程内没有 TTY 可继承，stdio 必须显式 ignore。
    const init = opts.runGitInit ?? ((cwd: string) => runGitInit(cwd, { stdio: 'ignore' }))
    await init(abs)
    gitInitialized = true
  }

  await prepareProjectDir(abs, opts.cwd)
  const gitignore = await ensureTmpIgnored(abs)
  const { entry, created } = await addProject(abs, opts.globalConfigPath, undefined, platform)
  return { entry, created, gitInitialized, gitignore }
}
