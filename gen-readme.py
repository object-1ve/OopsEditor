import base64

content = """# Oops Editor

一款跨平台桌面代码编辑器，基于 **Tauri v2 + React + Monaco Editor** 构建。

[English Version](./README.en.md)

## 特性

- 文件浏览：树形目录浏览，支持文件固定常用目录
- 多标签编辑：基于 Monaco Editor（支持多标签页、分栏（左右分屏）编辑
- 语法高亮：内置数十种语言语法高亮
- 集成终端：内嵌 xterm 终端，支持多终端标签页，跟随工作目录
- Git 集成：查看分支、暂存/未暂存/未跟踪文件、提交更改
- 图片预览：内联预览，支持缩放
- Word 文档预览：预览 .docx/.docm/.dotx 等格式
- Markdown 预览：实时渲染 + 代码高亮：查看二进制文件的十六进制表示
- 剪贴板表格：粘贴表格数据自动转为 Markdown 表格
- 自动保存：防丢失，自动字体大小、Tab 缩进、最大打开标签数等
- 自定义 Monaco 主题：暖心陶土色系主题
- 工作区持久化：自动恢复上次打开的标签、目录## 技术栈

| 层         | 技术                              |
| ---------- | --------------------------------- |
| 前端框架   | React 19 + TypeScript             |
| 编辑器引擎 | Monaco Editor (VS Code 内核)      |
| 桌面框架   | Tauri v2 (Rust 后端)              |
| 样式       | Tailwind CSS v4                   |
| 状态管理   | Zustand                           |
| 终端       | xterm.js + @xterm/addon-fit       |
| 构建工具   | Vite                             ```bash
# 安装依赖
pnpm install

# 开发模式（桌面应用）
pnpm tdev

# 仅前端开发（浏览器预览）
pnpm dev

# 构建
pnpm tbuild
```

> 注意：桌面端需要安装 [Rust](https://rustup.rs对应的 Tauri 编译环境。

## 许可证

MIT
"""

with open('C:/object1ve/oopseditor/build-b64.py', 'w', encoding='utf-8') as f:
    f.write('import base64\n')
    f.write('b64 = "' + base64.b64encode(content.encode('utf-8')).decode() + '"\n')
    f.write('with open("C:/object1ve/oopseditor/README.md", "wb") as f:\n')
    f.write('    f.write(base64.b64decode(b64))\n')
    f.write('print("done")\n')

print("Script generated")
