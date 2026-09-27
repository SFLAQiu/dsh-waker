# 架构（供维护者与贡献者）

> 用户请看 [README.md](README.md)。

## 总览

```
钉钉云 (Stream WS) ←→ .spike/bridge/bridge.js（零依赖 Node 桥接，stdout/stdin JSONL）
                              ↕
               dsh-waker 插件 Host 半（队列/状态机/映射/看板 RPC）
                              ↕ storageDomain(dsh_waker) + agents.create + session/event firehose
               DSH Agent 会话（当前会话 preset，default model 路由）
                              ↕
               Client 半（settings.section：任务看板 / IM 管理（机器人集成卡），dsw-alias token 主题）
```

插件为 npm 双入口：Host 半 + Client 半 + 钉钉 Stream 桥接辅助进程，零外部 npm 依赖。

关键决策见 `.doc/mvp-dev-plan.md` TD-1 ~ TD-11。

## 目录结构

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

## 关键行为细节

- 回复双通道：sessionWebhook 优先（随消息下发，有效期约 90 分钟，桥接落盘 `webhooks.json` v5 恢复，附 conversationType/senderStaffId）；失败/过期（errcode 300001）/缺失时自动切换开放平台「机器人主动发送」API（凭据自取 accessToken，群 `POST /v1.0/robot/groupMessages/send`、单聊 `POST /v1.0/robot/privateChatMessages/send`，msgKey sampleText/sampleMarkdown/sampleActionCard 映射，实测群聊 200）——回复不再受 webhook 90 分钟时效约束；短通知 `{msgtype:'text'}`；任务回执 `{msgtype:'actionCard', actionCard:{title, text}}`（无按钮）；`markdown`/`aicard`（开放平台 AI 卡片 API）作为可选 format 保留
- 回复上限 3000 字/条；20 条/分钟/聊天，超限节流合并
- 能力治理机制：`ToolRuntime.restrict` 只作用于 global 层工具（MCP），preset 层内置工具经生成式专属预设裁剪；生成预设的组块 YAML 以发行版 standard 预设为基线内嵌为模板（头部注释注明基线来源），DSH 升级若 standard 结构变化需同步模板，生成后即时 `agentPresets.resolve` 验证、失败自动删除目录回退 standard，不阻塞投递
- 桥接诊断：`GET /health`、`POST /rpc`（需 `DTW_BRIDGE_TOKEN`），日志落 `bridge/diag.log`（随安装目录）
- 钉钉未开放机器人消息表态 Reaction API（新旧网关 7 个候选端点探测均 404），「收到任务」用极短文本秒回近似
- ActionCard 回执实测 text 渲染子集最全：表格、代码块正常渲染，单换行即生效；不带 singleTitle/singleURL/btns 则无底部跳转按钮，实测 errcode 0
- 群内问答桥：会话内 `ask_user_question` 挂起的问题自动转达钉钉群（带编号选项），群里的下一条 @回复 作为答案回注工具结果，会话自主续跑（官方 agent 作用域 `user-questions/request` waterfall 自建应答器，先于 GUI 客户端命中；取消任务经 abort 信号解除挂起）
- 会话窗口按天滚动：每个群每天一个会话窗口（跨天自动新开，旧窗在跑任务自然跑完并照常回执，不强杀），同天内 @ 追问全部进同一会话（nearest step boundary 续聊，上下文全量共享）；「新任务：」前缀可在当天强制另开新窗；窗口命名 `[Waker][emoji Waker名] MMDD 首条任务摘要`；跨天上下文不携带，挂起中的提问跨天仍优先应答
- 会话窗口挂接：项目任务按 realpath 化的项目路径自动注册同名工作区组并挂入；非项目任务挂 Waker 分组——修复两类「工作区里看不到会话窗口」：① 项目权限上线后项目会话不挂接；② macOS 大小写不敏感卷上 fs realpath 会把路径改写为磁盘登记大小写（/go→/Go），注册/挂接未归一导致校验必败（attachSession 静默吞错）；启动时自动回溯挂接历史会话
- Waker 能力治理：安装收敛在 DSH 全局（Skills 目录 / MCP 设置），Waker 只做引用式选用；不配置 = 继承 standard 全量；配置后保存即生成专属预设 `~/.dsh/.agent-presets/wkr-<wakerId>/`（必选底座恒装：persona、agent-instructions、compaction 压缩保护、ask-user 问答桥、fs/bash 执行底座）；MCP 白名单经会话级 `ToolRuntime.restrict`（仅作用于该会话 global 层 `mcp__*` 工具，与现存工具名求交，失效引用自动跳过）；技能白名单经聚合目录符号链接引用全局安装（纯引用零复制）；修改无需重启，对新建会话生效；删除自定义 Waker 时其生成目录同步清理；启动时自动自愈
- 独立 Waker 工作区：每个 Waker 以其名称命名子目录（`<base>/<Waker 名>`，base 优先 `config.cwd`，默认 `~/.dsh/waker-workspace`；无 Waker 的任务归入「其他」），并自动在侧栏创建同名工作区分组；平台约束「会话真实 cwd 必须等于工作区路径」决定项目会话物理上归项目组；Waker 分组只收 cwd=Waker 执行目录的会话；启动时自动回溯挂接历史会话
- 项目权限强制约束：新任务会话的根目录（= 平台沙箱唯一可写根）只能落在该 Waker 已授权且就绪的项目目录或其 Waker 工作区内，越权写入被平台沙箱物理拒绝；会话创建时自动钉定 `workspace-write` 沙箱与「审批永不弹窗」（升级请求直接拒绝）；任务显式点名项目或 Waker 仅有一个就绪项目时会话根落该项目（直接可写），否则落 Waker 工作区（各项目只读，需修改时点名项目开启对应会话）；local 项目选根前校验目录真实存在；映射记录 `projectId`/`projectRoot` 供追溯

## 已知问题 / 限制

- sessionWebhook 过期（该聊天约 90 分钟无新消息）不再导致回复失败：桥接检测到 errcode 300001 自动清除失效缓存并当轮切换主动发送 API 投递，下一条 @消息 自动恢复 webhook 通道；仅当机器人凭据同时不可用时才会投递失败
- 「已完成」≠ 业务验收：状态只代表运行结束，产物需人工检查
- 长任务超时仅提醒（默认 30 分钟），不自动终止
- 单机单用户设计；多群共享同一并发池

## 开发（热重启循环）

本仓库即运行载体：插件以 link 方式装进 web profile，改代码即刻生效。

```bash
# 一次性安装（已装可跳过）
dsh plugin --profile web add /path/to/dsh-waker

# 开发模式：构建 → 启动 dsh web → 监视文件保存自动构建+热重启
npm run dev
```

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

### 发布（维护者）

```bash
# 1. 构建产物
node scripts/build.mjs
# 2. 发 npm（首次发布前 npm publish 需账号登录）
npm publish
```

版本变更请同步修改 `package.json` 的 `version`。
