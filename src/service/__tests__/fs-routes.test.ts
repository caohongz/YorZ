import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFsRoutes, resolveParent, validateDirName, type FsListResult } from '../routes/fs.js'

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

  it('win32 下缺省 path 也落在盘符列表层（而非主目录）', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'win32', homedir: () => root })
    const body = await list(app, '')

    expect(body.path).toBe('')
    expect(body.parent).toBeNull()
  })

  it('响应始终回填 home，供前端渲染「主目录」入口', async () => {
    const root = await fixture()
    const posix = createFsRoutes({ platform: 'darwin', homedir: () => root })
    expect((await list(posix, '')).home).toBe(root)

    // win32 盘符层同样带 home，否则 Windows 上主目录将失去入口。
    const win = createFsRoutes({ platform: 'win32', homedir: () => 'C:\\Users\\me' })
    expect((await list(win, '')).home).toBe('C:\\Users\\me')
  })
})

async function mkdirReq(
  app: ReturnType<typeof createFsRoutes>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/fs/mkdir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /fs/mkdir', () => {
  it('在已存在的父目录下创建单层目录', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    const res = await mkdirReq(app, { parent: root, name: 'gamma' })

    expect(res.status).toBe(201)
    expect(((await res.json()) as { path: string }).path).toBe(join(root, 'gamma'))
    expect((await stat(join(root, 'gamma'))).isDirectory()).toBe(true)
  })

  it('目录已存在返回 409', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    const res = await mkdirReq(app, { parent: root, name: 'alpha' })

    expect(res.status).toBe(409)
  })

  it('名称含路径分隔符或 .. 一律 400，且不产生目录', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })

    expect((await mkdirReq(app, { parent: root, name: 'a/b' })).status).toBe(400)
    expect((await mkdirReq(app, { parent: root, name: '..' })).status).toBe(400)
    expect((await mkdirReq(app, { parent: root, name: '   ' })).status).toBe(400)
    expect((await mkdirReq(app, { parent: root, name: '..\\escape' })).status).toBe(400)
    await expect(stat(join(dirname(root), 'escape'))).rejects.toThrow()
  })

  it('parent 不存在 / 非绝对路径 / 盘符层返回 400', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })

    expect((await mkdirReq(app, { parent: join(root, 'nope'), name: 'x' })).status).toBe(400)
    expect((await mkdirReq(app, { parent: 'relative/dir', name: 'x' })).status).toBe(400)
    expect((await mkdirReq(app, { parent: '', name: 'x' })).status).toBe(400)
  })

  it('parent 指向文件返回 400', async () => {
    const root = await fixture()
    const app = createFsRoutes({ platform: 'darwin' })
    const res = await mkdirReq(app, { parent: join(root, 'a-file.txt'), name: 'x' })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/not a directory/)
  })
})

describe('validateDirName', () => {
  it('接受普通目录名', () => {
    expect(validateDirName('repo', 'darwin')).toBeNull()
    expect(validateDirName('  my-repo ', 'darwin')).toBeNull()
    expect(validateDirName('我的项目', 'win32')).toBeNull()
  })

  it('拒绝空/点目录/分隔符/超长/控制字符', () => {
    expect(validateDirName('', 'darwin')).toMatch(/empty/)
    expect(validateDirName('.', 'darwin')).toMatch(/"\."/)
    expect(validateDirName('..', 'darwin')).toMatch(/"\."/)
    expect(validateDirName('a/b', 'darwin')).toMatch(/separator/)
    expect(validateDirName('a\\b', 'darwin')).toMatch(/separator/)
    expect(validateDirName('x'.repeat(256), 'darwin')).toMatch(/too long/)
    expect(validateDirName('a\u0001b', 'darwin')).toMatch(/control/)
  })

  it('win32 额外拒绝保留字符、保留设备名与尾随点号空格', () => {
    expect(validateDirName('a?b', 'win32')).toMatch(/Windows/)
    expect(validateDirName('CON', 'win32')).toMatch(/reserved/)
    expect(validateDirName('com1.txt', 'win32')).toMatch(/reserved/)
    expect(validateDirName('repo.', 'win32')).toMatch(/dot or space/)
    // 同样的名称在 POSIX 上是合法的
    expect(validateDirName('CON', 'linux')).toBeNull()
    expect(validateDirName('a?b', 'linux')).toBeNull()
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
