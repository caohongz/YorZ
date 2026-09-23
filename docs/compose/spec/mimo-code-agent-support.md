---
feature: mimo-code-agent-support
status: delivered
updated: 2026-09-23
branch: feat/mimo-code-agent-support
commits: f7df661..f7df661 # docs-only delivery; no implementation commits
---

# YorZ Agent 接入 mimo-code 可行性调研与落地方案

## Report

**What was built** — 本文档交付「mimo-code 接入 YorZ Agent 层」的可行性结论与可落地方案（调研报告，不含业务代码）。结论：**可行**。`@mimo-ai/sdk` 0.1.15 与 `@opencode-ai/sdk` 同构（`createOpencode` / `OpencodeClient`，MiMo Code 基于 OpenCode 分叉），可覆盖 `AgentSdkAdapter` 的 create/resume/list/messages/abort，并用 `promptAsync` + SSE `message.part.updated` 达到 Claude/Codex 级流式回放；`AssistantMessage.tokens`+`cost` 可进入 telemetry。与 Claude Code / Codex 支持面相比，**唯一硬缺口是配额窗口型 `usageStatus`**（SDK 无 rate-limit API；`mimo stats` 仅累计量）。推荐 P1 声明 `usageStatus: false` 先达主支持面，P2 可选用 `local-snapshot`/`external-cli` 提供无窗口降级。改动面按 pi-agent-adapter 先例列全，特别标出 `resolveProjectAgentKind` 等静默回落闸门与移动端 `ProjectSettings.tsx` 硬编码选项表。

**Verification** — `PASS`：文档引用的 21 个源码路径均存在；`AgentKind` / `normalizeUsage` / `SPEC_WRITE_TOOLS` / Claude·Codex·OpenCode capabilities 主张与源码一致；i18n 键齐全。`PASS`：`@mimo-ai/sdk` 0.1.15 类型面（`SessionListData`/`promptAsync`/`SessionAbortData`/`ToolState`）与 `mimo --help`/`run`/`stats`/`session`/`export` 实机输出一致。`PASS`（独立评审 + 复审）：T1–T5 验收闭环；上一轮 1 critical（漏 `resolveProjectAgentKind` 等白名单）+ 2 major（移动端误判、cost/tokens 归一化）+ 3 minor 已全部修入正文并复审 PASS。无代码变更，未跑 `pnpm test`/`typecheck`（docs-only）。

**Journey log** — (1) mimo-code 即 OpenCode 架构分叉，SDK 仍导出 `OpencodeClient` 命名：集成形状应对照 `opencode-adapter.ts` 而非 Claude/Codex，成本更低。(2) 评审揪出的 `resolveProjectAgentKind` 类白名单是静默回落点——扩 AgentKind 时只有 `BUILTIN: Record<AgentName, AgentCmd>` 有编译保护，其余漏改配置「保存成功但跑的还是 claude」。(3) `normalizeUsage` 的 kind 分发链同样是静默回落点（未知 kind → `fromClaude`），与 resolve* 闸门同类，易漏。(4) 移动端 `ProjectSettings.kindOptions()` 硬编码，类型扩张不驱动 UI；「复用 AgentKind 就自动生效」是误判。(5) `usageStatus` 窗口级对齐依赖 MiMo 官方 API，P1 明确降级以免阻塞主支持面。

## [S1] Problem

YorZ 的 Agent 层通过 `AgentSdkAdapter` 统一接入外部编码 Agent。当前一等公民是 Claude Code 与 Codex：二者均具备完整会话生命周期、历史读取、用量查询与流式事件。产品目标是让 **mimo-code（MiMo Code）** 在 YorZ 中达到与 Claude Code / Codex 同级的支持面——可被项目/全局配置选中、可创建与续跑会话、可列会话与读历史、可流式回放执行过程，并进入 telemetry。

本调研回答：mimo-code 是否具备等价程序化接入面；与 Claude/Codex 支持面逐项差距；以及达到该支持面的最小改动方案与风险。

## [S2] Design

### [S2.1] 支持面基线：Claude Code 与 Codex 在 YorZ 中的契约

统一契约见 `@src/service/agent-sdk/types.ts`：

| 能力 | 契约 | Claude | Codex |
|------|------|--------|-------|
| 新建会话 | `createSession()` | `@anthropic-ai/claude-agent-sdk` `query` + `sessionId` | `@openai/codex-sdk` `startThread` |
| 续跑会话 | `resumeSession(id)` | `options.resume` | `resumeThread` |
| 会话列表 | `listSessions()` | SDK `listSessions({dir})` | 扫 `~/.codex/sessions/**/rollout-*.jsonl` |
| 历史消息 | `getMessages(id)` | SDK `getSessionMessages` | 解析 rollout JSONL |
| 用量/配额 | `getUsageStatus()` | SDK `usage_EXPERIMENTAL`（rate limit 窗口） | 私有 API + 本地 `token_count` 快照 |
| 流式事件 | `send()` → `AgentEvent` | assistant/tool/result/compact 边界 | `runStreamed` / `item.completed` |
| 能力声明 | `capabilities()` | `{listSessions:true, getMessages:true, usageStatus:true}` | 同左 |
| 中止 | `abort()` | AbortController | AbortSignal |

`session-manager` 按 `['claude','codex','opencode','pi']` 合并原生会话列表；`telemetry/normalize.ts` 在适配器出口归一化 usage；`phase-usage.ts` 记录 spec 写回切分。GUI / `gui-shared` 的 `AgentKind`、项目配置、全局默认 Agent、i18n 标签与 `AgentUsageHint` 同步消费上述契约。

**「对齐 Claude Code / Codex 支持面」的验收定义**：`capabilities()` 三项均为 `true`，且 `send()` 能产出 text / tool-use / tool-result / turn-completed（含 usage）流；配置与 UI 可选中；会话可列表、可读历史；telemetry 可归一化。

对照参考（**非**目标基线）：OpenCode 与 Pi 已接入但 `usageStatus: false`，OpenCode 的 `send()` 还只回放最终文本、不流式工具过程。

### [S2.2] mimo-code 接入面调研结论

**身份与包**

- 产品名 MiMo Code / MiMoCode，仓库 `XiaomiMiMo/MiMo-Code`，npm `@mimo-ai/cli`（bin: `mimo`），平台二进制 `@mimo-ai/mimocode-*`，当前最新 `0.1.15`（2026-09-22）。
- 官方 **TypeScript SDK `@mimo-ai/sdk`**（同版本）：`createOpencode` / `createOpencodeClient` / `OpencodeClient`——API 面与 `@opencode-ai/sdk` **同构**（MiMo Code 基于 OpenCode 架构分叉）。另有 `@mimo-ai/plugin` 插件 SDK。
- 本机已有 MiMo Desktop 内嵌运行时与 `~/.local/share/mimocode/` 数据目录，实证会话/消息/工具数据形态。

**SDK 能力（`@mimo-ai/sdk` 0.1.15）**

| 需求 | SDK 面 | 证据 |
|------|--------|------|
| 列会话 | `session.list` | `SessionListData` |
| 建会话 | `session.create` | `SessionCreateData` |
| 续跑 | `session.get` / `session.prompt` 按 id | `SessionPromptData.path.id` |
| 读历史 | `session.messages` | 返回 `{info, parts}` |
| 发送并流式 | `session.promptAsync` + `event.subscribe`（SSE） | `message.part.updated` 带 `delta`；`session.idle` 表示轮结束 |
| 中止 | `session.abort` | `SessionAbortData` |
| 工具过程 | `ToolPart` + `ToolState`（pending/running/completed/error） | completed 含 `input`/`output` |
| 压缩 | `CompactionPart` + `message.updated` | `type: "compaction"` |
| Token/cost | `AssistantMessage.tokens` + `cost` | `{input,output,reasoning,cache:{read,write}}` |
| 配额窗口 | **无** | 全类型无 rate-limit / quota window API |

**CLI 面（`mimo`）**

- 无人值守：`mimo run [message..] --dangerously-skip-permissions`（别名 `--yolo`），支持 `--format json`、`--session`/`--continue`、`--title`、`--dir`、`--port`、`--attach`。
- 服务：`mimo serve`（headless server，SDK `createOpencode` 可拉起）。
- 会话：`mimo session list` / `mimo export [sessionID]`（JSON）。
- 用量：`mimo stats` 输出**累计** token/cost 统计（无 rate-limit 窗口；无 `--json`）。

**本地存储（与 SDK 互补的只读源）**

- SQLite `~/.local/share/mimocode/mimocode.db`：`session` / `message` / `part` / `project` 等表；`message.data` 为 JSON，含 `role`、`tokens`、`cost`、`modelID`、`providerID`。可作为 list/getMessages 的离线兜底（Codex 适配器已有同类「本地快照」先例）。

### [S2.3] 能力对齐矩阵

| 能力 | Claude | Codex | mimo-code 现有 | 对齐路径 | 结论 |
|------|--------|-------|----------------|----------|------|
| createSession | ✓ | ✓ | `session.create` | SDK 直用 | **可对齐** |
| resumeSession | ✓ | ✓ | 按 id `prompt` | SDK 直用 | **可对齐** |
| listSessions | ✓ | ✓ | `session.list` | SDK 直用 | **可对齐** |
| getMessages | ✓ | ✓ | `session.messages` | 映射 `Part`→`MessagePart` | **可对齐** |
| 流式 text/tool | ✓ | ✓ | `promptAsync`+SSE `delta`；`ToolPart` | 比 OpenCode 适配器更强 | **可对齐** |
| compact 事件 | ✓ | △ | `CompactionPart`（仅 `auto`） | 映射 `type:'compact'`，metrics 子字段可缺席 | **可对齐** |
| abort | ✓ | ✓ | `session.abort` | SDK 直用 | **可对齐** |
| telemetry usage | ✓ | ✓ | `tokens`+`cost` | 独立 `fromMimo`（`cost` 与 `tokens` 兄弟字段） | **可对齐** |
| phase 切分 spec 写 | ✓ | 空集 | 工具名含 `write`/`edit`/`Write`/`Edit` | 补 `SPEC_WRITE_TOOLS.mimo` | **可对齐** |
| 配置/UI/i18n | ✓ | ✓ | — | 扩 `AgentKind` 全触点 | **可对齐** |
| **usageStatus（配额窗口）** | ✓ native | ✓ private+snapshot | **SDK 无窗口 API**；`mimo stats` 仅累计 | 见 [S2.6] | **唯一硬缺口** |

结论：**总体可行**。除配额窗口型 `usageStatus` 外，mimo-code 的 SDK 面完整覆盖甚至优于现有 OpenCode 接入；集成形状与 `@src/service/agent-sdk/opencode-adapter.ts` 高度同构，改造成本低于 Claude/Codex 适配器。

### [S2.4] 推荐集成方案

**选型：`@mimo-ai/sdk` 适配器（对齐 Claude/Codex 的主路径），CLI spawn 仅作 `test:agent` 旁路。**

理由：

1. SDK 提供 list/create/messages/abort/SSE，足以实现 `AgentSdkAdapter` 全接口；
2. 与现有 OpenCode 适配器同构，可直接借鉴 server 生命周期（`createOpencode({port:0})` + `dispose`）；
3. SSE `message.part.updated.delta` + `ToolPart` 可达到 Claude/Codex 的流式回放质量（优于当前 OpenCode 适配器的「整段回放」）；
4. CLI `mimo run --dangerously-skip-permissions --format json` 仅用于 `@src/service/agent-config.ts` 的 `test:agent`  harness，与现有四后端一致。

**事件映射（`send()`）**

| MiMoCode | YorZ `AgentEvent` |
|----------|-------------------|
| 会话建立 / 首帧 id | `session-started` |
| `TextPart` / `message.part.updated` text `delta` | `text` |
| `ToolPart` 进入 running（或 pending→running） | `tool-use`（`tool` + `state.input`） |
| `ToolPart` completed/error | `tool-result`（`state.output` / `state.error`） |
| `AssistantMessage` 完成（`session.idle` 或 prompt 返回） | `turn-completed`（`usage` 原样 + `metrics` 归一化） |
| `CompactionPart` / compaction 类事件 | `compact` |
| 传输/业务错误 | `error` |

**usage 归一化**（`@src/service/telemetry/normalize.ts`）

新增独立的 `fromMimo`，**不要**在 `fromOpenCode` 上打补丁。MiMo 的 raw 形状是 `AssistantMessage` 级：`cost` 与 `tokens` 是**兄弟字段**，不是嵌套在同一 `tokens` 对象里；`fromOpenCode` 只读 `tokens.*` 且从不产出 `costUsd`。约定 raw 入参为：

```ts
// AssistantMessage 形（或等价截断）
{ cost?: number; tokens?: { input?; output?; reasoning?; cache?: { read?; write? } } }
```

映射：`inputTokens←tokens.input`，`outputTokens←tokens.output`，`reasoningTokens←tokens.reasoning`，`cacheReadTokens←tokens.cache.read`，`cacheCreateTokens←tokens.cache.write`，`costUsd←cost`。字段缺失留 `undefined` 不补零。`turn-completed.usage` 仍回传原始 payload，与其它 adapter 一致。

**phase 切分**（`@src/service/agent-sdk/phase-usage.ts`）

`SPEC_WRITE_TOOLS.mimo = {write, edit, patch, Write, Edit}`——本地 `mimo stats` 实测大小写并存，且 OpenCode 系工具面含 `patch`（对齐既有 `opencode` 条目）；路径键沿用 `file_path|filePath|path`。

**compact 事件**：`CompactionPart` 只有 `{auto: boolean}`，没有 pre/post token；映射为 `{type:'compact', metrics:{trigger: auto?'auto':'manual', preTokens: undefined, postTokens: undefined, durationMs: undefined}}`——metrics 必填但子字段可缺席，与契约一致。

**usageStatus 策略（分两阶段）**

- **P1（推荐首版）**：`capabilities().usageStatus = false`，与 OpenCode/Pi 一致，GUI 静默。核心聊天/会话/流式先达 Claude/Codex 水位。
- **P2（可选补齐）**：实现 `getUsageStatus()`，`source: 'local-snapshot'` 或 `'external-cli'`——只读 `mimocode.db` 近日 token/cost 或调用 `mimo stats`，映射为无 `windows` 的 `AgentUsageStatus`（`rateLimitsAvailable: false`）。GUI 将显示「可用但无明细」。这**不能**复刻 Claude/Codex 的 rate-limit 窗口；若必须窗口级对齐，需等待 MiMo 官方配额 API，属开放依赖。

### [S2.5] 改动面清单（实施时按此展开）

接线先例可对照 `@.yorz/specs/260914.feat.pi-agent-adapter/spec.md`（Pi 的完整 AgentKind 扩张清单）。除编译期强制的 `BUILTIN: Record<AgentName, AgentCmd>` 外，多数白名单漏改会**静默回落 `claude`**，故下表按「不落一行就失效」的粒度列出。

| 层 | 文件 | 改动 |
|----|------|------|
| 依赖 | `@package.json` | 增 `@mimo-ai/sdk`；keywords 可加 `mimo-code` |
| 构建 | `@vite.config.ts` | `external` 增 `@mimo-ai/sdk`（及 `/^@mimo-ai\//`） |
| **类型联合（5 处）** | `@src/service/agent-sdk/types.ts` `AgentKind`；`@src/service/agent-config.ts` `AgentName` **与** `AgentKind`（两套重复联合）；`@src/service/global-config.ts` `GlobalAgentKind`；`@src/service/project-config.ts` `AgentConfig` 判别联合；`@src/gui-shared/api/index.ts` `AgentConfig` / `GlobalConfig.agent.defaultKind` / `AgentKind` | 各增 `'mimo'` |
| 适配器 | `@src/service/agent-sdk/mimo-adapter.ts` | **新建**，按 [S2.4] 实现 |
| 注册 | `@src/service/agent-sdk/registry.ts` | `createAdapter` 增 `case 'mimo'` |
| **项目 kind 解析（关键闸门）** | `@src/service/project-registry.ts` `resolveProjectAgentKind` | 白名单增 `'mimo'`；漏改时 `kind:'mimo'` **静默回落 `claude`**，配置看似保存成功实际未生效 |
| **配置归一化** | `@src/service/project-config.ts` `normalizeAgent`（legacy 字符串 + 对象两条路径）；`@src/service/global-config.ts` `normalizeAgent` 的 `defaultKind` 白名单 | 两条路径都放行 `'mimo'`，否则存盘/读回被改写 |
| **路由校验** | `@src/service/routes/project-config.ts` `parseAgent`（含报错文案 `agent.kind must be …`）；`@src/service/routes/global-config.ts` `defaultKind` 校验（含报错文案） | 放行并更新错误枚举文案 |
| **CLI spawn 解析** | `@src/service/agent-config.ts` `BUILTIN.mimo`、`resolveAgentKind`、`readAgentCmd`（legacy + 对象两分支） | `BUILTIN.mimo`：`cmd: 'mimo'`，`args: ['run','--dangerously-skip-permissions','--format','json', prompt]`（按实测微调）；两处解析放行 `'mimo'` |
| 会话发现 | `@src/service/session-manager.ts` 跨 Kind 扫描数组；`@src/service/routes/sessions.ts` `KINDS` | 各增 `'mimo'` |
| 埋点 | `@src/service/telemetry/normalize.ts` | 独立 `fromMimo`（见 [S2.4]，勿改 `fromOpenCode`）；**并接入 `normalizeUsage` 的 kind 分发链**——未知 kind 现会静默走 `fromClaude`，漏改即错误归一化 |
| phase | `@src/service/agent-sdk/phase-usage.ts` | `SPEC_WRITE_TOOLS.mimo = {write, edit, patch, Write, Edit}` |
| 测试 harness | `@src/skill/yorz-spec/__tests__/runner.ts` `resolveTestAgent` 白名单 | 增 `'mimo'` |
| 共享 API | `@src/gui-shared/api/index.ts` | 见「类型联合」行 |
| 桌面 UI | `@src/gui/src/components/ProjectConfigDialog.tsx`、`GlobalConfigDialog.tsx` | 选项与 label |
| **移动端 UI** | `@src/gui-mobile/src/pages/settings/ProjectSettings.tsx` `AgentKindOption` + `kindOptions()` **硬编码列表** | 必须显式增一项；**不会**随 `AgentKind` 联合类型自动扩展 |
| i18n | `@src/gui/src/i18n/zh-CN.ts`、`@src/gui/src/i18n/en.ts` | `projectConfig.agentMimo: 'MiMo Code'`（桌面）；移动端 label 现状为硬编码英文短名，本次对齐追加 `MiMo` 一项，不顺带重构为 i18n（独立整改） |
| 测试 | `@src/service/__tests__/mimo-adapter.test.ts`、`agent-config.test.ts` 补例 | 对齐 `codex-adapter.test.ts` / `pi-adapter.test.ts` 粒度；验收含 `grep` 白名单无遗漏 |

Skill 注入路径无关 Agent（`~/.config/yorz/skills/` + prompt 绝对路径），mimo 侧无需额外 skill 安装。

### [S2.6] 风险与未决问题

1. **配额窗口缺口（已知）**：SDK 无 rate-limit API；P2 降级方案只提供累计量。窗口级对齐依赖 MiMo 官方能力，**不阻塞** P1 其余支持面。
2. **SDK 同构但非同一包**：`@mimo-ai/sdk` 仍导出 `OpencodeClient` 命名，类型可混用但版本节奏独立；实施时锁定 `0.1.15` 并在适配器内做本地类型收窄，避免直接依赖 OpenCode 类型。
3. **流式事件形态需实现期实测**：以 `promptAsync` + `event.subscribe` 为准；若 `delta` 稀疏，退化为 part 级整段 `text`（仍优于 OpenCode 适配器）。
4. **工具名大小写混用**：phase 切分须双写并含 `patch`；title 摘要可复用 `summarizeCodexPromptForTitle`。
5. **`test:agent` CLI 参数**：`mimo run` 的 JSON 事件行与退出码需实现期用真实任务校准（对齐 `@src/service/agent-config.ts` 注释中各后端的语义）。
6. **会话目录过滤**：`session.list` 是否按 cwd 过滤需实测；必要时仿 Codex 用 `session.directory`/`project.worktree` 过滤。
7. **白名单静默回落**：`resolveProjectAgentKind` / `normalizeAgent` ×2 / `resolveAgentKind` / `readAgentCmd` / `normalizeUsage` kind 分发等漏改不会编译失败（仅 `BUILTIN: Record<AgentName, AgentCmd>` 有编译保护），表现为配置保存成功但实际仍跑 claude，或 usage 被 `fromClaude` 误归一化。实施任务须以白名单 grep 清点收尾（见 [S2.5]）。
8. **移动端独立选项表**：`ProjectSettings.tsx` 的 `kindOptions()` 是硬编码，类型扩张不驱动 UI；漏改则移动端无法选中 mimo。

## [S3] Out of Scope

- 实现 `mimo-adapter.ts` 及配置/UI/测试落地（本文档只交付调研结论与可落地方案）。
- 复刻 Claude/Codex 的 rate-limit **窗口**型 `usageStatus`（依赖 MiMo 官方 API，见 [S2.6]）。
- 移动端 `gui-mobile` 的 label 全面 i18n 整改。注意：移动端 **不能**「仅复用 `AgentKind` 就自动生效」——`ProjectSettings.tsx` 维护独立的硬编码选项表，**接入 mimo 时必须显式增一项**（已列入 [S2.5]）；本 Out of Scope 仅排除的是把该硬编码表整体改成 i18n 的顺带重构。
- MiMo 账号登录、模型选择、计费开通引导。
- 修改 MiMoCode / OpenCode 上游。

## Tasks

- [x] T1: 梳理 Claude/Codex 支持面基线与 `AgentSdkAdapter` 契约 — acceptance: [S2.1] 能力表与契约文件路径可核对 (covers: S2.1)
- [x] T2: 调研 mimo-code 程序化接入面（SDK/CLI/本地存储） — acceptance: [S2.2] 每项能力有包名/API/命令证据 (covers: S2.2)
- [x] T3: 产出能力对齐矩阵与可行性结论 — acceptance: [S2.3] 覆盖 list/get/stream/usageStatus 且标明唯一硬缺口 (covers: S2.3)
- [x] T4: 给出推荐集成方案（事件映射、usage 归一化、usageStatus 策略） — acceptance: [S2.4] 可直接指导实现且与契约字段一一对应；usage 明确 `fromMimo` raw 形状与 `cost`/`tokens` 兄弟字段关系 (covers: S2.4)
- [x] T5: 列出实施改动面与风险 — acceptance: [S2.5] 覆盖全部白名单闸门（含 `resolveProjectAgentKind`、双 `normalizeAgent`、`resolveAgentKind`/`readAgentCmd`、`resolveTestAgent`、移动端 `kindOptions`）；[S2.6] 缺口不阻塞 P1 (covers: S2.5; S2.6)
