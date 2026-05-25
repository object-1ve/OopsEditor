[OPEN] window-not-showing

# Debug Session

- Session ID: `window-not-showing`
- Symptom: 应用启动后托盘存在，但主界面显示不出来或像没显示。
- Expected: 启动后主窗口应可见并正常渲染编辑器界面。

# Hypotheses

- A: 主窗口已创建，但窗口位置或尺寸恢复到屏幕外。
- B: 前端启动阶段抛错，导致根组件未完成渲染。
- C: 透明窗口已显示，但首屏未绘制导致视觉上像空白。
- D: 窗口启动后被隐藏或最小化，只剩托盘图标。

# Plan

- 启动调试服务器采集运行时日志。
- 在 Rust 启动链和前端入口增加最小埋点。
- 复现一次，依据日志排除或确认假设。
- 在证据明确后再做最小修复。

# Evidence

- `A` confirmed:
  - `settings loaded` 显示保存的 `windowSize` 为 `143x17`、`windowPosition` 为 `(-21326, -21332)`。
  - `window state after restore` 显示窗口 `isVisible: true` 且 `isMinimized: false`，但实际尺寸仅 `215x26`，坐标为大负值。
- `B` rejected as primary cause:
  - `main.tsx root check` 显示根节点存在，`setupApp start` 已执行。
- `C` rejected:
  - 问题不是透明窗口无内容，而是窗口被恢复到几乎不可见的尺寸和屏幕外坐标。
- `D` rejected as primary cause:
  - 窗口并未最小化或隐藏。

# Fix

- 对恢复的窗口尺寸和坐标增加有效性校验。
- 若尺寸异常，回退为 `1200x800`。
- 若坐标异常，回退为 `100,100`。
- 已同步修正当前用户配置文件中的坏坐标，避免旧脏数据继续生效。
