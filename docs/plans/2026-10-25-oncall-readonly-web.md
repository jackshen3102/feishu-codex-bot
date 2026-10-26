# Oncall 只读管理页实施计划

日期：2026-10-25。粒度：L2，认证、数据库只读和状态投影按明确合同执行。
状态：代码实现、构建和隔离验收已完成；现有机器人容器尚未启用 Web。结果见 [实施与验收记录](../testing/results/2026-10-25-oncall-web/README.md)。

## 1. 目标与已确认范围

为独立 `feishu-codex-bot` 增加只读 Web 管理入口。继续使用当前仓库与 `feat/oncall-bot` 分支，不接入 Runweave、OMH，不创建第二个飞书客户端，不改变 Codex 调用方式。

采用现有原型的组合：运行概览为首页，点击话题进入话题记录，案例库和工作区作为导航入口。视觉和只读交互参考 [原型说明](../prototypes/oncall-management/README.md)，生产页面重新组织代码，不直接复制原型整份脚本。

交付四个页面：

- **运行概览**：执行占用、需关注话题、排队请求、最终回复发送失败；话题搜索、状态筛选和详情。
- **话题记录**：话题暂停状态、当前执行、排队数量、最终回复发送状态；切换轮次查看该轮输入、结果、有限进展、结论与证据。
- **案例库**：工作区内搜索案例、查看逐条验证状态、文本证据、来源轮次，并跳转到对应任务。
- **工作区**：只读展示已有绑定、仓库关联、资料路径和执行配置；空配置显示空状态。

业务动作仍在飞书执行。Web 不提供分析、补充上下文、停止、继续、重跑、修订结论、编辑配置、提交代码或 MR 的能力。

本期也不做文件浏览／下载、完整工具日志回放、工具探活、统计性能指标、执行超时限制、聊天账号体系或群成员自助登录。既有五并发和异常处理规则保持原样。

## 2. 已核对的代码事实

| 来源 | 当前事实 | 实现约束 |
|---|---|---|
| `src/db/schema.sql` | 话题、任务、投递、Oncall 消息、当前案例、案例历史各自存表 | 不新增数据库字段或迁移 |
| `src/db/store.ts` 构造函数 | 会创建目录、chmod、迁移、绑定 Agent | Web 禁止通过 `new Store()` 打开生产库 |
| `src/contracts.ts` | 执行有 preparing / queued / running / cancel_requested / succeeded / failed / cancelled / interrupted | 不添加 waiting、待补充等推断状态 |
| `src/oncall/store.ts` | `paused`、`pause_reason` 属于话题，消息以 sequence 存储 | 暂停与当前任务终止分别展示 |
| `src/db/store.ts#getFinalReplyState` | 汇总全部 `final_reply` 分片；优先 abandoned，其次全部 delivered、存在 delivering、否则 pending | 不用第一条分片或 status 卡片成功代替最终回复送达 |
| `src/oncall/case-store.ts` | `oncall_cases` 是话题最新案例；`oncall_case_history` 按 job_id 保留记录 | 每轮只读自己的历史；不得套用最新案例 |
| `src/agent/progress.ts` | 只保留有限的用户可见 Agent 消息窗口 | 不称为完整轨迹、工具调用记录或模型思考过程 |
| `src/oncall/ingress.ts`、`src/db/store.ts` | 失败会暂停话题；普通 @ 不解除暂停；执行完成会清空 input_text | 输入从消息表关联；不得为 Web 改写执行或恢复逻辑 |
| `src/health.ts` | 进程状态、任务与投递快照，默认 90 秒过期 | 不推断飞书实时连接或业务工具可用 |
| `src/oncall/workspace-config.ts` | 文件配置，重启生效；包含 agentEnvironment | 仅输出白名单展示字段，不返回环境变量 |
| `compose.yaml`、`Dockerfile` | 单独 Docker、持久卷，当前没有 HTTP 页面 | 增加一个可选 HTTP 监听，不增加飞书连接 |

原型中的 OC/KB 编号、业务分类、成员姓名、群名称、精确业务标题都不是现有结构化字段。正式版不造数据：保留真实 topicId/jobId；话题标题取根消息首个非空文本行，最多 80 字，缺失时显示“话题 + 短 ID”；显示“群聊/私聊 + 短 chatId”，发起人使用短 openId；案例卡片以摘要首行作标题。不新增业务分类、关键词标签或对应筛选。

## 3. 实现与部署结构

### 3.1 采用一个可选 HTTP 服务

在现有 bot 容器中启动 Node 原生 HTTP server，提供同源 JSON API 和静态页面。继续使用 TypeScript、现有 `better-sqlite3`、`zod`；前端使用浏览器原生模块、HTML/CSS，无需引入 React/Vite 或另一套应用框架。

- 新 HTTP 入口在 `Gateway.start()` 成功后启动，使用独立只读 SQLite 连接；不持有 scheduler、runner、delivery 或 Gateway 的可变接口。
- `WEB_ENABLED` 默认 false。Web 配置、端口或静态资产异常时关闭 Web 入口并记录脱敏错误，飞书机器人继续运行；禁止为了 Web 启动失败重启或回滚机器人任务。
- 退出时先关闭 HTTP 监听、等待有限的在途读取、关闭只读连接，再走现有 Gateway 停止逻辑。
- 使用现有容器，不创建后台自重试任务，也不加载第二个 WebSocket 客户端。

### 3.2 只读与最低访问边界

第一版仅供当前机器所有者查看所有已配置工作区，包括绑定私聊和群聊；不开放给群成员，不建立多人权限系统。

- SQLite 使用 `readonly: true, fileMustExist: true`，设置 `query_only=ON` 与短 busy_timeout；不得调用 migration、写 PRAGMA journal_mode、checkpoint、备份覆盖或清理逻辑。保留正常 WAL 读取语义，禁止 `immutable=1` 读取运行中的数据库。
- HTTP Basic 单管理员认证，用户名固定 `oncall`；密码从外部只读文件读取，至少 32 字节随机值，恒定时间比较。不复用飞书 appSecret，不在 URL、前端资源、日志或命令参数中放密码。
- 配置项：`WEB_ENABLED=false`、`WEB_HOST=127.0.0.1`、`WEB_PORT=6193`、`WEB_PASSWORD_FILE`；Web 关闭时无需密码文件。由独立 `src/web/config.ts` 校验，不让 Web 参数错误使原有 `loadConfig` 拒绝启动 bot。
- Docker 开启时容器监听 `0.0.0.0:6193`，宿主只映射 `127.0.0.1:6193:6193`；通过一个单独的 `compose.web.yaml` overlay 启用。口令文件以 `/run/secrets/oncall-web-password` 只读挂载，不进入镜像或 Codex 环境 allowlist。
- 页面与 API 都认证；只允许 GET/HEAD，其他方法返回 405，OPTIONS 不授予 CORS。默认接受 localhost:6193 与 loopback Host；跨源 Origin、非 loopback Host 拒绝。远端访问使用 localhost 同号 SSH 转发；如 Runweave 临时预览入口与该限制不兼容，使用同号转发，不放宽为任意主机。
- 不提供目录索引、任意文件路径接口或 SQL 输入；静态资源严格限定 public 目录。响应使用 `Cache-Control: no-store`，文本以 textContent/转义方式渲染，不把 Agent 输出当 HTML。

Docker 内同 UID 的 Agent 与网关不是额外的秘密隔离边界；本期只保证 Web 不下发或记录凭据，不声称抵御容器内任意代码读取文件。

## 4. 页面与状态合同

### 4.1 话题与轮次

API 中话题有 `paused`、`pauseReason`、`queuedCount` 和 `currentJob`，任务保留原 executionStatus。前端不维护或推断另一套业务状态机。

当前轮次选择顺序：running/cancel_requested 优先，其次 preparing，最后最新创建的 job；同级按 id 倒序。队列中较新的请求不能遮住尚未结束的执行。preparing 是输入准备，可以与上一轮运行重叠；重复执行异常只统计 running/cancel_requested，不把正常 preparing 算进去。若意外出现多个活动执行，返回最新者并附 `multipleActiveJobs=true`，页面显示记录异常，不静默宣告正常。

列表和详情标注“当前执行/最近一轮”，以是否存在活动执行区分；上方话题概况不会随用户浏览旧轮次改变。详情选择历史任务后，下方标题明确显示真实 jobId、创建时间、执行状态和该轮最终回复状态。

搜索匹配真实 topicId、根消息文本；大小写不敏感的字面子串，禁止将用户输入当正则或 SQL wildcard。工作区过滤在 SQL 层执行。暂无任务、无根消息、仅附件消息分别显示空状态，不构造分析结果。

### 4.2 最终回复

只聚合 `job_deliveries.kind='final_reply'` 的所有 sequence：

1. 没有分片：state=null，显示“暂无最终回复”。
2. 任一 abandoned：state=abandoned，显示“发送失败”；若 deliveredCount>0，同时显示“已发送 x/n 段”。
3. 全部 delivered：state=delivered，显示“已发送”。
4. 否则存在 delivering：state=delivering；其余为 pending。

API 返回总分片数、成功数、失败数；不返回投递 payload、stable_uuid 或重试密钥。状态卡片最终结果更新成功后记录的 `final_reply` 回执继续按上面规则处理。执行成功 + 部分回复失败必须能同时显示。

### 4.3 指标口径

全部按所选工作区统计，名称明确计数单位：

- 执行占用：running + cancel_requested 的任务数；配置最大值读取 MAX_CONCURRENT_TURNS，默认 5。
- 排队请求：queued 任务数，包含暂停话题保留的队列。
- 需关注话题：paused=true、当前轮次 failed/interrupted/cancel_requested、multipleActiveJobs，或任意轮次最终回复 abandoned，按 topicId 去重。
- 回复发送失败：至少一个 final_reply 分片 abandoned 的任务数，不是分片数。
- “本轮已完成”筛选只按所选当前/最近 job 的 succeeded，不排除结论未验证或发送失败；不表示整个业务问题已解决。

历史失败即使后续轮次成功仍保留在关注统计中，因为当前没有“已处理”字段；本期不新增清除入口或凭新轮结果推断消除。

### 4.4 结论、证据与输入

- 案例列表读取 `oncall_cases`；轮次详情严格用 jobId + topicId 读取 `oncall_case_history`。缺失时返回 null，不用当前案例替代。
- verification 逐条显示 observed / verified / unverified；未知或缺失显示结论文本但不加标签。执行成功与已验证互不推导。
- `evidence` 仅展示原文字符串。`feishu-message:...` 是来源标识，保持文本；仅原文中的合法 HTTP(S) URL 可点击，不拼接伪造飞书跳转链接，不读取本地绝对路径。
- `jobs.result_text` 为该轮结果；`progress_json` 为有限进展。空内容明确显示无结果/无进展；损坏 JSON 标记 `dataWarnings`，不得返回 500 整页崩溃或填造结论。
- 本轮输入从 job.feishu_message_id 关联 oncall_messages.content_json，输出 text 和附件名称/类型；不向浏览器返回本地文件路径、image/file key 或内部 Codex prompt。
- 不读取执行工作区文件，不展示完整 Codex session 或工具凭据。结果正文可能包含敏感业务内容，因此本期仅供单管理员访问。

### 4.5 工作区与健康快照

工作区仅投影配置里的 id、knowledgePaths、repositories 的 name/url/description/defaultRef，以及绑定的 chatId/type；不返回 agentEnvironment、ownerOpenId 配置全文或任何外部口令文件内容。仓库 URL 如包含 userinfo，去除凭据后展示；不自动克隆仓库。

健康快照复用 `readHealthStatus` 的校验和 90 秒过期规则：缺失/损坏为 unavailable，超过阈值为 stale。进程运行与飞书连接、工具登录、业务资源权限不是同一事实。界面只展示快照中的进程状态、采样时间、鲜度和已有统计。

## 5. API 合同

所有业务资源路径以 `/api/oncall` 开头。仅查询当前配置允许的 workspaceId；非 Oncall 话题不可见。详情需同时验证 workspace、topic、job 归属，不按裸 jobId 绕过关联。单管理员可主动选择任一配置工作区，不声称群成员隔离已经实现。

| 方法与路径 | 输入 | 输出 |
|---|---|---|
| GET `/workspaces` | 无 | `{items: WorkspaceSummary[]}`，配置白名单投影 |
| GET `/overview` | workspaceId 必填 | `{metrics, health, sampledAt}` |
| GET `/topics` | workspaceId；q；filter=all/attention/running/succeeded；cursor；limit | `{items: TopicSummary[], nextCursor}` |
| GET `/topics/:topicId` | workspaceId | `{topic: TopicSummary}` |
| GET `/topics/:topicId/jobs` | workspaceId；cursor；limit | `{items: JobSummary[], nextCursor}`，id 倒序 |
| GET `/topics/:topicId/jobs/:jobId` | workspaceId | `{job, input, resultText, progress, caseSummary, dataWarnings}` |
| GET `/cases` | workspaceId；q；verification=all/verified；cursor；limit | `{items: CaseSummaryWithSource[], nextCursor}` |
| GET `/cases/:topicId` | workspaceId | 当前案例及 sourceJobId；来源跳转走上面的轮次详情 |

`TopicSummary` 至少包括 id、title、workspaceId、chatType、chatId、ownerId、paused、pauseReason、queuedCount、currentJob、multipleActiveJobs、updatedAt；id 保留真实值，UI 可显示短 ID。`JobSummary` 包括 id、executionStatus、createdAt/startedAt/finishedAt、errorKind、finalReply={state,totalCount,deliveredCount,abandonedCount}。`CaseSummaryWithSource` 包括 topicId、sourceJobId、summary、conclusions、evidence、updatedAt，不增加臆造业务标签。

q 最长 200 字；limit 默认 30，最大 100；非法或多余参数返回 400。页面 URL 保存 view、workspaceId、topic、job 选择；从案例进入轮次时携带 sourceJobId，刷新可恢复选择。topic/case 游标使用倒序时间 + ID 的固定锚点，job 使用 id；游标绑定 workspace 与筛选条件并校验结构，客户端更换筛选后清空游标。列表提供“加载更多”，不自动拉取所有历史。

200 空列表与无数据不是错误；无认证/错误认证 401；无效参数 400；未配置工作区、不存在资源/跨工作区归属 404；拒绝 Host/Origin 403；非 GET/HEAD 405。数据库忙或 schema 不兼容返回 503 `{error:{code,message}}`；不输出 SQL、堆栈、内部路径或秘密。已有页面读取失败时保留旧内容并标记更新失败，不能继续把旧计数当实时值。

每次 API 内多条 SELECT 使用短只读事务保持一致；不持有跨请求事务。页面可见时约 10 秒刷新概览、列表和当前任务；隐藏页停止轮询，历史已终结轮次不持续轮询，不刷新掉正在查看的历史选择。HTTP 同步查询必须有上限和参数化 SQL，禁止 N+1 扫全库。

## 6. 文件与任务拆分

不修改原型去冒充产品实现；下列新增文件均位于本仓库。

| 阶段 | 文件 | 工作与完成条件 |
|---|---|---|
| 1 只读数据 | `src/web/contracts.ts`、`src/web/read-model.ts` | DTO、readonly 连接、参数化查询、投递聚合、关联校验、JSON 降级；不 import Store/Gateway/runner |
| 2 HTTP | `src/web/config.ts`、`src/web/server.ts` | 独立开关配置、Basic、方法与 Host/Origin 限制、路由、静态目录、错误映射和关闭 |
| 3 页面 | `src/web/public/index.html`、`app.js`、`styles.css` | 从原型保留布局，改用真实 API；实现搜索、分页、轮次导航、空/加载/错误/过期状态；移除模拟数据、工具绿灯和业务写入按钮 |
| 4 生命周期 | `src/main.ts` | 在 bot 启动后可选启动 Web；失败只影响 Web；退出清理，保留 Gateway 行为 |
| 5 构建部署 | `package.json`、`Dockerfile`、`compose.web.yaml`、`eslint.config.js` | build 复制静态资源到 dist/web/public；Docker COPY 包含静态资源；浏览器 JS 明确 globals；overlay 启用本机端口和口令文件，不改默认 compose 启用状态 |
| 6 验证入口 | `scripts/verify-management-web.ts`、`scripts/management-web-fixture.ts` | 临时 SQLite + 真实 HTTP 集成验证；启动可供浏览器验收的隔离 fixture；绝不启动 Gateway、Codex 或飞书客户端 |
| 7 文档 | `docs/configuration.md`、`docs/deployment.md`、`docs/development.md`、`README.md` | 配置、访问、启动/关闭、验证和回滚说明 |

实现阶段给 package.json 增加 `web:verify`（tsx 集成验证器）与 `web:fixture`（tsx 隔离预览服务）。不新增单元测试文件或 TDD；集成验证必须真实启动 HTTP、连接临时 SQLite，而非复述 helper 实现。

fixture 支持 `--port` 和必填的绝对 `--state-dir`；拒绝复用非空目录，不默认生产路径。生成临时数据库、配置和受保护的认证文件，仅输出入口及文件路径，退出关闭本服务和连接；不删除用户提供的目录。便于核查的内容包含：多轮成功、部分投递失败、停止中且保留队列、缺失/损坏案例、跨工作区记录和过期健康数据。

## 7. 验收与命令

配套 [YAML 验收用例](../testing/oncall/readonly-web.testplan.yaml)。16 条 required 用例已完成格式校验与隔离验收。接口使用真实 HTTP 和临时 SQLite，生命周期使用既有假飞书适配器，UI 使用 Playwright 实际浏览器，容器使用最终编译镜像。逐项证据见实施与验收记录；不代表已部署到现有机器人。

实施完成后的基础门禁：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm web:verify
```

前四条为已有命令，最后一条为本计划新增。预期全部退出 0；集成验证器必须覆盖临时数据库的只读与最终投递聚合，输出场景结果，不写业务正文或口令。已有测试使用假飞书适配器，不做真实消息发送。

隔离浏览器验收入口（实施后）：

```sh
ONCALL_WEB_FIXTURE_DIR="$(mktemp -d /tmp/oncall-web-acceptance.XXXXXX)"
pnpm web:fixture -- --port 6193 --state-dir "$ONCALL_WEB_FIXTURE_DIR"
```

使用 `$toolkit:playwright-cli` 打开 `http://localhost:6193`，通过独立测试认证配置进入；按 YAML 逐条取证。桌面使用 1440×1000，窄屏 390×844；检查刷新后仍是相同工作区/话题/轮次、分页不串结果、无横向溢出。保存最终真实页面截图，说明来源。静态原型验收不能代替生产实现验收。

构建新镜像后，用临时 fixture 数据进行容器内 HTTP/SQLite 验收，再验证 Compose overlay：只发布 loopback 端口；不导出展开后的环境变量。真实部署时沿用外部配置路径，先记录当前镜像和备份；不得使用 `compose down --volumes`。

## 8. 发布、兼容与回滚

- 不改变数据库版本、不新增索引或回填历史；既有空/缺失记录按合同显示。只读查询若出现不可接受的性能问题，先优化查询和分页，不在该任务中擅自迁移生产库。
- 默认 WEB_ENABLED=false，部署带新代码的镜像也不会自动公开页面。启用 overlay 和口令后才开放 localhost:6193；端口冲突不自动漂移。
- 同容器启用需要重建/重启 bot 容器。发布窗口先检查活动任务，等待空闲再切换；如必须中断，遵循原有暂停/明确继续机制，不自动重放。计划编写与实现验收均不授权向群或私聊发送测试消息。
- 发布检查分开报告：原有机器人进程与健康快照、页面认证与只读查询、已有历史记录可见。不开第二个飞书 WebSocket，不为 Web 改机器人授权。
- 回滚首选关闭 WEB_ENABLED 并去掉 Web overlay 后按原 compose 重建；必要时回到此前记录的镜像。数据库没有迁移，不因关闭 Web 恢复旧数据库或丢弃期间新增任务。

## 9. 风险与完成定义

主要风险是把执行/投递/结论混淆、历史轮次错配、只读服务误触迁移、后台数据泄露、长查询阻塞机器人，以及发布重启影响进行中的任务。分别通过明确 DTO、归属查询、独立 readonly 连接、单管理员本机访问、限量查询和空闲发布控制。

完成必须同时满足：四页使用真实 API；当前与历史数据语义正确；页面无业务写入路径；服务关闭不影响既有启动；临时库集成、既有回归、YAML required 用例通过；部署与回滚步骤可复现。若尚未实际部署，交付只称“实现并验收完成”，不得称“已经上线”。
