import { For, Show, createSignal, type Component } from 'solid-js'
import { ChevronRight, CornerLeftUp, Folder, Monitor } from 'lucide-solid'
import { api, type FsListResult } from '../lib/api.js'
import { isAbsolutePathInput, joinDir, splitBreadcrumb } from '../lib/dir-picker.js'
import { Button } from './ui/button.jsx'
import { Input } from './ui/input.jsx'
import { Checkbox, CheckboxControl, CheckboxLabel } from './ui/checkbox.jsx'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.jsx'
import { t } from '../i18n/index.js'

export interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 添加成功后回调，参数是新项目 id，供调用方跳转。 */
  onAdded?: (projectId: string) => void
}

/**
 * 添加项目对话框：内置一个简洁的本地目录选择器。
 *
 * 目录数据全部来自后端 `GET /api/fs/list`——浏览器拿不到真实文件系统，也不知道
 * 后端跑在哪个平台，因此路径拼接一律使用响应里的 `sep`（见 `lib/dir-picker.ts`）。
 * 目标不是 git 仓库时后端返回 409，这里弹二次确认后带 `gitInit: true` 重试。
 */
export const AddProjectDialog: Component<AddProjectDialogProps> = (props) => {
  const [listing, setListing] = createSignal<FsListResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [pathInput, setPathInput] = createSignal('')
  const [showHidden, setShowHidden] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [needGitInit, setNeedGitInit] = createSignal<string | null>(null)

  /** 当前选中的目录；盘符列表层没有可选目录。 */
  const currentDir = (): string | null => {
    const l = listing()
    if (!l || l.path === '') return null
    return l.path
  }

  async function load(path?: string): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const result = await api.listDirs(path, showHidden())
      setListing(result)
      setPathInput(result.path)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function onOpenChange(open: boolean): void {
    props.onOpenChange(open)
    if (open) {
      setNeedGitInit(null)
      setError(null)
      void load()
    } else {
      setListing(null)
      setPathInput('')
    }
  }

  function gotoInput(): void {
    const raw = pathInput().trim()
    if (!raw) return
    if (raw === listing()?.path) return
    if (!isAbsolutePathInput(raw)) {
      setError(t('addProject.invalidPath'))
      return
    }
    void load(raw)
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
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('addProject.title')}</DialogTitle>
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
            <label class="grid gap-2 text-sm font-medium" for="add-project-path">
              {t('addProject.pathLabel')}
              <Input
                id="add-project-path"
                value={pathInput()}
                placeholder={t('addProject.pathPlaceholder')}
                disabled={submitting()}
                onInput={(e) => setPathInput(e.currentTarget.value)}
                onBlur={gotoInput}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    gotoInput()
                  }
                }}
              />
            </label>

            <div class="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                title={t('addProject.driveRoot')}
                onClick={() => void load('')}
              >
                <Monitor class="h-3.5 w-3.5" />
              </button>
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
