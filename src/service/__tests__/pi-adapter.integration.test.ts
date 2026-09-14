import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PiAdapter } from '../agent-sdk/pi-adapter.js'

/**
 * Runs against the **real** Pi SDK, not the doubles in `pi-adapter.test.ts`.
 *
 * The unit tests assert the mapping given an assumed JSONL/entry shape; this one
 * makes Pi itself write the transcript, so a change to its on-disk format (entry
 * kinds, `SessionInfo` fields, id→path layout) fails here instead of silently
 * emptying the session list in production. No auth or network is involved —
 * `listSessions` / `getMessages` are pure local-store reads.
 */
describe('PiAdapter against the real Pi session store', () => {
  let cwd: string
  let sessionDir: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'yorz-pi-cwd-'))
    sessionDir = mkdtempSync(join(tmpdir(), 'yorz-pi-sessions-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(sessionDir, { recursive: true, force: true })
  })

  function seedSession(id: string): void {
    const manager = SessionManager.create(cwd, sessionDir, { id })
    manager.appendMessage({
      role: 'user',
      content: 'Add the `Pi` adapter to YorZ',
      timestamp: 1000,
    })
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'dropped from the transcript', thinkingSignature: '' },
        { type: 'text', text: 'listing files' },
        { type: 'toolCall', id: 't1', name: 'bash', arguments: { cmd: 'ls' } },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
      },
      stopReason: 'toolUse',
      timestamp: 2000,
    })
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'README.md' }],
      isError: false,
      timestamp: 3000,
    })
  }

  it('lists a session Pi itself wrote and derives a title from the first message', async () => {
    seedSession('yorz-smoke-1')

    const sessions = await new PiAdapter(cwd, { sessionDir }).listSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'yorz-smoke-1',
      kind: 'pi',
      // Backticks are stripped by the shared title summarizer.
      title: 'Add the Pi adapter to YorZ',
    })
    expect(sessions[0]?.updatedAt).toBeGreaterThan(0)
  })

  it('normalizes a real transcript, folding the tool result into the assistant turn', async () => {
    seedSession('yorz-smoke-2')

    const messages = await new PiAdapter(cwd, { sessionDir }).getMessages('yorz-smoke-2')

    expect(messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Add the `Pi` adapter to YorZ' }], ts: 1000 },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'listing files' },
          { type: 'tool-use', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool-result', text: 'README.md' },
        ],
        ts: 2000,
      },
    ])
  })

  it('returns an empty history for an id that is not on disk', async () => {
    seedSession('yorz-smoke-3')

    expect(await new PiAdapter(cwd, { sessionDir }).getMessages('no-such-id')).toEqual([])
  })
})
