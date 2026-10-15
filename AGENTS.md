# AGENTS.md — dsh-waker

钉钉 ↔ DSH 桥接插件:群内 @机器人 即派活给 DSH Agent,进度与结果回流 IM。npm 双入口插件 + 钉钉 Stream 桥接辅助进程,零外部 npm 依赖。

## 环境速查

- 安装形态:本仓库以 link 方式装进 web profile(`~/.dsh/profiles/web/node_modules/dsh-waker` → 本目录),`dsh web` 直接加载**构建产物** `pkg/`,改源码必须先 build。
- 构建与热重载:`node scripts/build.mjs`(纯字符串拼接,无依赖);开发用 `node scripts/dev.mjs`(edit → build → T0 客户端刷新 / T1+ 重启 `dsh web`)。
- 模拟消息:`node scripts/sim.mjs "<任务>"`,仅 dev boot(`DSH_WAKER_DEV=1`)可用;生产构建不注册 `waker.injectEvent` RPC。
- RPC 端点:`POST /dsh-waker/api/rpc`,`{"method":"waker.xxx","args":{...}}`;方法清单在 `src/host-body.js` 搜 `rpcHandle('waker.`。

## 结构

- `src/host-body.js` — Host 半全部逻辑(约 3300 行的函数体):队列/状态机/会话映射/看板 RPC/能力治理/预设生成。异步函数 body,构建时包一层 `export default await body()`。
- `src/client-body.js` — Client 半(设置页 UI):任务看板、IM 管理、Waker/项目/能力编辑。
- `src/bridge.cjs` — 钉钉 Stream 桥接独立进程(零依赖 Node,CJS),经 stdout/stdin JSONL 与 Host 通信。
- `pkg/` — 构建产物,**不要手改**(build.mjs 从 src/ 重新生成;git 有追踪但仅作发布物)。
- `scripts/` — build.mjs / dev.mjs / sim.mjs;`examples/` — 使用与测试剧本;`resource/img` — 头像目录(经 `pkg/avatar-io.cjs` 子进程读写)。
- `package.json` 的 `dsh` 字段是 DSH 插件加载器消费的清单(`dsh.client` + `dsh.bundle.patch`);无 plugin.yaml。

## 关键约定

- **改 `src/` 后必须跑 build**,然后按 dev.mjs 的分层:只改 client → 浏览器强刷即可;改 host/bridge → 重启 `dsh web`。运行中的进程不会自动加载新产物——它在内存里持有旧代码,且可能在运行中用旧模板重写文件(如预设生成),改完及时重启。
- **生成式预设模板基线**:`src/host-body.js` 中 `WAKER_PRESET_YAML` 内嵌了 DSH 发行版 standard 预设(`config/agent-presets/standard/agent.cordis.yml`)的组块拷贝。DSH 升级若 standard 结构/插件 Config 契约变化,必须同步该模板——插件 Config 必填字段缺失会让任务投递失败(`preset "wkr-*" failed to mount`)。改模板后逐行对照各插件真实 Config schema 验证(路径 `~/.dsh/profiles/web/node_modules/@deepseek-ai/…/lib/index.js` 或 DSH 安装目录同款),用 `Config['~standard'].validate()` 走 cordis 同款校验路径。
- Host 半是 async function body 约定(`return { inject, apply }`),注入服务名见文件顶部 `inject` 数组;ctx 上可用的服务以该数组为准。
- 存储走 `ctx.storageDomain`(`dsh_waker` 域,表:mappings/config/queue/robots/wakers/bindings/projects);`table.entries()` 返回 iterator,统一数组化再用(见 `iterPairs`)。
- 凭据经 `ctx.credentials`(`DINGTALK_CLIENT_SECRET` / `DINGTALK_SECRET_<robotId>`);绝不硬编码本机路径,cwd 一律 `config.cwd` → 工作区注册表 → `DSH_WAKER_CWD` → `process.cwd()` 兜底。
- 沙箱事实:任务会话的唯一可写根 = 会话 cwd(项目权限强制约束),故投递前 `pickProjectRoot` 只允许授权且就绪的项目目录或 Waker 工作区;`realpath` 归一是 macOS 大小写不敏感卷上的硬要求(见 `realpathStr` 注释)。

## 钉钉对接事实(实测,勿凭文档想当然)

- 回复双通道:sessionWebhook(90 分钟时效,桥接落盘恢复)优先,过期/失败自动切开放平台主动发送 API;上限 3000 字/条、20 条/分钟/聊天。
- 群聊未 @ 机器人 → 完全静默;`conversationType` 2=群聊 1=单聊;回复引用消息有两种历史形状,解析见 `flattenDingText`/`textOfBotMsg` 注释。
- 表态 Reaction API 未开放(新旧网关均 404);ActionCard 的 text 渲染子集最全(表格/代码块可用)。
- 更多架构决策与已知限制见 `ARCHITECTURE.md`(TD-1~TD-11 决策记录在 `.doc/mvp-dev-plan.md`)。
