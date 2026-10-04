# Electron 版 vs Python 版：功能缺口核对

> 起因：用户反馈「Electron 版本好像是有点问题，我好像不能重置密码库，和其他版本对比是缺了挺多功能的」。
> 本文是对两版源码**逐模块核对**的结果，不是猜测。
> 核对日期：2026-10-04　核对方式：全量 grep + 逐文件读实现。

## 一、结论

用户判断正确。**Electron 版确实缺 9 项功能**，其中「重置密码库」是硬缺失 —— 全仓库 `grep -rni "reset" src/` **命中 0 次**。

另外还发现一个**两版共有的严重缺陷：没有单实例保护**，这正是 2026-10-02 密码库被写成空库的直接原因（见第七节）。

## 二、逐项对比（含源码位置）

| # | 功能 | Python 版（`C:\dev\aegis`） | Electron 版（`C:\dev\aegis-electron`） |
|---|---|---|---|
| 1 | 解锁 / 创建密码库 | ✅ `aegis_desktop/lock.py` | ✅ `src/renderer/src/Gate.tsx` |
| 2 | 条目增删改 / 批量删除 | ✅ `window.py` + `entry_dialog.py` | ✅ `VaultStore` + `EntryModal.tsx` + `BulkDelete.tsx` |
| 3 | 密码生成器 / 中文口令 | ✅ `generator_dialog.py` | ✅ `generate.ts` + `GeneratorModal.tsx` |
| 4 | TOTP 动态码 | ✅ `aegis_core/totp.py` | ✅ `totp.ts` + `TotpCard.tsx` |
| 5 | 命令面板 `Ctrl+K` | ✅ `window.py` | ✅ `CommandPalette.tsx` |
| 6 | 密码健康 / HIBP | ✅ `health.py` + `health_dialog.py` | ✅ `health.ts` + `hibp.ts` + `HealthPage.tsx` |
| 7 | 自动锁定 / 剪贴板自清 | ✅ `window.py` | ✅ `prefs.ts` + `main/index.ts` |
| 8 | 导入导出（多格式） | ✅ `importer.py` + `import_cli.py` | ✅ `portable.ts` + `ImportExport.tsx`（**有预览，这点不比 Python 差**）|
| 9 | 设置页 | ✅ `settings_dialog.py`（含「快捷键与自动填充」节、288 行）| ⚠️ `SettingsPage.tsx`（只有 安全/生成器/外观/数据/关于，252 行）|
| 10 | **修改主密码** | ✅ `window.py:1437 change_master_password` + `vault.py:232`（只重包 DEK）| ❌ **完全没有**（`changePassword`/`change_password`/`修改主密码` 命中 0）|
| 11 | **重置密码库（忘记主密码）** | ✅ `lock.py:324 _forgot_password` + `vault.py reset_vault` | ❌ **完全没有**（`reset` 命中 0）<br>`Gate.tsx` 只有 1 个按钮：解锁 |
| 12 | **历史版本 / 回滚** | ✅ `aegis_core/history.py`(69) + `history_dialog.py`(93) | ❌ `history` 命中 0 |
| 13 | **加密分享包（导出/导入）** | ✅ `share.py`(397) + `share_dialog.py`(516) + `share_cli.py` | ❌ `share` 命中 0 |
| 14 | **快速填充 / 自动填充** | ✅ `quick_fill.py`(498) + `autotype.py`(380) + `autotype_win.py`(246) | ❌ `autotype`/`quick_fill` 命中 0 |
| 15 | **全局热键** | ✅ `hotkeys.py`(244) | ❌ `hotkey` 命中 0 |
| 16 | **Windows Hello 解锁** | ✅ `hello.py`(293) + `lock.py:375 _unlock_hello` | ❌ `hello` 命中 0（唯一「指纹」是 health.ts 注释）|
| 17 | **系统托盘常驻** | ✅ `window.py:279 QMenu` 托盘菜单 | ❌ `tray` 命中 0 |
| 18 | **清空全部密码** | ✅ `window.py:606 _clear_all` | ❌ 没有 |
| 19 | **单实例保护** | ❌ 无 | ❌ 无（**两版都缺**）|

> 注：列 10–18 共 9 项是 Electron 版**真缺失**；列 9 是部分缺失；列 19 是**两版共同缺陷**。

## 三、Python 版「更多」菜单（`window.py:593-608`）

这十项就是 Electron 版侧边栏没有的：

```
新增条目…
快速填充（自动填写到其他窗口）…      ← Electron 缺
密码健康…
──────────
批量导入（CSV / TXT / JSON / KeePass）…
──────────
全局设置（快捷键 · 自动填充）…        ← Electron 缺
修改主密码                            ← Electron 缺
──────────
导出加密分享包…                       ← Electron 缺
导入分享包…                           ← Electron 缺
──────────
清空全部密码…                         ← Electron 缺
──────────
打开密码库所在目录
```

## 四、用户点名的「不能重置密码库」

**两件事被混在了一起，Electron 版**两件都没有**：**

### 4.1 重置密码库 = 忘记主密码时的后路

Python 版入口：解锁页底部「忘记主密码」（`lock.py:324 _forgot_password`）。语义：

1. 弹红色警告，明确告知**零知识没有后门，旧数据不可恢复**；
2. 二次确认（默认按钮是「取消」）；
3. 输入新主密码两次 + 新提示语；
4. 调 `reset_vault()`：把旧库另存为 `<库名>.<时间戳>.bak` → 生成全新 DEK + 新密钥槽 → 覆盖写回原路径；
5. 结果：新库为空，旧数据仍在 `.bak` 里（想起旧密码才能打开）。

Electron 版：`Gate.tsx` 一共 90 行，只有一个 `<button>`（第 84 行）——「创建并进入」/「解锁」。**没有任何「忘记主密码」入口**，也没有 `resetVault` 这个 IPC。

### 4.2 修改主密码 = 还记得旧密码，只想换

Python 版：`window.py:1437`，校验旧密码 → 用新 KEK 重包**同一个 DEK**（`vault.py:232`）→ 密文一条不动。

Electron 版：同样没有。设置页「数据」节只有 导入 / 导出 / 备份加密库文件 / 数据目录 四项。

## 五、Electron 版现有能力盘点（用于判断补齐难度）

- **`src/core/` 11 个模块**：crypto / formats / generate / health / hibp / portable / prefs / settings / strength / totp / types / vault
- **`VaultStore` 只有 7 个方法**：`lock / list / add / addMany / update / remove / removeMany`
  - 注意：**没有 `reset`、没有 `changePassword`、没有历史快照**
- **31 个 IPC handler**：`app:*`(5) `clip:*`(2) `greet` `health:report` `portable:*`(3) `pw:*`(2) `settings:*`(2) `totp:code` `vault:*`(10) `win:*`(3)
- **13 个 React 组件**：App / BulkDelete / ColoredPassword / CommandPalette / EntryModal / Gate / GeneratorModal / HealthPage / ImportExport / SettingsPage / Toast / TotpCard / api / main

> 也就是说：缺失的 9 项功能在 Electron 侧**一行代码都没有**，不是「隐藏了入口」或「有 bug」，是**从没实现**。

## 六、补齐方案与优先级

按「用户感知强度 ÷ 实现成本」排序：

### P0 — 安全兜底，必须先补

| 功能 | 工作量 | 说明 |
|---|---|---|
| **单实例保护** | 小（~20 行） | `app.requestSingleInstanceLock()`；拿不到锁就聚焦已有窗口并退出。**这是空库事故的根因**，不做会再发生 |
| **修改主密码** | 小–中 | `VaultStore.changePassword(old, new)`：校验旧密码 → 用新 KEK 重包同一 DEK → 落盘。UI 放设置页「安全」节 |
| **重置密码库** | 中 | 主进程加 `vault:reset`：改名备份 → 建新空库覆盖。UI 在 `Gate.tsx` 加「忘记主密码」链接 + 红色二次确认弹窗 |
| **清空全部密码** | 小 | `VaultStore.clearAll()` + 二次确认。和重置的区别是保留主密码 |

### P1 — 明显功能落差

| 功能 | 工作量 | 说明 |
|---|---|---|
| **历史版本 / 回滚** | 中 | 参照 `history.py`：每次写入前快照到 `history/`，UI 一个时间线列表 + 回滚按钮 |
| **加密分享包** | 大 | 参照 `share.py`(397 行)：独立口令派生 KEK 加密导出包，导入时处理 id 冲突（Python 版会 `rekeyed`）|
| **系统托盘** | 小 | `Tray` + 菜单（显示主窗口 / 锁定 / 退出）。Electron 原生支持，非常快 |

### P2 — 锦上添花

| 功能 | 工作量 | 说明 |
|---|---|---|
| 全局热键 | 中 | `globalShortcut.register()`，但**沙箱/权限在部分平台要额外处理** |
| Windows Hello 解锁 | 大 | Electron 侧需要 native 模块（`node-ffi` 或自写 addon）走 WinRT `UserConsentVerifier`，是这 9 项里最重的 |
| 快速填充 / 自动填充 | 很大 | 要模拟键盘输入到别的窗口，Electron 无原生能力，得装 native 依赖（类似 `node-key-sender`），**且和「不注入输入事件」的测试约定冲突** |

## 七、⚠️ 顺带发现的严重缺陷：没有单实例保护

2026-10-02 那次「密码库变空库」（`Aegis\aegis.vault.json` 变成 551 B / 0 条目）的时间线：

- 09:40:30 与 09:40:46，**两个 PyInstaller 版 `Aegis.exe` 相继启动**（桌面快捷方式被双击两次，`Get-Process` 确认 Path）；
- 两个进程同时持有同一个库文件句柄；
- 09:41:17，库文件被写成空库。

两版都**没有** `requestSingleInstanceLock` / `QLocalServer` / 命名互斥量。同时开两个进程操作同一个库文件，会出现「后写覆盖先写」。这不是理论风险，是**已经发生过的数据丢失**。

**建议：P0 第一项就做它。**Electron 侧实现极简单：

```ts
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
```

Python 侧用 `QLocalServer` 或 `CreateMutexW`（命名互斥量，名字里带库文件路径哈希）。

## 八、README 表述需要修正

`aegis-electron/README.md:3` 写着：

> 与 Tauri 版（`C:\dev\aegis2`）**完全同 UI 同功能目标**，专供技术选型对比。

「完全同功能目标」在缺失 9 项功能的情况下**不成立**，属误导。建议改成如实描述，例如：

> 与 Tauri 版同 UI 骨架、同加密核心；**当前功能覆盖为子集**，缺失项见 `docs/feature-gap-vs-python.md`。
> 定位：技术选型对比样本，非完整替代品。

顶层 `aegis/README.md:396` 那句「功能对齐（解锁 / 增删改 / 导入导出 / 自动填充设置）」也只对 Web 端成立，不适用于 Electron 端。
