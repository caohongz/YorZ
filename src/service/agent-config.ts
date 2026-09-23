import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type AgentName = 'claude' | 'opencode' | 'codex' | 'pi' | 'mimo'

export type AgentStreamFormat = 'json' | 'text'

export interface AgentCmd {
  cmd: string
  args(prompt: string, cwd?: string): string[]
  streamFormat: AgentStreamFormat
  /**
   * Extra environment variables to merge on top of `process.env` when the
   * runner spawns this backend. Optional — only backends that need to force
   * a working-directory signal (e.g. opencode reading `PWD` instead of the
   * child's `process.cwd()`) implement it.
   */
  env?(cwd: string): Record<string, string>
}

export interface ResolveAgentCmdOptions {
  cwd: string
  /**
   * Explicit agent name. When set, skips .yorz/config.json lookup and uses the
   * named builtin. Honored by the test:agent runner so `--agent=opencode` can
   * force opencode even in a project whose config picks claude.
   */
  agent?: AgentName
  /** Test hook: when set, overrides the resolved command path entirely. */
  override?: AgentCmd
  /** Read process.env. Injectable for testing. */
  env?: NodeJS.ProcessEnv
}

export function resolveAgentByName(name: AgentName): AgentCmd {
  return BUILTIN[name]
}

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'mimo'

/**
 * Resolve which Agent SDK adapter a project uses, from `.yorz/config.json`'s
 * `agent.kind` (or legacy bare-string `agent`). Defaults to `claude`. Unlike
 * `resolveAgentCmd` (CLI-spawn, retained only for the test:agent harness), this
 * feeds the SDK adapter registry used by the Service runtime.
 */
export function resolveAgentKind(cwd: string): AgentKind {
  const path = join(cwd, '.yorz', 'config.json')
  if (!existsSync(path)) return 'claude'
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return 'claude'
  }
  if (!raw.trim()) return 'claude'
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return 'claude'
  }
  if (!data || typeof data !== 'object') return 'claude'
  const agent = (data as { agent?: unknown }).agent
  if (typeof agent === 'string') {
    return agent === 'codex' || agent === 'opencode' || agent === 'pi' || agent === 'mimo'
      ? agent
      : 'claude'
  }
  if (!agent || typeof agent !== 'object') return 'claude'
  const kind = (agent as { kind?: unknown }).kind
  return kind === 'codex' || kind === 'opencode' || kind === 'pi' || kind === 'mimo'
    ? kind
    : 'claude'
}

const BUILTIN: Record<AgentName, AgentCmd> = {
  claude: {
    cmd: 'claude',
    // `--permission-mode bypassPermissions`：service 拉起 Agent 是后台无人值守
    // 场景，需要它自由完成读写/执行验证命令；-p 非交互模式默认权限会阻塞写
    // 文件与跑命令（典型表现："权限模式阻止了新建目录与文件"）。Agent 工作目
    // 录始终被锁定在项目根，落点也始终在 .yorz/specs/。
    // `--output-format stream-json --verbose`：claude 默认 text 输出会缓冲整段
    // 回复到 exit 前再 flush；stream-json 在每个增量 token/工具事件时立即
    // flush，配合服务端的 JSONL→文本解析后才能真正流式给到 GUI。
    args: (prompt) => [
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      prompt,
    ],
    streamFormat: 'json',
  },
  opencode: {
    cmd: 'opencode',
    // opencode CLI 入口非 `-p`：必须走 `opencode run <message>` 子命令；
    // `--dangerously-skip-permissions` 对齐 claude 的 bypassPermissions，保证无人值守。
    args: (prompt) => ['run', '--dangerously-skip-permissions', prompt],
    streamFormat: 'text',
    // opencode 不遵循 spawn 传入的 cwd，而是走 process.env.PWD 定位项目根：
    // 若不覆盖，worktree 项目下拉起的 opencode 会锚定到 `yorz serve` 启动时的
    // shell 目录。GIT_DIR / GIT_WORK_TREE 是保险项，用于兜住 opencode 内部若
    // 走 git CLI 探测项目的路径。claude 后端不需要此覆盖，保留默认行为。
    env: (cwd) => ({
      PWD: cwd,
    }),
  },
  codex: {
    cmd: 'codex',
    // Codex CLI 的无人值守入口是 `codex exec <prompt>`。这里显式传入目标 cwd，
    // 并用 exec 支持的 bypass 参数关闭审批/沙箱，以对齐 claude bypassPermissions
    // 与 opencode skip-permissions 的后台执行语义；服务端 spawn 的 cwd 也会设置
    // 为同一个目录，作为进程工作目录兜底。
    args: (prompt, cwd) => [
      'exec',
      '--cd',
      cwd ?? '.',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      prompt,
    ],
    streamFormat: 'text',
  },
  pi: {
    cmd: 'pi',
    // Pi 的非交互入口就是 `pi -p <prompt>`，且 SDK / CLI 层没有审批门——内置工具
    // 在 agent 决定后直接执行，等价于 claude 的 bypassPermissions，因此不需要任何
    // 权限旁路参数。Pi 也正常遵循 spawn 传入的 cwd，无需 opencode 那样的 env 覆盖。
    args: (prompt) => ['-p', prompt],
    streamFormat: 'text',
  },
  mimo: {
    cmd: 'mimo',
    // MiMo Code 的无人值守入口是 `mimo run <message>`（OpenCode 系同构）；
    // `--dangerously-skip-permissions` 对齐 claude bypassPermissions / opencode
    // skip-permissions 的后台执行语义。`--format json` 让事件行可被 JSONL 解析，
    // 与 claude 的 stream-json 同属 `streamFormat: 'json'` 路径。
    args: (prompt) => ['run', '--dangerously-skip-permissions', '--format', 'json', prompt],
    streamFormat: 'json',
  },
}

export function resolveAgentCmd(opts: ResolveAgentCmdOptions): AgentCmd {
  if (opts.override) return opts.override
  const env = opts.env ?? process.env
  const envCmd = env.YORZ_AGENT_CMD
  if (envCmd && envCmd.trim()) {
    const tokens = envCmd.trim().split(/\s+/)
    const cmd = tokens[0]!
    const prefix = tokens.slice(1)
    return { cmd, args: (prompt) => [...prefix, '-p', prompt], streamFormat: 'text' }
  }
  if (opts.agent) return BUILTIN[opts.agent]
  return readAgentCmd(opts.cwd)
}

/**
 * Sync read of `.yorz/config.json` and convert to an AgentCmd. Mirrors the
 * schema understood by `src/service/project-config.ts` (which is async). Kept
 * sync because `resolveAgentCmd` is called from non-async hot paths.
 */
function readAgentCmd(cwd: string): AgentCmd {
  const path = join(cwd, '.yorz', 'config.json')
  if (!existsSync(path)) return BUILTIN.claude
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return BUILTIN.claude
  }
  if (!raw.trim()) return BUILTIN.claude
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return BUILTIN.claude
  }
  if (!data || typeof data !== 'object') return BUILTIN.claude
  const agent = (data as { agent?: unknown }).agent
  // Legacy schema: bare string.
  if (typeof agent === 'string') {
    if (agent === 'opencode') return BUILTIN.opencode
    if (agent === 'codex') return BUILTIN.codex
    if (agent === 'pi') return BUILTIN.pi
    if (agent === 'mimo') return BUILTIN.mimo
    return BUILTIN.claude
  }
  if (!agent || typeof agent !== 'object') return BUILTIN.claude
  const kind = (agent as { kind?: unknown }).kind
  if (kind === 'opencode') return BUILTIN.opencode
  if (kind === 'codex') return BUILTIN.codex
  if (kind === 'pi') return BUILTIN.pi
  if (kind === 'mimo') return BUILTIN.mimo
  return BUILTIN.claude
}
