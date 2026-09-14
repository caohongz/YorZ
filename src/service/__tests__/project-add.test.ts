import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addProject, loadGlobalConfig } from '../global-config.js'
import { addProjectWithGit, NeedGitInitError } from '../project-add.js'
import { ProjectRegistry } from '../project-registry.js'
import { createProjectRoutes } from '../routes/project.js'

interface Fixture {
  root: string
  configPath: string
}

async function fixture(): Promise<Fixture> {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'yorz-add-')))
  const root = join(base, 'proj')
  await mkdir(root)
  return { root, configPath: join(base, 'config.json') }
}

async function makeGitRepo(dir: string): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true })
}

describe('addProjectWithGit', () => {
  it('非 git 目录且未授权时抛 NeedGitInitError，且零副作用', async () => {
    const { root, configPath } = await fixture()

    await expect(addProjectWithGit({ path: root, globalConfigPath: configPath })).rejects.toThrow(
      NeedGitInitError,
    )

    // 关键回归点：git 检查必须先于 prepareProjectDir，不能留下脏目录。
    expect(existsSync(join(root, '.yorz'))).toBe(false)
    expect(existsSync(configPath)).toBe(false)
  })

  it('已是 git 仓库时直接注册并写 gitignore', async () => {
    const { root, configPath } = await fixture()
    await makeGitRepo(root)

    const result = await addProjectWithGit({ path: root, globalConfigPath: configPath })

    expect(result.created).toBe(true)
    expect(result.gitInitialized).toBe(false)
    expect(result.gitignore).toEqual({ updated: true, path: join(root, '.gitignore') })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.yorz/tmp')
    expect(existsSync(join(root, '.yorz', 'specs'))).toBe(true)
  })

  it('gitInit: true 时执行 git init 后继续注册', async () => {
    const { root, configPath } = await fixture()
    const calls: string[] = []

    const result = await addProjectWithGit({
      path: root,
      globalConfigPath: configPath,
      gitInit: true,
      runGitInit: async (cwd) => {
        calls.push(cwd)
        await makeGitRepo(cwd)
      },
    })

    expect(calls).toEqual([root])
    expect(result.gitInitialized).toBe(true)
    expect(result.created).toBe(true)
    expect(result.gitignore?.updated).toBe(true)
  })

  it('已存在 .yorz/tmp 条目时不重复写入', async () => {
    const { root, configPath } = await fixture()
    await makeGitRepo(root)
    await writeFile(join(root, '.gitignore'), 'node_modules\n.yorz/tmp\n', 'utf8')

    const result = await addProjectWithGit({ path: root, globalConfigPath: configPath })

    expect(result.gitignore).toEqual({ updated: false, path: join(root, '.gitignore') })
  })

  it('重复添加同一路径是幂等的', async () => {
    const { root, configPath } = await fixture()
    await makeGitRepo(root)

    const first = await addProjectWithGit({ path: root, globalConfigPath: configPath })
    const second = await addProjectWithGit({ path: root, globalConfigPath: configPath })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.entry.id).toBe(first.entry.id)
    const config = await loadGlobalConfig(configPath)
    expect(config.projects).toHaveLength(1)
  })

  it('路径不存在时报可读错误', async () => {
    const { root, configPath } = await fixture()

    await expect(
      addProjectWithGit({ path: join(root, 'missing'), globalConfigPath: configPath }),
    ).rejects.toThrow(/does not exist/)
  })
})

describe('POST /projects 两步式 git init', () => {
  function routes(configPath: string) {
    const registry = new ProjectRegistry({ globalConfigPath: configPath })
    return createProjectRoutes(registry, {} as never)
  }

  async function post(
    app: ReturnType<typeof routes>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return await app.request('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('非 git 目录返回 409 needGitInit 且不建 .yorz', async () => {
    const { root, configPath } = await fixture()
    const res = await post(routes(configPath), { path: root })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { needGitInit: boolean; path: string }
    expect(body.needGitInit).toBe(true)
    expect(body.path).toBe(root)
    expect(existsSync(join(root, '.yorz'))).toBe(false)
  })

  it('二次确认后带 gitInit: true 成功注册', async () => {
    const { root, configPath } = await fixture()
    const app = routes(configPath)

    expect((await post(app, { path: root })).status).toBe(409)
    await makeGitRepo(root) // 模拟 git init 的结果，避免在测试中真的派生 git 子进程
    const res = await post(app, { path: root, gitInit: true })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { path: string; name: string }
    expect(body.path).toBe(root)
    expect(body.name).toBe('proj')
    expect(existsSync(join(root, '.yorz', 'specs'))).toBe(true)
  })

  it('相对路径返回 400', async () => {
    const { configPath } = await fixture()
    const res = await post(routes(configPath), { path: 'relative/dir' })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/absolute/)
  })
})

describe('addProject 去重（平台感知）', () => {
  it('win32 下大小写不同的同一路径只注册一条', async () => {
    const { configPath } = await fixture()

    const first = await addProject('C:\\Repo', configPath, undefined, 'win32')
    const second = await addProject('c:\\repo', configPath, undefined, 'win32')

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.entry.id).toBe(first.entry.id)
    const config = await loadGlobalConfig(configPath)
    expect(config.projects).toHaveLength(1)
  })

  it('POSIX 下大小写不同视为两个项目', async () => {
    const { configPath } = await fixture()

    const first = await addProject('/work/Repo', configPath, undefined, 'linux')
    const second = await addProject('/work/repo', configPath, undefined, 'linux')

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    const config = await loadGlobalConfig(configPath)
    expect(config.projects).toHaveLength(2)
  })
})
