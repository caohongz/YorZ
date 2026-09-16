import { useBeforeLeave, useIsRouting, useLocation } from '@solidjs/router'
import type { BeforeLeaveEventArgs } from '@solidjs/router'
import {
  decideDirection,
  prefersReducedMotion,
  runViewTransition,
  supportsViewTransition,
  waitFor,
  type ViewTransitionDirectionResolver,
} from './view-transition.js'

/**
 * 把 View Transition 接到 solid-router 上（桌面端与移动端共用）。
 *
 * 与 `view-transition.ts` 分家的原因：`@solidjs/router` 在 node 环境下 import
 * 即抛「Client-only API called on the server side」，同文件会让那边的纯函数
 * 没法在 vitest 里直接测。这里只留跑在浏览器里的那一半。
 *
 * ## 为什么拦在 useBeforeLeave
 *
 * solid-router 的三类导航——`<A>` 点击、程序化 `navigate()`、浏览器/系统的
 * 前进后退（popstate）——最终都汇合到 `beforeLeave.confirm()`。在这里注册一次
 * 就全覆盖，不必去改几十个调用点，新增页面也零成本。
 *
 * ## 为什么必须「先拦下、再在更新回调里放行」
 *
 * `document.startViewTransition(cb)` 的时序是：捕获旧快照 → 执行 `cb` →
 * 等 `cb` 的 promise resolve → 捕获新快照 → 播动画。而 solid-router 的提交在
 * 没有异步资源时是**同步**发生的。若只是「顺手起一个过渡、不拦导航」，DOM 会在
 * 旧快照捕获之前就换掉，旧快照拍到的是新页面，动画退化成「新页面淡入新页面」。
 * 所以只能：`preventDefault()` 拦下 → 起过渡 → 在更新回调里 `retry(true)` 放行
 * → 等提交完成再 resolve。
 */
export function createViewTransitionNav(opts: {
  resolveDirection: ViewTransitionDirectionResolver
}): void {
  const location = useLocation()
  const isRouting = useIsRouting()

  useBeforeLeave((e: BeforeLeaveEventArgs) => {
    const from = location.pathname
    const direction = decideDirection(
      {
        fromPathname: from,
        to: e.to,
        replace: e.options?.replace,
        defaultPrevented: e.defaultPrevented,
        // 现读而不是在注册时算一次：用户可能中途改系统的「减弱动态效果」
        enabled: supportsViewTransition() && !prefersReducedMotion(),
      },
      opts.resolveDirection,
    )
    if (!direction) return

    const isTraversal = typeof e.to === 'number'
    e.preventDefault()

    // ## 遍历导航（系统返回/前进，e.to 为数字）必须串行化两个相反的 history.go
    //
    // solid-router 对被 preventDefault 的 popstate 是「先撤销、再由 retry 重放」：
    // 本监听器返回后，router 会**同步**发一次 `history.go(-delta)` 把历史指针撤回
    // 当前页；而下面的 `e.retry(true)` 又会发一次 `history.go(delta)` 去重放。若这
    // 两个方向相反、时序相邻的遍历同时挂起，浏览器可能把它们合并成净零——撤销没
    // 落地、重放被吞掉，router 从未 commit，DOM 停在当前页，只剩过渡动画在播（即
    // 「系统返回需按两次」的根因）。
    //
    // 修复：在遍历分支里**先同步注册**下一个 popstate 的等待（此刻 router 的撤销
    // `go` 尚未发出），等这次撤销的 popstate 真正落地后再 `retry` 重放，两个 go 便
    // 不再相邻、不会被合并。字符串导航（isTraversal=false）没有 revert，路径不变。
    const revertLanded = isTraversal ? waitForNextPopstate() : undefined

    runViewTransition(direction, async () => {
      // 等 router 的撤销 go 落地后再重放，避免与撤销 go 相邻被浏览器合并成净零。
      if (revertLanded) await revertLanded
      // force=true 置上 router 内部的 ignore 标志，重放这次导航时不会再次进入
      // 本监听器，否则就是死循环。
      e.retry(true)
      if (isTraversal) {
        // 历史步进走的是 history.go()，DOM 提交发生在后续的 popstate 任务里，
        // 此刻 isRouting 还是 false，只等它会立即 resolve 并拍到旧 DOM。
        await waitFor(() => location.pathname !== from)
      }
      await waitFor(() => !isRouting())
    })
  })
}

/**
 * 等待下一个 `popstate` 事件落地，带超时兜底。
 *
 * 专供遍历导航串行化用：必须在 router 发出撤销 `history.go` **之前**同步注册，才
 * 能稳稳接住那一次撤销 popstate。若因异常始终等不到（例如浏览器未派发），超时后
 * 照常放行，退化为原先的行为，不会把过渡永久挂起。
 */
function waitForNextPopstate(timeoutMs = 600): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('popstate', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    window.addEventListener('popstate', finish, { once: true })
  })
}
