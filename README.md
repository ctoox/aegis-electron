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

## 功能

| 模块 | 说明 |
|---|---|
| 密码库 | Argon2id(m=64MiB,t=3,p=4) → KEK → AES-256-GCM 信封加密, AAD=`id\|type` |
| 三栏界面 | 分组 / 列表 / 详情, 自绘标题栏, 明暗主题 + 液态玻璃三层降级 |
| 生成器 | 参数化密码 + 中文词组口令, 约束硬校验 |
| TOTP | RFC 6238, 环形倒计时 |
| 命令面板 | `Ctrl/Cmd+K` 全局搜索 + 动作 |
| **密码健康** | 弱密码 / 重复使用 / 明文 HTTP / 缺两步验证 + **HIBP 泄露检测**(k-匿名, 只发 SHA-1 前 5 位) |
| **自动锁定** | 闲置 N 分钟 / 失焦即锁; 剪贴板 N 秒自清(内容被改动则不动), 锁库顺手清剪贴板 |
| **导入导出** | Bitwarden JSON/CSV · KeePass 2 XML/CSV · LastPass CSV · Chrome CSV · 神盾 JSON/CSV; 导入先预览可跳过重复 |
| **设置页** | 安全 / 生成器默认值 / 外观 / 数据 / 关于; 存 `aegis.settings.json`(不含密钥) |

演示数据: `npx tsx scripts/seed-health.ts`（主密码 `ctooctoo`，会往库里灌一批带健康问题的条目）。
测试: `npm test`（加密核心 / TOTP / 健康 / HIBP / 导入导出 / 设置，共 233 项断言）。

## 结构（electron-vite 标准）

```
src/main/       主进程 (Node 能力: 加密/存储/文件, 对应 Rust 侧职责)
src/preload/    预加载桥 (contextBridge, 唯一 IPC 入口)
src/renderer/   React 前端 (与 Tauri 版同 token)
src/core/       加密核心 + 业务规则 (health/hibp/portable/prefs/...)
```

安全约定沿用：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，渲染进程永远摸不到 Node API，全部走 preload 白名单 —— 对密码管理器是硬要求。

## 功能

- 三栏主界面 / 命令面板 (Ctrl+K) / TOTP / 密码字符着色 / 明暗主题 / 液态玻璃
- **密码健康检查**：弱密码 · 重复使用 · 明文 HTTP · 缺两步验证（本地）＋ HIBP 泄露检测（k-匿名，只发 SHA-1 前 5 位）
- **自动锁定**：闲置超时 / 失焦即锁；**剪贴板自清**：复制后倒计时清空，且内容被改动时不去动它
- **导入导出**：Bitwarden (JSON/CSV)、KeePass 2 (XML/CSV)、LastPass CSV、Chrome/Edge CSV、神盾可移植 JSON
- **设置页**：安全 / 生成器默认值 / 外观 / 数据 / 关于（KDF 参数只读）

细节与各家格式规格见 [docs/OPENSOURCE_FEATURES.md](docs/OPENSOURCE_FEATURES.md)。

## 测试

```bash
npm test     # 233 项: 加密核心 / TOTP / 健康检查 / HIBP / 导入导出 / 设置
```

演示数据：`npx tsx scripts/seed-health.ts`（主密码 `ctooctoo`）
