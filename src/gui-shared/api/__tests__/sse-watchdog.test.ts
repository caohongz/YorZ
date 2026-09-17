import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMuxForTests, subscribeProjectsList } from '../sse.js'

/**
 * 最小 EventSource 替身：只实现 mux 用到的部分，并暴露 emit* 方法供用例驱动。
 * 关键点是它**不会**自己重连——这正是「僵尸连接」的模型：readyState 停在 OPEN，
 * 既不报 error 也不再有任何帧。
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  closed = false
  private listeners = new Map<string, Set<(e: unknown) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(cb)
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  private dispatch(type: string, data?: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data } as unknown)
  }

  emitOpen(): void {
    this.readyState = 1
    this.dispatch('open')
  }

  emitHeartbeat(): void {
    this.dispatch('server-heartbeat', JSON.stringify({ ts: 1 }))
  }

  emitMsg(topic: string, event: string, data: unknown = {}): void {
    this.dispatch('msg', JSON.stringify({ topic, event, data }))
  }

  emitError(): void {
    this.dispatch('error')
  }
}

const g = globalThis as unknown as {
  EventSource?: unknown
  fetch?: unknown
}
let origEventSource: unknown
let origFetch: unknown
let subscribeBodies: string[]

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  subscribeBodies = []
  origEventSource = g.EventSource
  origFetch = g.fetch
  g.EventSource = FakeEventSource
  g.fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
    subscribeBodies.push(init?.body ?? '')
    return { ok: true } as unknown
  })
  __resetMuxForTests()
})

afterEach(() => {
  __resetMuxForTests()
  g.EventSource = origEventSource
  g.fetch = origFetch
  vi.useRealTimers()
})

const latest = (): FakeEventSource =>
  FakeEventSource.instances[FakeEventSource.instances.length - 1]!

describe('SseMultiplex 连接看门狗', () => {
  it('心跳持续到达时不重建连接', async () => {
    subscribeProjectsList(() => {})
    latest().emitOpen()
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      latest().emitHeartbeat()
    }
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(latest().closed).toBe(false)
  })

  it('连接僵死（readyState 仍为 OPEN 但长时间无帧）时强制重建并重新订阅全部 topic', async () => {
    const onChange = vi.fn()
    subscribeProjectsList(onChange)
    const zombie = latest()
    zombie.emitOpen()
    await vi.advanceTimersByTimeAsync(50)
    expect(FakeEventSource.instances).toHaveLength(1)

    // 模拟 Service 重启：代理与后端断了，但浏览器这端连接仍是 OPEN、不报 error、无帧。
    await vi.advanceTimersByTimeAsync(20_000)

    expect(zombie.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(2)

    // 新连接 open 后必须把 topic 重新订阅回去，否则服务端的新会话不认识我们。
    subscribeBodies.length = 0
    latest().emitOpen()
    await vi.advanceTimersByTimeAsync(50)
    expect(subscribeBodies.some((b) => b.includes('"projects"'))).toBe(true)

    // 重连后的事件能正常送达订阅方。
    latest().emitMsg('projects', 'projects-changed')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('浏览器彻底放弃重连（readyState = CLOSED）时由看门狗接管重建', async () => {
    subscribeProjectsList(() => {})
    const first = latest()
    first.emitOpen()
    // 代理回 HTTP 错误码：浏览器置 CLOSED 且不再重试。
    first.readyState = 2
    first.emitError()
    expect(FakeEventSource.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('普通消息帧也算活性信号，不会被误判为僵死', async () => {
    subscribeProjectsList(() => {})
    latest().emitOpen()
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      latest().emitMsg('projects', 'projects-changed')
    }
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
