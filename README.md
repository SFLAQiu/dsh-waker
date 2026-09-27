# dsh-waker

把 DSH 从「人驱动的编码会话工具」扩展为「IM 可唤醒的数字员工」：钉钉消息即任务入口，DSH 会话即执行引擎，任务看板即统一观察面。

一个 DSH 静态插件包（npm 双入口：Host 半 + Client 半 + 钉钉 Stream 桥接辅助进程），零外部 npm 依赖。

## 功能

- **钉钉 @机器人 即派活**：群聊 @机器人（或单聊直接发），消息自动投递到 DSH Agent 会话执行，回复自动发回钉钉
- **续聊**：同一钉钉聊天映射同一会话，上下文延续；发「新任务： <内容>」强制新建
- **FIFO 队列与并发**：并发上限默认 2（1-5 可配），超限自动排队，前序完成自动开跑
- **任务看板**：六态（排队中/运行中/需要操作/失败/已取消/已完成）状态机，事件驱动，持久化；统计、筛选、取消、重试、点击跳转会话
- **需要操作检测**：任务等待审批时看板标记「需要操作」，GUI 内批准后自动恢复「运行中」
- **可靠性**：消息 messageId 幂等去重、回复频控（20 条/分钟/聊天）、长任务 30 分钟提醒（只提示不杀）、桥接 webhooks 落盘恢复、插件重启后队列恢复、运行中任务重启标记可重试

## 安装

### 方式一：GitHub 直装（推荐）

包声明了 `dsh.bundle.patch`（`patch.cordis.yml`），`dsh plugin add` 装完自动加入 profile 插件层，**无需手工改任何组合文件**：

```bash
dsh plugin --profile web add github:<owner>/<repo>#<tag>
# 例: dsh plugin --profile web add github:sflyq/dsh-waker#v0.1.0
```

pnpm 对 git 托管包的 `prepare` 构建脚本默认拦截，首次安装若提示 `blocked build`，把 CLI 打印的确切键加进 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 后重跑一次：

```yaml
allowBuilds:
  dsh-waker: true
```

然后重启 `dsh web` 并强刷浏览器（⌘⇧R）。升级用 `dsh plugin --profile web update dsh-waker`（改过 spec/分支时加 `#<新tag>`），卸载用 `dsh plugin --profile web remove dsh-waker`（reconcile 会同步把包移出插件层）。

### 方式二：npm 包

发布到 npm 后同一条命令换个 spec：

```bash
dsh plugin --profile web add dsh-waker
```

同样自动进层栈，无需手工挂载。

### 方式三：源码安装（开发形态）

```bash
git clone https://github.com/<owner>/dsh-waker.git
cd dsh-waker
node scripts/build.mjs       # 零依赖构建: pkg/lib/index.js + pkg/client/client.js
dsh plugin --profile web add <本目录的绝对路径或 file: 路径>
# 或维持 symlink 直挂: ln -s "$(pwd)" ~/.dsh/profiles/web/node_modules/dsh-waker
#   symlink 形态首次需 reconcile 一次让 bundle 层识别 dsh.bundle 声明:
#   dsh plugin --profile web update dsh-waker
```

开发热重启循环见下文「开发（热重启循环）」。

### 方式四：插件市场（dshmarket）

向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库提 PR 添加本插件条目，站点收录后即可在 DSH 设置 → 插件市场一键安装（npm 与 GitHub source 均支持）。

> 前置条件：`web` profile 的 bundle 里已含 `@deepseek-ai/dsh-web-app`（默认 web profile 均含），插件依赖的 timer/subprocess/credentials/storageDomain/agents 等 Host 服务与 settings.section Slot 均来自 base bundle。

## 发布（维护者）

```bash
# 1. 构建产物
node scripts/build.mjs
# 2. 发 npm（首次发布前 npm publish 需账号登录）
npm publish
```

版本变更请同步修改 `package.json` 的 `version`。

## 开发（热重启循环）

本仓库即运行载体：插件以 link 方式装进 web profile，改代码即刻生效。

```bash
# 一次性安装（已装可跳过）
dsh plugin --profile web add /path/to/dsh-waker

# 开发模式：构建 → 启动 dsh web → 监视文件保存自动构建+热重启
npm run dev
```

### 目录结构

```
dsh-waker/
├── plugin.yaml        # 插件清单（name/version/dsh.client —— 构建的单一真源）
├── package.json       # main/exports 指向 pkg/；"dsh" 字段由 plugin.yaml 镜像
├── src/               # 源码：host-body.js / client-body.js / bridge.cjs
├── examples/          # 使用与测试剧本示例
├── scripts/           # build.mjs / dev.mjs / sim.mjs
└── pkg/               # ⚠️ 构建产物（build.mjs 自动生成，gitignore，永不上传）
    ├── lib/index.js   #    Host 入口
    ├── client/client.js  # Client 入口
    └── bridge/bridge.cjs # 桥接脚本（复制自 src/bridge.cjs）
```

### 迭代与测试

- 改 `src/`（Host/Client/Bridge 源码）→ 自动 build + 重启运行时（约 8 秒，任务与映射都在 storageDomain 持久化，不丢）
- 只改了 Client 界面 → build 后浏览器强刷（⌘⇧R）即可，client.js 是按请求从磁盘读的
- `npm run dev:once`：只构建+启动，不监视

### 不依赖钉钉的功能测试（模拟注入）

dev 模式自动开启注入 RPC，可把与桥接上报同构的事件直接灌进处理管线：

```bash
node scripts/sim.mjs "帮我看看当前仓库的结构"   # 新会话
node scripts/sim.mjs --list                    # 查看映射
node scripts/sim.mjs --conv <cid> "继续"        # 续聊
node scripts/sim.mjs --script "任务A" "继续" "汇总"  # 多步剧本
```

详见 `examples/hello.md`。生产构建（非 dev）不注册注入 RPC。

## 钉钉开放平台建机器人步骤

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com/) → 应用开发 → 创建**企业内部应用**（或使用已有应用）
2. 应用能力 → 添加「机器人」能力：
   - 接收消息模式选 **Stream 模式**（无需公网回调地址）
   - 订阅主题保持默认 `/v1.0/im/bot/messages/get`
3. 获取凭据：
   - **Client ID**（AppKey）：应用凭证页
   - **Client Secret**（AppSecret）：应用凭证页
4. 发布应用版本，机器人可用
5. 在 DSH Waker 设置页填入 Client ID 与 Client Secret → 「保存并应用」→ 状态徽标变「已连接」

群里把机器人拉进群聊；单聊直接对机器人发消息。

## 配置说明

| 配置 | 位置 | 说明 |
|------|------|------|
| Client ID | Waker → IM 管理 | 机器人卡的钉钉应用 AppKey（每机器人一份） |
| Client Secret | Waker → IM 管理 | 存入 DSH 凭据库（`DINGTALK_CLIENT_SECRET` / 每机器人一份），界面不回显 |
| 自动连接 | 内置 | 凭据就绪后自动建立 Stream 连接 |
| 并发上限 | storageDomain `config` 表（默认 2，1-5） | 同时运行的任务数 |
| 全局 Assist 模型 | Waker 设置页 | 任务判定 + Waker 匹配选人的轻量模型；绑定级 `assistModel` 优先 |
| 判定开关 | `config.judgeMode`（`off` 关闭） | 关闭后所有消息按任务处理 |
| 上下文窗口 | `config.contextWindow`（默认 10 条 / 24h） | 新建任务时注入的群聊历史范围 |
| 项目（代码来源） | Waker → 项目管理（独立页签） | 登记代码来源：本地路径或 Git 仓库（地址+分支）；公开项目所有 Waker 可用，Waker 专属项目可多选属主 Waker 共用（登记即授权：Waker 只能访问其可见项目，沙箱强制，见「项目权限强制约束」）（卡片显示多属主标签）；Git 项目保存即克隆到 `~/.dsh/waker-projects/`，可「拉取最新」；支持编辑（行内「编辑」按钮打开预填表单，save 为 upsert：本地路径可改、Git 改地址/分支保存时自动重新克隆；名称/可见范围/属主均可改）；新增与删除（删除二次确认）；Waker 详情「项目」页签内亦可新增/编辑项目，与项目管理同步 |
| Waker 头像 | Waker → Waker 管理 → 详情右上角「编辑」 | 每 Waker 分配 `resource/img/` 头像：内置 12 张（男女各 6），点击选择；可上传自定义图片（png/jpg/webp/gif ≤3MB，存入 `resource/img/`，选完即用） |
| 设置导航图标 | 自动（`resource/img/icon-dark.png` / `icon-light.png`） | 设置页左侧菜单「Waker」入口使用项目专属图标，随主题切换且与选中态无关：深色模式用 `icon-light.png`（浅色图形，暗底可见），浅色模式用 `icon-dark.png`（深色图形，亮底可见）；默认跟随系统，可在 DSH 设置「外观」手动切换验证 |

「重连」按钮：桥接进程未运行时拉起，运行中时对钉钉网关重连。

## 使用

- 群里 @机器人 + 任务描述 → 机器人立即秒回「收到了」确认已看到（钉钉未开放机器人消息表态 Reaction API，新旧网关 7 个候选端点探测均 404，极短文本秒回是最接近形态）→ 由轻量模型判定类型后按“当下问题最适合的 Waker”从绑定候选池自动匹配：问答类直接等答案回执（一次提问一次回复，不发作过程通知）；任务类回「已创建任务，正在执行…」，完成后回执
- `新任务： <内容>` → 强制新建会话（丢弃旧映射续聊）
- 会话窗口按天滚动：每个群每天一个会话窗口（跨天自动新开，旧窗在跑任务自然跑完并照常回执，不强杀），同天内 @ 追问全部进同一会话（nearest step boundary 续聊，上下文全量共享）；「新任务：」前缀可在当天强制另开新窗；窗口命名 `[Waker][emoji Waker名] MMDD 首条任务摘要`（日期即组织维度，同日多窗靠摘要区分）；会话记录永久保留可在工作区回看，跨天上下文不携带（无关系对话互不污染）；挂起中的提问跨天仍优先应答（应答先于窗口滚动）
- 会话窗口挂接：项目任务按 realpath 化的项目路径自动注册同名工作区组（如 moment）并挂入；非项目任务挂 Waker 分组——修复两类「工作区里看不到会话窗口」：① 项目权限上线后项目会话不挂接；② macOS 大小写不敏感卷上 fs realpath 会把路径改写为磁盘登记大小写（/go→/Go），注册/挂接未归一导致校验必败（attachSession 静默吞错）；启动时自动回溯挂接历史会话（项目会话归项目组，Waker 会话归各自分组）
- 群聊未 @ 机器人 → 完全静默（仅看板遥测计数）；@ 但被判定为讨论 → 不建任务，给委婉引导（说明未创建任务原因 + 提示说清需求或用「新任务：」开头强制创建），同会话 3 分钟内只引导一次防刷屏
- 新建任务自动附最近 10 条/24h 内群聊上下文（全局可配）
- 任务完成/失败 → ActionCard 无按钮卡片回执（实测 text 渲染子集最全：表格、代码块正常渲染，单换行即生效；不带 singleTitle/singleURL/btns 则无底部跳转按钮，实测 errcode 0），标题带 Waker 徽标；会话系统提示词注入「回复格式约束」（ActionCard 支持完整 markdown，表格/代码按需使用）；markdown 报文与 AI 卡片通道在 bridge 中保留（format `markdown`/`aicard` 触发即用，aicard 含 accessToken 自取 + createAndDeliver + card/streaming + 模板三重解析）；排队/开始/取消/需输入等短通知仍为纯文本；需输入时提醒发起人（昵称提示，精准 @ 需手机号映射）；**群内问答桥**：会话内 `ask_user_question` 挂起的问题自动转达钉钉群（带编号选项），群里的下一条 @回复 作为答案回注工具结果，会话自主续跑——不再卡死在无人应答的挂起上（官方 agent 作用域 `user-questions/request` waterfall 自建应答器，先于 GUI 客户端命中；取消任务经 abort 信号解除挂起）；配套「提问纪律」提示段：默认自主决策并在回执中说明假设，仅方向性缺失才提问且一次一个
- DSH 设置 → Waker → 任务看板：状态筛选、取消、重试、点击行定位会话（会话已按 Waker 工作区分组，可从侧栏进入；排队中任务提示暂无会话）；按最近更新倒序、分页；Waker 详情「任务看板」页签的行同样可点击定位
- DSH 设置 → Waker → IM 管理：每个钉钉机器人一张卡，只保留扫读层（凭据编辑 / 连接状态 / 收到消息计数与最近时间 / 会话映射条数），底部「运行详情」按钮打开弹窗查看日志调试类信息：最近消息（近 5 条 / 累计）、会话映射列表（含解绑）、管道遥测（桥接状态 + 静默遥测 + 全局事件计数），数据随 5 秒轮询实时刷新，点遮罩或 ✕ 关闭；「诊断」一键体检（凭据→桥接→Stream→事件流入）；可新建多个机器人
- 会话映射、凭据、连接状态统一挂在各自机器人卡下，不单独成卡
- DSH 设置 → Waker → Waker 管理：分区标题与「恢复预置默认」「＋ 新建 Waker」同栏；每个 Waker 一张卡，卡头为头像 + 名称 +「预置/自定义」徽章，卡片底部操作栏为「查看详情」「停用/启用」（非预置另有「删除」）；「查看详情」打开详情抽屉，左侧类目切换「档案 / 项目 / 能力 / 任务看板」——档案页签标题行右侧为「编辑」（次按钮，仅此页签显示），下方只读展示身份/职能/预设/触发词/并发/状态等档案字段，「编辑」打开对应编辑弹窗（弹窗标题行右侧 ✕ 关闭）；项目页签标题行右侧为「新增」（标题行与下方列表间隔 12px），下列该 Waker 可见/所属项目，每行「删除」需二次确认（与项目管理页签共用同一存储）；任务看板页签筛选出该 Waker 的执行记录、无编辑/新增操作；抽屉右上角 ✕ 关闭
- Waker 能力治理（详情抽屉「能力」页签）：**安装收敛在 DSH 全局（Skills 目录 / MCP 设置），Waker 只做引用式选用** —— 页签内从全局目录勾选启用哪些能力，不引入第二套安装/存储。可裁剪三类：内置能力组（基础执行/任务过程/技能为必选，规划/子代理与工作流/目标/联网检索可关）、MCP 工具（server 级整开或工具级细选，server 折叠展开）、用户级技能（全局 `~/.dsh/skills` 白名单；项目级技能随任务项目自动可用）。不配置 = 继承 standard 全量；配置后保存即生成专属预设 `~/.dsh/.agent-presets/wkr-<wakerId>/`（必选底座恒装：persona、agent-instructions、compaction 压缩保护、ask-user 问答桥、fs/bash 执行底座），新会话只装配白名单内能力——工具 schema 与技能目录不再全量进入上下文，执行不被无关能力干扰；MCP 白名单经会话级 `ToolRuntime.restrict`（仅作用于该会话 global 层 `mcp__*` 工具，与现存工具名求交，全局卸载/server 掉线的失效引用自动跳过）；技能白名单经聚合目录符号链接引用全局安装（纯引用零复制）；修改无需重启，对新建会话生效，运行中会话保持原代；删除自定义 Waker 时其生成目录同步清理；启动时自动自愈（目录缺失/漂移重建）
- DSH 设置 → Waker → 项目管理（独立页签）：维护公开 / Waker 专属项目（本地路径或 Git 仓库地址+分支，保存即克隆、可拉取、可编辑、可删除）；行内直接展示本地路径 / Git 源与克隆落点（悬停可看完整路径）；本地路径支持「选择…」按钮直接弹出系统文件夹选择对话框（复用宿主原生目录选择能力，取消/超时 3 分钟自动收起，无原生能力环境回退手动输入），Waker 详情「项目」页签的新增表单同样支持
- DSH 设置 → Waker → @Waker 管理：卡片为「🤖 机器人 → AI 路由 N 个 Waker」，候选池以「头像 + 名称」小标签展示（停用成员带「停」标）；新建/编辑绑定表单为加高弹窗（下拉浮层可溢出弹窗展开，不再被截断），含「Waker 候选池」多选下拉——点击下拉框以外区域自动收起，支持搜索（名称/职能）、键盘 ↑↓ 高亮 / Enter 勾选 / Esc 收起、底部常驻「已选 N 个」统计条；选项为头像 + 名称 + 职能副行，信息一眼可辨；【任务执行模型】【判定/路由轻量模型】为搜索式下拉，模型按 provider 分组（分组标题为独立底色带 + 数量，滚动时层级清晰），触发框两段式显示「模型显示名 + 提供方」，支持「全局默认/全局轻量档」跟随选项，键盘 ↑↓/Enter/Esc 可用，空间不足自动上翻；下拉内按 Esc 仅收起下拉、不再连带关闭设置面板——无“默认 Waker”、无前缀触发路由，多条任务消息由轻量模型自动匹配池内最合适的 Waker，池首成员作为兜底；【任务执行模型】经 agent/request waterfall 强制应用于该绑定全部任务会话（dsh-webhook 同款模式），即使全局默认模型变更或缺凭据（如 volcengine 未配 key）也不受影响
- 项目权限强制约束：Waker 配置的项目即其项目权限 —— 新任务会话的根目录（= 平台沙箱唯一可写根）只能落在该 Waker 已授权且就绪的项目目录或其 Waker 工作区内，授权清单之外的路径无法成为会话根，越权写入被平台沙箱物理拒绝；会话创建时自动钉定 `workspace-write` 沙箱与「审批永不弹窗」（升级请求直接拒绝，无人值守不被挂起）；任务显式点名项目或 Waker 仅有一个就绪项目时会话根落该项目（直接可写），否则落 Waker 工作区（各项目只读，需修改时点名项目开启对应会话）；local 项目选根前校验目录真实存在；路由候选附带各自项目名，任务点名项目时 AI 优先选拥有该项目的 Waker；系统提示词注入「项目权限」段（授权清单+当前会话根+纪律），用户 @Waker 询问拥有什么项目权限时如实完整告知（名称/类型/路径/分支）；映射记录 `projectId`/`projectRoot` 供追溯
- 独立 Waker 工作区：执行目录按 Waker 分组 —— 每个 Waker 以其名称命名子目录（`<base>/<Waker 名>`，base 优先 `config.cwd`，默认 `~/.dsh/waker-workspace`；无 Waker 的任务归入「其他」），并自动在侧栏创建同名工作区分组（如「全栈开发」，存量分组启动时自动改为纯名称），会话随建随挂入对应分组，不再散落「未分组」（项目根会话按 realpath 化的项目路径自动注册同名工作区组并挂入——平台约束「会话真实 cwd 必须等于工作区路径」决定了项目会话物理上归项目组；Waker 分组只收 cwd=Waker 执行目录的会话）；启动时自动回溯挂接历史会话（按会话 cwd 匹配工作区，无法匹配的归入「Waker 任务」共享组）
- Waker 展示统一「头像 + 名称」：Waker 管理、@Waker 管理候选池、任务看板行（头像 + 标题，名称入副行）、项目表单「可用 Waker」多选等均使用头像（无头像回退 emoji）+ 名称；纯文本无头像位的场景（钉钉回执卡片标题、会话侧栏标题、看板副行名称）仅保留名称或 Waker emoji 徽标

## 架构

```
钉钉云 (Stream WS) ←→ .spike/bridge/bridge.js（零依赖 Node 桥接，stdout/stdin JSONL）
                              ↕
               dsh-waker 插件 Host 半（队列/状态机/映射/看板 RPC）
                              ↕ storageDomain(dsh_waker) + agents.create + session/event firehose
               DSH Agent 会话（当前会话 preset，default model 路由）
                              ↕
               Client 半（settings.section：任务看板 / IM 管理（机器人集成卡），dsw-alias token 主题）
```

关键决策见 `.doc/mvp-dev-plan.md` TD-1 ~ TD-11；已知行为细节：

- 回复双通道：sessionWebhook 优先（随消息下发，有效期约 90 分钟，桥接落盘 `webhooks.json` v5 恢复，附 conversationType/senderStaffId）；失败/过期（errcode 300001）/缺失时自动切换开放平台「机器人主动发送」API（凭据自取 accessToken，群 `POST /v1.0/robot/groupMessages/send`、单聊 `POST /v1.0/robot/privateChatMessages/send`，msgKey sampleText/sampleMarkdown/sampleActionCard 映射，实测群聊 200）——回复不再受 webhook 90 分钟时效约束；短通知 `{msgtype:'text'}`；任务回执 `{msgtype:'actionCard', actionCard:{title, text}}`（无按钮）；`markdown`/`aicard`（开放平台 AI 卡片 API）作为可选 format 保留
- 回复上限 3000 字/条；20 条/分钟/聊天，超限节流合并
- 能力治理机制：`ToolRuntime.restrict` 只作用于 global 层工具（MCP），preset 层内置工具经生成式专属预设裁剪；生成预设的组块 YAML 以发行版 standard 预设为基线内嵌为模板（头部注释注明基线来源），DSH 升级若 standard 结构变化需同步模板，生成后即时 `agentPresets.resolve` 验证、失败自动删除目录回退 standard，不阻塞投递
- 桥接诊断：`GET /health`、`POST /rpc`（需 `DTW_BRIDGE_TOKEN`），日志落 `bridge/diag.log`（随安装目录）

## 已知问题 / 限制

- sessionWebhook 过期（该聊天约 90 分钟无新消息）不再导致回复失败：桥接检测到 errcode 300001 自动清除失效缓存并当轮切换主动发送 API 投递，下一条 @消息 自动恢复 webhook 通道；仅当机器人凭据同时不可用时才会投递失败
- 「已完成」≠ 业务验收：状态只代表运行结束，产物需人工检查
- 长任务超时仅提醒（默认 30 分钟），不自动终止
- 单机单用户设计；多群共享同一并发池
