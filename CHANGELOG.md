# Changelog

## [Unreleased]

### Changed
- 会话改用应用私有目录（`chat-sessions/`）存储，不再写进工作区 `.oops/sessions/`；
  文件名是时间戳 + 随机后缀，会话 id 存在内容里，首次启动自动把旧工作区会话搬进私有目录
- 会话文件改为**事件日志追加写**（`session` / `title` / `message` / `message-edit` /
  `message-favorite` / `message-delete`），读取时按序 fold；坏行与杂物文件跳过，
  一个坏文件不再让整个会话列表或搜索失败
- 会话列表改用 `chat_index` 派生索引（按 mtime + size 增量刷新，索引丢失只影响速度）
- 侧边栏新增虚拟「会话」分组（新建 / 重命名 / 删除 / 导出），文件树不再展示 `.oops`

## [0.1.41] - 2026-08-07

### Fixed
- 优化新建 Markdown 文件的命名、语言识别与图片附件目录行为
- 修复 Tauri 开发环境下 Material Icon SVG 动态模块加载失败

## [0.1.40] - 2026-08-03

### Added
- 图片插入时自动转换路径并刷新侧边栏

### Fixed
- 侧边栏缩进引导线在最后一行正确结束

## [0.1.39] - 2026-07-30

### Added
- 大量新功能（工具栏、窗口控制、标签页管理、侧边栏等增强）

## [0.1.38] - 2026-07-30

### Added
- Markdown 图片显示

## [0.1.37] - 2026-07-28

### Added
- 历史文件功能

## [0.1.34] - 2026-07-27

### Added
- 侧边栏文件树 VS Code 风格缩进引导线

## [0.1.33] - 2026-07-27

### Added
- 侧边栏文件树缩进引导线（分支发布版本）

## [0.1.32] - 2026-07-24

### Added
- 多项功能改动
- 优化 Markdown 前端渲染

### Changed
- 更新 README

## [0.1.30] - 2026-07-24

### Fixed
- 修复 Vite 构建内存溢出（懒加载 material-icon-theme SVG）

## [0.1.29] - 2026-07-24

### Changed
- 版本号升至 0.1.29，Release workflow 仅匹配 v 前缀 tag
- 对齐 OopsLauncher 的 pnpm 构建模式，新增 workflow_dispatch 手动触发
- 新增 .nvmrc 与 .editorconfig 工程配置

## [0.1.28] - 2026-07-23

### Changed
- Release workflow 改为只构建 Windows 版
- 新增 tag push 触发发布流程

## [0.1.27] - 2025-07-23

### Added
- GitHub Actions release workflow: Windows (MSI) + macOS (DMG) auto-build on tag push
- Build optimization configs for Tauri production builds

### Changed
- Refactored build system following OopsLauncher CI/CD pattern
- Updated package.json with full set of build scripts
- Updated tauri.conf.json with webview install mode and macOS config

### Fixed
- Rust compilation error in UTF-16 decoder (is_multiple_of argument type)

## [0.1.26] - 2025-07-21

### Added
- Git panel with full Git integration
- Terminal with xterm.js
- Settings persistence
- SQLite viewer
- .doc to .docx converter

### Changed
- Upgraded to Tauri v2
- Full project management module rewrite
