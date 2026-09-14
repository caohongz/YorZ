import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { E2E_FS_HOME } from './fixtures/setup.js'

// 显式挑 .tmp-e2e：本机注册了多个项目时 arr[0] 未必是 e2e 临时项目
async function resolveProjectId(
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const res = await request.get('/api/projects')
  const list = (await res.json()) as Array<{ id: string; name?: string }>
  return (list.find((p) => p.name === '.tmp-e2e') ?? list[0]!).id
}

/**
 * 造一个「父目录 + 一个子目录」的夹具。
 *
 * 目录选择器已没有路径输入框，只能点选；缺省落点是 Service 进程的 `os.homedir()`，
 * 而 playwright.config 把它指向了隔离的 `.tmp-e2e-fs-home`——夹具必须建在该目录下
 * 才走得到。
 */
async function makeFixture(opts: { git: boolean }): Promise<{ parent: string; child: string }> {
  // macOS 下 realpath 后才能和后端归一化结果对齐
  const parent = realpathSync(await mkdtemp(join(E2E_FS_HOME, 'add-')))
  const child = join(parent, 'demo-repo')
  await mkdir(child)
  if (opts.git) await mkdir(join(child, '.git'))
  return { parent, child }
}

async function removeProject(
  request: import('@playwright/test').APIRequestContext,
  path: string,
): Promise<void> {
  const res = await request.get('/api/projects')
  const list = (await res.json()) as Array<{ id: string; path: string }>
  const hit = list.find((p) => p.path === path)
  if (hit) await request.delete(`/api/projects/${hit.id}`)
}

async function expectRegistered(
  request: import('@playwright/test').APIRequestContext,
  path: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const list = (await (await request.get('/api/projects')).json()) as Array<{ path: string }>
      return list.some((p) => p.path === path)
    })
    .toBe(true)
}

test.describe.serial('GUI 添加项目', () => {
  test('从侧边栏打开目录选择器，点选浏览并添加 git 项目', async ({ page, request }) => {
    const { parent, child } = await makeFixture({ git: true })
    try {
      await page.goto(`/${await resolveProjectId(request)}`)

      await page.getByRole('button', { name: '添加项目' }).first().click()
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()

      // 未 hover 时 ? 提示不得自己浮出：弹窗挂载的自动聚焦一度落在 ? 按钮上，
      // 而 Kobalte TooltipTrigger 对任何聚焦都会展开提示（见 debug.md · Debug 2）
      await expect(page.getByText('yorz add <path>')).toBeHidden()

      // 缺省落点即隔离 HOME：逐级点进夹具
      await dialog.getByRole('button', { name: basename(parent), exact: true }).click()
      await dialog.getByRole('button', { name: 'demo-repo', exact: true }).click()

      // 标题旁的 ? 提示可用
      await dialog.getByRole('button', { name: '帮助' }).hover()
      await expect(page.getByText('yorz add <path>')).toBeVisible()

      await dialog.getByRole('button', { name: '选择此目录' }).click()
      await expect(dialog).toBeHidden()

      await expectRegistered(request, child)
    } finally {
      await removeProject(request, child)
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('非 git 目录先弹二次确认，确认后执行 git init 并添加', async ({ page, request }) => {
    const { parent, child } = await makeFixture({ git: false })
    try {
      await page.goto(`/${await resolveProjectId(request)}`)

      await page.getByRole('button', { name: '添加项目' }).first().click()
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()

      await dialog.getByRole('button', { name: basename(parent), exact: true }).click()
      await dialog.getByRole('button', { name: 'demo-repo', exact: true }).click()
      await dialog.getByRole('button', { name: '选择此目录' }).click()

      // 409 needGitInit → 二次确认面板
      await expect(dialog.getByText('该目录不是 git 仓库')).toBeVisible()
      await dialog.getByRole('button', { name: '执行 git init 并添加' }).click()
      await expect(dialog).toBeHidden()

      await expectRegistered(request, child)
    } finally {
      await removeProject(request, child)
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('在选择器内新建目录后直接添加', async ({ page, request }) => {
    const { parent } = await makeFixture({ git: false })
    const created = join(parent, 'fresh-dir')
    try {
      await page.goto(`/${await resolveProjectId(request)}`)

      await page.getByRole('button', { name: '添加项目' }).first().click()
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: basename(parent), exact: true }).click()

      await dialog.getByRole('button', { name: '新建文件夹' }).click()
      await dialog.locator('#add-project-new-folder').fill('fresh-dir')
      await dialog.getByRole('button', { name: '创建', exact: true }).click()

      // 创建后自动进入新目录：面包屑末段就是它，且列表为空
      await expect(dialog.getByText('该目录下没有子目录')).toBeVisible()

      await dialog.getByRole('button', { name: '选择此目录' }).click()
      await expect(dialog.getByText('该目录不是 git 仓库')).toBeVisible()
      await dialog.getByRole('button', { name: '执行 git init 并添加' }).click()
      await expect(dialog).toBeHidden()

      await expectRegistered(request, created)
    } finally {
      await removeProject(request, created)
      await rm(parent, { recursive: true, force: true })
    }
  })
})
