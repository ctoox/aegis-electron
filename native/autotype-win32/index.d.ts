/**
 * N-API 模块 `autotype_win32` 的类型声明。
 *
 * 与 `aegis_desktop/autotype_win.py` 逐函数对应，**唯一签名差异是 hwnd 用字符串**：
 * HWND 在 Win64 上是指针宽度，JS 的 number（double）整数只精确到 2^53。
 * 见 docs/AUTOTYPE-DESIGN.md 4.4。
 *
 * 注意本模块**只在 Windows 上构建**，非 Windows 平台由 JS 层直接返回"不可用"，
 * 正常情况下根本不会被加载（见 src/main/autotype-native.ts）。
 */

/** `available()` 的结果。`ok` 为假时 `reason` 是给用户看的一句人话 */
export interface Availability {
  ok: boolean;
  reason: string;
}

/**
 * 当前桌面能不能接受按键注入。
 * 锁屏 / UAC 安全桌面 / 远程会话切换中会返回 `ok:false` —— 提前查出来告诉用户，
 * 比让他对着"按了没反应"猜要强。
 */
export function available(): Availability;

/**
 * 把整串文本按 UTF-16 码元逐个发出去（走 KEYEVENTF_UNICODE 通道）。
 * 返回 false 表示被系统拒收（典型是 UIPI 拦提权窗口）—— 上层据此退回复制。
 *
 * 非 BMP 字符（emoji、生僻字）自动拆成两个连续码元，这正是 Windows 期望的形式。
 */
export function sendText(text: string): boolean;

/** 发一个功能键。名字：Tab / Enter / Escape / Space / Backspace / Delete / Insert / Home / End / PageUp / PageDown / Left / Up / Right / Down */
export function sendKey(name: string): boolean;

/** 当前前台窗口句柄，写成 `"0x00000000000A1B2C"`；没有前台窗口时返回 `"0"` */
export function foregroundWindow(): string;

/** 把指定窗口切到前台。返回是否成功（内部已含 Alt 轻敲兜底） */
export function setForeground(hwnd: string): boolean;

/** 读窗口标题。仅用于界面回显"将要填进哪个窗口"，内部有 200ms 超时防挂 */
export function windowTitle(hwnd: string): string;
