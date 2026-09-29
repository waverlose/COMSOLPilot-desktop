# COMSOLPilot Desktop

COMSOLPilot Desktop 是一个面向 COMSOL Multiphysics 的桌面工具。它把 COMSOL 服务、运行环境和 MCP 客户端连接集中到一个简洁的工作台里，让你可以从客户端对话中驱动 COMSOL 建模。

## 主要功能

- 自动识别本机 COMSOL 安装和版本
- 自动查找并复用已有 Python 环境
- 一键启动、停止和重启 COMSOL Server
- 支持 GUI 模式和无界面服务模式
- 为常用客户端生成或直接写入 MCP 配置
- 备份原配置后再写入，保留其它 MCP 配置
- 测试客户端连接并查看实际可用工具
- 查看本地服务输出和 COMSOL 服务端日志
- 系统托盘驻留，关闭窗口后仍可保持服务运行

## 使用流程

1. 第一次启动时完成 COMSOL、运行环境和客户端配置。
2. 回到主页，启动 COMSOL Server。
3. 在“客户端”页面选择客户端，点击“直接写入配置”。
4. 重启或重新加载客户端，然后在新对话中使用 COMSOL 工具。

之后日常使用只需要打开软件并启动服务。详细设置、客户端管理和日志可以从侧栏进入。

## 支持的客户端

目前支持 WorkBuddy、Claude Code、Claude Desktop、Gemini CLI、Cursor、Windsurf、OpenCode、Codex 和 DeepSeek 等客户端。

每个客户端使用自己的配置格式。软件只写入 `comsolpilot` 条目，不会覆盖其它 MCP；写入前会创建 `.bak` 备份。

## 系统要求

- Windows 10/11 x64
- 已安装 COMSOL Multiphysics
- 首次配置时准备可用的 Python 环境，软件会优先复用已有环境

## 下载

前往 GitHub 的 [Releases](https://github.com/waverlose/COMSOLPilot-desktop/releases) 下载 Windows 安装包。

## 相关项目

COMSOLPilot Desktop 使用 [COMSOLPilot](https://github.com/waverlose/COMSOLPilot) 作为建模和 MCP 能力核心。

## 反馈

欢迎在 [Issues](https://github.com/waverlose/COMSOLPilot-desktop/issues) 提交问题和使用建议。

## 最后

可以提交反馈，我将尽快完善

