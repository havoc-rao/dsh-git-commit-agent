# DSH Git Commit Agent 插件设计计划

- 状态：P0 公开 API 已核对（见 `docs/P0-VERIFICATION.md`）；P1 与 P2 已实施并通过 49 项测试；**实施状态与设计偏差见 §13**
- 日期：2026-09-14
- 插件目录：`dsh-git-commit-agent`
- 暂定包名：`dsh-git-commit-agent`（发布前核对命名与可用性）
- 依赖项目：DSH 宿主、DSH-better-sidebar（可选 UI 集成）

## 1. 目标与已确定决策

提供一个可持续交互的 Git Commit 专用 Agent：

> 从 GitLens 派发 → 分析 Git 状态与实际差异 → 制定 add/commit 计划 → 用户预览与对话调整 → 明确确认 → 执行实际 Git CLI → 报告提交结果或讨论失败原因。

已确定：

1. 以独立插件实现，不把完整业务继续堆进 better-sidebar。
2. 原生 DSH 聊天区承载专用会话，复用原生输入框与消息历史；GitLens 不再实现第二套聊天输入和转录。
3. 专用会话与来源编码会话分离，不把任务直接注入正在编码的主 Agent。
4. GitLens 提供入口、任务简短状态和返回会话入口；DiffPane 提供提交差异预览。
5. Agent 决定合理提交次数、顺序、范围和消息；Host 物化并验证计划；用户批准指定版本；受限执行器运行 Git CLI。
6. 自由讨论不等于任意 Git 写权限。规划和执行具有不同权限边界。
7. 不修改官方 DSH checkout，不编辑宿主生成产物，不使用 DOM monkey patch。

本文件只描述设计；宿主接入方式中尚未核实的部分不得视为已有 API。

## 2. 使用流程与界面

### 2.1 GitLens 入口

集成位置参考 better-sidebar 的 `src/client/changes/GitLens.tsx:559`，现有提交消息输入框与 Commit 按钮之间增加图标按钮，名称为“规划并提交变更”。

点击后：

1. Host 校验来源 session、仓库与当前选中的 worktree。
2. 创建或打开该来源与 worktree 对应的未完成提交任务。
3. 打开专用会话，标题建议为 `Git Commit · <branch>`，并聚焦原生输入框。
4. 自动投递首次规划请求。
5. 保留返回来源会话的入口，不丢弃原会话输入草稿。

无仓库、无变更、目标正在解析时禁用入口。重复点击与请求重试不得创建重复任务。完成后再次点击可开始新任务或查看既有记录。

GitLens 会自动选择有变更的 linked worktree，因此不能直接沿用来源 session cwd。任务一经创建即绑定目标，不随 UI 后续切换仓库而改变。

### 2.2 聊天与预览分工

- 原生聊天：用户补充、Agent 解释、计划修订、工具进度、失败讨论。
- 计划卡片：当前版本、提交消息、分组范围、顺序、风险、预览及确认执行控件。
- DiffPane：某次拟提交的准确差异，而非未经分组的整个工作区 diff。
- GitLens：仓库事实与任务入口，不保存唯一任务状态。

例：用户输入“把文档并到第一条，消息用中文”，Agent 发布新版本计划。旧版本保留在历史，但执行按钮失效。

如果宿主暂时没有公开计划卡片渲染接口，降级为原生聊天文字说明 + 插件侧计划预览/确认面；不得复制聊天输入框。该降级需要实施时明确记录。

### 2.3 确认方式

第一版以绑定计划版本的“确认执行 N 次提交”按钮完成授权。自然语言“可以，提交吧”表达意图，由 Agent 引导用户确认当前计划，不由模型自行认定完成授权。

未来纯聊天确认必须接入明确的审批协议，并消除旧消息与新版本之间的歧义。

## 3. 插件边界与集成契约

新插件拥有：专用 Agent composition、任务与计划服务、受限 Git 工具、执行器、持久化关联、计划结果 UI。

better-sidebar 拥有：GitLens 和 DiffPane。由其公开扩展 API 接入；若现有 API 没有 commit 区入口或计划 diff 接缝，应在 better-sidebar 通过独立 PR 增加最小扩展契约并更新接入指南，不反向修改 DSH 核心。

候选集成契约（仅设计，不是现有接口）：

- 注册 GitLens action，并取得来源 session 与所选仓库/worktree。
- 打开指定提交计划/提交项的只读 diff 资源。
- 按目标查询当前任务状态及打开已有会话。
- 注册注销时清理入口，未安装本插件时 GitLens 行为不变。

插件应避免强制依赖 better-sidebar 的私有 React 组件。若公开宿主能力允许，可另提供命令入口，使专用会话不依赖 GitLens 才能启动。

安装走独立包与 profile/patch 机制，不侵入官方 checkout。发布时另行核对市场 manifest、peer、客户端 bundle 与宿主版本要求。

## 4. 宿主 Agent 接入

### 4.1 推荐入口

优先复用 `AgentRegistry.create({ setup, ... })`，安装专用提示词和受限工具，再通过 `agent.followup()` 驱动宿主 agent-loop；不自行实现模型循环。

后续输入继续使用同一专用会话。冷恢复使用 `agents.resume({ setup, ... })`，重新安装同样的工具与限制。恢复会话不会恢复旧执行授权。

不默认继承来源会话全部历史或全部 preset 权限，只传递任务目标、明确用户约束、计划和执行记录。模型配置如何选择需单独适配，不盲目复制来源 agent options。

“可持续对话”不等于必须使用 `startContinuable`。会话是否标记为 subagent 尚待原生聊天寻址、导航与恢复契约核对；不能假设 sidechat 的 subagent-origin 会话可以直接作为普通会话打开。

### 4.2 已核对事实与限制

此前已委派 deepseek-harness 工作区只读核对，其当前源码提供：

- `AgentRegistry.create/resume`、`AgentSetup`：`packages/core/agent/src/index.ts`。
- `agent.followup/cancel/whenIdle`：`packages/core/agent/src/runtime-types.ts`。
- `tools.register/restrict/guard`：`packages/core/tools/src/index.ts`。
- 一次性 `subagents.start('spawn', ...)` 支持 outputSchema，但不支持任意 cwd/preset/setup，并从父 Agent 派生 composition。
- continuable 请求不支持 outputSchema，因此不能虚构相应参数。
- `restrict` 对自身 scope 工具有豁免，需执行末端 guard 配合。

以上仅是所引用开发工作区的源码事实，不是已发布 npm 版本兼容保证。实施前必须对目标发布基线验证。

参考的 `packages/client/ui-chat/lib/types/client/chat/ChatView.js:705` 是生成产物中的消息展示树，包含 ChatNodeList、TurnStatus 等，不是输入框本体。该处传递 renderSlot 不足以证明已有计划卡片公开槽。应检查源码及导出契约，禁止编辑该产物。

## 5. Agent 工具与安全边界

### 5.1 规划阶段

候选工具（拟新增）：

- `commit_agent_status`：读取绑定目标的状态。
- `commit_agent_diff`：按已验证变更 ID 读取 index/worktree 差异。
- `commit_agent_read_context`：受限读取必要文件、未跟踪内容与仓库规范。
- `commit_agent_recent_commits`：读取少量提交风格参考。
- `commit_agent_publish_plan`：提交分组意图，Host 验证并物化为可预览计划。

不开放通用 bash、任意 Git 参数、任意 cwd、文件写入、网络或委派工具。仓库文本与 diff 中的指令仅作为数据，不改变任务和权限。

工具通过精确 allowlist 和执行前 guard 限制。Git 参数数组由 Host 构造，禁用外部 diff、textconv、pager 与不必要的递归执行；清理会改变目标和行为的 Git 环境变量。路径验证需处理符号链接、字面量 pathspec、特殊字符、rename 原路径及读取边界。读取设文件数、字节、时间、步数预算，敏感文件默认不自动发给模型并解释排除原因。

### 5.2 执行阶段

候选工具 `execute_approved_commit_plan(planId, revision)` 只消费 Host 已保存且已授权的计划，不接收模型传入的任意命令或新增文件集合。也可由审批服务直接调度同一执行器；必须单一执行入口，避免重复执行。

客户端批准请求需鉴权、校验任务归属并绑定内容摘要。Agent 不能伪造批准，修改计划自动撤销旧批准。权限不能仅靠 prompt 或 UI 隐藏按钮保证。

默认不 push、不 amend、不 reset/revert 已完成提交、不跳过 hooks、不自动修代码。用户要求“修复测试”时解释能力边界或交回编码会话，不能静默扩权。

## 6. 计划数据与物化

Agent 根据 status 发现范围，根据实际 diff 判断语义，不能仅按目录、文件类型或暂存分区机械拆分。

分组原则：逻辑自洽、便于审查和回滚；功能与必要测试/文档通常一起；独立格式化/重构可拆分；manifest/lockfile 配套；依赖给出顺序；允许一条提交，不硬凑数量；未覆盖变更必须解释。

计划概念字段：

```text
id / revision / schemaVersion
sourceSessionId / agentSessionId
target { repositoryId, worktreePath, branch, head }
snapshotId
commits[] {
  id, message, rationale, dependsOn,
  changes[] { whole-file changeId | patchId },
  expectedTree
}
excludedChanges[] { changeId, reason }
indexStrategy
```

Agent 提出变更分组，Host 生成 expectedTree，不能让模型猜 tree hash。Host 校验引用归属、重复/遗漏、依赖无环、补丁可应用性与顺序一致性。

变更记录保留 index/worktree/untracked 层、旧新路径、文件模式、二进制/子模块分类与内容摘要。现有 better-sidebar `GitStatusEntry` 仅 path/xy，rename 原路径被解析器跳过，不能直接作为完整执行模型。

### 6.1 预览演算

候选方案为插件拥有的临时 index：从 HEAD（无首提交则空树）开始，按计划逐条暂存/应用补丁并物化 tree，展示相邻 tree 的真实差异。模型不可直接控制临时 index 路径或 Git 环境。

此过程可能写入临时文件及 Git 对象，不应宣称严格零磁盘写入；承诺是不修改工作区文件、真实 index 和分支历史。需独立受限工具、资源回收策略与兼容验证。

实际执行使用正常 git commit，保留身份、hooks 与签名行为，不默认用 commit-tree 绕过用户配置。

### 6.2 快照与过期

快照覆盖 HEAD、状态、真实 index、相关工作区内容和已读取 untracked 内容。仅 status 字母不够，文件内容改变可能仍显示相同状态。

普通 Git 读取非原子操作，采集前后需验证一致性；持续变化时返回过期/需重试，不无限自动重启。UI 切换目标不改变任务目标。执行前及每条提交前后再次验证，外部终端和 Agent 不受插件锁控制。

## 7. 暂存区策略与第一版限制

第一版支持：

1. index 为空：按完整文件分组，逐条精确暂存、校验、提交。
2. index 非空：尊重已有内容，将其作为第一条提交的基础；可经明确预览添加相关未暂存变更，不自动拆散用户已暂存内容。

不自动 git reset，不用无范围 git add -A 重新收集所有变化。同一文件部分暂存时保留 index/worktree 区别，不因整文件 add 意外纳入未批准内容。无法在第一版准确表达的组合应拒绝执行并引导手动整理。

第一版不执行同文件跨多次提交的 hunk 拆分。可识别需求，但结果需标记需人工处理，不允许对不可执行计划点确认。hunk 级物化与暂存恢复作为第二阶段。

冲突、进行中的 merge/rebase/cherry-pick、子模块特殊状态、未知 index 特性等，第一版默认阻止自动执行并说明原因，实施时列明支持矩阵。

## 8. 执行、故障与取消

顺序：

1. 校验审批、目标、HEAD、快照及 index。
2. 获取插件内目标 worktree 执行锁。
3. 精确暂存当前提交组。
4. 校验真实 index tree 等于批准 tree。
5. 执行 git commit。
6. 读取并验证实际 commit hash、parent、tree，记录结果。
7. 校验剩余状态后进入下一条。

注意 hooks 可执行任意用户配置的程序、改变 index/工作区/消息。不能保证使用正常 hooks 的提交全过程等同沙箱只读。须在确认面解释 hooks 会按用户配置运行；出现与批准结果不符时停止后续步骤并报告，不能声称能在 commit 后验证的同时阻止该 commit 已经发生。是否需要执行前额外约束 hooks 为实施验证项。

失败后：已完成提交保留；不自动 --no-verify；不盲目重试 commit。即使命令异常或被取消，也要检查真实 HEAD/index，避免重复提交。

取消默认在安全步骤边界生效。正在执行的 CLI 若请求终止，进入 cancelling 状态，等待进程与仓库状态核对后再报告。已收到取消请求不等于未产生 commit。

失败/取消后显示真实暂存状态及部分成功列表，不自动清空或恢复 index。多提交不是原子事务。

执行期间收到计划修改要求，应先安全暂停再生成新版本，不能热修改正在执行的批准计划。

## 9. 生命周期、持久化与接口草案

状态：分析中 → 待确认 ↔ 调整中 → 执行前校验 → 执行中 → 完成/部分失败/已停止。过期是快照属性，旧版本与执行记录不可覆写。

Host 持久化任务、计划版本、会话关联、审批记录及每步实际结果。Agent transcript 不是唯一业务数据库，React state 也不是权威状态。日志写入不违反“不修改目标仓库”的规划约束。

重启后恢复会话与计划；未完成执行标记需核对，先对账实际 HEAD/提交结果，不自动重复执行或复用批准。

候选业务接口（名称可调整，不是宿主现成 API）：

```text
git.commit-agent.open
git.commit-agent.prompt
git.commit-agent.get
git.commit-plan.update
git.commit-plan.approve
git.commit-plan.cancel
```

接口由新插件自行拥有，传输方式遵循已验证宿主公开能力，不依赖 better-sidebar 私有 /sidebar/api 作为新插件后端。所有操作校验归属、目标和版本；创建与审批有幂等 requestId。

原生输入框正常走专用会话的宿主输入路径；prompt 业务接口仅在桥接确有必要时实现，避免出现双重投递。

事件进度使用真实工具/执行器阶段；agent idle 不等于计划成功。计划发布必须经过工具结果与 Host 校验。按会话和 run 关联临时 assistant stream 与持久化事件。

## 10. 待核对项（实施前阻断项）

- [ ] 目标 DSH 已发布版本与上述 Agent/tools 契约的兼容性。
- [ ] 公开创建专用原生会话、导航、聚焦输入框、返回来源会话的 API。
- [ ] 普通专用会话/子代理 origin 的选择、可见性、所有权与冷恢复。
- [ ] 原生消息/工具结果渲染的公开槽，以及版本化计划卡片交互能力。
- [ ] better-sidebar 公开 API 能否注册 GitLens action 与计划 diff 资源；不足则设计最小独立 PR。
- [ ] 普通原生输入不会覆盖专用 Agent composition 或绕过工具 guard。
- [ ] Git hook、签名、临时 index、无首提交、Windows 和异常退出的实际行为。
- [ ] 任务存储、审批原子性、崩溃恢复与执行对账方案。

任何缺口优先使用公开接缝或插件自有实现；需要修改 DSH 核心才能实现的能力，应先提出取舍，不绕过约束。

## 11. 分阶段实施与验收

### P0：接入验证

只验证会话创建/导航、原生输入、受限工具、结果渲染、GitLens 扩展方式，确定支持的宿主版本。完成上述阻断项后再提交最终技术接口设计。

### P1：可交互规划

实现独立会话、status/diff 分析、完整文件级计划、版本更新、精确预览、旧卡片失效。此阶段不开放真实 commit。

### P2：批准与执行闭环

实现精确授权、执行器、真实 add/commit、取消、部分失败、hooks/签名日志、恢复对账。只有预览一致性与权限测试通过后才开放确认执行。

### P3：进阶拆分

评估 hunk 级分组、复杂暂存区备份/重建、更多 Git 状态及明确的聊天审批协议。

验收至少包含：

- 全未暂存、已有暂存、MM、rename/delete、untracked、特殊字符路径、文件模式和二进制。
- 无首提交、linked worktree、来源 cwd 与目标不同、UI 中途切换目标。
- 仓库变化但 status 不变、计划更新后旧批准失效、双击/重复请求不重复提交。
- 恶意仓库文本不能取得 bash/写文件/委派权限；Agent 无法伪造审批。
- 预览 tree 与批准 tree 一致；执行前暂存 tree 校验；提交后 parent/tree 校验。
- hook 拒绝/修改文件、签名失败、取消竞态、成功后返回异常、部分成功与进程崩溃。
- 原生输入补充与草稿保留，旧计划卡片不可执行，返回来源会话正常。
- 插件卸载无残留入口；主题令牌、可访问性与国际化符合宿主及集成仓库约束。

## 12. 非目标

第一版不做 push、历史重写、自动回滚已完成提交、自动跳过 hooks、自动修改代码修测试、任意 shell Agent 或跨仓库事务。不实现第二套 chatbox，不编辑 DSH 官方源码和 lib 生成产物。

## 13. 实施状态与设计偏差（2026-09-14 落地）

### 13.1 阶段完成度

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 接入验证 | 已完成（源码级） | `docs/P0-VERIFICATION.md`；核对基线 DSH `0.1.5-rc.2` + better-sidebar `0.20.0`，只读，未改动被参考仓库 |
| P1 可交互规划 | 已完成 | `src/core/git/*`、`src/core/plan/validate.ts`、`materialize.ts`、`src/host/session.ts`、`src/host/tools.ts`；测试 `tests/snapshot.test.ts`、`tests/plan.test.ts`、`tests/tools.test.ts` |
| P2 批准与执行闭环 | 已完成 | `src/core/plan/digest.ts`、`executor.ts`、`lock.ts`、`src/core/store/store.ts`；测试 `tests/execute.test.ts` |
| P3 进阶拆分 | 未开始（原计划） | — |
| GitLens 入口 / DiffPane 计划预览 | better-sidebar 侧接缝**已交付并实现**（`feat/git-commit-action-seam` @ `edf6837`）；本插件**客户端 UI 尚未实现** | 确切名字与证据见 `docs/BETTER-SIDEBAR-INTEGRATION.md` |
| 真机宿主联调 | **已完成一次**：mount / 受限工具面 / guard / 会话可见性 / 真实提交全部跑通；发现并修复 2 个阻断缺陷 | `docs/P0-VERIFICATION.md` §7 |

测试：`npm test` → 59/59 通过（`node --test`，真实隔离 git 仓库）。
真机联调在 scratch `DSH_HOME` 的 headless profile 中进行，未修改官方 checkout 或生成产物。

### 13.2 对 §10 待核对项的结论

1. **已发布版本兼容性**：仅核对源码 `0.1.5-rc.2`，非 npm 发布兼容保证。插件运行时不 import 宿主包（全部为结构镜像），宿主成员缺失时以编码错误在调用点暴露，而非模块加载崩溃。
2. **原生会话创建/导航**：`AgentRegistry.create({ sessionId, setup, meta.cwd })` 已核对；**聚焦输入框无公开 API**（偏差 1）；导航用 `ISessions.open` / `uiWorkspace.openSession`。
3. **普通会话与子代理 origin**：必须创建**普通**会话（不设 `origin:'subagent'`），并设置 `meta.cwd`，否则冷会话在侧栏不可见。已按此实现。
4. **消息/工具结果渲染槽**：`tool.call.toolview`（按工具名 keyed）为公开槽，plan 卡片第一版走该槽；任意 transcript 卡片需 ChatNode 三件套（P3）。
5. **better-sidebar 扩展接缝**：原始核对（提交区硬编码、选中仓库/worktree 未公开、无 proposed diff）成立。已通过跨工作区委派由 better-sidebar 工作区落地：`registerGitCommitAction` / `getGitCommitActions` / `getGitCommitTarget` / `setGitCommitTarget`（internal）、feature `'gitCommitActions'` / `'planDiff'`、`SidebarDiffRef` 新增 `{kind:'proposed'}`。确切名字与行号见 `docs/BETTER-SIDEBAR-INTEGRATION.md`。遗留：本插件的客户端 UI 组件与 `openTab` 调用尚未实现。
6. **原生输入不覆盖 composition/guard**：`setup` 在会话发布前安装 `restrict` + 末端 `guard`（fail-closed）。未在真机验证。
7. **hooks/签名/临时 index/无首提交/异常退出**：hooks 与签名按用户配置运行（不加 `--no-verify`）；临时 index 用 `GIT_INDEX_FILE` + 私有临时目录；无首提交（unborn HEAD）已测试；异常退出用 `reconcilePlan` 对账。Windows 未验证。
8. **存储/审批原子性/崩溃恢复**：原子写（临时文件 + rename）、append-only 版本、审批绑定 digest、执行前后对账均已实现并测试。

### 13.3 设计偏差（必须记录）

1. **`dsh.plugin.json` 不存在**：核对显示该文件在 DSH checkout 中无任何契约。改用已核对的 `package.json.dsh.bundle.patch` + `cordis.patch.yml`。（better-sidebar 仍带该文件，视为其自身约定，未参照。）
2. **“聚焦原生输入框”降级**：公开 API 不存在聚焦能力，也无原子草稿交换。降级为“打开会话 + `setDraft` 预置草稿”，来源会话草稿只能显式读后恢复。
3. **计划卡片第一版不走自定义 transcript 节点**：改为 keyed `tool.call.toolview` + 工具结果携带 planId/revision/digest。ChatNode 卡片列为 P3。
4. **better-sidebar 不作为运行时依赖**：插件不 import better-sidebar 任何代码，入口通过自有业务 API 提供；GitLens 按钮通过对方新交付的 `registerGitCommitAction` 接入。对方明确退回的边界（业务状态、持久化、专用会话创建、审批绑定）本插件自行承担，与 §3 一致。对方同时**去掉了 descriptor 的 `title`/`icon`**、未实现 `setGitCommitStatus`，且 `getGitCommitTarget` 故意非响应式——本插件组件需自持文案/图标与状态展示。
5. **工具定义不走 `defineTool` DSL**：为消除对 `@deepseek-ai/dsh-tools` 的编译期依赖，直接构造宿主 `register` 要求的 `ToolDefinition`（原始 JSON Schema + `render`）。契约等价。
6. **`followup` 的 `UserMessage` 形状未核对**：P0 未记录其字段，当前发送 `{ text }`，首次真机挂载需确认（`src/host/session.ts` 已标注）。
7. **末端 guard 的 `ToolExecution` 字段未核对**：guard 在无法读出工具名时**拒绝**（fail-closed），不假设字段名。
8. **`materializePlan` 的 `baseTree` 语义修正**：reuse-index 策略下，首个提交的“父树”是 HEAD 树而非 index 树；空提交检测与预览 diff 均以此为准（原设计未区分，实现时修正）。

### 13.4 已知限制与后续步骤

- **真机联调已完成一轮**（2026-09-14，scratch `DSH_HOME` headless profile）：原样 mount 曾因 `inject` 缺 `agents` 直接 boot 失败 → 改为 `ctx.get('agents')` 惰性解析；`followup({text})` 形状错误 → 改为完整 `UserMessage`。修复后 mount、restrict（33→8）、guard 拒绝、专用会话活/冷可见、`ctx.provide` 跨插件、status→publish→approve→execute 真实提交均实测通过。仍未实测：`resume`、web 客户端 `ISessions.open`、cancel/reconcile、卸载 disposal、并发、Windows（见 `docs/P0-VERIFICATION.md` §7）。
- **本插件客户端 UI（下一步首要）**：新增自带 `dsh.client`（platform web）的客户端入口，用 `registerGitCommitAction` 挂"规划并提交变更"按钮（组件内自绘 icon/文案与 inline 状态），用 `openTab({type:'diff', diff:{kind:'proposed', …}})` 展示计划 diff；`ctx.sessions.open?.(sessionId)` 做"返回来源会话"。不要引入 better-sidebar 的私有 React 组件。
- better-sidebar 侧已交付分支 `feat/git-commit-action-seam` @ `edf6837`（本地未 push）：需要时由用户决定是否合并/发布。
- P3：hunk 级分组、暂存区备份/重建、纯聊天审批协议。
- Windows 换行/符号链接/权限位行为未验证。
- 发布前：包名可用性、peer、客户端 bundle 与宿主版本要求核对。
