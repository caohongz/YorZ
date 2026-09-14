---
status: resolved
active:
updated_at: '2026-09-14 18:24:30'
---

## Debug 1 · 首次添加目录 A 后左侧项目列表不动态刷新（刷新页面才出现）

- 状态：resolved
- 快照：6f6066e8bca092aaf430dcb1d790d76179cf9e5e
- 进入时间：'2026-09-14 18:04:10'

### 1.1 Bug 现象与复现

用户反馈：

1. 在 GUI 通过「添加项目」选择目录 A → 添加成功，URL 已切到 A 项目；
2. **左侧项目列表没有出现 A**，手动刷新页面后正确显示；
3. 删除 A 项目后，再次添加同一个目录 A → 列表**能**动态更新。

关键对照：同一套代码路径，第一次添加不刷新、第二次添加刷新。说明问题不在"写没写进 registry"（刷新后能看到），而在**列表刷新链路的某个状态依赖于"这个目录之前是否已被添加过"**。

### 1.2 关联链路分析

列表刷新链路（后端 → 前端）：

```
POST /api/projects
  └─ ProjectRegistry.addWithGit → addProjectWithGit
       ├─ isGitRepo / runGitInit(stdio:'ignore')
       ├─ prepareProjectDir（mkdir .yorz/specs）
       ├─ ensureTmpIgnored（写 .gitignore）
       └─ addProject → saveGlobalConfig（tmp + rename 原子写 ~/.config/yorz/config.json）
                                   │
RegistryEventBus.start(configPath) ─┘ watch(父目录) → 200ms 防抖 → emit()
  └─ EventsHub.attachProjects 的 bus.subscribe → emit(s,'projects','projects-changed')
       └─ SSE msg 帧 → 前端 mux 分发 → subscribeProjectsList → ProjectsSidebar refetch()
```

要点记录：

- `POST /api/projects` **不显式 emit** projectsBus，完全依赖 config.json 的文件 watch（`src/service/server.ts:70-74` 只有 worktreeManager 走显式 emit）。
- 删除项目在前端是 `confirmDelete()` 里 `await refetch()` **显式刷新**（`ProjectsSidebar.tsx:284`），**不能**用来证明 SSE 链路是通的。
- 添加成功后 `onAdded` 调 `navigate(projectHref('', projectId))`（`ProjectsSidebar.tsx:467`），注释写明"列表本身由 SSE 自动 refetch"。
- `loadGlobalConfig` 无内存缓存，每次 `GET /api/projects` 都重读文件 → 排除"后端返回陈旧列表"。

### 1.3 Debug 基线

- 快照 SHA：`6f6066e8bca092aaf430dcb1d790d76179cf9e5e`（`git stash create`，进入时工作区已有本 spec 的未提交改动）
- 退出闸门：`git diff 6f6066e8bca092aaf430dcb1d790d76179cf9e5e` 只剩合法修复。

### 1.4 假设看板

| # | 假设 | 若成立会看到 | 若不成立会看到 | 结论 |
| - | ---- | ------------ | -------------- | ---- |
| H1 | SSE `projects-changed` 帧根本没发出（后端 watch/防抖问题） | 裸 SSE 客户端在首次添加后收不到 `projects-changed` | 裸客户端能收到帧 | ❌ **已排除**（证据 E1） |
| H2 | 帧发出了但前端没 refetch（导航期间订阅被顶掉） | 浏览器有帧、但无 `GET /api/projects` 跟随 | 有跟随的 GET | ❌ **已排除**（证据 E2/E3：帧到达即触发 GET，列表正常刷新） |
| H3 | refetch 发生但 Solid Router transition 挂起，DOM 不更新 | GET 返回含 A，但 DOM 不变 | DOM 立即变 | ❌ **已排除**（证据 E3：DOM 立即变） |
| H4 | **service 重启后，经 vite 代理的 EventSource 变「僵尸连接」**（readyState 仍为 OPEN、不 error、不重连、永不再收帧），此后所有 SSE 静默失效，直到刷新页面 | 重启 service 后前端收不到任何帧；新增项目列表不刷新；刷新页面即恢复 | 重连后帧照常到达 | ✅ **坐实**（证据 E4） |

### 1.5 证据

**E1 · 后端广播正常**（`.yorz/tmp/debug/repro-sse.mjs`，裸 SSE 客户端 + 独立 service）

三种场景后端都在 ~230ms（200ms 防抖）后广播了 `projects-changed`：

```
[+ 1832ms] POST /api/projects gitInit=true -> 201
[+ 2067ms] SSE frame event=msg data={"topic":"projects","event":"projects-changed"}
[+ 3834ms] 场景1（首次添加，非 git → gitInit）收到 projects-changed = true
[+ 5867ms] 删除后收到 projects-changed = true
[+ 7884ms] 场景3（删除后再次添加）收到 projects-changed = true
```

→ H1 排除：后端「首次添加」与「二次添加」行为完全一致。

**E2 · e2e 环境（构建版 GUI + 独立 service）无法复现**：首次添加、删除、二次添加，侧边栏均动态刷新。

**E3 · 用户真实 dev 环境（vite 5173 + service 7424，6 个既有项目）新开页面也无法复现**（`.yorz/tmp/debug/repro-browser.mjs`）：

```
[+ 7333ms] res POST /api/projects -> 201
[+ 7536ms] [ES] msg {"topic":"projects","event":"projects-changed"}
[+ 7536ms] req GET /api/projects        ← 帧到达立即 refetch
[+ 8802ms] 侧边栏含 proj-dbg-a = true
```

→ H2/H3 排除。至此可判定：**bug 不在"添加"这条链路上，而在页面当时所处的会话状态**。

**E4 · 决定性线索与复现**

服务日志 `~/.config/yorz/logs/serve.log` 显示：dev service（`pnpm dev:cli`，pid 32808）在 **09:55:42Z 重启**，而用户的添加操作发生在 09:56:5x（`GET /api/fs/list` 两条 400 紧随其后）——**用户的页面是在 service 重启之前就已打开的**。

据此构造复现（`.yorz/tmp/debug/repro-restart.mjs`：独立 service 17432 + 独立 vite 5174 代理 + playwright）：

```
[+ 10242ms] EventSource readyState = 1
[+ 10242ms] === 重启 service（模拟 pnpm dev:cli 重启）===
[+ 15258ms] service 已重启
[+ 23260ms] EventSource readyState = 1   ← 仍是 OPEN，期间没有任何 error / 新建 EventSource / 重新 POST /api/events/subscribe
[+ 23269ms] POST /api/projects -> 201
[+ 28275ms] 侧边栏含 proj-dbg-a = false  ← 复现！列表不动态刷新
[+ 32772ms] 刷新后侧边栏含 proj-dbg-a = true ← 与用户描述完全一致
```

**根因**：service 重启后，浏览器 ↔ vite 代理这一段 TCP 连接**没有断开**，vite 只是丢掉了它与后端的上游连接。于是浏览器侧的 `EventSource` 停在 `readyState === 1`（OPEN）、**不触发 `error`、不触发浏览器内置自动重连**，成为一条永不再有数据的**僵尸连接**。

`src/gui-shared/api/sse.ts` 的 `SseMultiplex` 对此毫无防护：

- `ensureOpen()` 只判断 `this.source` 是否为 null（僵尸 source 非 null → 永不重建）；
- `error` 监听器写着 `// EventSource auto-reconnects; no-op`——该前提在「僵尸 OPEN」和「代理返回 HTTP 错误码致浏览器彻底放弃」两种情形下都不成立；
- 服务端每 5s 发的 `server-heartbeat` 被分发给 handler，但 `grep -rn "onServerHeartbeat" src/gui src/gui-mobile` **零消费方**，`readyState()` 同样无人调用——mux 重构后看门狗事实上消失了，心跳成了死代码。

**用户现象的完整解释**：
1. 页面在 service 重启前打开 → 重启后 SSE 变僵尸；
2. 添加 A：`POST /api/projects` 是普通 fetch（新连接，正常）→ URL 切换成功；`projects-changed` 收不到 → 左侧列表不刷新；
3. 刷新页面 → 新建 EventSource → 恢复；
4. 删除 A：`confirmDelete()` 里 `await refetch()` 是**显式刷新**，本就不依赖 SSE；此时 SSE 已因刷新恢复 → 再次添加 A 列表能动态更新。

影响面远不止项目列表：僵尸期内 spec 列表、会话状态、命令输出等**全部** SSE 实时更新都会静默失效。

### 1.6 修复

**`src/gui-shared/api/sse.ts` —— 给 `SseMultiplex` 补上连接看门狗**（桌面端与移动端共用同一份 mux，一处修复两端受益）：

- 任何帧（`open` / `server-heartbeat` / `msg`）都刷新 `lastFrameAt`；
- 每 `WATCHDOG_INTERVAL_MS`(5s) 巡检一次：`Date.now() - lastFrameAt > STALE_AFTER_MS`(16s，留 3 个心跳周期余量) **或** `readyState === CLOSED` → 关闭旧 source、重建 EventSource；新连接的 `open` 走既有的 `scheduleSync(true)`，把全部 topic 重新订阅回去；
- `error` 监听器**不做**同步重连（否则代理持续回 500 时会打成高频重试风暴），统一交给看门狗的固定节奏；
- 额外挂 `visibilitychange`：后台标签页定时器被节流到分钟级，切回前台时立刻补一次巡检；
- 新增 `dispose()`，`__resetMuxForTests()` 里调用，避免测试间定时器泄漏。

新增单测 `src/gui-shared/api/__tests__/sse-watchdog.test.ts`（4 例，假 EventSource + fake timers）：心跳持续时不重建 / 僵尸连接被强制重建且重新订阅 / `CLOSED` 由看门狗接管 / 普通消息帧也算活性信号。

**修复验证**（同一份 `repro-restart.mjs`，修复前后对照）：

```
修复前：[+23260ms] readyState=1（僵尸）→ POST 201 → [+28275ms] 侧边栏含 proj-dbg-a = false
修复后：[+26549ms] [ES] new /api/events/stream...   ← 看门狗重建（末帧后约 17s）
        [+26554ms] req POST /api/events/subscribe   ← topic 全量重订阅
        [+39662ms] POST /api/projects -> 201
        [+39921ms] [ES] msg {"topic":"projects","event":"projects-changed"}
        [+44667ms] 侧边栏含 proj-dbg-a = true       ← 问题消失
```

> 未做的改动与理由：不在 `onAdded` 里额外补一次显式 `refetch()`。SSE 自愈后添加链路已闭环，而侧边栏与 Welcome 两个入口共用同一个对话框、列表资源只在侧边栏，单点补刀反而造成不对称的冗余。

### 1.7 脚手架清单

| # | 文件 / 位置 | 类型 | 状态 |
| - | ----------- | ---- | ---- |
| 1 | `.yorz/tmp/debug/repro-sse.mjs` | 临时复现脚本（裸 SSE 客户端 + 独立 service） | ✅ 已删除 |
| 2 | `.yorz/tmp/debug/repro-browser.mjs` | 临时复现脚本（真实 dev 环境 + playwright） | ✅ 已删除 |
| 3 | `.yorz/tmp/debug/repro-restart.mjs` | 临时复现脚本（重启 service 复现僵尸连接） | ✅ 已删除 |
| 4 | `.yorz/tmp/debug/vite.debug.config.mts` | 临时 vite 配置（5174 → 17432 代理） | ✅ 已删除 |
| 5 | `src/gui/src/__e2e__/zz-debug-add-refresh.spec.ts` | 临时 e2e 用例 | ✅ 已删除 |

调试期间未改动任何业务代码分支、未加临时日志、未 Mock 任何接口——全部探针都在上述独立脚本内，故无需还原。

### 1.8 收尾核对

- [x] 根因有硬证据（E4：僵尸 EventSource + 可重复的复现脚本）
- [x] 修复后重跑复现步骤，问题消失
- [x] 脚手架全部核销（`.yorz/tmp/debug/` 整目录 + 临时 e2e 用例已删除）
- [x] `git diff 6f6066e` 只剩合法修复（仅 `src/gui-shared/api/sse.ts`，+90/-1）
- [x] `tsc -b` 通过；`vitest run` 95 文件 / 956 通过 2 跳过；`vite build`（gui + gui-mobile）成功
