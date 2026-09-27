# 示例:注入模拟钉钉消息

前提:`npm run dev` 已启动(dev 模式自动带 `DSH_WAKER_DEV=1`)。

```bash
# 单条消息(新会话)
node scripts/sim.mjs "帮我看看当前仓库的结构,写一份摘要"

# 续聊既有会话(用 --list 查 conversationId)
node scripts/sim.mjs --list
node scripts/sim.mjs --conv cidOqsee0wjdpASAeZ2qOO37g== "继续刚才的任务"

# 多步剧本(间隔 1.2s)
node scripts/sim.mjs --script "新任务:整理 TODO" "第一个 TODO 是修编译警告" "汇总后输出"
```

注入的事件与桥接上报完全同构,走同一条 handleLine 管线(建映射 → 建会话 →
投递 → 排队 → 状态流转全真)。钉钉链路断开时回复会被跳过,不影响管线测试。
