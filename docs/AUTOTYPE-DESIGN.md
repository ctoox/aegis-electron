# Auto-Type（快速填充）设计文档

> 状态：**阶段 1 已实现**（Windows 自动打字 MVP，2026-10-04 落地）。本文保留作为设计依据，
> 实现过程中与设计的偏离、以及踩到的坑，逐条记在第 15 节。
> 规格来源：本项目另一实现（Python 版 `aegis`，源码不在本仓库）的三份文件 ——
> `aegis_core/autotype.py`（381 行，纯序列编译）、`aegis_desktop/autotype_win.py`（246 行，Win32 发送层）、
> `aegis_desktop/quick_fill.py`（498 行，填充面板）。
> **本文是移植设计，不是重新发明**：凡是能 1:1 对应的都对应，只在 Electron 特有的地方做改动，改动点逐条标出理由。
> 编写日期：2026-10-04

---

## 0. 一句话

按 `Ctrl+Alt+Shift+F` 唤出一个置顶小面板，搜到条目后回车，Aegis 把焦点交还给你刚才那个窗口，
**逐字符把用户名/密码打进去** —— 浏览器、SSH 客户端、任何有输入框的程序都能用。

这是 KeePassXC Auto-Type 那一路能力，也是本项目 Python 版已经做完、Electron 版**一行都没有**的最后一块大缺口。

---

## 1. 范围

### 1.1 做

| 能力 | 说明 |
|---|---|
| 全局快捷键唤出填充面板 | `Ctrl+Alt+Shift+F` |
| 五种填法 | 填全部 / 强制账号+密码 / 只填密码 / 只填账号 / 只复制密码 |
| 自定义按键模板 | `{USERNAME}{TAB}{PASSWORD}{ENTER}` 这类占位符 |
| 智能降级 | 条目缺用户名 → 只填密码（反之亦然） |
| 等待选目标 | 从 Aegis 内部唤起时，轮询 10 秒，你点哪填哪 |
| 受挫自动退回复制 | 管理员窗口 / 非 Windows / 切不回目标 → 复制到剪贴板并在界面上说明 |

### 1.2 明确不做（本轮）

- **不做浏览器扩展**、不做页面内 DOM 注入、不做 Native Messaging。那是独立的一条线（第 11 节阶段 3）。
- **不做 macOS / Linux 的自动打字**。Windows 之外 `available()` 直接返回不可用，界面禁用「填入」按钮、引导用「复制密码」——与 Python 版行为一致。原理见第 6.4 节。
- **不做 WM_SETTEXT 控件直填兜底**。Python 版有这条路（`TECH_POINTS.md:59`），但它要先在目标窗口里找到正确的子控件句柄，误填风险高于收益。留作阶段 2 备选。
- 不做「域绑定校验」。原因与缓解见第 7.1 节，**这是本功能最需要向用户讲清的一条**。

---

## 2. 分层：与 Python 版 1:1 对应

Electron 版不能照抄 Python 的目录结构，但**必须照抄它的分层**，因为那个分层解决了一个真实约束：

| 层 | Python 版 | Electron 版（本设计） | 是否纯 TS |
|---|---|---|---|
| ① 序列编译（纯逻辑，不碰平台 API） | `aegis_core/autotype.py`（381） | `src/core/autotype.ts` | ✅ 纯，渲染层可 import |
| ② 平台发送（Win32） | `aegis_desktop/autotype_win.py`（246，ctypes） | `native/autotype-win32/` (N-API C++) + `src/main/autotype-native.ts` | ❌ 只从主进程可达 |
| ③ 编排（抓目标窗口 / 降级 / 轮询） | `quick_fill.py` 内 | `src/main/autotype.ts` | ❌ 主进程 |
| ④ 面板 UI | `aegis_desktop/quick_fill.py`（498） | `src/renderer/src/FillPanel.tsx` + `#/fill` 路由 | ✅ 纯前端 |

**①必须纯**，不只是洁癖：渲染层要用它算「这条会怎么填」的预览行，而 `npm run check:purity`
会沿 import 链做传递闭包检查 —— `src/core/autotype.ts` 一旦碰 `node:*`，渲染层一 import 就红。
Python 版拆这两层的理由写在 `autotype.py` 文件头第一句（"这里只回答一个问题：该往目标窗口依次打什么？"），
在 Electron 里这个理由**变成硬约束**。

**②必须只在主进程**：这是「不注入输入事件」那条约定能被保留的前提，见第 9 节。

---

## 3. ① 序列编译器 `src/core/autotype.ts`

### 3.1 逐项移植清单（源：`aegis_core/autotype.py`）

| Python | TypeScript | 备注 |
|---|---|---|
| `@dataclass Token(kind, value)` | `type Token = { kind: "text"\|"key"\|"delay"\|"empty"; value: string \| number }` | `frozen` 用 `readonly` |
| `Token("empty","")` 哨兵 | `const EMPTY: Token = { kind: "empty", value: "" }` | **语义别丢**，见 3.2 |
| `_FIELD_PLACEHOLDERS` | `FIELD_PLACEHOLDERS: Record<string, keyof Entry>` | `USERNAME→username` / `PASSWORD→password` / `TITLE→title` / `URL→url` |
| `_KEY_PLACEHOLDERS` | `KEY_PLACEHOLDERS` | `TAB→Tab` … `ESCAPE→Escape`（两别名）、`DEL→Delete` |
| `_TOKEN = /\{([A-Za-z]+)(?::(\d+))?\}/` | 同名正则 | 大小写不敏感靠 `.toUpperCase()` |
| `unknown_placeholders` | `unknownPlaceholders` | 先摘合法的、再看剩下的 `{...}`，避免嵌套 `{}` 误判 |
| `validate_template` | `validateTemplate` | 除了认占位符，还要求**至少一个字段占位符** |
| `expand_template` | `expandTemplate` | 空值 → 推 `EMPTY` 而不是跳过 |
| `_drop_empty_edges` | `dropEmptyEdges` | **最容易漏的一条**，见 3.2 |
| `build_sequence` | `buildSequence` | 主编译入口 |
| `effective_mode` | `effectiveMode` | 降级矩阵，见 3.3 |
| `mode_summary` | `modeSummary` | 列表里那一行「这条会怎么填」 |
| `describe_sequence` | `describeSequence` | 预览行，密码打码 |
| `preview` | `preview` | 编译 + 渲染 |

### 3.2 两个「看起来可以省、其实不能省」的细节

**(a) 空值哨兵 `EMPTY` 与 `dropEmptyEdges`**

用户名是空的，模板 `{USERNAME}{TAB}{PASSWORD}` 直接跳过空值会展开成 `[Tab, 密码]` ——
**那个 Tab 会把光标在目标窗口里白跳一格，密码就打进错误的输入框**。

所以空值必须留个哨兵（`EMPTY`），由 `dropEmptyEdges` 把**紧挨哨兵的 `Tab`/`Enter`** 一起删掉。
注意它只处理"紧挨着"的：用户自定义模板里**故意**写在结尾的 `{USERNAME}{TAB}` 要原样保留。
`autotype.py:235-260` 那段注释把边界讲得很清楚，移植时把这套 case 全部搬成单测。

**(b) 预览行的分隔符只能用 `→`**

`autotype.py:304` 那条注释是血泪：`▸`(U+25B8) 在 MiSans 里 `inFont()` 谎报有、实际渲染成豆腐块。
Electron 端字体栈不同，但结论照搬 —— 分隔符用 `→`，密码部分打 `•`。

### 3.3 降级矩阵（`effectiveMode`，显示与实际按键共用同一份规则）

| 条目设置的填法 | 有账号有密码 | 只有密码 | 只有账号 | 都空 |
|---|---|---|---|---|
| `both` | both | **password** | **username** | — |
| `password` | password | password | **username** | — |
| `username` | username | password | username | — |
| `custom` | custom | custom | custom | —（模板里自己删字段）|

「显示」与「实际按键」**必须共用这一份函数**，否则界面写「用户名+密码」而实际只打了密码。
`aegis_core/autotype.py:341-366` 为此专门留了注释，移植时保持注释。

### 3.4 与 Python 版的唯一差异：`fillMode` 存哪

Python 存 `entry.extra["fill"]` / `entry.extra["fill_template"]`。
Electron 的 `Entry` 也有 `extra`（`src/core/types.ts`），**沿用同样的键名** ——
这样分享包（`src/core/share.ts`）在两个实现之间往来时，填充方式不会丢。

### 3.5 新增：`PLACEHOLDER_NAMES` 要导出给界面

设置页/填充面板的自定义模板输入框需要「可用占位符」提示列表。Python 用模块私有
`_PLACEHOLDER_NAMES` + `validate_template` 的报错文案兜住。Electron 直接导出
`export const PLACEHOLDER_NAMES: readonly string[]` 给界面渲染成可点击的插入芯片（chip）——
纯 UX 优化，不影响语义。

---

## 4. ② N-API 原生模块

### 4.1 为什么不复用现成的

| 方案 | 否决理由 |
|---|---|
| `webContents.sendInputEvent` | **只能发给自己窗口**，对别的程序完全无效。这是最常见的一个误解 |
| `robotjs` | 已停维护多年；要 `electron-rebuild`；原生依赖链重 |
| `@hurdlegroup/robotjs` 等 fork | 上游分裂、维护取决于个人；引入一个我们控制不了的 win32 build 链 |
| `@nut-tree/nut-js` | 新版**商业许可**；旧版 GPL-3.0。本项目 `THIRD-PARTY-NOTICES.md` 的结论是依赖全宽松、**无 GPL/AGPL**，引入它会破坏这条基线。且它体积巨大（带图像识别）|
| `node-key-sender` | 靠**每次填字都 spawn 一个 Java 进程**，延迟数百毫秒、依赖本机 JRE |
| PowerShell `SendKeys` | 每次填字 spawn 一个 `powershell.exe`；`SendKeys` 还受输入法/布局影响；杀软对"脚本模拟按键"的评分极差 |

结论：**自己写一个最小 N-API 模块**。它其实就是 Python 版 `autotype_win.py` 的 C++ 直译 ——
那个文件 246 行，绝大部分是 `ctypes` 结构体声明，真正的逻辑不到 80 行。

### 4.2 为什么必须是 N-API（node-api）而不是普通原生模块

**N-API 是 ABI 稳定的**：编译一次，跨 Node 版本、**跨 Electron 版本**都能直接加载，
不需要 `@electron/rebuild`、不需要为每个 Electron 升级重编。

这对本项目直接决定 CI 复杂度：我们现在有 5 个发布目标，若走普通 addon 路线，
每个目标都要在对应 runner 上装编译链重编一遍；走 N-API 只需要在需要的平台上构建一次。

### 4.3 只在 Windows 上构建（也就不需要 5 套工具链）

模块只实现 Windows 的 `user32` 调用。非 Windows 平台 **`binding.gyp` 根本不参与构建**，
JS 层直接返回「不可用」。所以：

- CI 里只有 `windows-*` 那个 job 跑 `npm run build:native`；其余 job 该脚本直接 exit 0；
- 其余平台的 `electron-builder` 产物里不含 `.node` 文件，体积不变；
- `available()` 在非 Windows 上是**纯 JS 的常量返回**，不 try/catch 一个必然失败的 require。

#### 这条还有个不显眼但很重要副作用：保住了 Linux 的 glibc 兼容性结论

`docs/BUILD-PLATFORMS.md` 与项目长期记忆里有一条已定型的结论：

> Electron 33 的预编译二进制基于 **Ubuntu 20.04** 构建，**Debian 10+（glibc ≥ 2.28）可跑**，
> 所以国产系统（UOS / 麒麟）能跑。**这条成立的前提是「无原生模块」** ——
> 一旦引入 `.node`，它就会按 CI runner 的 glibc 编译，兼容基线随之被抬高。

同一处还写着：**引入原生模块后，arm64 的 deb/rpm 就不能再在 x64 上交叉打包**
（必须改用 ARM runner + 系统 fpm + `USE_SYSTEM_FPM=true`）。

**本设计不触发这两条**，因为原生模块只在 Windows 上构建：

| 平台 | 是否含 `.node` | glibc 基线 | arm64 交叉打包 |
|---|---|---|---|
| Windows x64 | ✅ 有 | 不适用 | 不适用 |
| macOS arm64 / x64 | ❌ 无 | 不适用 | 不适用 |
| Linux x64 | ❌ 无 | **仍是 Ubuntu 20.04 / glibc 2.28** | 不适用 |
| Linux arm64 | ❌ 无 | 同上 | **仍可在 x64 上交叉打包** |

也就是说：**`docs/BUILD-PLATFORMS.md` 与 `release.yml` 里「为什么这么做」的那套论证全部继续有效，
一行都不用改**，只需要给 windows job 加一步构建 + 产物自检（见 10.3）。

> ⚠️ 将来若有人想给 macOS 也加原生注入（比如改用 `CGEventPost`），上面这张表**立刻失效**，
> 必须同步重写 `BUILD-PLATFORMS.md` 与 `release.yml` 的注释。**别默默加。**

### 4.4 导出接口（与 `autotype_win.py` 逐函数对应）

```ts
// native/autotype-win32/index.d.ts  —— 与 aegis_desktop/autotype_win.py 对齐
export interface NativeToken {
  kind: "text" | "key" | "delay";
  value: string | number;
}
export interface Availability {
  ok: boolean;
  /** 不可用时给设置页显示的一句人话；可用时为空串 */
  reason: string;
}

/** autotype_win.available() */
export function available(): Availability;

/** autotype_win.send_text() —— 按 UTF-16 码元逐字符发 */
export function sendText(text: string, delayMs: number): boolean;

/** autotype_win.send_key() —— 功能键走 VK 码，扩展键带 KEYEVENTF_EXTENDEDKEY */
export function sendKey(name: string): boolean;

/** autotype_win.run_tokens() —— 按序执行 text / key / delay */
export function runTokens(tokens: NativeToken[], delayMs: number): boolean;

/** autotype_win.foreground_window() —— 无前台窗口时返回 "0" */
export function foregroundWindow(): string;

/** autotype_win.set_foreground() —— SetForegroundWindow + Alt 轻敲兜底 */
export function setForeground(hwnd: string): boolean;

/** autotype_win.focus_target() */
export function focusWindow(hwnd: string, settleMs: number): boolean;

/** 【新增】读目标窗口标题。仅用于界面上回显"将要填进哪个窗口"，见 7.2 */
export function windowTitle(hwnd: string): string;
```

**与 Python 版的唯一签名差异：hwnd 是 `string` 不是 `number`。**

`HWND` 在 Win64 上是**指针宽度(64 位)**。JS `number` 是 double，整数只能精确到 2^53 ——
真实用户态窗口句柄事实上落在 32 位内，但没有任何 API 契约保证这一点。
Python 版可以用 `int` 是因为 Python 整数是任意精度，**这条经验不能照搬**。

用十六进制字符串（`"0x00000000000A1B2C"`）表示：无损、能安全穿过 `contextBridge` 的序列化、
日志里可读、也避免了 `BigInt` 在 IPC 序列化上的兼容坑。

### 4.5 关键实现点（照搬 `autotype_win.py` 的三条结论）

**(a) 用 `KEYEVENTF_UNICODE` 通道，不用虚拟键码**

```cpp
static bool sendUnit(wchar_t unit) {
  INPUT in[2] = {};
  in[0].type = INPUT_KEYBOARD;
  in[0].ki.wScan = unit;
  in[0].ki.dwFlags = KEYEVENTF_UNICODE;
  in[1] = in[0];
  in[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
  return SendInput(2, in, sizeof(INPUT)) == 2;
}
```

- `wScan` 走 **Unicode 通道** → **不受键盘布局影响、不经过输入法**。
  用虚拟键码的话，中文输入法开着、或用户是 Dvorak/US 布局而系统记着别的布局，都会打错。
- 逐 **UTF-16 码元**发送：JS 的 `str.length` / `charCodeAt` 天然按 UTF-16 计数，
  与 `std::u16string` 1:1 对应。非 BMP 字符（emoji、部分生僻字）自动拆成代理对发两次 —— 这正是 Windows 期望的形式。
- `SendInput` **返回值必须检查**：返回 0 表示被系统拒收（典型是 UIPI 拦提权窗口），
  这是「目标窗口拒收」的唯一可靠信号，也是退回复制那条路径的触发点。

**(b) 功能键走虚拟键码 + 扩展键标志**

`Tab`/`Enter`/`Esc`/`Backspace` 等走 `wVk`；`_EXTENDED` 集合
（`Up/Down/Left/Right/Home/End/Insert/Delete/PageUp/PageDown`）必须**同时**带
`KEYEVENTF_EXTENDEDKEY`，否则方向键在小键盘区语义下是错的。映射表照抄 `autotype_win.py:24-31`。

**(c) 切前台要带 Alt 轻敲兜底**

Windows 限制非前台进程调 `SetForegroundWindow`（刻意防焦点窃取）。
`set_foreground` 的兜底是在失败时轻敲一次 `Alt` —— 让本进程"看起来"刚被用户交互过，
系统即放行。这条在 `autotype_win.py` 里是注释写明的，移植时保留并保留注释。

---

## 5. ③ 主进程编排 + IPC 形状

### 5.1 新增 IPC 通道（沿用现有 `领域:动词` 命名）

现有 31 个 handler 的命名规律是 `vault:*` `clip:*` `portable:*` …
新家族用 **`atype:*`**（`autotype` 太长，`at:*` 与现有 `app:` 易混）。

| 通道 | 方向 | 签名 | 说明 |
|---|---|---|---|
| `atype:available` | invoke | `() → { ok, reason }` | 当前平台能不能自动打字 |
| `atype:entries` | invoke | `() → FillItem[]` | 可填充条目，**不含 password 字段**，见 5.3 |
| `atype:preview` | invoke | `(id, mode) → { text }` | 预览行（密码已打码） |
| `atype:run` | invoke | `(id, mode) → { ok, how, notice }` | 执行填充；`how ∈ typed…` |
| `atype:cancel` | invoke | `() → void` | 关面板 + 取消等待 |
| `atype:arm` | **main → 面板** | `{ targetTitle, canType, canTypeReason, fillingSelf, preselect }` | 每次唤出前推送 |
| `atype:notice` | **main → 主窗口** | `string` | 走现有 `Toast` 组件显示 |

`FillItem`：

```ts
export interface FillItem {
  id: string;
  title: string;
  username: string;
  url: string;
  type: string;
  /** 这条实际会怎么填（modeSummary 的结果），列表右侧那一行小字 */
  modeSummary: string;
}
```

### 5.2 抓「目标窗口」的时机 —— 全流程最容易错的一步

Python 版在 `quick_fill.py:217` 写了一行注释，这是整个功能的关键：

```python
# 关键: 必须在显示自己之前抓, 否则拿到的就是我们自己
self.target_hwnd = autotype_win.foreground_window()
```

Electron 里同理，且顺序不能变：

```
热键触发 → ① native.foregroundWindow()  ← 此刻前台还是用户的浏览器
        → ② 判断该句柄是否属于我们自己的窗口（ownHwnds）
        → ③ 创建/显示 fillPanel 窗口
        → ④ panel.webContents.send("atype:arm", { targetTitle: titleOf(①), … })
```

对应的辅助函数（Windows 专用）：

```ts
function handleOf(win: BrowserWindow): string {
  // getNativeWindowHandle() 在 Windows 上返回 8 字节小端 HWND
  const buf = win.getNativeWindowHandle();
  return "0x" + buf.readBigUInt64LE(0).toString(16).padStart(16, "0");
}
```

### 5.3 面板是「密码盲」的 —— 比 Python 版更收紧一步

Python 版把整个 `Entry`（含明文密码）交给面板对象，面板自己编译序列、自己打字。
Electron 版拆开：

- `atype:entries` 返回的 `FillItem` **不含 `password` 字段**；
- 面板只回传 `{ id, mode }`，**主进程**用 `vault.list()` 查出完整条目、编译序列、执行注入；
- 预览行也由主进程算好（`modeSummary` 随 `FillItem` 一起下发，详细预览走 `atype:preview`）。

收益：**明文密码少经过一个渲染进程**。项目现有设计里 `vault:list` 已经把明文给主窗口渲染层了
（这是既有取舍，改动它不在本次范围），但没有任何理由再让**第二个**窗口也拿到一份。

这条要写进 `check:purity` 相关文档的「攻击面收敛」一节。

### 5.4 「等待选目标」状态机（`quick_fill.py:441-487` 的移植）

从 Aegis 内部（比如主窗口的「快速填充」菜单项）唤起时，前台窗口就是 Aegis 自己，
没有"刚才的窗口"可回。Python 的行为是**轮询 10 秒**，用户点哪个窗口就填到哪：

| 步骤 | 行为 |
|---|---|
| `fillingSelf = true` 且可打字 | 不立即失败；`setInterval(120ms)` 轮询 `foregroundWindow()` |
| 轮询到非自己的窗口 | 停表 → `focusWindow(hwnd, 120)` → `runTokens` |
| `fillingSelf = true` **且不可打字** | 直接退回复制（打给自己没意义），提示「目标窗口就是神盾，已改为复制密码」|
| 10 秒超时 | 停表 → 退回复制，提示「超时没有切到其他窗口，已改为复制密码」|
| 用户 Esc / `atype:cancel` | 清定时器、关面板 |

**超时判定必须优先于前台窗口判定** —— Python 版 `_poll_target` 里专门写了注释
（"超时优先判 —— 截止后不再认任何前台窗口"）：否则截止瞬间刚好有窗口活动，就会在用户已经放弃之后
突然往那个窗口打字。移植时保持这个顺序。

### 5.5 ⚠️ 与现有「失焦即锁」冲突 —— 必须在本次一起修

`src/main/index.ts:200-202`：

```ts
win.on("blur", () => {
  if (settings.lockOnBlur && vault?.unlocked) lockVault("blur");
});
```

填充面板是**独立窗口**，它一显示就抢走主窗口焦点 → 主窗口 `blur` → **开了「失焦即锁」就当场锁库**，
用户正要填密码时被锁出去。这不是理论问题，是必然发生。

修法：主进程维护一个「辅助窗口正在使用」标志，`blur` 回调先看它。

```ts
/** 填充面板等辅助窗口显示期间, 主窗口失焦不算"用户离开" */
let auxWindowActive = false;

win.on("blur", () => {
  if (auxWindowActive) return;
  if (settings.lockOnBlur && vault?.unlocked) lockVault("blur");
});
```

配套：
- `openFillPanel()` 里置 `true`，面板 `hide`/`closed` 时置 `false`；
- 自动锁定计时不受影响：面板的每次 IPC 都会走 `touch()`，用户正在操作就等于有活动；
- 把这个标志做成通用的（未来加别的辅助窗口直接复用），而不是 `fillPanelActive` 这种一次性命名。

### 5.6 剪贴板降级要复用现有的定时清空

退回复制时**不要**直接 `clipboard.writeText`，而是走现有的 `copyToClipboard()`
（`src/main/index.ts:292-318`）。它已经处理了三件容易漏的事：
写入后记 `clipToken`、到点只在"内容仍是自己写的那份"时才清、清完发 `clip:cleared` 事件。
自己再写一份必然漏掉其中之一。

---

## 6. ④ 填充面板 UI

### 6.1 窗口参数

| 项 | 值 | 理由 |
|---|---|---|
| 尺寸 | 468 × 动态高度（320 起，随结果行数变） | 与 Python 版 `_PANEL_W = 468` 一致 |
| `frame` | `false` | 自绘（Windows/Linux 与主窗口一致；macOS 上仍给 `titleBarStyle` 默认值即可，面板不需要红绿灯）|
| `alwaysOnTop` | `true` | 否则被目标窗口盖住 |
| `skipTaskbar` | `true` | 它是个临时面板，不该占任务栏（对应 Python 的 `Qt.Tool`）|
| `resizable` / `maximizable` / `fullscreenable` | `false` | — |
| `show` | `false` | 建好先不显示，`arm` 之后再 `showInactive()`/`show()` |
| `webPreferences` | 与主窗口**同一份** preload，`contextIsolation`/`sandbox` 全开 | 见 6.4 |

高度自适应：面板渲染完测量内容高度，`ipcRenderer.invoke("atype:resize", h)` → 主进程 `setBounds`。
比在窗口里做滚动条体验好（Python 版也是这个思路：`adjustSize()`）。

### 6.2 路由

`src/renderer/src/main.tsx` 按 hash 分支：

```tsx
const isFill = location.hash.startsWith("#/fill");
root.render(isFill ? <FillPanel /> : <App />);
```

主进程 `createFillPanel()` 加载 `index.html#/fill`（开发态拼 `ELECTRON_RENDERER_URL`）。
**不新开一个 vite entry**：面板与主窗口共用 `styles.css` 的设计 token（颜色/圆角/字号），
拆 entry 会逼着把 token 再拷一份。

### 6.3 布局（对应 `quick_fill.py:131-201`）

```
┌─ #QuickFillBody ────────────────────────────────┐
│ [ 搜索要填充的条目…                        ✕ ] │  ← 唤醒后自动聚焦
│ ┌────────────────────────────────────────────┐ │
│ │ 🗂  GitHub                                 │ │  ← 图标(30×30, 强调色软底)
│ │    me@example.com            用户名 + 密码 │ │  ← 副行 = username || url；右侧 = modeSummary
│ ├────────────────────────────────────────────┤ │
│ │ …最多 7 行，超出靠搜索筛                        │
│ └────────────────────────────────────────────┘ │
│ [ 填入 ]  [ 只填密码 ]  [ 复制密码 ]              │
│ Enter 填入 · Ctrl+Enter 账号+密码 · Alt+P 只填密码 │  ← 提示行
│ · Alt+U 只填用户名 · Esc 取消                     │
└─────────────────────────────────────────────────┘
```

- 空状态三态（照抄 `quick_fill.py:296-305`）：库里没有可填充条目 / 没有匹配「X」的条目 / 没有可填充的条目。
  三种文案不同，别合成一句 —— 用户看到「没有匹配」会去改搜索词，看到「库里没有」才会去新建。
- 键盘：`Enter` 填入、`Ctrl+Enter` 强制账号+密码、`Alt+P` 只填密码、`Alt+U` 只填用户名、
  `Alt+C` 复制、`Esc` 取消、`↑`/`↓` 换行（对应 `quick_fill.py:315-354`）。
- 「填入」按钮在 `canType === false` 时禁用并把 tooltip 换成「当前平台不支持自动打字，请用『复制密码』」
  （`quick_fill.py:291-294` 同款）。

### 6.4 与 Python 版的差异：窗口归属

Python 版把面板做成独立 `QWidget`（刻意不给 parent，"要能独立于主窗口置顶"）。
Electron 侧**不要**把面板设成主窗口的 child window（`parent`）—— 那会让它跟着主窗口最小化。
独立窗口 + `alwaysOnTop` + 在 `ownHwnds` 里登记，行为一致。

---

## 7. 安全设计

### 7.1 最大的那个问题：没有域绑定

**这必须写进 README，不能只写在设计文档里。**

浏览器扩展能看到页面 URL，所以能拒绝在非 `github.com` 的页面上填 GitHub 的密码。
**Auto-Type 做不到** —— 它只知道"前台有个窗口"，不知道里面是什么网站。
用户点了钓鱼站然后按 `Ctrl+Alt+Shift+F`，Aegis 会照填不误。

缓解措施（本轮就做）：

1. **默认不自动提交**（`autoSubmit: false`）。填完停在输入框里，用户自己按回车 ——
   给用户一个"看清楚了再提交"的停顿点。Python 版默认也是关的（`settings.py:26`）。
2. **回显目标窗口标题**。`windowTitle(hwnd)` + 在面板顶部显示「将填入：`Chrome — GitHub 登录`」。
   用户扫一眼标题就能发现不对。**这是 Electron 版相对 Python 版新增的能力**，成本极低、收益明确。
3. 文档如实说明这条限制。

**考虑过、本轮不做**：拿条目 `url` 的 host 与目标窗口标题做模糊匹配，不匹配就警告。
否决理由：浏览器标题是页面 `<title>`，与域名没有稳定映射（用户可能把标题改成任何东西），
误报率高到会让用户学会无视警告 —— 而"会让用户学会无视警告的警告"是负资产。

### 7.2 输入事件注入本身的风险

- **杀软误报**：`SendInput` 模拟键盘是键盘记录器/远控的典型行为，可能被启发式引擎拦。
  必须给 Windows 产物做代码签名；未签名时要在 README 里说明可能被拦。
- **不提权**：本进程始终以普通权限运行。提权才能填管理员窗口，但**整个密码管理器都提权**的代价远大于收益。
  管理员窗口一律退回复制（`SendInput` 返回 0 即触发）。
- **注入只发生在主进程**：渲染层拿不到发送能力，见第 9 节。

### 7.3 剪贴板改良（顺带做）

现有 `clipboardClearSeconds` 默认 30 秒。退回复制后这 30 秒里密码躺在剪贴板上。
建议加一个独立开关「**粘贴后立即清空**」：主进程监听焦点变化，
若复制后用户切到过别的窗口并发生过一次粘贴可能性，就提前清。

> 更稳的实现：用 Electron 的 `clipboard` 无法感知"被粘贴"。可行做法是复制后开一个短定时器（如 5 秒）+
> 监听主窗口失焦事件，二者先到者清。**措辞上要诚实**：这是启发式提前清空，不是真检测到粘贴。
> 若评审认为不够可靠，就只做「退回复制后的默认秒数调小到 10 秒」这个简单版本。

---

## 8. 设置项（`src/core/prefs.ts` 新增）

现有 `Settings` 是扁平结构，新增字段同样扁平、`autotype` 前缀：

| 字段 | 默认 | 说明 |
|---|---|---|
| `autotypeEnabled` | `true` | 总开关（关掉就不注册热键）|
| `autotypeDefaultMode` | `"both"` | 条目没设 `extra.fill` 时的默认填法 |
| `autotypeAutoSubmit` | `false` | 填完自动回车。**默认关**，理由见 7.1 |
| `autotypeTypeDelayMs` | `0` | 逐字符间隔；有的前端要等接口返回 |
| `autotypeHotkey` | `"CommandOrControl+Alt+Shift+F"` | 可改；注册失败要在设置页显示冲突 |
| `autotypeShowTargetTitle` | `true` | 面板顶部回显目标窗口标题 |
| `autotypeClearClipboardAfterFallback` | `10` | 退回复制后的清空秒数（复用 `clipboardClearSeconds` 亦可）|

`normalizeSettings` 目前对枚举只有一个内联的 `theme` 判断，新增 `autotypeDefaultMode` / `autotypeHotkey`
会让内联判断变多 —— 顺手抽一个 `enumOr<T extends string>(v, allowed, fallback)` helper，
`theme` 也改用它。这是纯重构，行为不变，由 `tests/settings.test.ts` 保住。

设置页新增「**快速填充**」一节，排布照 `settings_dialog.py` 的「快捷键与自动填充」节：
开关 + 默认填法下拉 + 自动提交开关 + 逐字延迟 + 热键显示（只读展示当前注册状态）+ 一句
「自动打字不受键盘布局影响；管理员权限的窗口无法自动填入，会改为复制到剪贴板」。

注册冲突要**显式报出来**：`globalShortcut.register()` 返回 `false` 表示被别的程序占用，
不能静默失败 —— 设置页显示「该快捷键已被其他程序占用」，这是 Python 版
（`hotkeys.py` 有冲突检测与状态显示）已有、不能丢的能力。

---

## 9. 改掉的三处既有约定（已生效）

「不注入输入事件」这条约定**原本是对的**，它防的是渲染层去碰输入注入 ——
但当初写下来时，Auto-Type 还是个"不做"的功能，所以措辞是笼统的。
现在要做它了，**正确的做法是把约定收紧到它真正该管的范围，而不是把约定删掉**。
下面三处的最终文本就是改完之后的样子。

### 9.1 `docs/feature-gap-vs-python.md`（缺口表最后一行）

原文：

```
| 快速填充 / 自动填充 | 很大 | 要模拟键盘输入到别的窗口，Electron 无原生能力，得装 native 依赖（类似 `node-key-sender`），**且和「不注入输入事件」的测试约定冲突** |
```

改为：

```
| 快速填充 / 自动填充 | 很大 | 要模拟键盘输入到别的窗口，Electron 无原生能力，得装 native 依赖。**已实现（阶段 1，仅 Windows）**：自写最小 N-API 模块 `native/autotype-win32`，既不用 `node-key-sender`（要 JRE、每次填字还 spawn 进程）也不用 `nut-js`（商业许可）。渲染层仍然不碰输入注入 —— 注入只发生在主进程，`check:purity` 照旧全绿。设计见 `docs/AUTOTYPE-DESIGN.md` |
```

### 9.2 `docs/OPENSOURCE_FEATURES.md`（功能矩阵那两行）

原文两行：

```
| 浏览器自动填充 | ✅ | ✅ | ✅ | ✅ | ➖ | ✖ | 需扩展程序，不在桌面端范围 |
| 全局快捷键快速填充 | ➖ | ✅ Auto-Type | ➖ | ➖ | ➖ | ✖ | Python 版（aegis）已做，Electron 版不重复 |
```

改为：

```
| 浏览器自动填充（页面内） | ✅ | ✅ | ✅ | ✅ | ➖ | ✖ | 需浏览器扩展 + Native Messaging，能读到页面内容，不在本轮范围（见 `docs/AUTOTYPE-DESIGN.md` 阶段 3）|
| 系统级 Auto-Type | ➖ | ✅ | ➖ | ➖ | ➖ | ✅ | 已实现（仅 Windows；其他平台退化为「复制到剪贴板」）。与上一行的区别：不注入页面 DOM，而是把按键发给目标窗口 |
```

并把表下的「结论 → 本轮落地四项」后面补一段，说明 Auto-Type 是紧随其后的第五项（**不是**那四项之一）。

### 9.3 `README.md`（「明确不做的事」表）

原文一行：

```
| 不提供浏览器扩展的自动填充 HTTP 注入 | 减少攻击面；当前只提供手动复制与 TOTP |
```

改为两行 —— 第二行是**必须补上的**，因为 Auto-Type 有一个 Python 版没有的问题：没有域绑定。

```
| 不提供浏览器扩展、不做页面内 DOM 注入 | 扩展要一条常驻的 Native Messaging 通道，还能读到页面内容 —— 对一个零知识密码管理器来说是明显扩大的攻击面。功能上由系统级 Auto-Type 覆盖（见 `docs/AUTOTYPE-DESIGN.md`）|
| 自动填充不校验目标网站 | Auto-Type 只知道「当前前台窗口」，不知道那个窗口里是哪个网站，所以钓鱼页面照样会填。因此**默认不自动提交**、面板顶部回显目标窗口标题，把「看清地址栏再回车」这一步留给人 |
```

**注意**：`README.md` 原来那行读起来像「我们不做自动填充」，而实现后我们会做 ——
不改就是文档与产品不一致，比缺文档更糟。另外「功能一览」表里也补了一行「快速填充（Auto-Type）」。

---

## 10. 打包与 CI

### 10.1 `package.json`

```jsonc
{
  "scripts": {
    // 非 Windows 平台直接 exit 0（见 4.3）
    "build:native": "node scripts/build-native.mjs",
    "dist:win": "npm run build:native && electron-vite build && electron-builder --win"
  },
  "build": {
    "files": [
      "out/**/*",
      "package.json",
      "build/icon.png",
      // 只把已经构建好的 .node 塞进包；没构建的平台该 glob 匹配不到，不报错
      "native/autotype-win32/build/Release/*.node"
    ],
    // 原生模块不能从 asar 里加载，必须解包到 app.asar.unpacked
    "asarUnpack": ["**/*.node"]
  }
}
```

`scripts/build-native.mjs` 要点：
1. `process.platform !== "win32"` → `console.log("跳过：自动打字模块仅 Windows 需要")` + `exit 0`；
2. 检测 `native/autotype-win32/build/Release/*.node` 是否已存在且比源码新 → 跳过（本地开发别每次都编译）；
3. 否则 spawn `node-gyp rebuild`（Windows 上需要 MSVC Build Tools，缺失时**报清楚**而不是让 electron-builder 在最后一步崩）。

### 10.2 加载（避开打包器的静态分析）

```ts
// src/main/autotype-native.ts
import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";

const require_ = createRequire(import.meta.url);
let native: NativeApi | null = null;

if (process.platform === "win32") {
  try {
    const p = join(app.getAppPath(), "native", "autotype-win32", "build", "Release", "autotype_win32.node");
    // 打包后 app.getAppPath() 指向 app.asar，而 .node 在 app.asar.unpacked 里
    native = require_(p.replace("app.asar", "app.asar.unpacked"));
  } catch (e) {
    console.warn("[autotype] 原生模块加载失败，自动打字将不可用：", e);
    native = null;
  }
}
```

- 用**运行期计算出来的路径** `require`，而不是 `import`，这样 vite/rollup 不会试图把它打进 bundle；
- 加载失败**不抛错**，只降级 —— `.node` 缺失/被 AV 隔离/架构不符时，用户看到的应该是"填入按钮灰掉 + 提示用复制"，不是一个起不来的应用。

### 10.3 `.github/workflows/release.yml`

只改 `windows-x64`（以及未来的 `windows-arm64`）那个 job：在 `npm ci` 之后插一步。

```yaml
- name: Build native autotype addon
  run: npm run build:native
```

其余 job 不加 —— 它们的 `npm run dist:*` 不会去构建 `.node`，产物里也不含它。

**产物自检要加一条**：`windows-*` 的 job 断言 archive 内存在
`resources/app.asar.unpacked/native/autotype-win32/build/Release/*.node`。
理由同托盘图标那次教训（`src/main/index.ts:337-340` 的注释）：原生文件缺失是**静默失败**，
不主动断言就会以"打包后自动填充莫名其妙不工作"的形式在用户那里爆出来。

**同时要反向断言**：`linux-*` 与 `macos-*` 的产物里**不应存在任何 `.node`**。
这条不是多余的 —— 它正是 4.3 那张表（glibc 兼容性 / arm64 交叉打包）成立的**唯一依据**。
没有这条断言，"某天有人顺手给 Linux 也编一份"就会静默破坏国产系统兼容性，
而症状（UOS 上装不上）要在几个月后由用户反馈才能发现。

### 10.4 阶段 2 可选项：`prebuildify`

现在要求构建机有 MSVC。用 `prebuildify` 把编好的 `.node` 提交/发布后，
终端用户与其他 CI 都不需要编译链。**本轮不做** —— 先让功能跑通，再优化构建体验。

---

## 11. 分期

### 阶段 1（✅ 已完成，2026-10-04）：Windows 自动打字 MVP

| 交付 | 文件 | 状态 |
|---|---|---|
| 纯序列编译器 + 单测 | `src/core/autotype.ts`、`tests/autotype.test.ts` | ✅ 92 项断言 |
| N-API 模块 | `native/autotype-win32/{binding.gyp,autotype.cc,index.d.ts}` | ✅ 真机 17 项断言全过 |
| 构建脚本（MSVC 探测 + 人话报错） | `scripts/build-native.mjs` | ✅ |
| 原生加载封装 | `src/main/autotype-native.ts` | ✅ 含 `normalizeHwnd()`（15.2 第 1 条）|
| 编排 + IPC + 热键 | `src/main/autotype.ts`，`src/main/index.ts` 接线 | ✅ |
| 面板 | `src/renderer/src/FillPanel.tsx`，`main.tsx` 路由分支 | ✅ |
| 失焦即锁冲突修复 | `src/main/index.ts`（§5.5）| ✅ 有探针盯（§12.2）|
| 设置项 + 设置页一节 | `src/core/prefs.ts`、`SettingsPage.tsx` | ✅ 含热键注册状态与冲突提示 |
| 回归探针 | `scripts/shot-ui.mjs`、`scripts/verify-autotype-native.mjs` | ✅ 每条都做过定点红测 |
| 三处约定改写 | 第 9 节 | ✅ |

### 阶段 2：体验与安全收口

- 目标窗口标题回显 + 「粘贴后清空剪贴板」改良（7.3）
- `Ctrl+Alt+Shift+A`「填入上一个条目」（不弹面板）：需要一个「最近填入条目」偏好项
- `WM_SETTEXT` 控件直填兜底（**备选**，见 1.2）
- `prebuildify` 免编译链

### 阶段 3：浏览器扩展 + Native Messaging

页面内自动填充的正统做法。独立排期 —— 它要新增一个浏览器侧代码库、
一条常驻的本地消息通道、一套扩展商店发布流程，**不是**桌面端加几百行能带上的事情。
到时 Auto-Type 与扩展是并存关系（扩展负责网页，Auto-Type 负责桌面程序），不是替代关系。

---

## 12. 测试计划

### 12.1 纯逻辑单测（`tests/autotype.test.ts`，可离线跑，进 `npm test`）

照 `aegis_core/autotype.py` 的既有行为与注释逐条落断言：

| 组 | 断言 |
|---|---|
| 三种内置填法 | `both` → `[text(用户), key(Tab), text(密码)]`；`password` / `username` 各自单段 |
| **空值孤立导航键** | 用户名空 + `{USERNAME}{TAB}{PASSWORD}` → **Tab 被删掉**；用户故意写的尾部 `{TAB}` → **保留** |
| 自定义模板校验 | 空模板报错；`{FOO}` 报「认不出的占位符」；只有 `{TAB}` 报「至少要有一个字段占位符」；`{DELAY:abc}` 报错；`{DELAY:300}` 通过 |
| 降级矩阵 | 3.3 表的 12 个格子逐个断言（含 `effectiveMode` 与 `modeSummary` **两者一致**）|
| 预览渲染 | 密码渲染成 `•`（长度上限 10）；分隔符含 `→` 且**不含** `▸`；超长截断加 `…` |
| `autoSubmit` | 末尾追加一个 `Enter`；且**不影响**前面的降级结果 |
| `extra.fill` 兼容 | 从 `{fill:"password", fill_template:"…"}` 读得出；非法值退回默认 |

### 12.2 探针（已落地：`scripts/shot-ui.mjs` 的「快速填充（Auto-Type）」一节）

按项目既有做法，**探针必须先在旧代码上红一次**，否则可能是空转。本次每条都做过定点红测
（把护栏单独退回旧写法 → 看 ✘ → 还原 → 看 ✔）。

| 探针 | 断言 | 红测做法 |
|---|---|---|
| 面板不泄露密码 | 调 `atype:entries`，断言返回对象**没有任何** `password` 键（5.3 的回归护栏）| 在 `fillItems()` 里加回 `password: e.password` → ✘ |
| 不可用时不崩 | `available()` 返回 `{ok, reason}`，`ok` 为假时 `reason` 非空；`atype:run` 对不存在的条目返回 `{ok:false, how:"failed"}` 而不抛 | 断言的是「不抛」，靠类型收紧来保证 |
| 面板是独立窗口、不叠窗 | 唤出前 `#/fill` 目标数 = 0，唤出后 = 1，**再唤出一次仍是 1** | 人工清单第 7 条的自动化 |
| **失焦即锁不被面板触发** | 开 `lockOnBlur` → 收起面板并用 `Page.bringToFront` 把主窗口拉回前台 → 唤出面板 → 断言 `vault.status().unlocked` **仍为 true**（5.5 的回归护栏）| 删掉 `index.ts` 里的 `if (isPanelVisible()) return;` → ✘ |

**这条探针自己踩过一次坑，值得写下来**：第一版没有「先收起面板、把主窗口拉回前台」这一步，
结果上一条探针留下的面板让主窗口**一直处于失焦状态**，`open()` 不会再产生第二次 `blur`，
`unlocked === true` 成了一条恒真断言 —— 在**故意删掉让路逻辑**的代码上照样绿。
所以现在多了两条 `预置条件` 断言：主窗口必须先持有焦点，弹出后必须真的失焦。

**没能自动化的窗口属性**：`isAlwaysOnTop()` / `isResizable()` / `skipTaskbar`。
这些都是**主进程**属性，而 `shot-ui.mjs` 走的是渲染侧 CDP，够不着。试过连主进程的 Node inspector
（`--inspect` + `/json/list`），能连上、能求值，但主进程全局作用域里 **`require` / `process.mainModule` / `globalThis.require` 全是 `undefined`**
（Electron 主进程的引导脚本是 `electron/js2c/browser_init`，不是普通 CJS 入口），拿不到 `BrowserWindow`。
为了三条断言专门加一条只服务于测试的 IPC 不划算 —— 于是落到人工清单（12.3 第 9 项）。

### 12.3 人工真机清单（只能人做，写进 PR 描述）

Windows 真机上逐项：

1. 记事本：`Ctrl+Alt+Shift+F` → 选区目 → 回车 → 账号/密码正确落入；
2. 浏览器登录框（Chrome / Edge 各一）：同上；确认 Tab 落在密码框；
3. **中文输入法开着**时重复第 2 步 —— 验证 Unicode 通道确实绕开输入法；
4. 密码含 emoji 或生僻字（非 BMP）→ 验证代理对；
5. **管理员权限打开的窗口**（如管理员 cmd）→ 应退回复制并给出提示，不静默失败；
6. 从 Aegis 主窗口菜单唤起 → 应进入「10 秒内点一下目标窗口」模式；超时 → 退回复制；
7. 连续快速按 `Ctrl+Alt+Shift+F` 多次 → 不应叠出多个面板窗口；
8. 开「失焦即锁」重复第 1 步 → **不应**被锁出（12.2 已自动化，人工再走一遍是确认体感是对的）；
9. 面板显示时：**不出现在任务栏**、**压在其他窗口之上**、**拖边框改不了大小**。
   这三个属性（`skipTaskbar` / `alwaysOnTop` / `resizable`）在渲染侧读不到，只能肉眼确认，原因见 12.2 末。

---

## 13. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 杀软把 `SendInput` 判为可疑行为 | 功能被静默拦截 | 代码签名；README 说明；`sendInput` 失败一定要有可见提示，不能静默 |
| Windows 构建机缺 MSVC | CI 在最后一步才失败 | `build-native.mjs` 提前探测并给人话报错（10.1 第 3 点）|
| 用户机器是 ARM64 Windows | 无可用 `.node` | 本轮不发 `windows-arm64`；加载失败自动降级为"仅复制"（10.2 的 try/catch）|
| `globalShortcut` 被占用 / Linux Wayland 不支持 | 热键无效 | 注册返回值必须检查并在设置页显示（8 节末）；Wayland 下引导用菜单项入口 |
| 面板在全屏应用（游戏、视频）上被盖住 | 面板不可见 | 已知限制，文档说明。`alwaysOnTop` 已是 Electron 能给的最强保证 |
| 无域绑定导致钓鱼站照填 | **安全** | 7.1：默认不自动提交 + 回显目标窗口标题 + 文档如实说明 |

---

## 14. 验收标准

实现完成后，以下全绿才算做完：

1. `npm run ci` 通过（含新增的 `tests/autotype.test.ts`）；
2. `npm run check:purity` **仍通过** —— `src/core/autotype.ts` 是纯模块，注入能力只在主进程可达；
3. 12.2 的四个探针全部 ✔，且每个都在旧代码上验证过会 ✘；
4. 12.3 的人工清单 9 项全过，其中第 5、6、8 项**必须**明确验证（它们是降级路径与冲突修复）；
5. `docs/feature-gap-vs-python.md` / `docs/OPENSOURCE_FEATURES.md` / `README.md` 三处按第 9 节改写完毕；
6. 非 Windows 平台上：面板可正常唤出与搜索，「填入」按钮禁用、tooltip 指向「复制密码」，**不出现任何报错或空白窗口**。
   ⚠️ **这一条本机没验证过**（没有 Linux/macOS 环境），见 15.3。别把它当成已通过。

---

## 15. 实现记录（与本文的偏离、以及踩到的坑）

阶段 1 已落地。这里只记**与本文不一致**、或**本文没写但后来必须知道**的东西 ——
照着本文从零实现的人，应该先看这一节。

### 15.1 有意偏离

| 位置 | 本文写的 | 实际实现 | 为什么 |
|---|---|---|---|
| §3.1 占位符校验 | 照抄 Python：名字认得出来就放过 | **多拦一条**：非 `DELAY` 的占位符不许带参数，`{TAB:5}` 报错 | Python 版会放过它，然后在展开阶段把 `{TAB:5}` 当成**字面量打进目标窗口** —— 密码里凭空多出一段字符，用户很难自查。宁可在校验阶段就报错 |
| §8 热键设置项 | 列了 `autotypeHotkey` | 设置页**只读展示**热键与注册状态，不给输入框 | 在界面里改 accelerator 需要一整套格式校验与即时反馈，而非法写法会被 `globalShortcut.register` 静默拒绝。先做「显示注册成功没有 + 冲突原因」，改值走 `aegis.settings.json` |
| §3.5 `PLACEHOLDER_NAMES` | 导出给界面 | 已导出，界面用它做提示（`FILL_HINTS`）| —— |

### 15.2 本文没写、实现时才踩到的

1. **hwnd 必须归一化成「16 位大写十六进制字符串」。**
   原生侧 `foregroundWindow()` 由 C 的 `kHex`（大写表）拼出，形如 `0x0000000000120A9C`；
   JS 里 `toString(16)` 拼的是小写。数值相同、`setForeground` 照常工作，
   但 `===` 字符串比较**静默为假** → `ownHwnds().has(hwnd)` 永远 false →
   「目标窗口是不是神盾自己」判错，从软件内唤出时会想着去打字给自己。
   现在所有出口都过 `normalizeHwnd()`，`scripts/verify-autotype-native.mjs` 里有一节「句柄格式契约」专门守它。

2. **`binding.gyp` 必须加 `/utf-8`。**
   中文 Windows 上 MSVC 默认按 GBK(936) 读源码，UTF-8 的中文注释与 `u"…"` 字面量会被读错，
   报 `C2001: 常量中有换行符`。加 `/utf-8`（同时指定源码字符集与执行字符集）即可，不需要 BOM。

3. **面板状态存在竞态。**
   主进程 `send("atype:arm")` 可能早于面板 React 的 effect 注册监听 → 面板永远停在初始态。
   修法不是加延时：给 `ArmState` 加单调递增的 `seq`，面板**同时**订阅 `onArm` **并**主动拉一次
   `atype:armState`，用 `seq` 丢弃迟到的旧值。

4. **`focusTarget` 单次判定会误报失败。**
   `SetForegroundWindow` 之后焦点可能被别的进程抢走（实测是验证脚本里 PowerShell 退出时的窗口）。
   所以改成「重试 3 次 + 每次之间留 settle 时间」，而不是把一次失败当成最终结论。

5. **探针会被自己写空转。** 见 §12.2 末尾：`lockOnBlur` 那条第一版是**恒真**的，
   靠「故意删掉被保护的代码」才发现。结论：凡是断言「某个坏结果没发生」的探针，
   都必须额外断言「这个坏结果的发生条件是成立的」，否则它测的是别的东西。

### 15.3 本次**没有**验证的

- **非 Windows 行为**（§14 第 6 条）：本机没有 Docker，也没有 WSL 发行版，
  所以「`available()` 返回假 → 面板禁用『填入』→ 退化为复制」这条路径**没在真机跑过**。
  要么在 GitHub Actions 的 linux / macos job 上跑一次，要么等有机器再补。**别把它当成已验证。**
- **多显示器 / 高 DPI 下的面板定位**：`placeNearCursor()` 只用主显示器工作区，
  多屏环境可能落在另一块屏上。已知取舍，不阻塞阶段 1。
- **杀软拦截 `SendInput`**（§13 第 1 条）：本机 Defender 未拦截，其他引擎未知。

---

## 附：与 Python 版对照速查

| 关注点 | Python 版 | Electron 版（本设计） |
|---|---|---|
| 序列编译位置 | `aegis_core/autotype.py` | `src/core/autotype.ts`（纯）|
| 发送实现 | `ctypes` 调 `SendInput` | 自写 N-API C++ 模块 |
| hwnd 类型 | `int`（任意精度） | `string`（十六进制，无损）|
| 面板是否持有密码 | 是 | **否**（密码盲）|
| 目标窗口标题回显 | 无 | **有**（新增）|
| 失焦即锁与面板冲突 | 无此问题（Qt 窗口语义不同）| **必须显式修**（5.5）|
| 原生产物分发 | PyInstaller 内含 | `.node` + `asarUnpack` |
| 非 Windows 降级 | `available()` 返回假 | 同 |
| 填充方式存储键 | `extra.fill` / `extra.fill_template` | **同**（分享包互通）|
