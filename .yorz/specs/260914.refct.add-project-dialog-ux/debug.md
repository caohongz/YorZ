---
status: resolved
active:
updated_at: '2026-09-14 19:53:59'
---

## Debug 1 · 新建目录时「创建 / 取消」按钮宽度被压缩，文字显示不下

- 状态：resolved
- 快照：ed61480cea3b7b7e51932438aa62e911723d1423
- 进入时间：'2026-09-14 19:36:10'

### 1.1 Bug 现象与复现

现象：GUI「添加项目」弹窗 → 点击工具条 `FolderPlus`（新建文件夹）→ 展开的内联行中，右侧「创建」「取消」两个按钮宽度过窄，按钮文字被裁切/挤压显示不全。

复现路径（待用 Playwright 取硬证据）：

1. 打开 GUI，侧边栏点「添加项目」；
2. 弹窗内点「新建文件夹」按钮；
3. 观察同一行的 `Input` + 「创建」+「取消」。

### 1.2 关联链路分析

涉及文件：

- `src/gui/src/components/AddProjectDialog.tsx:239-277` —— `<Show when={creating()}>` 内的 `div.flex.items-center.gap-2`，依次放 `Input` / 「创建」Button / 「取消」Button。
- `src/gui/src/components/ui/input.tsx:10` —— Input 基类含 `w-full`（`width:100%`）。
- `src/gui/src/components/ui/button.tsx:11` —— `buttonVariants` 基类为 `inline-flex items-center justify-center ...`，**不含 `whitespace-nowrap`**，`size=sm` 为 `h-8 rounded-md px-2 text-sm`，且两个按钮**未加 `shrink-0`**。

初判链路：flex 行内 `Input` 的 `w-full` 使其 flex-basis 诉求为容器 100%，三个 flex item 默认 `flex-shrink:1`，超出部分按比例压缩；`<button>` 元素在 Chromium 下不受 `min-width:auto` 自动最小尺寸保护（UA 对 button 的内部匿名盒特殊处理），于是按钮被压到内容宽度以下，叠加基类缺 `whitespace-nowrap` 导致文字换行/裁切。

### 1.3 Debug 基线

- 快照 SHA：`ed61480cea3b7b7e51932438aa62e911723d1423`（`git stash create`，工作区含本 spec 既有未提交改动）
- 进入时间：`2026-09-14 19:36:10`
- 退出闸门基准：`git diff ed61480`

### 1.4 假设看板

| # | 假设 | 若成立会看到 | 若不成立会看到 | 结论 |
| - | ---- | ------------ | -------------- | ---- |
| H1 | `Input` 的 `w-full` 抢占全部行宽，两个 Button 缺 `shrink-0` 被 flex 压缩到内容宽度以下 | 两按钮实际宽度 < 其 `max-content` 宽度 | 实际宽度 >= `max-content` | ✅ **成立**（见 1.5） |
| H2 | `buttonVariants` 基类缺 `whitespace-nowrap`，文字换行导致「显示不下」 | 按钮 `offsetHeight` > `h-8`(32px)，文字折成两行 | 高度恒为 32px，文字仅被水平裁切 | ❌ **证伪**：`offsetH=32`，未折行，属水平裁切 |

### 1.5 证据

临时 Playwright 用例 `src/gui/src/__e2e__/zz-debug-newfolder.spec.ts` 打开弹窗 → 点「新建文件夹」→ 就地测量，输出：

```
input  = {"rect":430.69, "parent":526}
create = {"client":39,"scroll":39,"offsetH":32,"rect":38.66,"minContent":44,"ws":"normal","flexShrink":"1","minWidth":"auto"}
cancel = {"client":39,"scroll":39,"offsetH":32,"rect":40.66,"minContent":46,"ws":"normal","flexShrink":"1","minWidth":"auto"}
```

解读（`minContent` 是把按钮克隆成 `width:max-content` 探针量出的自然宽度）：

1. **两按钮均被压缩约 5.3px**：「创建」自然宽 44px → 实渲 38.66px；「取消」自然宽 46px → 实渲 40.66px。`px-2` 左右各 8px，可用文字区仅 22.66px，而 `text-sm`(14px) 的两个中文字约需 28px —— 文字确实放不下，被横向裁掉。
2. **宽度守恒验证挤压来源**：`430.69 + 8(gap) + 38.66 + 8(gap) + 40.66 = 526.01 ≈ parent 526`。`Input` 基类的 `w-full`（`width:100%` = 526px）让三个 flex item 总诉求超出容器，默认 `flex-shrink:1` 于是按比例压缩每一项。
3. **`min-width:auto` 对 `<button>` 不生效**：computed `minWidth` 确为 `auto`，但按钮仍被压到 `max-content` 以下 —— Chromium 对 `<button>` 内部匿名盒按「overflow 非 visible」处理，自动最小尺寸保护失效。这也解释了 `scrollWidth == clientWidth == 39`（溢出被匿名盒吞掉，`scrollWidth` 不反映），所以必须用 `max-content` 探针才量得到真实需求。
4. **`ws: normal` 但 `offsetH: 32`** → 未折行，H2 证伪；根因唯一落在 H1 的 flex 压缩。

> 补充风险：英文包下 `Create` / `Cancel` 比中文更宽，压缩量只会更大。

**根因**：`AddProjectDialog.tsx` 新建文件夹行 `div.flex.items-center.gap-2` 中，`Input` 带 `w-full` 独占 100% 行宽，而「创建」「取消」两个 `Button` 未设 `shrink-0`，被 flex 按比例压缩至自然宽度以下，`<button>` 又不受 `min-width:auto` 保护，导致文字被裁。

**修复**：给两个 Button 加 `class="shrink-0"`（`AddProjectDialog.tsx:259-275`）。`Input` 作为唯一可伸缩项吸收剩余空间，按钮保持自然宽度。不动 `buttonVariants` 基类——H2 已证伪，无证据支撑的全局改动不做。

修复后复测：

```
input  = {"rect":420.69, "parent":526}
create = {"rect":44,"minContent":44}   // 44 == 44，不再压缩
cancel = {"rect":46,"minContent":46}   // 46 == 46，不再压缩
```

### 1.6 脚手架清单

| 文件 | 位置 | 类型 | 状态 |
| ---- | ---- | ---- | ---- |
| `src/gui/src/__e2e__/zz-debug-newfolder.spec.ts` | 整文件 | 临时复现用例（测量按钮宽度） | ✅ 已删除 |

### 1.7 收尾核对

- [x] 脚手架逐条核销：临时 spec `zz-debug-newfolder.spec.ts` 已删除
- [x] 退出闸门：`git diff ed61480` 仅剩 `AddProjectDialog.tsx` 两处 `class="shrink-0"` + 本 `debug.md`
- [x] 复现步骤重跑：按钮实渲宽度 == `max-content`，文字完整
- [x] 完整性检查：`tsc -b` 通过；`vitest run` 全绿；`playwright test add-project` 3 例通过

## Debug 2 · 打开添加项目弹窗时，`?` 的 CLI 提示 tooltip 未 hover 就默认展开

- 状态：resolved
- 快照：0d9b9df58d6852d985324af0cf56bd5a65719efd
- 进入时间：'2026-09-14 19:45:18'

### 2.1 Bug 现象与复现

现象：打开「添加项目」弹窗的瞬间，标题旁 `?` 图标的 tooltip（`也可使用命令 \`yorz add <path>\` 添加项目`）自动浮出，此时鼠标并未 hover 该图标。

复现路径：

1. 打开 GUI，侧边栏点「添加项目」；
2. 鼠标停在原地不动（不移到 `?` 上）；
3. 观察标题右侧：提示气泡已展开。

### 2.2 关联链路分析

- `src/gui/src/components/AddProjectDialog.tsx:141-156` —— `DialogHeader` 内 `DialogTitle` + `Tooltip`(`openDelay=150`) + `TooltipTrigger as={Button}`，该按钮是 `DialogContent` 里**第一个可 Tab 元素**（`DialogPrimitive.CloseButton` 在 children 之后渲染）。
- `node_modules/@kobalte/core/dist/chunk/KEL2LLJM.jsx:100-115`（`createFocusScope`）—— 弹窗挂载时派发可取消的 `focusScope.autoFocusOnMount`；未被 `preventDefault` 则 `setTimeout(0)` 内 `focusWithoutScrolling(firstTabbable())`。
- `node_modules/@kobalte/core/dist/chunk/U2LDQJ3A.jsx:471-478`（`TooltipTrigger.onFocus`）—— **只要拿到焦点就 `handleShow()`**，不区分 `:focus-visible`／程序化聚焦；`isPointerDown` 才是唯一豁免。
- `src/gui/src/components/ui/dialog.tsx:26-31` —— `DialogContent` 只 `splitProps` 出 `class`/`children`，**`rest` 未被透传**给 `DialogPrimitive.Content`，所以现在无法从业务侧挂 `onOpenAutoFocus`。

### 2.3 Debug 基线

- 快照 SHA：`0d9b9df58d6852d985324af0cf56bd5a65719efd`（`git stash create`，工作区含本 spec 既有未提交改动）
- 进入时间：`2026-09-14 19:45:18`
- 退出闸门基准：`git diff 0d9b9df`

### 2.4 假设看板

| # | 假设 | 若成立会看到 | 若不成立会看到 | 结论 |
| - | ---- | ------------ | -------------- | ---- |
| H1 | Kobalte Dialog 挂载时自动聚焦首个可 Tab 元素＝`?` 按钮，而 Kobalte Tooltip 的 `onFocus` 无条件展开 | 弹窗打开后 `document.activeElement` 是 `aria-label=帮助` 的按钮，且 `[role=tooltip]` 已存在并可见 | 焦点在别处 / 无 tooltip 节点 | ✅ **成立**（见 2.5） |
| H2 | 是 `openDelay=150` 之类的 Tooltip 配置写错导致默认 open | 无任何焦点/hover 也展开，且 activeElement 与按钮无关 | activeElement 恰是该按钮 | ❌ **证伪**：展开与焦点严格同源 |

### 2.5 证据

临时用例 `src/gui/src/__e2e__/zz-debug-tooltip.spec.ts`：打开弹窗后**不做任何 hover**，等 600ms（> `openDelay` 150ms）后就地快照：

```
SNAP = {"activeTag":"BUTTON","activeLabel":"帮助","activeText":"","tooltipCount":1,
        "tooltipTexts":["也可使用命令 `yorz add <path>` 添加项目"],
        "helpDescribedBy":"tooltip-cl-34-content"}
TIP_VISIBLE = true
```

解读：

1. 焦点确实落在 `?` 按钮上（`aria-label=帮助`）——`createFocusScope` 的 `firstTabbable()` 命中它；
2. 同时 `[role=tooltip]` 已渲染且可见，按钮 `aria-describedby` 指向 tooltip content —— 正是 `TooltipTrigger.onFocus → handleShow()` 的产物；
3. 全程零 pointer 事件，H2 证伪。

**根因**：`DialogContent` 挂载时 Kobalte 会自动聚焦容器内第一个可 Tab 元素，而标题旁的 `?` 恰是第一个；Kobalte `TooltipTrigger` 对**任何**聚焦（含程序化聚焦）都展开 tooltip，不区分键盘 `:focus-visible`，于是弹窗一开提示就浮出。

**修复**（两处，均为最小面）：

1. `src/gui/src/components/ui/dialog.tsx:36` —— `DialogContent` 补 `{...rest}` 透传（此前只取 `class`/`children`，其余 props 被静默丢弃，业务侧根本挂不上 `onOpenAutoFocus`）。全仓 9 处 `<DialogContent>` 调用当前只传 `class`，透传属纯增量。
2. `src/gui/src/components/AddProjectDialog.tsx:139-150` —— 挂 `onOpenAutoFocus`：`e.preventDefault()` 取消「聚焦首个可 Tab 元素」，改为聚焦对话框容器本身（`role=dialog` 且 `tabIndex=-1`，正是 Kobalte `createFocusScope` 自己的兜底分支），焦点仍留在弹窗内，Tab 顺序不变。

> 为何不在 `tooltip.tsx` 里按 `:focus-visible` 过滤：Kobalte 的 `TooltipTrigger.onFocus` 先 `callHandler` 业务处理器再判断 `defaultPrevented`，而 `focus` 事件不可取消（`preventDefault()` 不会置位 `defaultPrevented`），拦不住；要拦只能把 tooltip 改成受控 open，代价与影响面都大于「别去自动聚焦帮助按钮」。
>
> 为何不给 `?` 加 `tabIndex={-1}`：那会让它彻底退出 Tab 序列，键盘用户再也看不到该提示——用无障碍换体验，不划算。

修复后复测（同一临时用例，仍不做任何 hover）：

```
SNAP = {"activeTag":"DIV","activeRole":"dialog","activeLabel":null,
        "tooltipCount":0,"helpDescribedBy":null}
TIP_VISIBLE = false          // 默认不再浮出
HOVER_OK = true              // hover 仍能唤出提示
AFTER_TAB = {"label":"帮助","insideDialog":true}   // Tab 序列未变，键盘仍可达
PLAIN_ESC_OK = true          // Esc 仍关闭弹窗
```

> 顺带发现（**既有问题，非本次引入，未修**）：当焦点停在 `?` 上、tooltip 因聚焦而展开时，连按 Esc 既关不掉 tooltip 也关不掉弹窗（`tooltips:1, dialogs:1` 三次 Esc 不变）——tooltip 的 dismissable layer 在顶层吞掉了 Esc，而 hide 后又被仍然存在的焦点立刻重开。修复前它在**弹窗一打开**就发生（Esc 直接失灵）；修复后只在用户主动 Tab 到 `?` 时才会遇到，已属明显改善。若后续要根治，需把该 Tooltip 改成受控 open。

### 2.6 脚手架清单

| 文件 | 位置 | 类型 | 状态 |
| ---- | ---- | ---- | ---- |
| `src/gui/src/__e2e__/zz-debug-tooltip.spec.ts` | 整文件 | 临时复现用例（探焦点/tooltip/Esc） | ✅ 已删除 |

### 2.7 收尾核对

- [x] 脚手架逐条核销：临时 spec `zz-debug-tooltip.spec.ts` 已删除
- [x] 退出闸门：`git diff 0d9b9df` 仅剩 `ui/dialog.tsx` 透传 rest、`AddProjectDialog.tsx` 的 `onOpenAutoFocus`、`add-project.spec.ts` 的回归断言
- [x] 复现步骤重跑：打开弹窗不 hover → 无 tooltip 节点；hover 仍出提示
- [x] 回归断言固化：`add-project.spec.ts` 首个用例在 hover 前先断言提示 `toBeHidden()`
- [x] 完整性检查：`tsc -b` 通过；`vitest run` 95 文件 / 966 通过 2 跳过；`playwright test` 57 通过 1 失败（`sidebar-hover-peek` 宽度断言，既有 flaky，与本次改动无关）

