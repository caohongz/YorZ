import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

// 显式挑 .tmp-e2e：本机注册了多个项目时 arr[0] 未必是 e2e 临时项目
async function resolveProjectId(
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const res = await request.get('/api/projects')
  const list = (await res.json()) as Array<{ id: string; name?: string }>
  return (list.find((p) => p.name === '.tmp-e2e') ?? list[0]!).id
}

/** 造一个「父目录 + 一个子目录」的夹具，子目录预置 .git 以走「已是 git 仓库」直通路径。 */
async function makeFixture(opts: { git: boolean }): Promise<{ parent: string; child: string }> {
  // macOS 的 tmpdir 是软链，realpath 后才能和后端归一化结果对齐
  const parent = realpathSync(await mkdtemp(join(tmpdir(), 'yorz-e2e-add-')))
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

test.describe.serial('GUI 添加项目', () => {
  test('从侧边栏打开目录选择器，浏览并添加 git 项目', async ({ page, request }) => {
    const { parent, child } = await makeFixture({ git: true })
    try {
      await page.goto(`/${await resolveProjectId(request)}`)

      await page.getByRole('button', { name: '添加项目' }).first().click()
      // DialogContent 未展开 rest，data-testid 会被静默丢弃，只能用 role 定位
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()

      // 粘贴父目录 → 回车跳转
      const input = dialog.locator('#add-project-path')
      await input.fill(parent)
      await input.press('Enter')

      // 列表里出现子目录，点进去
      await dialog.getByRole('button', { name: 'demo-repo' }).click()
      await expect(input).toHaveValue(child)

      await dialog.getByRole('button', { name: '选择此目录' }).click()
      await expect(dialog).toBeHidden()

      // 后端真的注册了该项目
      await expect
        .poll(async () => {
          const list = (await (await request.get('/api/projects')).json()) as Array<{
            path: string
          }>
          return list.some((p) => p.path === child)
        })
        .toBe(true)
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

      const input = dialog.locator('#add-project-path')
      await input.fill(child)
      await input.press('Enter')
      await expect(input).toHaveValue(child)

      await dialog.getByRole('button', { name: '选择此目录' }).click()

      // 409 needGitInit → 二次确认面板
      await expect(dialog.getByText('该目录不是 git 仓库')).toBeVisible()
      await dialog.getByRole('button', { name: '执行 git init 并添加' }).click()
      await expect(dialog).toBeHidden()

      await expect
        .poll(async () => {
          const list = (await (await request.get('/api/projects')).json()) as Array<{
            path: string
          }>
          return list.some((p) => p.path === child)
        })
        .toBe(true)
    } finally {
      await removeProject(request, child)
      await rm(parent, { recursive: true, force: true })
    }
  })
})
