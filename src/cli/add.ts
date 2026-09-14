import { createInterface } from 'node:readline/promises'
import type { GlobalProjectEntry } from '../service/global-config.js'
import { addProjectWithGit, NeedGitInitError } from '../service/project-add.js'
import { runGitInit } from './git.js'

export interface RunAddOptions {
  path: string
  cwd?: string
  globalConfigPath?: string
  /** 非 TTY 或 CI 场景直接跳过 git-init 确认。 */
  yes?: boolean
  /** 测试注入点：提问并返回用户输入（原始行，不含换行）。 */
  prompt?: (question: string) => Promise<string>
  /** 测试注入点：跑 `git init`。 */
  runGitInit?: (cwd: string) => Promise<void>
  /** 覆盖默认的 TTY 判定，主要用于测试。 */
  isTTY?: boolean
}

export interface RunAddResult {
  entry: GlobalProjectEntry
  created: boolean
  gitInitialized: boolean
  gitignore: { updated: boolean; path: string } | null
}

export class AddGitAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddGitAbortedError'
  }
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

/**
 * CLI `yorz add` 的入口：在共享的 {@link addProjectWithGit} 之上补 TTY 交互确认。
 *
 * 非 git 仓库时 `addProjectWithGit` 会零副作用地抛 {@link NeedGitInitError}，
 * 这里据此询问用户（或按 `--yes` 直接放行），确认后带 `gitInit: true` 重试。
 *
 * @param opts 目标路径与交互/测试注入点。
 * @returns 注册结果。
 * @throws {AddGitAbortedError} 用户拒绝 `git init`，或非交互环境下未传 `--yes`。
 */
export async function runAdd(opts: RunAddOptions): Promise<RunAddResult> {
  // CLI 侧保持 stdio: 'inherit'，让用户直接看到 git 输出。
  const gitInit = opts.runGitInit ?? ((cwd: string) => runGitInit(cwd))
  const base = {
    path: opts.path,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.globalConfigPath !== undefined ? { globalConfigPath: opts.globalConfigPath } : {}),
    runGitInit: gitInit,
  }

  try {
    return await addProjectWithGit(base)
  } catch (err) {
    if (!(err instanceof NeedGitInitError)) throw err

    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (!opts.yes) {
      if (!isTTY) {
        throw new AddGitAbortedError(
          `yorz add: target directory is not a git repository; pass --yes to auto-run git init in non-interactive mode`,
        )
      }
      const ask = opts.prompt ?? defaultPrompt
      const raw = await ask(`yorz add: ${err.path} 未 git init，是否自动执行 \`git init\`? [y/N] `)
      const answer = raw.trim().toLowerCase()
      if (answer !== 'y' && answer !== 'yes') {
        throw new AddGitAbortedError(`yorz add: aborted — target directory is not a git repository`)
      }
    }
    return await addProjectWithGit({ ...base, gitInit: true })
  }
}
