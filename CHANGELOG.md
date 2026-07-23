# Changelog

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
