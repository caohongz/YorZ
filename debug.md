---
status: resolved
active:
updated_at: '2026-07-28 17:22:38'
---

## Debug 1 · npm 发布工作流未识别 0.3.1 提交消息

- 状态：resolved
- 快照：821ee63e68c1f2462219a27e074af23b341be177（工作区干净，git stash create 无输出，使用 HEAD 作为基线）
- 进入时间：'2026-07-25 18:26:30'

### 1. Bug 现象与复现

GitHub Actions `Publish npm` 在 `main` 分支 push 后未继续执行发布步骤。日志中 `REF_TYPE=branch`、`REF_NAME=main`、`HEAD_COMMIT_MESSAGE=0.3.1`，判断步骤输出 `main head commit message does not match vX.Y.Z.`。

### 2. 关联链路分析

`.github/workflows/npm-publish.yml` 的 `Determine publish eligibility` 步骤只使用 `^v[0-9]+\.[0-9]+\.[0-9]+$` 匹配发布标记。分支路径读取 `github.event.head_commit.message`，因此提交消息 `0.3.1` 不会通过发布资格判断。

### 3. Debug 基线

基线：`821ee63e68c1f2462219a27e074af23b341be177`。

### 4. 假设看板

- H1：分支发布判断要求提交消息必须带 `v` 前缀，导致 `0.3.1` 被拒绝。若成立，本地以 `REF_TYPE=branch`、`REF_NAME=main`、`HEAD_COMMIT_MESSAGE=0.3.1` 运行等价判断应得到 `should_publish=false`；修复后应得到 `should_publish=true`、`release_version=0.3.1`。

### 5. 证据

- GitHub Actions 日志显示 `HEAD_COMMIT_MESSAGE: 0.3.1`，随后输出 `main head commit message does not match vX.Y.Z.`。
- 本地等价验证显示：`branch main 0.3.1` 输出 `should_publish=true release_version=0.3.1`。
- 本地等价验证显示：`branch main v0.3.1` 输出 `should_publish=true release_version=0.3.1`。
- 本地等价验证显示：`tag 0.3.1` 输出 `should_publish=false`，tag 发布仍要求 `vX.Y.Z`。

### 6. 脚手架清单

- 无。

### 7. 收尾核对

- 已完成：验证分支标记 `0.3.1` 与 `v0.3.1` 均可解析为 `release_version=0.3.1`。
- 已完成：验证 tag 标记仍要求 `v0.3.1`。
- 已完成：`git diff --check -- .github/workflows/npm-publish.yml debug.md` 通过。

## Debug 2 · Windows 操作期间反复弹出 cmd 窗口

- 状态：resolved
- 快照：877f964d00af81bd6e86208b93bab88526eca9e0
- 进入时间：'2026-07-28 16:40:35'

### 1. Bug 现象与复现

Windows 启动 YorZ Service 后，在 GUI 内执行部分步骤会不断弹出 Windows Terminal / cmd 窗口，严重时持续重复弹出。用户提供了录屏与截图；当前先解析录屏中的触发动作和时间顺序，不进入修复阶段。

### 2. 关联链路分析

候选链路包括：`yorz serve` 的后台 Node 子进程、`--open` 浏览器启动、Claude / Codex / OpenCode SDK 拉起的外部 CLI、真实 Agent 测试 runner，以及任何通过 `.cmd` / PowerShell shim 间接调用的子进程。需从录屏触发动作映射到具体 HTTP 路由和 Agent Adapter，再确认新建窗口对应的真实进程命令行与父 PID。

### 3. Debug 基线

基线：`877f964d00af81bd6e86208b93bab88526eca9e0`（`git stash create`；包含用户已有的 `pnpm-lock.yaml` 修改）。未跟踪的 `.codegraph/` 为用户要求初始化的 CodeGraph 索引。

### 4. 假设看板

- H1（排除为连续弹窗根因）：Windows `tryOpenBrowser()` 使用 `spawn('start')` 确实存在 `ENOENT` 兼容问题，但该函数只在 Service 启动且传入 `--open` 时调用，不能解释 Review 页空闲期间每秒出现的新窗口。
- H2（次要兼容风险）：Agent SDK 或 runner 仍可能通过 `.cmd` / PowerShell shim 创建可见控制台，但录屏中的固定周期与 Agent 请求无关，不能解释本次持续弹窗。
- H3（确认次要问题）：后台 Service 使用 `detached: true` 且未设置 `windowsHide`，Windows 启动后台 Service 时可能分配一次独立控制台；它能解释启动阶段的一次弹窗，不能解释一次 Service 生命周期内的持续弹窗。
- H4（确认主根因）：Review 页订阅变更事件后，Service 立即执行一次 `git status`，随后每 1000ms 再执行一次；`execFile('git', ...)` 未设置 `windowsHide`。Windows 后台 Service 每次启动控制台型 `git.exe` 时均可能创建可见控制台，频率、页面和录屏现象完全吻合。

### 5. 证据

- 截图显示至少两个标题为 `C:\WINDOWS\system32\cmd...` 的 Windows Terminal 标签页，窗口内容为空；弹窗发生时 YorZ GUI 仍在后台。
- 上一轮 Windows 实机验证已确认 `spawn('start', [url], { detached: true })` 返回 `ENOENT`，说明 `--open` 当前不可用，但尚无证据表明 GUI 普通操作会反复进入该函数。
- 录屏时长约 3 秒，GUI 保持在 Review 页面且没有持续点击；空白 cmd / Windows Terminal 窗口按接近 1 秒的固定节奏出现和消失，说明触发源是后台周期任务，而非连续用户操作。
- `SpecReview` 挂载时订阅 `project:{pid}:spec:{id}:changes`；Service 的 `attachSpecChanges()` 将该主题连接到共享的项目 Git 变更观察器。
- `subscribeGitChanges()` 在首次订阅时立即调用 `listChanges()`，并通过 `setInterval(..., 1000)` 每秒再次调用；最后一个订阅者离开后才停止轮询。
- `listChanges()` 最终通过 `execFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ...)` 启动原生 `git.exe`，其选项没有 `windowsHide: true`。
- 当前机器解析到的 Git 包括 `D:\Program Files\Git\cmd\git.exe`，不是必须经 shell 执行的 `.cmd` shim，因此无需开启全局 `shell: true`；直接隐藏非交互式子进程控制台即可。
- Node.js 文档明确说明 `windowsHide` 用于隐藏 Windows 上通常会创建的子进程控制台，默认值为 `false`；同时 `detached: true` 会让 Windows 子进程拥有自己的控制台窗口。
- 当前进程快照中没有正在运行的 YorZ Service，无法补采本次弹窗对应的父 PID；但录屏的页面、固定周期与源码中唯一的 1000ms Git 轮询已经形成一致证据链。

### 5.1 结论与修复边界

主根因是 Review 页 Git 变更轮询在 Windows 后台 Service 中每秒启动一个未隐藏的 `git.exe` 控制台进程。最小正确修复是在所有非交互式 `execFile` / `spawn` 调用上统一设置 `windowsHide: true`，首先覆盖 `src/service/git.ts` 的 Git 调用；同时修复后台 Service 启动和浏览器打开链路，避免残留的一次性弹窗与 `ENOENT`。

不建议为解决弹窗而全局开启 `shell: true`：这会扩大命令注入、引号和空格路径风险，也无法统一解决 `.cmd`、`.ps1` 与原生 `.exe` 的差异。需要执行 shim 时应按扩展名显式选择 `cmd.exe` 或 PowerShell，并同样隐藏控制台。

### 6. 脚手架清单

- 无。

### 7. 收尾核对

- 已完成：解析录屏并锁定 Review 页固定周期触发。
- 已完成：以页面订阅、Service 轮询、Git 子进程和 Node Windows 控制台行为确认主根因。
- 已完成：新增跨平台子进程封装，仅 Windows 注入 `windowsHide: true`，macOS/Linux 原样保留既有选项。
- 已完成：Git 轮询、后台 Service、浏览器启动和 Agent 测试 runner 接入统一封装。
- 已完成：Windows 浏览器启动由不可执行的 shell 内建命令 `start` 改为原生 `explorer.exe`；异步派生错误保持 best-effort，不影响 Service。
- 已完成：`test:agent` 改为通过当前 Node 运行 Vitest 真实入口，修复 Windows `spawn vitest ENOENT`。
- 已完成：TDD RED 记录为 `process.test.ts` 因缺失封装模块失败；GREEN 为 8 个子进程跨平台用例通过。
- 已完成：定向运行 `process.test.ts`、`git.test.ts`、`serve.test.ts`、`service.test.ts`，共 32 个测试全部通过。
- 已完成：`pnpm run build:cli` 通过，99 个模块完成生产构建。
- 已完成：Windows 后台 Service 实机启动，Review changes SSE 订阅保持 5 秒，随后 Service 正常停止。
