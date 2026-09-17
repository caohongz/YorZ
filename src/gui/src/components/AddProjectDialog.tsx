import { For, Show, createEffect, createSignal, on, type Component } from 'solid-js'
import {
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderPlus,
  HelpCircle,
  Home,
  Monitor,
} from 'lucide-solid'
import { api, type FsListResult } from '../lib/api.js'
import { isValidDirName, joinDir, splitBreadcrumb } from '../lib/dir-picker.js'
import { Button } from './ui/button.jsx'
import { Input } from './ui/input.jsx'
import { Checkbox, CheckboxControl, CheckboxLabel } from './ui/checkbox.jsx'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.jsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.jsx'
import { t } from '../i18n/index.js'

export interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 添加成功后回调，参数是新项目 id，供调用方跳转。 */
  onAdded?: (projectId: string) => void
}

/**
 * 添加项目对话框：内置一个纯点选的本地目录选择器。
 *
 * 目录数据全部来自后端 `GET /api/fs/list`——浏览器拿不到真实文件系统，也不知道
 * 后端跑在哪个平台，因此路径拼接一律使用响应里的 `sep`（见 `lib/dir-picker.ts`），
 * 「主目录」按钮的目标也取自响应里的 `home`。缺省落点由后端按平台决定：POSIX 是
 * 主目录，Windows 是盘符列表页。
 *
 * 目标不是 git 仓库时后端返回 409，这里弹二次确认后带 `gitInit: true` 重试。
 */
export const AddProjectDialog: Component<AddProjectDialogProps> = (props) => {
  const [listing, setListing] = createSignal<FsListResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [showHidden, setShowHidden] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [needGitInit, setNeedGitInit] = createSignal<string | null>(null)
  const [creating, setCreating] = createSignal(false)
  const [newName, setNewName] = createSignal('')
  const [createBusy, setCreateBusy] = createSignal(false)

  /** 当前选中的目录；盘符列表层（win32 的「此电脑」）没有可选目录。 */
  const currentDir = (): string | null => {
    const l = listing()
    if (!l || l.path === '') return null
    return l.path
  }

  /** 后端跑在 Windows 上时才有「此电脑」这一虚拟层级。 */
  const isWindows = (): boolean => listing()?.sep === '\\'

  async function load(path?: string): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const result = await api.listDirs(path, showHidden())
      setListing(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 打开/关闭的副作用挂在 props.open 上而非 Kobalte 的 onOpenChange：弹窗由调用方
  // 的信号受控，外部把 open 置 true 时 onOpenChange 根本不会触发，首帧就拿不到目录。
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setNeedGitInit(null)
          setError(null)
          cancelCreate()
          void load()
        } else {
          setListing(null)
          cancelCreate()
        }
      },
    ),
  )

  function cancelCreate(): void {
    setCreating(false)
    setNewName('')
  }

  async function createDir(): Promise<void> {
    const parent = currentDir()
    const name = newName().trim()
    if (!parent || !isValidDirName(name)) {
      setError(t('addProject.invalidName'))
      return
    }
    setCreateBusy(true)
    setError(null)
    try {
      const created = await api.createDir(parent, name)
      cancelCreate()
      // 直接进入新建的目录：用户多半就是要把它选作项目目录。
      await load(created.path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreateBusy(false)
    }
  }

  async function submit(gitInit: boolean): Promise<void> {
    const dir = currentDir()
    if (!dir) return
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await api.addProject(dir, gitInit ? { gitInit: true } : undefined)
      if (!outcome.ok) {
        setNeedGitInit(outcome.path)
        return
      }
      setNeedGitInit(null)
      props.onOpenChange(false)
      props.onAdded?.(outcome.project.id)
    } catch (err) {
      setError(t('addProject.failed', { message: (err as Error).message }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        class="max-w-xl"
        // 弹窗挂载时 Kobalte 默认聚焦第一个可 Tab 元素——这里恰是标题旁的 `?`，而
        // Kobalte TooltipTrigger 对任何聚焦（含程序化聚焦）都会展开提示，导致一打开
        // 弹窗 CLI 提示就浮出。改为把焦点放在对话框容器上（tabIndex=-1，Kobalte 自身
        // 的兜底行为），Tab 仍能依次走进内部控件。
        onOpenAutoFocus={(e: Event) => {
          e.preventDefault()
          const container = e.currentTarget
          if (container instanceof HTMLElement) container.focus()
        }}
      >
        <DialogHeader>
          <div class="flex items-center gap-1.5">
            <DialogTitle>{t('addProject.title')}</DialogTitle>
            <Tooltip openDelay={150} closeDelay={0}>
              <TooltipTrigger
                as={Button}
                type="button"
                variant="ghost"
                size="icon"
                class="h-6 w-6 text-muted-foreground"
                aria-label={t('addProject.help')}
              >
                <HelpCircle class="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>{t('addProject.helpTooltip')}</TooltipContent>
            </Tooltip>
          </div>
        </DialogHeader>

        <Show
          when={!needGitInit()}
          fallback={
            <div class="grid gap-4">
              <p class="m-0 font-medium">{t('addProject.gitInitTitle')}</p>
              <p class="m-0 text-sm text-muted-foreground break-all">
                {t('addProject.gitInitDesc', { path: needGitInit() ?? '' })}
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting()}
                  onClick={() => setNeedGitInit(null)}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="button" disabled={submitting()} onClick={() => void submit(true)}>
                  {submitting() ? t('common.submitting') : t('addProject.gitInitConfirm')}
                </Button>
              </DialogFooter>
            </div>
          }
        >
          <div class="grid gap-3">
            <div class="flex items-center gap-1">
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm text-muted-foreground">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                  aria-label={t('addProject.home')}
                  title={t('addProject.home')}
                  disabled={!listing()}
                  onClick={() => void load(listing()?.home)}
                >
                  <Home class="h-3.5 w-3.5" />
                </button>
                <Show when={isWindows()}>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                    aria-label={t('addProject.driveRoot')}
                    title={t('addProject.driveRoot')}
                    onClick={() => void load('')}
                  >
                    <Monitor class="h-3.5 w-3.5" />
                  </button>
                </Show>
                <For each={splitBreadcrumb(listing()?.path ?? '', listing()?.sep ?? '/')}>
                  {(seg) => (
                    <>
                      <ChevronRight class="h-3 w-3 shrink-0 opacity-50" />
                      <button
                        type="button"
                        class="rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                        onClick={() => void load(seg.path)}
                      >
                        {seg.label}
                      </button>
                    </>
                  )}
                </For>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="h-7 w-7 shrink-0"
                aria-label={t('addProject.newFolder')}
                title={t('addProject.newFolder')}
                disabled={!currentDir() || loading() || submitting()}
                onClick={() => {
                  setError(null)
                  setCreating(true)
                }}
              >
                <FolderPlus class="h-4 w-4" />
              </Button>
            </div>

            <Show when={creating()}>
              <div class="flex items-center gap-2">
                <Input
                  id="add-project-new-folder"
                  class="h-8"
                  autofocus
                  value={newName()}
                  placeholder={t('addProject.newFolderPlaceholder')}
                  disabled={createBusy()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createDir()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelCreate()
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  class="shrink-0"
                  disabled={createBusy() || !isValidDirName(newName())}
                  onClick={() => void createDir()}
                >
                  {t('addProject.newFolderConfirm')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  class="shrink-0"
                  disabled={createBusy()}
                  onClick={cancelCreate}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </Show>

            <div class="h-64 overflow-y-auto rounded border">
              <Show
                when={!loading()}
                fallback={
                  <p class="m-0 p-3 text-sm text-muted-foreground">{t('addProject.loading')}</p>
                }
              >
                <Show when={listing()?.parent !== null && listing()?.parent !== undefined}>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    onClick={() => void load(listing()!.parent!)}
                  >
                    <CornerLeftUp class="h-4 w-4 shrink-0 opacity-70" />
                    {t('addProject.parent')}
                  </button>
                </Show>
                <For
                  each={listing()?.entries ?? []}
                  fallback={
                    <Show when={listing() && listing()!.entries.length === 0}>
                      <p class="m-0 p-3 text-sm text-muted-foreground">{t('addProject.empty')}</p>
                    </Show>
                  }
                >
                  {(entry) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                      onClick={() =>
                        void load(joinDir(listing()!.path, entry.name, listing()!.sep))
                      }
                    >
                      <Folder class="h-4 w-4 shrink-0 opacity-70" />
                      <span class="truncate">{entry.name}</span>
                    </button>
                  )}
                </For>
                <Show when={listing()?.truncated}>
                  <p class="m-0 px-3 py-1.5 text-sm text-muted-foreground">
                    {t('addProject.truncated')}
                  </p>
                </Show>
              </Show>
            </div>

            <Checkbox
              class="flex items-center gap-2"
              checked={showHidden()}
              onChange={(checked: boolean) => {
                setShowHidden(checked)
                void load(listing()?.path)
              }}
            >
              <CheckboxControl />
              <CheckboxLabel class="text-sm">{t('addProject.showHidden')}</CheckboxLabel>
            </Checkbox>

            <Show when={error()}>
              <p class="m-0 text-sm text-destructive break-all">{error()}</p>
            </Show>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting()}
                onClick={() => props.onOpenChange(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={submitting() || loading() || !currentDir()}
                onClick={() => void submit(false)}
              >
                {submitting() ? t('common.submitting') : t('addProject.choose')}
              </Button>
            </DialogFooter>
          </div>
        </Show>
      </DialogContent>
    </Dialog>
  )
}
