# 神盾 Aegis (Electron 版)

**这是神盾的「发布版」** —— 面向最终用户的日常使用版本，UI 最完整、跨平台三平台出包。
四个发行形态（Electron 发布版 / Python 性能版 / 源码调试版 / Web 服务器版）的定位见
`C:\dev\aegis\docs\versions.md`。

与 Tauri 版（`C:\dev\aegis2`）**同一个 UI 设计稿、同一套加密线格式（分享包互通）**。
功能面已对齐，但**库文件格式仍不互通**（见下「与 Python 版的差异」）。技术点基线见 [docs/TECH_POINTS.md](docs/TECH_POINTS.md)。

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

### 主密码级操作（破坏性由低到高）

| 能力 | 数据结局 | 确认门槛 |
|---|---|---|
| **修改主密码** | 条目密文**一条不动**, 只换包裹 DEK 的那一层 | 旧密码 + 新密码双输, 走真实的 Argon2id 校验 |
| **清空全部条目** | 条目没了, **主密码不变** | 输入真主密码（服务端重新派生校验, 不是比对字符串） |
| **重置密码库** | 条目 + 主密码**都换**（新 DEK, 旧密文在数学上作废） | 手打「重置」二字 + 默认保留旧库 `.bak` |

零知识加密没有后门, 所以「忘记主密码」的唯一出路是重置 —— 解锁页的「忘记主密码？」直达。

### 数据安全网

| 能力 | 说明 |
|---|---|
| **单实例保护** | `requestSingleInstanceLock()`; 第二次双击只把已有窗口提到面前, 不会再起第二个进程 |
| **原子写 + 库文件快照** | 每次落盘走 tmp + `renameSync`; 改前先把旧库留一份到 `backups/`, 滚动保留 10 份, 可从设置页一键回滚 |
| **条目级历史版本** | 核心字段(标题/用户名/密码/网址/备注)变动时留旧值, 每条最多 20 版; 随条目一起加密, 可回滚 |
| **加密分享包** | 选中若干条 → 独立口令打包成密文文件（明文只留标题/条数给接收方辨认）; 线格式与 Python 版**双向互通** |
| **系统托盘** | 可选「关闭窗口时最小化到托盘」; 托盘菜单: 显示主窗口 / 锁定密码库 / 退出神盾 |
| **设置页** | 安全 / 生成器默认值 / 外观 / 数据(含快照列表) / 关于; 存 `aegis.settings.json`(不含密钥) |

### 与 Python 版（`C:\dev\aegis`）的差异

- **库文件不互通**：Python 版 header 用 `slots` 数组，Electron 版是扁平的 `kdf_salt` / `dek_nonce` / `wrapped_dek`。
  迁移走**明文导入导出**（神盾可移植 JSON）或**加密分享包**。
- **分享包互通**：`aegis-share v1`，`b64(nonce‖ct‖tag)` 合并布局 + AAD_DEK=`aegis/v1/dek` + AAD=`{id}|{type}`，
  KDF 固定 `t=3, m=65536, p=1`（注意库内是 p=4）。互通性有测试钉住：`testdata/share-from-python.json` 是
  Python 版真导出的夹具，`tests/share.test.ts` 用它做跨语言解密。

演示数据: `npx tsx scripts/seed-health.ts`（主密码 `ctooctoo`，会往库里灌一批带健康问题的条目）。

测试: `npm test`（加密核心 / 库操作 / 分享包 / TOTP / 健康 / HIBP / 导入导出 / 设置，共 **340** 项断言）。

界面冒烟与截图（`npm test` 碰不到「窗口能不能开起来」「两个实例会不会同时跑」）：

```bash
npm run seed:visual -- "$TEMP/aegis-vis"    # 造一份内容可预期的演示库 (主密码 visual-check-123)
npm run smoke                       # 启动冒烟 + 单实例保护实证 + 托盘图标是否加载成功
npm run smoke -- --exe C:\app\aegis\AegisNext.exe   # 直接冒烟打包产物 (推荐: 打包漏文件只有跑真 exe 才发现)
npm run smoke -- --hold 60          # 起一个实例保活 60 秒, 打印 PID, 供抓图/肉眼看
npm run shot:ui -- --user-data-dir "$TEMP/aegis-vis" --password visual-check-123 [--exe <打包产物>]
                                    # 走 CDP 点着截: 解锁页/重置/历史/分享/设置页, 顺带探针查弹窗按钮够不够得着
npm run list:asar                   # 直接翻 app.asar 目录表, 核对 build/icon.png 等关键文件进没进去
```

`shot:ui` 用 CDP（`--remote-debugging-port` + Node 内置 `WebSocket`）而不是抓窗口，
所以能真的点击、能拿渲染进程的精确像素，也不受窗口被遮挡/最小化影响。
它救过一次场：新增的「重置主密码」「导出加密分享包」两个弹窗比视口高，
底部按钮滚不到 —— 普通截图看不出来。

## 结构（electron-vite 标准）

```
src/main/       主进程 (Node 能力: 加密/存储/文件, 对应 Rust 侧职责)
src/preload/    预加载桥 (contextBridge, 唯一 IPC 入口)
src/renderer/   React 前端 (与 Tauri 版同 token)
src/core/       加密核心 + 业务规则 (health/hibp/portable/prefs/...)
```

安全约定沿用：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，渲染进程永远摸不到 Node API，全部走 preload 白名单 —— 对密码管理器是硬要求。

细节与各家格式规格见 [docs/OPENSOURCE_FEATURES.md](docs/OPENSOURCE_FEATURES.md)，
Electron 版与 Python 版的功能逐项对照见 [docs/feature-gap-vs-python.md](docs/feature-gap-vs-python.md)。

## 质量门与 CI/CD

一条命令跑完所有本地检查（**推代码前先跑它，和 CI 跑的是同一套**）：

```bash
npm run ci
# = tsc --noEmit                     类型
#   scripts/check-renderer-purity.ts  渲染层零 Node API（含传递依赖）
#   scripts/check-package-assets.ts   打包资源齐备且已进版本库
#   npm test                          340 项断言: 加密核心 / 库操作 / 分享包 / TOTP / 健康 / HIBP / 导入导出 / 设置
```

两条流水线在 `.github/workflows/`：

| 流水线 | 触发 | 干什么 |
|---|---|---|
| `ci.yml` | 任何 push / PR | ubuntu + windows 双平台跑上面的质量门，再 `electron-vite build` 并校验 `out/` 三件套结构；测试结果写进 Actions 摘要 |
| `release.yml` | 推 `v*` tag，或手动 Run workflow | 校验 tag 与 `package.json` 版本一致 → 三平台**原生**打包（win NSIS / mac dmg arm64+x64 / linux deb+AppImage）→ 产物自检 → 生成 `SHA256SUMS.txt` → 发 GitHub Release |

```bash
# 发版
npm version patch        # 改 package.json 版本 + 打 tag（记得 tag 必须是 v0.1.1 这种形式）
git push --follow-tags
```

手动跑 `release.yml` 默认**只出包不发版**，勾上 `publish` 才发。macOS 签名/公证需要仓库 Secrets：
`CSC_LINK` / `CSC_KEY_PASSWORD`（Apple 证书）+ `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`；
没配就自动跳过签名，出未签名 dmg。Windows 代码签名走 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`。

### 踩过的坑（别再踩）

- **`build/icon.png` 必须提交**。它是 electron-builder 生成 `.ico`/`.icns` 的唯一来源，靠
  `scripts/gen_pack_icon.py` 生成（依赖本机 PySide6，CI 重建不了）。它曾被 `.gitignore` 忽略 ——
  本地打包正常，CI 干净检出后图标没了，electron-builder **不报错**，只是静默换成默认 Electron 图标。
  现在 `.gitignore` 里写了警告，`check:assets` 也会专门查它有没有被跟踪。
- **渲染层零 Node API 是硬约束**，靠人记不住，所以 `check:purity` 会沿 import 链做传递闭包检查：
  `src/core/` 里怎么拆文件都不用改规则，引入含 `node:*` 的模块立刻报完整链路。
- **`testdata/*.csv` 固定用 LF**（`.gitattributes`）。本机 `core.autocrlf=true`，不锁的话 Windows
  检出变 CRLF，而 `tests/portable.test.ts` 直接读这份 fixture。
- **打包环境**：`.npmrc` 指向 npmmirror（electron / electron-builder 二进制 + npm 包）。
  CI 上同样生效；若某天镜像挂了，删掉 `.npmrc` 里对应行即可回退官方源。
- **托盘图标要显式写进 `build.files`**。`electron-builder` 的默认 glob **不含 `build/`**，
  开发时托盘正常、打包后托盘空白 —— 且不报错。和 `build/icon.png` 是同一类坑的两副面孔。
- **有些 shell 会注入 `ELECTRON_RUN_AS_NODE=1`**，那样 `electron.exe` 被当纯 Node 跑，
  `require("electron")` 返回**字符串路径**而不是模块，应用第一行就崩（报错还很有迷惑性：
  `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`）。
  `scripts/` 里的两个脚本都会显式删掉它。
- **别从 shell 直接起 `electron.exe` 做后台冒烟**：父 shell 一退，GUI 子进程跟着被回收（退出码 0、无日志）。
  要「后台挂一个窗口」必须让一个 Node 进程撑着（`npm run smoke` / `npm run shot:ui` 就是这么做的）。
- **弹窗别用 `max-height: 82vh + overflow-y: auto` 自己滚**。那样内容一超高，底部那两个按钮
  （「确认重置」「导出 N 条」）就被压在裁切线以下 —— 而它们恰恰是弹窗唯一的出口。
  现在由遮罩层 `overflow-y: auto` + 弹窗 `margin: auto` 承担：矮的居中，高的整页滚，顶和底都够得着。
  `npm run shot:ui` 里有探针专门钉这件事。

