---
type: mixed
density: minimal
style: sketch-notes
palette: macaron
language: zh
image_count: 2
---

## Illustration 1
**Position**: 文档开头（替换现有 `resource/dsh-waker-introduction.png` 引用）
**Purpose**: 一图讲清核心工作流：群聊 @机器人 → 匹配 Waker → 执行任务 → 结果回群
**Visual Content**: 左到右流程：用户在群聊发「@机器人 帮我看看仓库结构」→ 机器人秒回「收到了」→ 排队/执行（最多并发 2，超限排队）→ 结果回执发回群聊
**Filename**: resource/dsh-waker-introduction.png

## Illustration 2
**Position**: 「功能」小节的「任务看板」条目之后
**Purpose**: 可视化任务看板的状态机与流转
**Visual Content**: 看板六状态：排队中 → 运行中 → 需要操作（审批/答疑，虚线回到运行中）→ 失败（可重试）→ 已取消 / 已完成
**Filename**: resource/dsh-waker-kanban.png
