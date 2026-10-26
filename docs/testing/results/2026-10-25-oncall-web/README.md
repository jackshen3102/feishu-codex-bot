# Oncall 只读管理页实施与验收记录

日期：2026-10-25。代码分支：`feat/oncall-bot`。对应实施计划：`docs/plans/2026-10-25-oncall-readonly-web.md`。

四个正式页面、只读 API、独立只读 SQLite 连接、可选生命周期和 Docker overlay 已实现。以下结果来自实际 HTTP、临时 SQLite、假飞书适配器和真实浏览器，不是静态原型点击结果。

所有数据均为专门建立的合成 fixture。没有读取或改动生产数据库，没有启动第二个真实飞书客户端，没有发送飞书消息，没有重启或替换正在运行的机器人。代码尚未提交；验收镜像不代表已发布版本。

## 命令与制品

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。
- `pnpm test`：15 个测试文件、128 个测试通过；包括 Web 默认关闭、密码错误/端口冲突隔离、HTTP 关闭后原 Gateway 停止的集成场景。[回归输出](regression.log)
- `pnpm web:verify`：真实监听 HTTP + 临时 SQLite 的只读查询、认证、归属、投递聚合、游标、损坏数据、健康快照、WAL 更新可见性和关闭检查通过。[集成输出](integration.log)
- 验收 YAML 的 16 条 required 用例通过最小 schema 解析及 Runweave `parseTestPlan` 格式校验。没有为通过验收修改用例合同。
- 使用仓库固定版本 `pnpm exec playwright cli` 驱动服务器独立 Chrome。用户已有飞书浏览器标签未被替换。正常浏览过程中控制台 0 errors / 0 warnings。额外停止验收服务后出现预期的网络读取失败，页面明确显示“更新失败”并保留原数据，不将旧计数宣称为已更新。
- 最终 `oncall-tools` Docker 镜像 `feishu-oncall:readonly-web-acceptance` 已构建，包含原有固定版本业务 CLI。镜像 ID：`sha256:26ddfbe5a7476c8454df46cd4c9e6d58de68fefd0b056fa3e3de89184bd6891f`。
- 在非特权 `node` 用户下，用编译后的 `dist/web/server.js` 运行只读容器，实际查询临时 SQLite。7 个关键源文件/资源 SHA-256 与当前工作区一致。完整记录见 [容器检查](container.json)。
- 基础 Compose 与 opt-in Web overlay 均使用合成路径和占位环境执行 `config --quiet` 验证通过，没有展开或打印生产秘密。

## 用例结果

| 用例 | 结果 | 实际证据 |
|---|---|---|
| ONCALLWEB-001 | 通过 | 读取前后 schema、user_version、各业务表逻辑摘要完全一致；尝试经只读连接 UPDATE 被 SQLite 拒绝。容器退出后再次核对表与 schema 摘要不变。 |
| ONCALLWEB-002 | 通过 | 首页、JS、CSS、概览在无认证/错误认证下 401；正确 Basic 认证返回 200；工作区白名单输出无 agentEnvironment/ownerOpenId 配置全文。 |
| ONCALLWEB-003 | 通过 | POST/PUT/PATCH/DELETE/OPTIONS 均 405，无放行 CORS；跨源 Origin 与自定义非本机 Host 403；任意文件及编码路径穿越 404。 |
| ONCALLWEB-004 | 通过 | 跨工作区 topic、case 及跨 topic 的 job 查询 404；旧模式话题不可见；缺少 workspace 或非法参数 400，未配置 workspace 404。 |
| ONCALLWEB-005 | 通过 | 浏览器同时显示话题已暂停、任务 #201 正在停止、排队 1；查看排队 #202 不改变上方当前轮次，概览占用包含停止中的执行。 |
| ONCALLWEB-006 | 通过 | 全部成功/部分 abandoned/部分 pending/delivering/无分片分别聚合；#103 显示执行已完成、发送失败、已发送 1/2 段。 |
| ONCALLWEB-007 | 通过 | 依次查看 #101 旧案例、#102 无案例、#103 新案例；空轮次不借用其他轮次证据。刷新保留 job；逐条 observed/unverified 标签独立存在。 |
| ONCALLWEB-008 | 通过 | 损坏请求/进展/案例显示警告且保留本轮结果；附件只返回名称和类型，接口及页面不含私有 path/key；缺失请求明确显示不可用。 |
| ONCALLWEB-009 | 通过 | 普通证据名称、feishu-message、本地路径保持文本；合法原文 HTTP URL 才可点击；javascript 及 HTML 显示为文字，未创建 img 或执行脚本。 |
| ONCALLWEB-010 | 通过 | 控制 fixture 健康文件为 fresh、超 90 秒、损坏、缺失，再恢复；浏览器依次显示有效、已过期、不可用、不可用、有效。无工具探活绿灯。 |
| ONCALLWEB-011 | 通过 | 30→50 条话题分页无重复；百分号/下划线按字面匹配；工作区和筛选切换重置结果；案例 verified 筛选与来源 #300 跳转正确，当前 #301 仍执行中；刷新保留历史选择。最终镜像还验证了待触发搜索不跨工作区，以及自动刷新保留已加载的 35 条结果。 |
| ONCALLWEB-012 | 通过 | 现有 Gateway 集成测试：未设置 Web 配置仍正常启动，只有一个假飞书客户端，Web 不启动。 |
| ONCALLWEB-013 | 通过 | 现有 Gateway 集成测试：无效密码文件和端口冲突分别只关闭 Web，Gateway health 保持 running，客户端启动计数仍为 1。 |
| ONCALLWEB-014 | 通过 | 实际 HTTP 读取后有序关闭并重复关闭；端口释放、查询失败，Gateway 原停止逻辑完成，health 为 stopped，临时数据保留。 |
| ONCALLWEB-015 | 通过 | 四页分别在 1440×1000 与 390×844 实际打开并截图，scrollWidth 等于视口宽度；无业务写入控件、表单和消息输入区；观察到的页面请求仅 GET/HEAD；空配置工作区不补造仓库或资料。最终 Docker 编译资产重新检查和截图通过；实际停止服务后页面保留 30 条列表与原计数，并显示更新失败。 |
| ONCALLWEB-016 | 通过 | 最终镜像真实运行：宿主只绑定 loopback 6193，密码只读挂载，node 用户；认证读取页面与 SQLite 200。退出码 0，端口释放，数据库保留、schema 与业务表摘要未变。临时容器已删除。 |

接口错误输入与状态组合使用脚本自建临时数据库；浏览器场景使用自建 fixture。停止与启动故障使用既有 Gateway 集成测试中的假飞书适配器。容器场景使用独立 bind 目录，不挂载生产数据卷。没有将线上任务重跑作为 Web 验收方法。

## 页面截图

截图来自最终 Docker 镜像实际提供的 Web 页面，展示合成数据，不代表生产当前状态。

- [运行概览，桌面 Chrome](console-desktop.png)
- [话题记录，桌面 Chrome](desk-desktop.png)
- [话题记录，390px 窄屏 Chrome](desk-mobile.png)
- [案例库，桌面 Chrome](cases-desktop.png)
- [工作区，桌面 Chrome](workspace-desktop.png)
- [真实服务停止后的读取失败提示](read-failure-desktop.png)

其余窄屏图片为同目录的 `console-mobile.png`、`cases-mobile.png`、`workspace-mobile.png`。

## 发布边界

现有机器人容器尚未启用 Web。完成的是代码实现、构建与隔离验收；不是生产上线。

实际启用时使用 `docs/deployment.md` 的 Web overlay 流程，先确认发布窗口和原有镜像，配置外部专用密码文件，再仅向本机开放 http://localhost:6193。同容器替换可能影响进行中的轮次，必须沿用已确认的中断/明确继续机制。关闭 Web 不需要数据库回滚。

测试容器和独立浏览器已关闭，临时数据目录保留作核查；测试口令文件留在受保护的临时目录，没有写入此报告或仓库。原型端口 6192 的已有服务不属于此次产品验收。
