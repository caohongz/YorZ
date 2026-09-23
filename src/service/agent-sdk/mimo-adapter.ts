import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeClient, type OpencodeClient } from '@mimo-ai/sdk'
import { getLogger } from '../logger.js'
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

const agentLog = () => getLogger().child('agent')

/** `mimo serve` stdout: `mimocode server listening on http://127.0.0.1:PORT`. */
const MIMO_LISTEN_RE = /mimocode server listening on\s+(https?:\/\/\S+)/

function resolveMimoBin(): string {
  // Must hit the binary the user already logged into — a bare `mimo` may have no auth.
  const override = process.env.MIMOCODE_BIN_PATH?.trim()
  if (override) return override
  const candidates = [
    'mimo',
    join(homedir(), '.local', 'bin', 'mimo'),
    '/opt/homebrew/bin/mimo',
    '/usr/local/bin/mimo',
  ]
  for (const c of candidates) {
    if (c === 'mimo') return c
    try {
      if (statSync(c).isFile()) return c
    } catch {
      // keep looking
    }
  }
  return 'mimo'
}

/** SDK `createOpencodeServer` hardcodes `spawn("opencode")`; boot `mimo serve` ourselves. */
async function startMimoServer(cwd: string): Promise<{ client: OpencodeClient; server: Server }> {
  const bin = resolveMimoBin()
  const proc: ChildProcess = spawn(
    bin,
    ['serve', '--hostname=127.0.0.1', '--port=0'],
    {
      cwd,
      env: {
        ...process.env,
        // Do not inject MIMOCODE_CONFIG_CONTENT — it can rewrite provider/model and break auth.
        MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let output = ''
  let stop: () => void = () => {}
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`Timeout waiting for mimo serve after 10000ms\n${output}`))
    }, 10000)
    const settle = (fn: () => void) => {
      clearTimeout(timer)
      fn()
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = MIMO_LISTEN_RE.exec(output)
      if (match?.[1]) settle(() => resolve(match[1]!))
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.on('exit', (code) => {
      settle(() =>
        reject(
          new Error(`mimo serve exited with code ${code}${output.trim() ? `\n${output}` : ''}`),
        ),
      )
    })
    proc.on('error', (error) => {
      settle(() =>
        reject(
          new Error(
            `failed to launch mimo serve (bin=${bin}): ${error.message}` +
              (error.message.includes('ENOENT')
                ? ' — 请安装 @mimo-ai/cli 并确保 `mimo` 在 PATH，或设置 MIMOCODE_BIN_PATH'
                : ''),
          ),
        ),
      )
    })
  })

  stop = () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill()
  }

  return {
    client: createOpencodeClient({ baseUrl: url }),
    server: {
      url,
      close() {
        stop()
      },
    },
  }
}

interface MimoToolState {
  status?: unknown
  input?: unknown
  output?: unknown
  error?: unknown
}

interface MimoPart {
  id?: unknown
  sessionID?: unknown
  messageID?: unknown
  type?: unknown
  text?: unknown
  tool?: unknown
  state?: MimoToolState
  auto?: unknown
  synthetic?: unknown
  ignored?: unknown
}

interface MimoMessageInfo {
  id?: unknown
  sessionID?: unknown
  role?: unknown
  time?: { created?: unknown; completed?: unknown }
  cost?: unknown
  tokens?: unknown
  modelID?: unknown
  providerID?: unknown
  error?: { name?: unknown; data?: { message?: unknown } } | unknown
}

interface MimoModelRef {
  providerID: string
  modelID: string
}

/** Desktop-only provider; `mimo serve` cannot resolve `mimo-desktop/*`. */
const DESKTOP_ONLY_PROVIDER = 'mimo-desktop'

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

/** SSE properties carry no top-level sessionID — read `part.sessionID` / `info.sessionID`. */
function eventSessionId(part: MimoPart | undefined, info: MimoMessageInfo | undefined): string {
  if (part && typeof part.sessionID === 'string' && part.sessionID) return part.sessionID
  if (info && typeof info.sessionID === 'string' && info.sessionID) return info.sessionID
  return ''
}

function errorMessageOf(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error
  if (!isRecord(error)) return String(error)
  const data = isRecord(error.data) ? error.data : {}
  if (typeof data.message === 'string' && data.message) return data.message
  if (typeof error.name === 'string' && error.name) return error.name
  return 'mimo turn failed'
}

function modelRefOf(info: MimoMessageInfo | undefined): MimoModelRef | undefined {
  if (!info) return undefined
  const providerID = typeof info.providerID === 'string' ? info.providerID : ''
  const modelID = typeof info.modelID === 'string' ? info.modelID : ''
  if (!modelID) return undefined
  return { providerID: providerID || '', modelID }
}

/** TTS/ASR/embedding endpoints reject the chat `system` message — never pick them. */
function isChatModelId(id: string): boolean {
  return !/-(tts|asr|speech|audio|voice|embed)|whisper/i.test(id)
}

/**
 * Map a Desktop-pinned model onto a CLI-registered chat model.
 * Same modelID first, then the user's configured default, then any tool-capable
 * chat model — never vendor-specific.
 */
function pickCliModel(
  all: Array<{
    id?: unknown
    models?: Record<string, { id?: unknown; tool_call?: unknown } | undefined> | unknown
  }>,
  preferred?: MimoModelRef,
  defaultModel?: MimoModelRef,
): MimoModelRef | undefined {
  const available: Array<MimoModelRef & { toolCall?: boolean }> = []
  for (const provider of all) {
    const providerID = typeof provider.id === 'string' ? provider.id : ''
    if (!providerID || providerID === DESKTOP_ONLY_PROVIDER) continue
    const models = isRecord(provider.models) ? provider.models : {}
    for (const key of Object.keys(models)) {
      const entry = models[key]
      const rawId = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined
      const modelID = typeof rawId === 'string' && rawId ? rawId : key
      if (typeof modelID !== 'string' || !modelID || !isChatModelId(modelID)) continue
      const toolCall =
        entry && typeof entry === 'object' ? (entry as { tool_call?: unknown }).tool_call : undefined
      available.push({ providerID, modelID, toolCall: toolCall !== false })
    }
  }
  if (!available.length) return undefined
  const pick = (m: MimoModelRef & { toolCall?: boolean }): MimoModelRef => ({
    providerID: m.providerID,
    modelID: m.modelID,
  })
  if (preferred?.modelID && isChatModelId(preferred.modelID)) {
    const same = available.find((m) => m.modelID === preferred!.modelID)
    if (same) return pick(same)
  }
  if (defaultModel) {
    const hit = available.find(
      (m) => m.providerID === defaultModel!.providerID && m.modelID === defaultModel!.modelID,
    )
    if (hit) return pick(hit)
  }
  const ranked = available.find((m) => m.toolCall) ?? available[0]
  return pick(ranked)
}

export function messagePartsFromMimoPart(part: MimoPart): MessagePart[] {
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    if (part.synthetic === true || part.ignored === true) return []
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

/** `cost` and `tokens` are siblings on AssistantMessage, not nested. */
function usagePayload(info: MimoMessageInfo | undefined): unknown {
  if (!info) return undefined
  return { cost: info.cost, tokens: info.tokens }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Bridges push SSE `event.subscribe` onto the pull `AsyncIterable` of `send()`. */
class EventQueue<T> {
  private items: T[] = []
  private wake: (() => void) | null = null
  private closed = false

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

/** Emit only what SSE never delivered (dedupe keeps this idempotent). */
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
    // User text parts also arrive on SSE — filter or they echo as assistant text.
    const userMsgIds = new Set<string>()

    const phase = new PhaseAccumulator('mimo', Date.now())
    let planPhase: PhaseUsageSnapshot | undefined
    const withPhases = (base?: TurnMetrics): TurnMetrics => ({
      ...(base ?? {}),
      planPhase,
      observedTotal: phase.snapshot(),
    })
    const noteTool = (name: string, input: unknown): void => {
      if (!planPhase && isSpecWrite('mimo', name, input)) planPhase = phase.snapshot()
    }

    // No session-started: a mismatched live id would reconcile sid to a ghost UUID.
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
            const partMsgId = typeof part.messageID === 'string' ? part.messageID : ''
            if (partMsgId && userMsgIds.has(partMsgId)) continue
            const delta = typeof props.delta === 'string' ? props.delta : ''
            for (const mapped of mapStreamPart(part, delta, seen)) {
              if (mapped.type === 'tool-use') noteTool(mapped.name, mapped.input)
              queue.push(mapped)
            }
          } else if (type === 'message.updated') {
            const info = isRecord(props.info) ? (props.info as MimoMessageInfo) : undefined
            const sessionId = eventSessionId(undefined, info)
            if (sessionId && sessionId !== this.id) continue
            if (info?.role === 'user' && typeof info.id === 'string') userMsgIds.add(info.id)
            if (info?.role === 'assistant') turnInfo = info
          }
        }
      } catch {
        // SSE dropped mid-turn; the prompt payload + merge pass still finish the turn.
      }
    })()

    // Desktop sessions pin mimo-desktop/*; rewrite so `mimo serve` can continue them.
    const modelOverride = await this.resolveModelOverride().catch(() => undefined)

    let promptError: unknown
    const promptBody: {
      parts: Array<{ type: 'text'; text: string }>
      model?: MimoModelRef
    } = { parts: [{ type: 'text', text: prompt }] }
    if (modelOverride) promptBody.model = modelOverride

    const running = this.client
      .session.prompt({
        path: { id: this.id },
        query: { directory: this.directory },
        body: promptBody,
      })
      .then((res) => {
        const data = res.data as MimoMessageRow | undefined
        const infoErr = data?.info?.error
        agentLog().info('mimo prompt result', {
          sessionId: this.id,
          hasData: Boolean(data),
          hasError: Boolean(res.error),
          infoError: errorMessageOf(infoErr),
          modelOverride: modelOverride
            ? `${modelOverride.providerID}/${modelOverride.modelID}`
            : undefined,
          partCount: partList(data?.parts).length,
        })
        if (data) {
          if (data.info) turnInfo = data.info
          turnParts = partList(data.parts)
          if (infoErr) promptError = errorMessageOf(infoErr)
        } else if (res.error) {
          promptError = errorMessageOf(res.error) ?? 'prompt failed'
        } else {
          promptError = 'mimo prompt returned neither data nor error'
        }
      })
      .catch((err: unknown) => {
        promptError = err
      })
      .finally(() => {
        void (stream?.return?.() as Promise<void> | undefined)?.catch(() => {})
        queue.close()
      })

    try {
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

      // Tail merge: prompt returns only the last assistant message; pull history
      // plus the prompt payload so mid-turn tool parts are not dropped.
      if (!this.aborted) {
        try {
          const hist = await this.client.session.messages({
            path: { id: this.id },
            query: { directory: this.directory },
          })
          const rows = (hist.data ?? []) as MimoMessageRow[]
          let lastAssistantErr: string | undefined
          for (const row of rows) {
            if (row.info?.role !== 'assistant') continue
            if (row.info) turnInfo = row.info
            for (const part of partList(row.parts)) {
              const partMsgId = typeof part.messageID === 'string' ? part.messageID : ''
              if (partMsgId && userMsgIds.has(partMsgId)) continue
              for (const ev of mapStreamPart(part, '', seen)) {
                if (ev.type === 'tool-use') noteTool(ev.name, ev.input)
                yield ev
              }
            }
            // AssistantMessage.error is not in parts; only trust the last one.
            lastAssistantErr = errorMessageOf(row.info?.error)
          }
          if (lastAssistantErr && !promptError) promptError = lastAssistantErr
        } catch {
          // fall back to prompt payload below
        }
        for (const ev of replayMissedParts(turnParts, seen)) {
          if (ev.type === 'tool-use') noteTool(ev.name, ev.input)
          yield ev
        }
      } else {
        for (const ev of replayMissedParts(turnParts, seen)) {
          if (ev.type === 'tool-use') noteTool(ev.name, ev.input)
          yield ev
        }
      }

      if (promptError) {
        yield {
          type: 'error',
          message: promptError instanceof Error ? promptError.message : String(promptError),
        }
        return
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

  /** `undefined` keeps the session default model. */
  private async resolveModelOverride(): Promise<MimoModelRef | undefined> {
    let preferred: MimoModelRef | undefined
    try {
      const hist = await this.client.session.messages({
        path: { id: this.id },
        query: { directory: this.directory },
      })
      const rows = (hist.data ?? []) as MimoMessageRow[]
      for (let i = rows.length - 1; i >= 0; i--) {
        const ref = modelRefOf(rows[i]?.info)
        if (ref) {
          preferred = ref
          break
        }
      }
    } catch {
      // no history — pick from the provider list alone
    }

    const listed = (await this.client.provider
      .list({ query: { directory: this.directory } })
      .then((res) => res.data)) as { all?: unknown } | undefined
    const all = Array.isArray(listed?.all)
      ? (listed!.all as Array<{ id?: unknown; models?: unknown }>)
      : []
    const hasPreferred =
      !!preferred &&
      all.some(
        (p) =>
          typeof p.id === 'string' &&
          p.id === preferred!.providerID &&
          p.id !== DESKTOP_ONLY_PROVIDER,
      )
    if (preferred && hasPreferred) return undefined

    let defaultModel: MimoModelRef | undefined
    try {
      const cfg = (await this.client.config
        .providers({ query: { directory: this.directory } })
        .then((res) => res.data)) as { default?: unknown } | undefined
      const def = cfg?.default
      if (isRecord(def)) {
        for (const [providerID, modelID] of Object.entries(def)) {
          if (typeof modelID === 'string' && modelID) {
            defaultModel = { providerID, modelID }
            break
          }
        }
      }
    } catch {
      // no config defaults — fall through
    }
    return pickCliModel(all, preferred, defaultModel)
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
      this.booting = startMimoServer(this.cwd).catch((err) => {
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

  /** `usageStatus: false` — SDK has no rate-limit window API. */
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
