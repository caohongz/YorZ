import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MimoAdapter, messagePartsFromMimoPart } from '../agent-sdk/mimo-adapter.js'
import type { AgentEvent } from '../agent-sdk/types.js'

interface FakePromptData {
  info: {
    role: string
    time: { created: number; completed: number }
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    modelID: string
  }
  parts: unknown[]
}

function resetPromptResult(): void {
  mimo.promptResult = {
    data: {
      info: {
        role: 'assistant',
        time: { created: 1, completed: 2 },
        cost: 0.034,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 20 } },
        modelID: 'mimo-v2.6-pro',
      },
      parts: [],
    },
    error: undefined,
  }
}

function setPromptParts(parts: unknown[]): void {
  const data = mimo.promptResult.data
  if (!data) throw new Error('promptResult.data missing; call resetPromptResult first')
  data.parts = parts
}

const mimo = vi.hoisted(() => ({
  createOpencode: vi.fn(),
  promptResult: {
    data: undefined as unknown,
    error: undefined as unknown,
  } as { data?: FakePromptData; error?: unknown },
  promptError: undefined as unknown,
  events: [] as unknown[],
  listed: [] as unknown[],
  messages: [] as unknown[],
  createdId: 'ses-new',
  aborts: 0,
}))

vi.mock('@mimo-ai/sdk', () => ({
  createOpencode: mimo.createOpencode,
}))

function fakeClient() {
  return {
    event: {
      // Matches hey-api `ServerSentEventsResult`: `{ stream: AsyncGenerator }`.
      subscribe: async () => ({
        stream: (async function* () {
          for (const ev of mimo.events) yield ev
        })(),
      }),
    },
    session: {
      create: async () => ({ data: { id: mimo.createdId } }),
      // Settle on a macrotask so the SSE pump can drain the mock stream first.
      // Without this, prompt resolves in a microtask and tears the stream down
      // before any event is read — mirroring the review race, but deterministically.
      prompt: async () => {
        await new Promise((r) => setTimeout(r, 0))
        return mimo.promptResult
      },
      promptAsync: async () => mimo.promptResult,
      abort: async () => {
        mimo.aborts += 1
      },
      list: async () => ({ data: mimo.listed }),
      messages: async () => ({ data: mimo.messages }),
    },
  }
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('messagePartsFromMimoPart', () => {
  it('maps text and tool parts', () => {
    expect(messagePartsFromMimoPart({ type: 'text', text: 'hi' })).toEqual([
      { type: 'text', text: 'hi' },
    ])
    expect(
      messagePartsFromMimoPart({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { cmd: 'ls' }, output: 'a.ts' },
      }),
    ).toEqual([
      { type: 'tool-use', name: 'bash', input: { cmd: 'ls' } },
      { type: 'tool-result', text: 'a.ts' },
    ])
  })
})

describe('MimoAdapter', () => {
  beforeEach(() => {
    mimo.events = []
    mimo.listed = []
    mimo.messages = []
    mimo.aborts = 0
    mimo.createdId = 'ses-new'
    resetPromptResult()
    mimo.createOpencode.mockReset()
    mimo.createOpencode.mockResolvedValue({
      client: fakeClient(),
      server: { url: 'http://127.0.0.1:0', close: vi.fn() },
    })
  })

  it('declares list/messages support but no usage-status (P1)', () => {
    expect(new MimoAdapter('/repo').capabilities()).toEqual({
      listSessions: true,
      getMessages: true,
      usageStatus: false,
    })
  })

  it('streams SSE text/tool events then emits turn-completed with fromMimo usage', async () => {
    mimo.events = [
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: 'ses-1', type: 'text', text: 'hello' },
          delta: 'hello',
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 't1',
            sessionID: 'ses-1',
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { cmd: 'ls' } },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 't1',
            sessionID: 'ses-1',
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed', input: { cmd: 'ls' }, output: 'a.ts' },
          },
        },
      },
    ]
    setPromptParts([
      { id: 'p1', sessionID: 'ses-1', type: 'text', text: 'hello' },
      {
        id: 't1',
        sessionID: 'ses-1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { cmd: 'ls' }, output: 'a.ts' },
      },
    ])
    const adapter = new MimoAdapter('/repo')
    const session = await adapter.resumeSession('ses-1')
    const events = await collect(session.send('go'))

    expect(events[0]).toEqual({ type: 'session-started', sessionId: 'ses-1' })
    // Dedupe: streamed parts are not replayed by the merge pass.
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1)
    expect(events.some((e) => e.type === 'text' && e.delta === 'hello')).toBe(true)
    expect(events.filter((e) => e.type === 'tool-use')).toHaveLength(1)
    expect(events.some((e) => e.type === 'tool-use' && e.name === 'bash')).toBe(true)
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(1)
    expect(events.some((e) => e.type === 'tool-result' && e.text === 'a.ts')).toBe(true)
    const done = events.find((e) => e.type === 'turn-completed')
    expect(done).toBeTruthy()
    if (done?.type === 'turn-completed') {
      expect(done.usage).toEqual({
        cost: 0.034,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 20 } },
      })
      expect(done.metrics?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadTokens: 100,
        cacheCreateTokens: 20,
        costUsd: 0.034,
      })
      expect(done.metrics?.model).toBe('mimo-v2.6-pro')
    }
  })

  it('ignores SSE events belonging to another session', async () => {
    mimo.events = [
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'px', sessionID: 'ses-other', type: 'text', text: 'intruder' },
          delta: 'intruder',
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: 'ses-1', type: 'text', text: 'mine' },
          delta: 'mine',
        },
      },
    ]
    setPromptParts([])
    const session = await new MimoAdapter('/repo').resumeSession('ses-1')
    const events = await collect(session.send('go'))
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)
    expect(texts).toEqual(['mine'])
  })

  it('merges the tail when SSE drops mid-turn', async () => {
    // Stream delivered only the first text part; tool exchange arrives solely
    // on the prompt payload (the "missed the tail" case from review).
    mimo.events = [
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: 'ses-1', type: 'text', text: 'head' },
          delta: 'head',
        },
      },
    ]
    setPromptParts([
      { id: 'p1', sessionID: 'ses-1', type: 'text', text: 'head' },
      { id: 'p2', sessionID: 'ses-1', type: 'text', text: 'tail' },
      {
        id: 't1',
        sessionID: 'ses-1',
        type: 'tool',
        tool: 'Write',
        state: { status: 'completed', input: { path: 'spec.md' }, output: 'ok' },
      },
    ])
    const session = await new MimoAdapter('/repo').resumeSession('ses-1')
    const events = await collect(session.send('go'))
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)
    expect(texts).toEqual(['head', 'tail'])
    expect(events.some((e) => e.type === 'tool-use' && e.name === 'Write')).toBe(true)
    expect(events.some((e) => e.type === 'tool-result' && e.text === 'ok')).toBe(true)
  })

  it('emits compact from a CompactionPart and error when the prompt fails', async () => {
    mimo.events = [
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'c1', sessionID: 'ses-1', type: 'compaction', auto: true },
        },
      },
    ]
    setPromptParts([])
    const session = await new MimoAdapter('/repo').resumeSession('ses-1')
    const events = await collect(session.send('go'))
    expect(events.some((e) => e.type === 'compact')).toBe(true)
    const compact = events.find((e) => e.type === 'compact')
    if (compact?.type === 'compact') {
      expect(compact.metrics.trigger).toBe('auto')
      expect(compact.metrics.preTokens).toBeUndefined()
    }

    mimo.promptResult = { data: undefined, error: { data: { message: 'boom' } } }
    const session2 = await new MimoAdapter('/repo').resumeSession('ses-1')
    const errEvents = await collect(session2.send('go'))
    expect(errEvents.some((e) => e.type === 'error' && e.message === 'boom')).toBe(true)
    expect(errEvents.some((e) => e.type === 'turn-completed')).toBe(false)
  })

  it('falls back to part replay when SSE never streams', async () => {
    mimo.events = []
    setPromptParts([
      { id: 'p1', type: 'text', text: 'offline' },
      {
        id: 't1',
        type: 'tool',
        tool: 'Write',
        state: { status: 'completed', input: { path: 'a.ts' }, output: 'ok' },
      },
    ])
    const adapter = new MimoAdapter('/repo')
    const session = await adapter.resumeSession('ses-2')
    const events = await collect(session.send('go'))
    const types = events.map((e) => e.type)
    expect(types).toContain('text')
    expect(types).toContain('tool-use')
    expect(types).toContain('tool-result')
    expect(types).toContain('turn-completed')
    // fallback must not double-emit when SSE already streamed
    expect(types.filter((t) => t === 'text')).toHaveLength(1)
  })

  it('maps history parts including tool exchange', async () => {
    mimo.messages = [
      {
        info: { role: 'user', time: { created: 10 } },
        parts: [{ type: 'text', text: 'hi' }],
      },
      {
        info: { role: 'assistant', time: { created: 20 } },
        parts: [
          { type: 'text', text: 'run' },
          {
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed', input: { cmd: 'ls' }, output: 'x' },
          },
        ],
      },
    ]
    const messages = await new MimoAdapter('/repo').getMessages('ses-3')
    expect(messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }], ts: 10 },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'run' },
          { type: 'tool-use', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool-result', text: 'x' },
        ],
        ts: 20,
      },
    ])
  })

  it('filters listSessions to the adapter cwd', async () => {
    mimo.listed = [
      { id: 'a', title: 'A', directory: '/repo', time: { created: 1, updated: 2 } },
      { id: 'b', title: 'B', directory: '/other', time: { created: 1, updated: 3 } },
      { id: 'c', time: { created: 4, updated: 5 } },
    ]
    const list = await new MimoAdapter('/repo').listSessions()
    expect(list.map((s) => s.id)).toEqual(['c', 'a'])
    expect(list.every((s) => s.kind === 'mimo')).toBe(true)
  })
})
