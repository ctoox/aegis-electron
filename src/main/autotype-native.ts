/**
 * 快速填充的「发送层」：加载 N-API 原生模块，并在 JS 侧编排按键时序。
 *
 * 为什么时序放在 JS 而不是 C
 * -------------------------
 * 逐字符延迟（`autotypeTypeDelayMs`）如果用原生里的 `Sleep` 实现，会把 Electron
 * **主进程整个冻住** —— 托盘、自动锁定计时、所有窗口的 IPC 一起卡。
 * 一个 30 字符的密码配上 120ms 延迟就是 3.6 秒假死，用户会以为应用崩了。
 * 放 JS 里用 `await` 就不阻塞事件循环。
 * 所以原生模块只提供"快"的原语，时序由 `runTokens` 在这里编排。
 *
 * 这是与 Python 版的一处**有意差异**：那边 `time.sleep` 直接写在
 * `aegis_desktop/autotype_win.py` 里（Qt 单线程，只卡住自己）。
 *
 * 加载失败一律降级、不抛错
 * ------------------------
 * `.node` 缺失 / 被杀软隔离 / 架构不符时，用户该看到的是
 * 「填入按钮灰掉 + 提示改用复制密码」，而不是一个起不来的应用。
 * 这也顺应了「非 Windows 平台不构建这个模块」的设计（见 docs/AUTOTYPE-DESIGN.md 4.3）。
 */
import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Token } from "../core/autotype";

export interface Availability {
  ok: boolean;
  /** 不可用时给用户看的一句人话 */
  reason: string;
}

/** 与 native/autotype-win32/index.d.ts 一致 */
interface NativeApi {
  available(): Availability;
  sendText(text: string): boolean;
  sendKey(name: string): boolean;
  foregroundWindow(): string;
  setForeground(hwnd: string): boolean;
  windowTitle(hwnd: string): string;
}

const UNSUPPORTED: Availability = {
  ok: false,
  reason: "当前平台不支持自动打字，请用「复制密码」",
};

let native: NativeApi | null = null;
let loadTried = false;
let loadError = "";

/** 相对工程根的 .node 路径（打包后 app.asar → app.asar.unpacked） */
function addonPath(): string {
  const root = app.getAppPath();
  const p = join(root, "native", "autotype-win32", "build", "Release", "autotype_win32.node");
  return p.replace("app.asar", "app.asar.unpacked");
}

/**
 * 懒加载。不在模块导入期做 —— 那样会在 app ready 之前碰 app.getAppPath()，
 * 而且一个用不上的功能不该在启动路径上占时间。
 */
function api(): NativeApi | null {
  if (loadTried) return native;
  loadTried = true;

  if (process.platform !== "win32") return null;

  try {
    // 用运行期算出来的绝对路径 require，而不是静态 import ——
    // 这样打包器不会试图把它打进 bundle（.node 是二进制，打不进去）
    const req = createRequire(join(app.getAppPath(), "package.json"));
    const mod = req(addonPath()) as Partial<NativeApi>;
    if (typeof mod?.sendText !== "function" || typeof mod?.sendKey !== "function") {
      loadError = "模块加载成功但接口不完整（可能版本不匹配）";
      console.warn("[autotype]", loadError);
      return null;
    }
    native = mod as NativeApi;
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    console.warn(`[autotype] 原生模块加载失败，快速填充将只能复制密码：${loadError}`);
    native = null;
  }
  return native;
}

/** 当前环境能不能真的打字，以及为什么不能 */
export function availability(): Availability {
  if (process.platform !== "win32") return UNSUPPORTED;
  const n = api();
  if (!n) {
    return {
      ok: false,
      reason: loadError
        ? "自动打字组件不可用（未随包分发或被杀毒软件拦截），请用「复制密码」"
        : "自动打字组件不可用，请用「复制密码」",
    };
  }
  return n.available();
}

/** 给设置页/排障用的一句话状态 */
export function debugInfo(): { platform: string; loaded: boolean; error: string } {
  api();
  return { platform: process.platform, loaded: native !== null, error: loadError };
}

// ---------------------------------------------------------------- hwnd 归一化
//
// ⚠️ 这一节是踩过坑之后加的，别删。
//
// 原生模块把句柄格式化成 **大写** 十六进制（"0x00000000002708FC"），
// 而 JS 侧用 `(n).toString(16)` 拼出来的是 **小写**（"0x00000000002708fc"）。
// 两者数值相同、`parse_hwnd` 也都认，所以**功能看起来完全正常** ——
// 但 `a === b` 的字符串比较会静默为假。最初 write 的 `ownHwnds().has(target)`
// 就踩了这个坑：它永远返回 false，于是"目标窗口是不是神盾自己"永远判错，
// 会往神盾自己的窗口里打字（用户看到的是"填了个寂寞"）。
//
// 所以：模块内部**任何**句柄比较都必须先过 normalizeHwnd。

/** 统一成 "0x" + 16 位大写十六进制；"0" 表示没有窗口 */
export function normalizeHwnd(h: string): string {
  if (!h) return "0";
  const s = h.trim();
  if (s === "0") return "0";
  try {
    const v = s.toLowerCase().startsWith("0x") ? BigInt(s) : BigInt(s.replace(/\D/g, "") || "0");
    if (v === 0n) return "0";
    return "0x" + v.toString(16).toUpperCase().padStart(16, "0");
  } catch {
    // 解析不了就原样返回（不做大小写变换：变了反而可能让两个不同的坏值"看起来相等"）
    return s;
  }
}

/** 比较两个句柄是不是同一个窗口（大小写/前导零都容错） */
export function sameHwnd(a: string, b: string): boolean {
  return normalizeHwnd(a) === normalizeHwnd(b);
}

// ---------------------------------------------------------------- 快封装（同步）

/** 当前前台窗口句柄（十六进制字符串；无前台窗口时 "0"） */
export function foregroundWindow(): string {
  return normalizeHwnd(api()?.foregroundWindow() ?? "0");
}

export function windowTitle(hwnd: string): string {
  const h = normalizeHwnd(hwnd);
  if (h === "0") return "";
  return api()?.windowTitle(h) ?? "";
}

// ---------------------------------------------------------------- 时序编排（异步）

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 按序执行按键序列。`delayMs` 是**逐字符之间**的间隔（0 = 不等待）。
 *
 * 返回 false = 中途被系统拒收（典型是 UIPI 拦提权窗口）或模块不可用，
 * 调用方据此退回复制到剪贴板 —— 这是唯一可靠的成功/失败信号。
 */
export async function runTokens(tokens: readonly Token[], delayMs = 0): Promise<boolean> {
  const n = api();
  if (!n) return false;
  const gap = Math.max(0, Math.min(1000, Math.trunc(delayMs || 0)));

  for (const t of tokens) {
    if (t.kind === "empty") continue;
    if (t.kind === "delay") {
      await sleep(Math.trunc(Number(t.value) || 0));
      continue;
    }
    if (t.kind === "key") {
      if (!n.sendKey(String(t.value))) return false;
      continue;
    }

    const s = String(t.value);
    if (gap === 0) {
      // 常见路径：一次调用发完，快
      if (!n.sendText(s)) return false;
    } else {
      // 逐 UTF-16 码元发（与 Python 版逐字符的粒度一致；emoji 自动拆成两个码元）
      for (let i = 0; i < s.length; i++) {
        if (!n.sendText(s[i]!)) return false;
        if (i + 1 < s.length) await sleep(gap);
      }
    }
  }
  return true;
}

/**
 * 切到目标窗口并等它稳定。
 *
 * `settleMs` 的等待在 JS 里做（原生模块里没有 Sleep，理由见文件头）。
 *
 * 判定以「实际前台是谁」为准，而不是 `setForeground` 的返回值 ——
 * 有些窗口会立刻把前台让回来（置顶工具窗之类），那种情况填进去就是填错窗口。
 *
 * **要重试而不是只试一次**：实测中发现，只要有第三方进程恰好在切换的瞬间
 * 抢一下焦点（验证脚本里跑 PowerShell 就复现过），单次判定会误报失败 ——
 * 于是明明能打字却退回复制，用户看到的是「快速填充坏了」。
 * 重试 3 次、每次 120ms，最坏多花 360ms，换掉的是这个误报。
 */
export async function focusTarget(hwnd: string, settleMs = 120, attempts = 3): Promise<boolean> {
  const n = api();
  const target = normalizeHwnd(hwnd);
  if (!n || target === "0") return false;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    n.setForeground(target);
    await sleep(Math.max(0, settleMs));
    // 必须用归一化后的比较 —— 见上面 hwnd 归一化一节的说明
    if (sameHwnd(n.foregroundWindow(), target)) return true;
  }
  return false;
}
