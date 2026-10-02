# 开源参考与技术路线（2026-10-02 调研）

## 一、同类开源项目一览（可借鉴，不抄代码）

| 项目 | 技术栈 | 许可 | 值得借鉴的点 |
|---|---|---|---|
| **Bitwarden Desktop** [github](https://github.com/bitwarden/clients) | Electron + Angular + TS | GPL/AGPL | **三栏布局的事实标准**（分组 22% / 列表 28% / 详情余量）；SCSS 主题 map + `themify()` mixin 多主题；`FieldView` 打码/渐进披露模型；密码按字符类型着色（ColorPasswordPipe） |
| **KeeWeb** [github](https://github.com/keeweb/keeweb) | 纯 JS + Vue + Electron（WebCrypto/WASM 解密） | MIT | UI 精致度最高的开源密码管理器之一；浏览器版与桌面版同源；WebAssembly 做加密的早期范例 |
| **Padloc** [github](https://github.com/padloc/padloc) | TS + PWA + Electron | AGPL | 现代感最强的界面（自研组件体系）；本地模式 + 云同步双形态；端到端加密组织模型 |
| **KeePassXC** | C++ / Qt | GPL | 开源密码管理器的功能标杆：自动填充（Auto-Type）、TOTP、浏览器集成、KDBX 兼容 |
| **Latch** [github](https://github.com/parthashirolkar/latch) | **Tauri 2 + React + Rust** | MIT | 命令面板（Raycast 式）单窗口 UI；三层加密模式（主密码/OAuth/生物）；**30 分钟自动锁定 + 剪贴板 30s 自清**；HIBP k-匿名泄露检测；失败指数退避锁定 |
| **yapk-next** | **Tauri 2 + React 19 + Tailwind + rusqlite** | - | SQLite 存储 + 亮/暗/跟随系统主题；健康检查（弱密码/重复）；导入导出 |
| **VaultX** [案例文](http://skillnav.dev/articles/vaultx-build-password-manager-with-claude-code-in-19-hours) | Tauri 2 + React + SQLCipher | 开源 | 双层加密 + 内存密钥归零；全局快捷键搜索；恢复套件；**先写 CLAUDE.md / product-spec / design-spec 三份文档再动手**的工作法 |
| **Desktop-Password-Vault** | Tauri 2 + React + Tailwind | - | **严格 CSP + KDF 参数进 AAD** 加固细节；可选密钥文件作第二因子；多用户档案 |
| AliasVault / Passbolt / Vaultwarden | .NET+React / PHP / Rust | 混合 | 自托管形态参考（服务端不在本期范围） |

**结论**：*界面*看 Bitwarden（布局）+ Padloc/KeeWeb（观感）+ Latch（命令面板交互）；*安全实现*看 Latch + Desktop-Password-Vault（都是 Tauri+Rust，可直接对照 crate 用法）。

## 二、路线决策：一份前端，两种壳

**核心判断：前端（HTML/React）在 Electron 与 Tauri 之间是**可移植资产**——两个壳都只是「跑一个 web 前端 + 暴露 IPC」。所以我们现在的做法就是最优解：**

```
        ┌──────────────────────────────┐
        │   React + TS 前端（唯一一份）  │  ← 设计/交互全部在这里投入
        └──────────────┬───────────────┘
                       │ 只跨这一层：api.ts（适配器）
        ┌──────────────┴───────────────┐
        │  Electron 主进程 (Node)       │  现在：全平台交付（含 UOS）
        │  Tauri 主进程 (Rust)          │  将来：性能/体积版
        └──────────────────────────────┘
```

约束（必须守住，否则将来换壳会疼）：
1. 前端**零 Node API**（不用 fs/path/child_process），一切走 `api.*`；
2. 加密核心（`src/core/*`）与前端无耦合，接口形状在两边一致：
   - `hash-wasm` argon2id → Rust `argon2` crate
   - `node:crypto` AES-256-GCM → Rust `aes-gcm` crate
   - 库文件格式（`aegis-vault` JSON）**跨实现兼容**，换壳不换数据
3. 业务规则（生成器约束、强度阈值、健康分公式）写在核心层，前端不重复实现。

## 三、Python / HTML→Electron 两条路的取舍

| 路线 | 快 | 交付 | 结论 |
|---|---|---|---|
| **Python（PySide6/Qt）** | 原型最快，核心算法写起来爽 | PyInstaller 体积 100MB+、UOS 要带一堆 so、动效/自绘弱、Qt 商用授权要注意 | **仅适合核心算法原型**——而这部分我们已经有 Python 版了 |
| **HTML 画好 → 套 Electron** | 稍慢但开发体验最好（热重载） | 全平台一键出包 | **主线**，已验证 |
| HTML 画好 → 套 Tauri | 同前端 | 体积小、内存低 | **将来性能版**，前端零改动 |

即：**不是"HTML 转 Electron"，而是"HTML 本身就是应用，Electron/Tauri 只是它的壳"**。

## 四、UOS 上的现实（重要，推翻"Tauri 一定更小"的直觉）

- **UOS V20 / Deepin V20 基于 Debian 10**，源里**没有 webkit2gtk-4.1**（Ubuntu 22.04 / Debian 12 才有）→ **Tauri v2 原生跑不起来**（[deepin 论坛实测帖](https://bbs.deepin.org/post/298592)）。
- 社区解法是 AppImage 二进制修补 webkit2gtk 外挂打包，但作者实测：**打出来近 150MB，已超过 Electron**，且 mesa/glib 版本还会和 UOS 4.19 内核打架。
- Tauri 官方也要求：**用最老的基线系统（Ubuntu 22.04/Debian 12）+ Docker/CI 编译**，ARM AppImage 不支持交叉编译（需 ARM runner）。
- ⇒ **含 UOS 的多平台交付，Electron 是唯一省心解**；Tauri 留给"Windows/macOS/新 Linux"的性能版。

## 五、UI 重画计划（控件清单）

做法：**借鉴布局与交互，不复制代码**——所有控件用我们的 design token（Apple 风）重画，保证一套视觉语言。

| # | 控件 | 状态 | 参考 |
|---|---|---|---|
| 1 | 自绘标题栏 + 窗口键 | ✅ 已有 | VS Code |
| 2 | 三栏骨架（分组/列表/详情） | ✅ 已有 | Bitwarden 的比例（22/28/余量） |
| 3 | 条目行（头像/副标题/徽章/红点） | ✅ 已有 | 1Password 式首字母头像 |
| 4 | 字段卡（打码/眼睛/复制/生成） | ✅ 已有 | Bitwarden FieldView |
| 5 | 主密码门（创建/解锁/错误态） | ✅ 已有 | - |
| 6 | 参数化生成器弹窗 | ✅ 已有 | 对齐 Python 版 GeneratorDialog |
| 7 | **密码字符着色**（数字/符号不同色） | ⬜ 待做 | Bitwarden ColorPasswordPipe |
| 8 | **命令面板**（Ctrl+K 全局搜索+动作） | ⬜ 待做 | Latch / Raycast |
| 9 | **TOTP 卡片**（环形倒计时） | ⬜ 待做 | KeePassXC / Bitwarden |
| 10 | 健康检查页（弱/重复/泄露） | ⬜ 待做 | Latch HIBP k-匿名 |
| 11 | 明暗主题切换（跟随系统） | ⬜ 待做 | yapk-next / Bitwarden themify |
| 12 | 自动锁定 + 剪贴板自清提示 | ⬜ 待做 | Latch（30min / 30s） |
| 13 | 导入导出（CSV/KeePass/自有格式） | ⬜ 待做 | KeePassXC 兼容 |
| 14 | 设置页（KDF 参数/锁定策略/快捷键） | ⬜ 待做 | - |

## 六、Tauri 迁移清单（将来换壳时照此执行）

1. `npm create tauri-app` 或复用 `C:\dev\aegis2`，把本仓库 `src/renderer` + `src/core`（去掉 Node 依赖的部分）整体搬入前端；
2. `src/core/crypto.ts` → Rust：`argon2` + `aes-gcm` crate（参数保持一致：m=64MiB, t=3, p=4；AAD=`id|type`）；
3. `src/core/vault.ts` → Rust：库文件 JSON 结构不变，直接读现有 `aegis.vault.json`；
4. `api.ts` 一层替换（`window.api.x` → `invoke("x")`），其余前端代码不动；
5. 打包走 CI（ubuntu-22.04 基线 + Windows runner），产物 deb/AppImage/msi。
