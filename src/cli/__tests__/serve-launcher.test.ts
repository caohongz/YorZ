import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveServeLauncherPath } from '../serve.js'

const LAUNCHER = resolveServeLauncherPath()

function exitCodeOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}

describe('serve-launcher', () => {
  it('spawns the worker with forwarded argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yorz-launcher-'))
    try {
      const marker = join(dir, 'marker.txt')
      const workerJs = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ok'); setTimeout(()=>{},8000)`
      const child = spawn(
        process.execPath,
        [LAUNCHER, '--', process.execPath, '-e', workerJs],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => (stderr += chunk))

      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 })
      expect(await readFile(marker, 'utf8')).toBe('ok')
      expect(stderr).toBe('')
      child.kill()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 15000)

  it('forwards worker stdout through the launcher stdio', async () => {
    const child = spawn(
      process.execPath,
      [LAUNCHER, '--', process.execPath, '-e', `process.stdout.write('worker-stdout'); setTimeout(()=>{},8000)`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    await vi.waitFor(() => expect(stdout).toContain('worker-stdout'), { timeout: 5000 })
    child.kill()
  }, 15000)

  it('guards the worker: stays alive while it runs and exits after it does', async () => {
    // worker 2 秒后自行退出；先验证 launcher 守卫存活，再验证 launcher 随 worker 退出。
    const child = spawn(
      process.execPath,
      [LAUNCHER, '--', process.execPath, '-e', `setTimeout(()=>process.exit(0),2000)`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => (stderr += chunk))

    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()

    const code = await exitCodeOf(child)
    expect(code).toBe(0)
    expect(stderr).toContain('worker exited code=0')
  }, 15000)

  it('exits non-zero when worker argv is missing after "--"', async () => {
    const child = spawn(process.execPath, [LAUNCHER], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    expect(await exitCodeOf(child)).toBe(1)
  }, 15000)
})
