# Oops Editor

A cross-platform desktop code editor built with **Tauri v2 + React + Monaco Editor**.

[中文版](./README.md)

## Features

- **File Explorer** -- Tree-based directory browsing with file CRUD, rename, and pin support
- **Multi-tab Editing** -- Monaco Editor (VS Code engine) with split-pane support
- **Syntax Highlighting** -- Built-in highlighting for dozens of languages
- **Integrated Terminal** -- xterm terminal with multi-tab support, follows workspace directory
- **Git Integration** -- View branches, staged/unstaged/untracked files, commit changes
- **Image Preview** -- Inline preview with zoom support
- **Word Document Preview** -- Preview .docx/.docm/.dotx formats
- **Markdown Preview** -- Live rendering with syntax highlighting
- **Hex Viewer** -- Hex dump for binary files
- **Clipboard Table** -- Paste table data auto-converts to Markdown tables
- **Auto Save** -- Automatic content saving to prevent data loss
- **Settings Panel** -- Customize font size, tab indentation, max open tabs, and more
- **Custom Monaco Theme** -- Warm terracotta color scheme
- **Workspace Persistence** -- Automatically restores tabs, folder state, and pinned items

## Tech Stack

| Layer         | Technology                    |
| ------------- | ----------------------------- |
| Frontend      | React 19 + TypeScript         |
| Editor Engine | Monaco Editor (VS Code core)  |
| Desktop       | Tauri v2 (Rust backend)       |
| Styling       | Tailwind CSS v4               |
| State Mgmt    | Zustand                       |
| Terminal      | xterm.js + @xterm/addon-fit   |
| Build Tool    | Vite                          |

## Quick Start

```bash
# Install dependencies
pnpm install

# Desktop development mode
pnpm tdev

# Frontend-only development (browser preview)
pnpm dev

# Build
pnpm tbuild
```

> Note: Desktop build requires [Rust](https://rustup.rs/) and the system's Tauri compilation environment.

## License

MIT
