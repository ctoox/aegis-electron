# 神盾 Aegis (Electron 版)

与 Tauri 版（`C:\dev\aegis2`）**完全同 UI 同功能目标**，专供技术选型对比。技术点基线见 [docs/TECH_POINTS.md](docs/TECH_POINTS.md)。

## 运行

```bash
cd C:\dev\aegis-electron
npm install        # 首次 (会下载 Electron 二进制 ~100MB)
npm run dev        # 开发
npm run build      # 构建 out/
```

## 对比要点（跑起来后重点看）

| 维度 | Tauri (`aegis2`) | Electron (本项目) |
|---|---|---|
| 渲染引擎 | 系统 WebView2 | 自带 Chromium |
| 安装包体积 | ~5MB | ~90-150MB |
| 空载内存 | ~80-150MB | ~200-350MB |
| 启动速度 | 快 | 中 |
| 字体渲染 | WebView2 (跟随系统) | Chromium (各平台一致) |
| 后端语言 | Rust (加密生态强) | Node (与前端同语言) |

## 结构（electron-vite 标准）

```
src/main/       主进程 (Node 能力: 加密/存储/文件, 对应 Rust 侧职责)
src/preload/    预加载桥 (contextBridge, 唯一 IPC 入口)
src/renderer/   React 前端 (与 Tauri 版同 token)
```

安全约定沿用：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，渲染进程永远摸不到 Node API，全部走 preload 白名单 —— 对密码管理器是硬要求。
