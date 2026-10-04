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
}

export const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 30, 60] as const;
export const CLIP_CLEAR_CHOICES = [0, 10, 20, 30, 60, 120] as const;

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

/** 把任意来源的对象归一化成合法 Settings（逐项兜底，不抛错） */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const theme = o.theme;
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
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_SETTINGS.theme,
    glass: boolOr(o.glass, DEFAULT_SETTINGS.glass),
    closeToTray: boolOr(o.closeToTray, DEFAULT_SETTINGS.closeToTray),
  };
}
