# 平台构建与发行目标

本文说明：**在哪些平台上打包**、**打出来的包给哪些系统用**、以及国产操作系统（UOS / 麒麟 / 龙芯）和移动端的现状。

---

## 一、先分清两件事：构建平台 ≠ 目标平台

这是最容易混的一点：

| | 是什么 | 有哪些 |
|---|---|---|
| **构建平台**（CI 跑在哪） | GitHub 托管的 runner 镜像 | `ubuntu-*`、`windows-*`、`macos-*`，就这三类 |
| **目标平台**（包装给谁用） | 用户实际运行的系统 | Windows / macOS / 各种 Linux 发行版（含 UOS、麒麟…） |

**GitHub 没有 UOS / 麒麟的 runner，也不可能在 CI 里临时装一个。**
所以流水线里不会有 `runs-on: uos` 这种写法 —— 覆盖这些系统靠的是**选对包格式 + 选对构建基线**，
而不是给它们单独开 job。

## 二、产物矩阵

`.github/workflows/release.yml` 一次发版产出：

| 构建 runner | 产物 | 架构 | 谁用 |
|---|---|---|---|
| `windows-latest` | `AegisNext-Setup-*.exe`（NSIS） | x64 | Windows 10/11 x64 |
| `macos-14` | `*.dmg` | arm64 **与** x64 各一个 | Apple Silicon 与 Intel Mac |
| `ubuntu-22.04` | `*.AppImage`、`*.deb`、`*.rpm`、`*.tar.gz` | x86_64 | 桌面 Linux、UOS x86_64、麒麟 x86_64 |
| `ubuntu-22.04` | `*.AppImage`、`*.deb`、`*.rpm`、`*.tar.gz` | arm64 / aarch64 | 飞腾 / 鲲鹏等国产 ARM 整机 |
| `ubuntu-latest` | `SHA256SUMS.txt` | — | 全平台校验 |

### 包格式怎么选

| 格式 | 适用 | 优点 | 缺点 |
|---|---|---|---|
| **AppImage** | 几乎所有 Linux，**国产系统首选** | 单文件、免安装、不需要 root、不解析依赖 | 不自动装桌面图标/菜单项；Ubuntu 24.04 需要额外处理（见第六节） |
| **deb** | UOS、深度、银河麒麟桌面、Ubuntu、Debian | 有依赖声明、自动装图标菜单 | **依赖名对不上就装不上**（见第五节） |
| **rpm** | 中标麒麟、麒麟服务器版、RHEL/CentOS/openSUSE | 同上 | 同上 |
| **tar.gz** | 兜底 | 解压即用，零依赖 | 完全手动 |

## 三、国产系统对照表

| 系统 | 内核系 | glibc 基线 | 推荐包 | 备注 |
|---|---|---|---|---|
| **UOS V20 / 深之度 V20** | Debian 10 | 2.28 | `deb` → 装不上就 `AppImage` | 默认无 root，AppImage 更省事 |
| **银河麒麟 V10 桌面** | Debian / Ubuntu 系 | 2.28 ~ 2.31 | `deb` / `AppImage` | 常见于飞腾(ARM64)整机 → 用 arm64 包 |
| **中标麒麟 / 麒麟服务器** | RHEL / CentOS 系 | 2.17 ~ 2.28 | `rpm` | 老版本 glibc 偏低，见第四节 |
| **龙芯 3A5000/3A6000（麒麟桌面）** | LoongArch64 | — | **暂不支持**，见第八节 | Electron 官方无 loong64 预编译包 |

## 四、为什么这些系统能跑

关键在于：**Electron 的预编译二进制是基于 Ubuntu 20.04 构建的**，官方明确验证可在
**Debian 10 及更高版本**上运行 —— 也就是说最低 glibc 约 2.28。

而本项目**没有任何原生模块**（`build.npmRebuild = false`，依赖里没有 node-gyp / `.node` 文件），
所以应用自己的代码**不会引入比 Electron 更高的 glibc 要求**。结论：

> 在 ubuntu-22.04 上打出来的包，在 UOS V20 / Debian 10 上是能跑的 ——
> 因为包里的可执行文件是 Electron 自己的（Ubuntu 20.04 基线），不是 CI 机器上编出来的。

⚠️ **这条前提一旦被破坏就会失效**：如果将来引入原生模块（比如某个 npm 包带 `.node`），
它会用 CI 机器的 glibc 2.35 编译，那些老系统立刻就打不开了。要引原生模块前请先想清楚这件事。

## 五、装不上怎么办

`deb` / `rpm` 会声明依赖，目标系统缺包就装不上。Electron 的默认依赖是
`libgtk-3-0`、`libnotify4`、`libnss3`、`libxss1`、`libxtst6`、`xdg-utils`、
`libatspi2.0-0`、`libuuid1`、`libsecret-1-0`；`libappindicator3-1`（托盘）只是 **recommends**，
缺了不影响安装。

排查顺序：

```bash
# 1. 看看到底缺什么
sudo dpkg -i AegisNext_*.deb          # 报依赖错误
sudo apt-get -f install               # 尝试自动补齐

# 2. 补齐后直接装（推荐，能自动带依赖）
sudo apt install ./AegisNext_*.deb

# 3. 还是不行 → 别折腾了，用 AppImage
chmod +x AegisNext-*.AppImage
./AegisNext-*.AppImage
```

> 如果某个依赖在国产系统上叫别的名字（例如 `libappindicator3-1` 不存在），
> 改 `package.json` 的 `build.deb.depends` 即可；但更建议**引导用户用 AppImage**，
> 因为 AppImage 根本不解析依赖。

## 六、已知坑

### Ubuntu 24.04 的 AppArmor（重要）

Ubuntu 24.04 起默认**限制非特权用户命名空间**，Electron 的沙箱（userns）会被拦，
表现为 AppImage 双击没反应或报 sandbox 错误。三种处理，**按推荐度排序**：

1. **装 deb 而不是 AppImage** —— deb 会正确设置 `chrome-sandbox` 的 SUID 位，走的是另一条沙箱路径。
2. 让用户手动加 AppArmor profile（发行方提供 `.profile` 文件）。
3. 兜底：`./AegisNext-*.AppImage --no-sandbox` —— **但这会关掉渲染进程沙箱，密码管理器不该这么用**，只作最后手段并要明确告知用户。

### 不要把 `--no-sandbox` 写进 .desktop

写进去等于对所有用户默认关沙箱。宁可让极少数人看到报错，也不要默认降级安全。

### 托盘图标

Linux 下托盘依赖 `libappindicator`/`libayatana-appindicator` 与桌面环境支持。
GNOME 默认不显示托盘图标（需要 AppIndicator 扩展），**这是桌面环境的限制，不是应用 bug** ——
在 UOS / 麒麟自带桌面（DDE / UKUI）上通常正常。

## 七、自动更新的平台差异

| 平台 | 自动更新 | 说明 |
|---|---|---|
| Windows | ✅ | NSIS + `latest.yml` |
| macOS | ✅ | 但**必须签名 + 公证**，否则系统拒绝更新 |
| Linux **x86_64** | ✅ 仅 AppImage | electron-updater 在 Linux 上只支持 AppImage，deb/rpm 装完不会自更新 |
| Linux **arm64** | ❌ | 见下 |
| Linux deb / rpm | ❌ | 让用户 `apt upgrade` 或手动下新包 |

**为什么 arm64 不产出更新索引**：electron-updater 读的是唯一一个 `latest-linux.yml`，
如果里面同时列着 x86_64 和 arm64 两个 AppImage，**它分不清架构、会下错包**。
所以流水线让 x64 独占这个索引，arm64 只发安装包 —— 并在 CI 里断言 arm64 产物中
**不存在** `latest-linux.yml`，防止将来有人"顺手"把它加回去。

## 八、龙芯（LoongArch64）：现状

- **Electron 官方没有 loong64 预编译包**（仅有 x64 / arm64 / armv7l / ia32 等）。
- 但**龙芯官方维护了移植版**：`loongson/electron` 仓库 + 龙芯开源社区镜像
  （`https://docs.loongnix.cn/electron/download/`），有 **v33.4.6 loong64** ——
  正好对应本项目的 Electron 33 大版本。
- 因此理论路径是：下载 loong64 版 Electron → 用 `--config.electronDist=<解压目录>`
  让 electron-builder 用它 → 打 deb / AppImage。

**⛔ 这条路线尚未验证，所以流水线里没有对应的 workflow。** 未验证的关键点有三个：

1. electron-builder 是否接受 `--loong64` 架构参数（`Arch` 枚举里是否有它）；
2. FPM 打出的 deb 的 `Architecture` 字段是否为 `loongarch64`（国产系统认这个值）；
3. AppImage 的 runtime 是否有 loong64 版本（没有就只能出 deb / tar.gz）。

想在真机上验证时，用这段（**未验证，仅供参考**）：

```yaml
# .github/workflows/build-loong64.yml（确认上面三点后再启用）
name: build-loong64
on: { workflow_dispatch: }
jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - name: 取龙芯移植版 Electron
        run: |
          curl -fL -o el.zip \
            https://github.com/loongson/electron/releases/download/v33.4.6/electron-v33.4.6-linux-loong64.zip
          mkdir -p electron-loong64 && unzip -q el.zip -d electron-loong64
      - run: sudo apt-get update && sudo apt-get install -y --no-install-recommends rpm
      - run: npx electron-builder --linux deb --loong64 --config.electronDist="$PWD/electron-loong64" --publish never
      - uses: actions/upload-artifact@v4
        with: { name: aegis-loong64, path: "release/*.deb" }
```

> 更稳的做法是在**真机（龙芯整机）上直接用系统 fpm 打 deb**，而不是在 x64 上交叉打包 ——
> 国产平台的工具链差异往往比文档写的大。

## 九、Android：为什么不是"加个 workflow"

Electron **没有 Android 目标**，它只出 Windows / macOS / Linux。所以 Android 不是 CI 问题，
而是一次**前端重构 + 原生桥接**。

### 三条路线

| 路线 | 做法 | 工作量 | 安全评估 |
|---|---|---|---|
| **Capacitor 套壳** | 复用现有 React 渲染层；加密从主进程搬到 WebView | 中 | 密钥在 WebView 里，内存擦除不如桌面可控；可接 Android Keystore，但无硬件级保证 |
| **Tauri v2 mobile** | `src/core` 重写成 Rust | 大 | 安全模型最接近桌面版，Rust 侧管密钥；但等于把加密核心再实现一遍 |
| **PWA** | 浏览器直接访问 + 加到主屏 | 小 | **最弱**：存储可能被系统清理、无自动填充、无生物识别，不建议给密码管理器用 |

### 必须重做的部分（`src/renderer`）

现在的三栏布局（分组 / 列表 / 详情并排）**在手机上根本放不下**，必须重新规划：

| 桌面 | 移动端 |
|---|---|
| 三栏并排 | 底部 Tab（密码库 / 收藏 / 健康 / 设置）+ 列表→详情**路由式**跳转 |
| 右键菜单 | 长按操作面板 |
| 顶部工具栏 | 大标题 + 悬浮"新建"按钮 |
| 命令面板 `Ctrl+K` | 底部搜索抽屉 |
| 解锁页（单输入框） | 全屏解锁页 + 系统生物识别（`BiometricPrompt`） |
| 复制密码 | 还应该对接 **Android Autofill Framework**（需要原生插件） |

### 加密核心怎么搬

现在密钥在主进程（Node），渲染层摸不到 —— 这是桌面版最核心的安全设计。
搬到移动端后没有"主进程"，只能：

- Argon2id：`hash-wasm` 本来就是 WASM，**可以直接复用**；
- AES-256-GCM：`node:crypto` → **WebCrypto**（`crypto.subtle.encrypt/decrypt`），接口需要包一层；
- 库文件读写：`node:fs` → Capacitor Filesystem / Tauri fs；
- 内存清零：JS 做不到 `zeroize`，只能尽力（用完置空引用 + 缩短密钥生命周期）。

### 建议

**先做响应式改造，别急着上 Android。** 具体是：给界面加断点
（`< 720px` 切单栏 + 底部 Tab，`≥ 720px` 保持三栏），把移动端布局铺出来。
这一步在桌面端立刻就有收益（窄窗口、分屏、小屏笔记本），且是三条路线**共同的前置**——
UI 铺好后，无论最后选 Capacitor 还是 Tauri，套壳都是最后一步。
如果确定要做，可以单独排期；CI 这边等 UI 定型再加 Android job 也不迟。

## 十、发布前的手工验证清单

CI 只能保证"包生出来了、架构对了、更新索引在"。**真正的兼容性必须在真机上确认**：

- [ ] UOS V20 x86_64：`sudo apt install ./AegisNext_*.deb` 装得上；AppImage 双击能起
- [ ] 银河麒麟 V10 桌面（ARM64）：arm64 deb/AppImage 能起；托盘图标正常
- [ ] 中标麒麟 / 麒麟服务器：rpm 装得上
- [ ] 国产 ARM 整机：解锁 → 建条目 → 重启后能解开（确认 Argon2id WASM 在 ARM 上没问题）
- [ ] macOS 未签名包：右键 → 打开 能过 Gatekeeper
- [ ] Windows：NSIS 装在非管理员账号下正常
- [ ] 每个包都核对 `SHA256SUMS.txt`
