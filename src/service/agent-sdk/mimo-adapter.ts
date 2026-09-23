import { createOpencode } from '@mimo-ai/sdk'
import type { OpencodeClient } from '@mimo-ai/sdk'
import { normalizeUsage } from '../telemetry/index.js'
import { PhaseAccumulator, isSpecWrite } from './phase-usage.js'
import type { PhaseUsageSnapshot, TurnMetrics } from '../telemetry/index.js'
import type {
  AgentEvent,
  AgentSdkAdapter,
  AgentSession,
  Capabilities,
  MessagePart,
  NormalizedMessage,
  SendOptions,
  SessionInfo,
} from './types.js'

type Server = { url: string; close(): void }

interface MimoToolState {
  status?: unknown
  input?: unknown
  output?: unknown
  error?: unknown
}

interface MimoPart {
  id?: unknown
  sessionID?: unknown
  type?: unknown
  text?: unknown
  tool?: unknown
  state?: MimoToolState
  auto?: unknown
}

interface MimoMessageInfo {
  sessionID?: unknown
  role?: unknown
  time?: { created?: unknown; completed?: unknown }
  cost?: unknown
  tokens?: unknown
  modelID?: unknown
}

interface MimoMessageRow {
  info?: MimoMessageInfo
  parts?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function partList(raw: unknown): MimoPart[] {
  return Array.isArray(raw) ? (raw as MimoPart[]) : []
}

function toolResultText(state: MimoToolState | undefined): string {
  if (!state) return ''
  if (typeof state.output === 'string' && state.output) return state.output
  if (typeof state.error === 'string' && state.error) return state.error
  return ''
}

function toolName(part: MimoPart): string {
  return typeof part.tool === 'string' ? part.tool : '?'
}

function partKey(part: MimoPart): string {
  return typeof part.id === 'string' && part.id ? part.id : `${part.type}:${toolName(part)}`
}

/**
 * SSE `message.part.updated` / `message.updated` 的 properties **不带**顶层
 * sessionID（见 @mimo-ai/sdk `EventMessagePartUpdated` / `EventMessageUpdated`）。
 * 必须从 `part.sessionID` / `info.sessionID` 取，否则过滤恒放行、跨会话串扰。
 */
function eventSessionId(part: MimoPart | undefined, info: MimoMessageInfo | undefined): string {
  if (part && typeof part.sessionID === 'string' && part.sessionID) return part.sessionID
  if (info && typeof info.sessionID === 'string' && info.sessionID) return info.sessionID
  return ''
}

/** Flatten one MiMo part into zero or more normalized chat parts. */
export function messagePartsFromMimoPart(part: MimoPart): MessagePart[] {
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    return [{ type: 'text', text: part.text }]
  }
  if (part.type === 'tool') {
    const out: MessagePart[] = []
    out.push({ type: 'tool-use', name: toolName(part), input: part.state?.input ?? {} })
    const status = part.state?.status
    if (status === 'completed' || status === 'error') {
      out.push({ type: 'tool-result', text: toolResultText(part.state) })
    }
    return out
  }
  return []
}

/**
 * AssistantMessage 截断：`cost` 与 `tokens` 是兄弟字段。turn-completed 的
 * `usage` 回传该对象整体，`normalizeUsage('mimo', …)` 再做归一化。
 */
function usagePayload(info: MimoMessageInfo | undefined): unknown {
  if (!info) return undefined
  return { cost: info.cost, tokens: info.tokens }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Bridges MiMo's push-based SSE `event.subscribe` onto the pull-based
 * `AsyncIterable` that `AgentSession.send()` must return. Same contract as the
 * Pi adapter's queue: the listener only enqueues and wakes a parked consumer.
 */
class EventQueue<T> {
  private items: T[] = []
  private wake: (() => void) | null = null
  private closed = false

  /** After close() the queue rejects late pushes — the merge pass owns the tail. */
  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.notify()
  }

  close(): void {
    this.closed = true
    this.notify()
  }

  private notify(): void {
    const resume = this.wake
    this.wake = null
    resume?.()
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift() as T
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}

interface StreamDedupe {
  textPartIds: Set<string>
  toolStarts: Set<string>
  toolEnds: Set<string>
}

function mapStreamPart(part: MimoPart, delta: string, seen: StreamDedupe): AgentEvent[] {
  const out: AgentEvent[] = []
  if (part.type === 'text') {
    const key = partKey(part)
    if (seen.textPartIds.has(key)) return out
    seen.textPartIds.add(key)
    if (delta) out.push({ type: 'text', delta })
    else if (typeof part.text === 'string' && part.text) {
      out.push({ type: 'text', delta: part.text })
    }
    return out
  }
  if (part.type === 'tool') {
    const key = partKey(part)
    const status = part.state?.status
    if (!seen.toolStarts.has(key) && (status === 'running' || status === 'pending')) {
      seen.toolStarts.add(key)
      out.push({ type: 'tool-use', name: toolName(part), input: part.state?.input ?? {} })
    }
    if (!seen.toolEnds.has(key) && (status === 'completed' || status === 'error')) {
      if (!seen.toolStarts.has(key)) {
        seen.toolStarts.add(key)
        out.push({ type: 'tool-use', name: toolName(part), input: part.state?.input ?? {} })
      }
      seen.toolEnds.add(key)
      out.push({ type: 'tool-result', text: toolResultText(part.state) })
    }
    return out
  }
  if (part.type === 'compaction') {
    // CompactionPart only carries `auto`; metrics subfields stay absent.
    out.push({
      type: 'compact',
      metrics: {
        trigger: part.auto === true ? 'auto' : part.auto === false ? 'manual' : undefined,
        preTokens: undefined,
        postTokens: undefined,
        durationMs: undefined,
      },
    })
  }
  return out
}

/** Tail merge: emit only what SSE never delivered (partial stream / no stream). */
function replayMissedParts(turnParts: MimoPart[], seen: StreamDedupe): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const part of turnParts) {
    for (const mapped of mapStreamPart(part, '', seen)) {
      out.push(mapped)
    }
  }
  return out
}

class MimoSession implements AgentSession {
  private aborted = false
  constructor(
    public id: string,
    private readonly client: OpencodeClient,
    private readonly directory: string,
  ) {}

  async *send(prompt: string, opts?: SendOptions): AsyncIterable<AgentEvent> {
    this.aborted = false
    if (opts?.signal?.aborted) return
    const onAbort = () => void this.abortInternal()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })

    const seen: StreamDedupe = {
      textPartIds: new Set(),
      toolStarts: new Set(),
      toolEnds: new Set(),
    }
    let turnInfo: MimoMessageInfo | undefined
    let turnParts: MimoPart[] = []

    const phase = new PhaseAccumulator('mimo', Date.now())
    let planPhase: PhaseUsageSnapshot | undefined
    /** Fold the phase split in at the last moment, so `observedTotal` is final. */
    const withPhases = (base?: TurnMetrics): TurnMetrics => ({
      ...(base ?? {}),
      planPhase,
      observedTotal: phase.snapshot(),
    })
    /** Snapshot *after* the request that decided on this write was accumulated. */
    const noteTool = (name: string, input: unknown): void => {
      if (!planPhase && isSpecWrite('mimo', name, input)) planPhase = phase.snapshot()
    }

    yield { type: 'session-started', sessionId: this.id }

    const queue = new EventQueue<AgentEvent>()
    // hey-api SSE result is `{ stream: AsyncGenerator }`, not itself async-iterable.
    let stream: AsyncGenerator<unknown, void, unknown> | null = null
    try {
      const sub = (await this.client.event.subscribe().catch(() => null)) as {
        stream?: AsyncGenerator<unknown, void, unknown>
      } | null
      const s = sub?.stream
      if (s && typeof s[Symbol.asyncIterator] === 'function') stream = s
    } catch {
      stream = null
    }

    const pump = (async () => {
      if (!stream) return
      try {
        for await (const raw of stream) {
          if (this.aborted) break
          const ev = isRecord(raw) ? raw : null
          if (!ev) continue
          const type = typeof ev.type === 'string' ? ev.type : ''
          const props = isRecord(ev.properties) ? ev.properties : {}

          if (type === 'message.part.updated') {
            const part = (isRecord(props.part) ? props.part : {}) as MimoPart
            const sessionId = eventSessionId(part, undefined)
            if (sessionId && sessionId !== this.id) continue
            const delta = typeof props.delta === 'string' ? props.delta : ''
            for (const mapped of mapStreamPart(part, delta, seen)) {
              if (mapped.type === 'tool-use') noteTool(mapped.name, mapped.input)
              queue.push(mapped)
            }
          } else if (type === 'message.updated') {
            const info = isRecord(props.info) ? (props.info as MimoMessageInfo) : undefined
            const sessionId = eventSessionId(undefined, info)
            if (sessionId && sessionId !== this.id) continue
            if (info?.role === 'assistant') turnInfo = info
          }
        }
      } catch {
        // SSE dropped mid-turn; the prompt payload + merge pass still finish the turn.
      }
    })()

    let promptError: unknown
    const running = this.client
      .session.prompt({
        path: { id: this.id },
        query: { directory: this.directory },
        body: { parts: [{ type: 'text', text: prompt }] },
      })
      .then((res) => {
        const data = res.data as MimoMessageRow | undefined
        if (data) {
          if (data.info) turnInfo = data.info
          turnParts = partList(data.parts)
        } else if (res.error) {
          promptError =
            res.error && typeof res.error === 'object' && 'data' in res.error
              ? String(
                  (res.error as { data?: { message?: unknown } }).data?.message ?? 'prompt failed',
                )
              : 'prompt failed'
        }
      })
      .catch((err: unknown) => {
        promptError = err
      })
      .finally(() => {
        // SSE is long-lived and does not end with the turn. Stop the pump and
        // close the queue — no timed race. The merge pass owns any tail.
        void (stream?.return?.() as Promise<void> | undefined)?.catch(() => {})
        queue.close()
      })

    try {
      // Yield streamed events while the prompt is in flight; drain() ends when
      // the prompt settles and the queue closes.
      for await (const event of queue.drain()) {
        if (this.aborted) return
        yield event
      }
      await running
      if (this.aborted) return

      if (promptError) {
        yield {
          type: 'error',
          message: promptError instanceof Error ? promptError.message : String(promptError),
        }
        return
      }

      // Tail merge: always replay parts SSE never delivered (no stream, partial
      // stream, or events that raced the close). Dedupe keeps this idempotent.
      for (const ev of replayMissedParts(turnParts, seen)) {
        if (ev.type === 'tool-use') noteTool(ev.name, ev.input)
        yield ev
      }

      if (turnInfo) phase.add(usagePayload(turnInfo))
      const usage = usagePayload(turnInfo)
      const model = typeof turnInfo?.modelID === 'string' ? turnInfo.modelID : undefined
      yield {
        type: 'turn-completed',
        usage,
        metrics: withPhases({
          usage: normalizeUsage('mimo', usage),
          model,
        }),
      }
    } finally {
      queue.close()
      void (stream?.return?.() as Promise<void> | undefined)?.catch(() => {})
      opts?.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async abortInternal(): Promise<void> {
    this.aborted = true
    try {
      await this.client.session.abort({ path: { id: this.id } })
    } catch {
      // best-effort
    }
  }

  abort(): void {
    void this.abortInternal()
  }
}

export class MimoAdapter implements AgentSdkAdapter {
  readonly kind = 'mimo' as const
  private booting: Promise<{ client: OpencodeClient; server: Server }> | null = null

  constructor(private readonly cwd: string) {}

  private async ensure(): Promise<{ client: OpencodeClient; server: Server }> {
    if (!this.booting) {
      // port 0 lets the OS pick a free port (same as the OpenCode adapter).
      // Permissions are pre-allowed: YorZ dispatches are unattended and always
      // confined to the project root / .yorz/specs.
      this.booting = createOpencode({
        hostname: '127.0.0.1',
        port: 0,
        config: {
          permission: {
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
            doom_loop: 'allow',
            external_directory: 'allow',
          },
        },
      }).catch((err) => {
        this.booting = null
        throw err
      })
    }
    return this.booting
  }

  async createSession(opts?: { title?: string }): Promise<AgentSession> {
    const { client } = await this.ensure()
    const res = await client.session.create({
      query: { directory: this.cwd },
      body: opts?.title ? { title: opts.title } : {},
    })
    const data = res.data as { id?: string } | undefined
    const id = data?.id
    if (!id) throw new Error('mimo session.create failed')
    return new MimoSession(id, client, this.cwd)
  }

  async resumeSession(id: string): Promise<AgentSession> {
    const { client } = await this.ensure()
    return new MimoSession(id, client, this.cwd)
  }

  async listSessions(): Promise<SessionInfo[]> {
    const { client } = await this.ensure()
    const res = await client.session.list({ query: { directory: this.cwd } })
    const list = (res.data ?? []) as Array<{
      id?: string
      title?: string
      directory?: string
      time?: { created?: number; updated?: number }
    }>
    const out: SessionInfo[] = []
    for (const s of list) {
      if (!s.id) continue
      // `session.list({directory})` already scopes, but older rows may leak in
      // when the server holds several projects — filter defensively.
      if (s.directory && s.directory !== this.cwd) continue
      // Missing timestamps sort last rather than pretending "just now".
      out.push({
        id: s.id,
        title: s.title || s.id,
        kind: this.kind,
        createdAt: num(s.time?.created) ?? 0,
        updatedAt: num(s.time?.updated) ?? 0,
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async getMessages(id: string): Promise<NormalizedMessage[]> {
    const { client } = await this.ensure()
    const res = await client.session.messages({
      path: { id },
      query: { directory: this.cwd },
    })
    const rows = (res.data ?? []) as MimoMessageRow[]
    const out: NormalizedMessage[] = []
    for (const row of rows) {
      const role = row.info?.role
      if (role !== 'user' && role !== 'assistant') continue
      const parts: MessagePart[] = []
      for (const part of partList(row.parts)) {
        parts.push(...messagePartsFromMimoPart(part))
      }
      if (parts.length) {
        out.push({ role, parts, ts: num(row.info?.time?.created) })
      }
    }
    return out
  }

  /**
   * `usageStatus: false` —— MiMo 公开 SDK 没有 rate-limit / 配额窗口 API，
   * `mimo stats` 也只有累计量。P1 对齐 OpenCode/Pi：明确声明不支持，前端静默。
   * P2 若补 local-snapshot 降级再打开本开关。
   */
  capabilities(): Capabilities {
    return { listSessions: true, getMessages: true, usageStatus: false }
  }

  async dispose(): Promise<void> {
    if (!this.booting) return
    try {
      const { server } = await this.booting
      server.close()
    } catch {
      // best-effort
    }
    this.booting = null
  }
}
