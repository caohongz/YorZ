import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFsRoutes, resolveParent, type FsListResult } from '../routes/fs.js'

async function fixture(): Promise<string> {
  // macOS 的 tmpdir 是 /var → /private/var 软链，realpath 后才能和路由归一化结果对齐。
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'yorz-fs-')))
  await mkdir(join(root, 'alpha'))
  await mkdir(join(root, 'beta'))
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, 'a-file.txt'), 'x', 'utf8')
  return root
}

async function list(app: ReturnType<typeof createFsRoutes>, query: string): Promise<FsListResult> {
  const res = await app.request(`/fs/list${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as FsListResult
}

describe('GET /fs/list', () => {
  it('只返回目录，过滤文件与隐藏目录', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    const body = await list(app, `?path=${encodeURIComponent(root)}`)

    expect(body.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
    expect(body.path).toBe(root)
    expect(body.sep).toBe('/')
    expect(body.truncated).toBe(false)
    expect(body.entries[0]!.path).toBe(join(root, 'alpha'))
  })

  it('showHidden=1 纳入点号开头的目录', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    const body = await list(app, `?path=${encodeURIComponent(root)}&showHidden=1`)

    expect(body.entries.map((e) => e.name)).toEqual(['.hidden', 'alpha', 'beta'])
  })

  it('缺省 path 回落到注入的 homedir', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin', homedir: () => root })
    const body = await list(app, '')

    expect(body.path).toBe(root)
    expect(body.parent).toBe(dirname(root))
  })

  it('跟随指向目录的软链，跳过断链', async () => {
    const root = await fixture()
    await symlink(join(root, 'alpha'), join(root, 'link-ok'))
    await symlink(join(root, 'nope'), join(root, 'link-broken'))
    const app = createFsRoutes({ platform: 'darwin' })
    const body = await list(app, `?path=${encodeURIComponent(root)}`)

    expect(body.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'link-ok'])
  })

  it('不产生副作用：不创建 .yorz/specs', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    await list(app, `?path=${encodeURIComponent(root)}`)

    const after = await list(app, `?path=${encodeURIComponent(root)}&showHidden=1`)
    expect(after.entries.map((e) => e.name)).not.toContain('.yorz')
  })

  it('相对路径返回 400', async () => {
    const app = createFsRoutes({ platform: 'darwin' })
    const res = await app.request('/fs/list?path=relative/dir')

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/absolute/)
  })

  it('不存在的路径返回 400 且带可读提示', async () => {
    const app = createFsRoutes({ platform: 'darwin' })
    const res = await app.request(`/fs/list?path=${encodeURIComponent('/definitely/not/here')}`)

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/does not exist/)
  })

  it('指向文件的路径返回 400', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    const res = await app.request(`/fs/list?path=${encodeURIComponent(join(root, 'a-file.txt'))}`)

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/not a directory/)
  })

  it('win32 下 path 为空串返回盘符列表层', async () => {
    const app = createFsRoutes({ platform: 'win32' })
    const body = await list(app, '?path=')

    expect(body.path).toBe('')
    expect(body.parent).toBeNull()
    expect(body.sep).toBe('\\')
    // 非 Windows 上探测不到任何盘符，这里只约束层级语义与 sep。
    expect(Array.isArray(body.entries)).toBe(true)
  })
})

describe('resolveParent', () => {
  it('POSIX 到 / 为止', () => {
    expect(resolveParent('/a/b', 'linux')).toBe('/a')
    expect(resolveParent('/a', 'linux')).toBe('/')
    expect(resolveParent('/', 'linux')).toBeNull()
  })

  it('win32 盘符根的上级是盘符列表层', () => {
    expect(resolveParent('C:\\a\\b', 'win32')).toBe('C:\\a')
    expect(resolveParent('C:\\a', 'win32')).toBe('C:\\')
    expect(resolveParent('C:\\', 'win32')).toBe('')
  })

  it('win32 UNC 到 share 根即停', () => {
    // UNC 的「根」形态带尾分隔符（`win32.parse().root`），上溯到它即为 share 根。
    expect(resolveParent('\\\\server\\share\\proj', 'win32')).toBe('\\\\server\\share\\')
    expect(resolveParent('\\\\server\\share\\', 'win32')).toBeNull()
  })
})
