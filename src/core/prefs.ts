/**
 * 设置项的**结构与校验** (纯 TS, 零 Node 依赖).
 *
 * 为什么单独一个文件: 设置页要渲染下拉框与开关, 只需要类型 / 默认值 / 可选项;
 * 真正读写文件在 ./settings.ts (用 node:fs)。
 * 若 UI 直接从 settings.ts 取, Vite 会把 node:fs 打进前端产物,
 * 违反本项目「前端零 Node API」的硬约束 (见 docs/OPENSOURCE_REFS.md §2)。
 *
 * 核心不变量: normalizeSettings 对**任意**输入都不抛错, 且输出永远是完整的 Settings。
 */

export type Theme = "light" | "dark" | "system";

/** 条目「怎么填」的四种方式。与 Python 版的 `settings.py:47-52` 同一个取值空间，别改字面量 */
export type FillMode = "both" | "password" | "username" | "custom";

export const FILL_BOTH: FillMode = "both";
export const FILL_PASSWORD: FillMode = "password";
export const FILL_USERNAME: FillMode = "username";
export const FILL_CUSTOM: FillMode = "custom";

export const FILL_MODES: readonly FillMode[] = [
  FILL_BOTH,
  FILL_PASSWORD,
  FILL_USERNAME,
  FILL_CUSTOM,
];

/** 下拉框/列表里显示的名称 */
export const FILL_LABELS: Record<FillMode, string> = {
  both: "用户名 + 密码",
  password: "只填密码",
  username: "只填用户名",
  custom: "自定义模板",
};

/** 设置页里的一句解释 */
export const FILL_HINTS: Record<FillMode, string> = {
  both: "先打用户名，按 Tab 跳到密码框，再打密码（大多数登录页）",
  password: "只打密码。适合分两步登录，或密码框已经聚焦",
  username: "只打用户名",
  custom: "用条目自己的模板；条目没写模板时用 {USERNAME}{TAB}{PASSWORD}{ENTER}",
};

export function isValidFillMode(v: unknown): v is FillMode {
  return typeof v === "string" && (FILL_MODES as readonly string[]).includes(v);
}

export function fillLabel(mode: string): string {
  return isValidFillMode(mode) ? FILL_LABELS[mode] : FILL_LABELS[FILL_BOTH];
}

/**
 * 默认快捷键。用 Electron 的 `CommandOrControl` 写法 ——
 * 它在 Windows/Linux 上解析成 Ctrl、在 macOS 上解析成 Cmd，
 * 与 Python 版的 `Ctrl+Alt+Shift+F` 在 Windows 上等价。
 */
export const DEFAULT_AUTOTYPE_HOTKEY = "CommandOrControl+Alt+Shift+F";

/**
 * 把 Electron 的 accelerator 写法转成给人看的短标签。
 *
 * `CommandOrControl+Alt+Shift+F` → `Ctrl Alt Shift F`（macOS 上是 `⌘ Alt Shift F`）。
 * **只用于展示** —— 回填设置时要用 `CommandOrControl` 那种跨平台写法，
 * 用这个转换过的字符串去 register 会在另一个平台上失效。
 */
export function hotkeyLabel(accelerator: string, platform: string = "win32"): string {
  if (!accelerator) return "";
  const mac = platform === "darwin";
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, mac ? "⌘" : "Ctrl")
    .replace(/\bCommand\b|\bCmd\b/gi, mac ? "⌘" : "Ctrl")
    .replace(/\bControl\b|\bCtrl\b/gi, mac ? "⌃" : "Ctrl")
    .replace(/\bOption\b|\bAlt\b/gi, mac ? "⌥" : "Alt")
    .replace(/\bShift\b/gi, mac ? "⇧" : "Shift")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

export interface Settings {
  /** 闲置自动锁定（分钟），0 = 不自动锁 */
  autoLockMinutes: number;
  /** 窗口失焦立即锁定 */
  lockOnBlur: boolean;
  /** 复制后多少秒清空剪贴板，0 = 不清空 */
  clipboardClearSeconds: number;
  /** 锁库时顺手清空剪贴板 */
  clearClipboardOnLock: boolean;
  /** 健康检查调用 HIBP 泄露检测 */
  hibpEnabled: boolean;
  /** 上次跑泄露检测的时间戳（用于“N 天内不重复联网”节流） */
  lastHealthCheck: number;
  /** 生成器默认长度 */
  genLength: number;
  /** 生成器字符池开关 */
  genUseUpper: boolean;
  genUseLower: boolean;
  genUseDigits: boolean;
  genUseSymbols: boolean;
  /** 生成器默认最少数字位数 */
  genMinDigits: number;
  /** 生成器默认最少符号位数 */
  genMinSymbols: number;
  theme: Theme;
  /** 液态玻璃效果开关 */
  glass: boolean;
  /** 关闭窗口时最小化到托盘（而不是退出应用） */
  closeToTray: boolean;

  // ---- 快速填充 / Auto-Type（见 docs/AUTOTYPE-DESIGN.md）----
  /** 总开关。关掉就不注册全局热键，也不建填充面板窗口 */
  autotypeEnabled: boolean;
  /** 条目没设 `extra.fill` 时用哪种填法 */
  autotypeDefaultMode: FillMode;
  /**
   * 填完自动回车提交。**默认关** —— Auto-Type 无域绑定（不知道目标窗口里是什么网站），
   * 停在输入框里让用户自己按回车，是留给用户"看清楚再提交"的停顿点。别改成默认开。
   */
  autotypeAutoSubmit: boolean;
  /** 逐字符间隔（毫秒）。某些前端要等接口返回才认得输入 */
  autotypeTypeDelayMs: number;
  /** 唤出填充面板的全局快捷键 */
  autotypeHotkey: string;
  /** 在面板顶部回显「将填入：<目标窗口标题>」 */
  autotypeShowTargetTitle: boolean;
}

export const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 30, 60] as const;

/**
 * 剪贴板自动清空的时长（秒）。**0 = 不清空**。
 *
 * 为什么要单独留 300（5 分钟）这一档：用「无界鼠标 / Mouse Without Borders」
 * 这类工具把密码送到另一台机器时，「清空」是一次**真实的剪贴板写入**，会被
 * 镜像过去 —— 于是你刚走到对面要粘贴，那边已经空了。跨机粘贴的时间预算根本
 * 不可控，所以既要给得起长时长，也要允许直接选 0。
 * 选 0 之后靠托盘菜单的「清除剪贴板中的密码」收尾（`wipeClipboard`）。
 */
export const CLIP_CLEAR_CHOICES = [0, 10, 20, 30, 60, 120, 300] as const;

/**
 * 时长的人话标签。设置页的下拉与各处提示语共用同一份，避免出现
 * 「选项里写 5 分钟、提示里写 300 秒」这种同义不同形的说法。
 */
export function clipClearLabel(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "不清空";
  if (secs % 60 === 0) return `${secs / 60} 分钟`;
  return `${secs} 秒`;
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 5,
  lockOnBlur: false,
  clipboardClearSeconds: 30,
  clearClipboardOnLock: true,
  hibpEnabled: true,
  lastHealthCheck: 0,
  genLength: 20,
  genUseUpper: true,
  genUseLower: true,
  genUseDigits: true,
  genUseSymbols: true,
  genMinDigits: 1,
  genMinSymbols: 1,
  theme: "system",
  glass: true,
  closeToTray: false,
  autotypeEnabled: true,
  autotypeDefaultMode: FILL_BOTH,
  autotypeAutoSubmit: false,
  autotypeTypeDelayMs: 0,
  autotypeHotkey: DEFAULT_AUTOTYPE_HOTKEY,
  autotypeShowTargetTitle: true,
};

export const SETTINGS_FILENAME = "aegis.settings.json";

/**
 * 拼接设置文件路径（不依赖 node:path）。
 * 按目录本身用了哪种分隔符来决定——Windows 传 "C:\\...\\userData" 就回 "\\"。
 */
export function settingsPath(userDataDir: string): string {
  const dir = userDataDir.replace(/[\\/]+$/, "");
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir + sep + SETTINGS_FILENAME;
}

function intOr(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * 字符串枚举兜底。抽出来是因为 theme / autotypeDefaultMode 都要用 ——
 * 逐个内联 `v === "a" || v === "b"` 会越长越容易漏一个分支。
 */
function enumOr<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 逐字符延迟的可选项。0 = 不等待；太大的值会让填充看起来像卡住 */
export const AUTOTYPE_DELAY_CHOICES = [0, 10, 30, 60, 120] as const;

const THEMES: readonly Theme[] = ["light", "dark", "system"];

/** 把任意来源的对象归一化成合法 Settings（逐项兜底，不抛错） */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    autoLockMinutes: intOr(o.autoLockMinutes, DEFAULT_SETTINGS.autoLockMinutes, 0, 24 * 60),
    lockOnBlur: boolOr(o.lockOnBlur, DEFAULT_SETTINGS.lockOnBlur),
    clipboardClearSeconds: intOr(
      o.clipboardClearSeconds,
      DEFAULT_SETTINGS.clipboardClearSeconds,
      0,
      600,
    ),
    clearClipboardOnLock: boolOr(o.clearClipboardOnLock, DEFAULT_SETTINGS.clearClipboardOnLock),
    hibpEnabled: boolOr(o.hibpEnabled, DEFAULT_SETTINGS.hibpEnabled),
    lastHealthCheck: intOr(o.lastHealthCheck, DEFAULT_SETTINGS.lastHealthCheck, 0, Number.MAX_SAFE_INTEGER),
    genLength: intOr(o.genLength, DEFAULT_SETTINGS.genLength, 6, 64),
    genUseUpper: boolOr(o.genUseUpper, DEFAULT_SETTINGS.genUseUpper),
    genUseLower: boolOr(o.genUseLower, DEFAULT_SETTINGS.genUseLower),
    genUseDigits: boolOr(o.genUseDigits, DEFAULT_SETTINGS.genUseDigits),
    genUseSymbols: boolOr(o.genUseSymbols, DEFAULT_SETTINGS.genUseSymbols),
    genMinDigits: intOr(o.genMinDigits, DEFAULT_SETTINGS.genMinDigits, 0, 16),
    genMinSymbols: intOr(o.genMinSymbols, DEFAULT_SETTINGS.genMinSymbols, 0, 16),
    theme: enumOr(o.theme, THEMES, DEFAULT_SETTINGS.theme),
    glass: boolOr(o.glass, DEFAULT_SETTINGS.glass),
    closeToTray: boolOr(o.closeToTray, DEFAULT_SETTINGS.closeToTray),
    autotypeEnabled: boolOr(o.autotypeEnabled, DEFAULT_SETTINGS.autotypeEnabled),
    autotypeDefaultMode: enumOr(
      o.autotypeDefaultMode,
      FILL_MODES,
      DEFAULT_SETTINGS.autotypeDefaultMode,
    ),
    autotypeAutoSubmit: boolOr(o.autotypeAutoSubmit, DEFAULT_SETTINGS.autotypeAutoSubmit),
    autotypeTypeDelayMs: intOr(o.autotypeTypeDelayMs, DEFAULT_SETTINGS.autotypeTypeDelayMs, 0, 1000),
    // 快捷键只做「非空字符串」的兜底：真正的合法性由 globalShortcut.register 的返回值判定，
    // 在设置页显示"已被占用/无效"。在这里做格式校验会把合法写法误杀。
    autotypeHotkey:
      typeof o.autotypeHotkey === "string" && o.autotypeHotkey.trim()
        ? o.autotypeHotkey.trim()
        : DEFAULT_SETTINGS.autotypeHotkey,
    autotypeShowTargetTitle: boolOr(
      o.autotypeShowTargetTitle,
      DEFAULT_SETTINGS.autotypeShowTargetTitle,
    ),
  };
}
