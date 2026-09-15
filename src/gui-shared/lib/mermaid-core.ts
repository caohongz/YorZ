import { resolvedTheme } from './theme.js'

export interface RenderMermaidCleanup {
  (): void
}

/**
 * Platform hooks for the render core.
 *
 * The core owns everything that is genuinely platform-independent: lazy-loading
 * mermaid, the per-container epoch guard, the serial run queue, painting only
 * unprocessed placeholders, and the full redraw on a theme flip. What it does
 * NOT own is the *interaction* layered on top of a finished diagram — desktop
 * adds a hover fullscreen button driven by wheel-zoom/pointer-drag, mobile opens
 * a pinch-zoom sheet. Those have no common shape, so each side injects its own
 * `enhance` and the core just calls it at the right moments.
 */
export interface MermaidCoreOptions {
  /**
   * Called after every successful paint (and after each theme redraw), once the
   * SVGs are in the DOM. Must return a cleanup that undoes whatever it attached;
   * the core calls it before re-rendering and on teardown.
   */
  enhance?: (container: HTMLElement) => RenderMermaidCleanup
}

let mermaidLoaded: Promise<(typeof import('mermaid'))['default']> | null = null
let mermaidRunQueue: Promise<void> = Promise.resolve()
const containerEpoch = new WeakMap<HTMLElement, number>()

/**
 * 就绪门控的帧预算。客户端路由 + View Transition + Suspense 叠加时，Solid 可能在
 * article 真正挂进文档前就把 ref 交给 effect；预测"几帧后就绪"猜不准（上一轮修复
 * 写死一帧，结果是概率性不出图），所以改成按帧轮询 + 硬上限兜底。
 */
const CONTAINER_READY_MAX_FRAMES = 30
/** 事后校验发现漏图时的重画轮数上限，避免异常场景下每帧重绘泄漏。 */
const PAINT_MAX_ATTEMPTS = 3

function isDevEnv(): boolean {
  return (
    typeof import.meta !== 'undefined' &&
    (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true
  )
}

/**
 * 渲染管线里任何"这次没画"的分支都必须留痕。生产构建静默，开发构建吵——上一轮把
 * 报错压成静默 return 后，复发时控制台一片干净，无从下手。
 */
function warnMermaid(reason: string, detail?: Record<string, unknown>): void {
  if (!isDevEnv()) return
  if (detail) {
    console.warn(`[mermaid] ${reason}`, detail)
    return
  }
  console.warn(`[mermaid] ${reason}`)
}

/**
 * 判据只用 isConnected，**不用尺寸**：折叠在 <details> 里的图尺寸为 0 是合法状态，
 * 拿零尺寸当失败会让折叠图被反复重绘。
 */
async function waitForContainerReady(container: HTMLElement, epoch: number): Promise<boolean> {
  for (let frame = 0; frame < CONTAINER_READY_MAX_FRAMES; frame += 1) {
    if (!isCurrentContainerRender(container, epoch)) {
      warnMermaid('readiness wait aborted: superseded by a newer render', { frame })
      return false
    }
    if (container.isConnected) return true
    await nextFrame()
  }
  warnMermaid('container never connected within frame budget; giving up', {
    frames: CONTAINER_READY_MAX_FRAMES,
    placeholders: container.querySelectorAll('.mermaid').length,
  })
  return false
}

/**
 * 失败判据用"没有 svg 子元素"而非 data-processed：mermaid 在渲染**前**就会打上
 * data-processed，打了不等于画成了。
 */
function unpaintedMermaidNodes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.mermaid')).filter((node) => {
    const source = node.getAttribute('data-mermaid-source')
    return source !== null && source !== '' && node.querySelector('svg') === null
  })
}

async function loadMermaid() {
  if (!mermaidLoaded) {
    mermaidLoaded = import('mermaid').then((m) => m.default)
  }
  return mermaidLoaded
}

function getTheme(): 'dark' | 'default' {
  // 跟随应用主题（含手动选择的 light/dark），而非系统偏好——否则在亮色系统上
  // 手动切到暗色时，图表仍会渲染成亮色。
  return resolvedTheme() === 'dark' ? 'dark' : 'default'
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
      return
    }
    window.setTimeout(resolve, 0)
  })
}

function startContainerRender(container: HTMLElement): number {
  const epoch = (containerEpoch.get(container) ?? 0) + 1
  containerEpoch.set(container, epoch)
  return epoch
}

function isCurrentContainerRender(container: HTMLElement, epoch: number): boolean {
  return containerEpoch.get(container) === epoch
}

async function enqueueMermaidRun(task: () => Promise<void>): Promise<void> {
  const run = mermaidRunQueue.then(task, task)
  mermaidRunQueue = run.catch(() => {})
  await run
}

export async function renderMermaidCore(
  container: HTMLElement,
  opts: MermaidCoreOptions = {},
): Promise<RenderMermaidCleanup> {
  // Nothing to draw and nothing to re-theme → no-op (and no listener to clean up).
  if (container.querySelector('.mermaid') === null) {
    warnMermaid('no .mermaid placeholder in container; nothing to render')
    return () => {}
  }

  const epoch = startContainerRender(container)
  const mermaid = await loadMermaid()
  if (!isCurrentContainerRender(container, epoch)) {
    warnMermaid('render superseded while loading mermaid module')
    return () => {}
  }
  // On client-side route transitions Solid may assign the ref before the article is
  // fully connected. Poll by frame until it is, instead of guessing a fixed delay.
  if (!(await waitForContainerReady(container, epoch))) return () => {}
  let enhanceCleanup: RenderMermaidCleanup = () => {}
  let runFailed = false

  function refreshEnhance() {
    enhanceCleanup()
    enhanceCleanup = opts.enhance ? opts.enhance(container) : () => {}
  }

  async function render(nodes: HTMLElement[]) {
    const liveNodes = nodes.filter((node) => node.isConnected && container.contains(node))
    if (liveNodes.length === 0) {
      warnMermaid('all candidate nodes are detached from the container; skipping run', {
        candidates: nodes.length,
      })
      return
    }

    await enqueueMermaidRun(async () => {
      if (!isCurrentContainerRender(container, epoch)) {
        warnMermaid('render superseded while waiting in the mermaid run queue')
        return
      }
      const currentNodes = liveNodes.filter((node) => node.isConnected && container.contains(node))
      if (currentNodes.length === 0) {
        warnMermaid('nodes went detached while waiting in the mermaid run queue', {
          candidates: liveNodes.length,
        })
        return
      }

      const theme = getTheme()
      mermaid.initialize({ startOnLoad: false, theme })
      enhanceCleanup()
      enhanceCleanup = () => {}

      currentNodes.forEach((node) => {
        const source = node.getAttribute('data-mermaid-source')
        if (source) {
          node.removeAttribute('data-processed')
          // 用 textContent 写入原始源码，避免浏览器把 `<x>` 等标签形 token
          // 当作 HTML 二次解码，保证 mermaid 读到的 textContent 与 lint 一致。
          node.textContent = source
        }
      })

      try {
        await mermaid.run({ nodes: currentNodes })
        await nextFrame()
        refreshEnhance()
      } catch (err) {
        // 源码本身有语法错误时重画多少次都一样，标记后让上层退出重试循环。
        runFailed = true
        console.error('[mermaid] render error:', err)
      }
    })
  }

  // Initial pass only renders NEW/CHANGED nodes: morphdom leaves unchanged mermaid
  // SVGs in place (still carrying data-processed), so rendering all of them again
  // would needlessly redraw and thrash height. Only raw placeholders — those
  // without data-processed — need painting.
  let nodesToPaint = Array.from(
    container.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])'),
  )
  // 事后校验 + 有界自愈：画完一轮就回头数还有几张没出 svg，有漏就再画一轮。这样
  // 即便本批次被更新的批次顶掉、或容器刚挂载时某些节点还没就位，最终仍能画到为止。
  // Await the actual render: the returned promise must not resolve until the SVG
  // has been injected, so callers observing the final height see it settled.
  for (let attempt = 1; attempt <= PAINT_MAX_ATTEMPTS; attempt += 1) {
    if (nodesToPaint.length > 0) await render(nodesToPaint)
    if (runFailed) break
    if (!isCurrentContainerRender(container, epoch)) {
      warnMermaid('paint loop superseded by a newer render; the newer one takes over', { attempt })
      break
    }
    const missed = unpaintedMermaidNodes(container)
    if (missed.length === 0) break
    if (attempt === PAINT_MAX_ATTEMPTS) {
      warnMermaid('still unpainted after max paint attempts; giving up', {
        attempts: PAINT_MAX_ATTEMPTS,
        unpainted: missed.length,
      })
      break
    }
    await nextFrame()
    nodesToPaint = missed
  }
  await nextFrame()
  refreshEnhance()

  // A theme flip must re-render EVERY diagram, processed or not — re-query live at
  // event time so diagrams added by later refreshes are included too.
  const rerenderAll = () =>
    void render(Array.from(container.querySelectorAll<HTMLElement>('.mermaid')))
  // 观察 <html data-kb-theme> 而非 matchMedia：属性是所有主题变更路径（引导脚本、
  // 手动切换、system 模式下的系统翻转）的共同终点，一处订阅即可覆盖全部。
  // 与本模块其余浏览器 API 一致地走 window.*，而非裸全局
  const themeObserver = new window.MutationObserver(rerenderAll)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-kb-theme'],
  })

  return () => {
    enhanceCleanup()
    themeObserver.disconnect()
  }
}
