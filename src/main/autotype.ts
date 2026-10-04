/**
 * 快速填充的**编排层**（主进程）。
 *
 * 职责：抓目标窗口、管填充面板窗口、跑「等待选目标」状态机、在受挫时降级，
 * 以及注册 `atype:*` 这一族 IPC。
 * 序列怎么编译在 `src/core/autotype.ts`（纯），字怎么打进去在 `./autotype-native.ts`。
 * 设计全文见 docs/AUTOTYPE-DESIGN.md。
 *
 * 三处最容易写错、且错了很难查的地方，都在下面标了 ★：
 *   1. 抓目标窗口的时机（必须在显示自己之前）
 *   2. 面板是"密码盲"的（不下发 password 字段）
 *   3. 句柄比较必须先归一化（大小写陷阱）
 */
import { BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen } from "electron";
import { join } from "node:path";
import {
  buildSequence,
  isFillable,
  modeSummary,
  preview,
  type ArmState,
  type FillAction,
  type FillItem,
  type RunResult,
  type Token,
} from "../core/autotype";
import type { FillMode, Settings } from "../core/prefs";
import type { Entry } from "../core/types";
import type { VaultStore } from "../core/vault";
import * as atype from "./autotype-native";

export type { FillItem, RunResult };

/** 主进程那边的能力，用注入避免与 index.ts 形成循环依赖 */
export interface AutotypeDeps {
  getVault: () => VaultStore | null;
  getSettings: () => Settings;
  getMainWindow: () => BrowserWindow | null;
  /** 复用现有的剪贴板定时清空逻辑（它已经处理了"内容被改过就别清"等细节） */
  copyToClipboard: (text: string) => { clearIn: number };
  /** 刷新自动锁定计时（用面板也算活动） */
  touch: () => void;
  /** 往主窗口推一条提示（走现有 Toast） */
  notify: (msg: string) => void;
}

const PANEL_W = 468;
/** 高度随内容变（渲染完自己上报），这个是初值与上下限 */
const PANEL_DEFAULT_H = 320;
const PANEL_MIN_H = 120;
const PANEL_MAX_H = 560;
/** 从神盾内部唤起时，等用户点目标窗口的上限 */
const AWAIT_MS = 10_000;
const AWAIT_POLL_MS = 120;

/** 本文件里的等待都走它（原生模块里刻意没有 Sleep，理由见 autotype-native.ts 文件头） */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** 解析出实际主题。跟系统时由主进程判定，不把这个判断留给面板 */
function resolvedTheme(s?: Settings | null): "light" | "dark" {
  if (s?.theme === "light") return "light";
  if (s?.theme === "dark") return "dark";
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/** 面板窗口底色。给个与主题一致的实底，避免唤出瞬间白闪 */
const PANEL_BG = { light: "#f5f5f7", dark: "#1c1c1e" } as const;

let deps: AutotypeDeps | null = null;
let panel: BrowserWindow | null = null;
let panelReady: Promise<void> | null = null;
let panelShownAt = 0;
/** 最近一次唤出时抓到的目标（面板里的动作都填到它） */
let armed: { target: string; targetIsSelf: boolean } | null = null;
/**
 * 最近一次推给面板的状态。面板除了订阅 `atype:arm`，挂载后还会主动拉一次 ——
 * 因为主进程的 `send` 有可能早于渲染层的监听注册（见 ArmState.seq 的说明）。
 */
let armedState: ArmState | null = null;
let armSeq = 0;
let awaitToken: { cancelled: boolean } | null = null;
let awaitTimer: NodeJS.Timeout | null = null;

// ============================================================ 窗口句柄

function handleOf(win: BrowserWindow): string {
  try {
    const buf = win.getNativeWindowHandle();
    // Windows 上 getNativeWindowHandle() 返回 8 字节小端 HWND
    const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
    return atype.normalizeHwnd("0x" + v.toString(16));
  } catch {
    return "0";
  }
}

/**
 * ★ 这一族比较必须走归一化。
 * 原生模块返回**大写**十六进制，而 `toString(16)` 拼出来是**小写** ——
 * 数值相同、功能照常，但 `===` 会静默为假。踩过一次：
 * 于是"目标窗口是不是神盾自己"永远判错，会往自己窗口里打字。
 */
function ownHwnds(): Set<string> {
  const out = new Set<string>();
  for (const w of [deps?.getMainWindow() ?? null, panel]) {
    if (w && !w.isDestroyed()) {
      const h = handleOf(w);
      if (h !== "0") out.add(h);
    }
  }
  return out;
}

function isOwn(hwnd: string): boolean {
  return hwnd === "0" || ownHwnds().has(atype.normalizeHwnd(hwnd));
}

// ============================================================ 面板窗口

function placeNearCursor(win: BrowserWindow): void {
  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;
  const { width, height } = win.getBounds();
  let x = Math.round(pt.x - width / 2);
  let y = Math.round(pt.y + 18);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));
  // 光标太靠下就翻到上方，避免面板被压出屏幕
  if (y + height > wa.y + wa.height - 8) y = Math.round(pt.y - height - 18);
  y = Math.max(wa.y + 8, y);
  win.setBounds({ x, y, width, height });
}

function ensurePanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;

  const win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_DEFAULT_H,
    // 独立窗口而不是主窗口的子窗口 —— 设 parent 会让它跟着主窗口一起最小化
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 临时面板不该占任务栏
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // 刻意**不用**透明 + 圆角：项目里已经吃过"无边框窗口在远控采集下黑屏/不可见"
    // 的亏（见 frame 与 Material 那几处注释）。一个直角 + 细边框的小面板，
    // 少一个平台相关的失败模式，值。
    backgroundColor: PANEL_BG[resolvedTheme(deps?.getSettings())],
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // pop-up-menu 层能盖住普通置顶窗口
  win.setAlwaysOnTop(true, "pop-up-menu");

  // Esc / 关闭一律只隐藏，不销毁 —— 下次唤出才快
  win.on("close", (e) => {
    e.preventDefault();
    win.hide();
  });
  // 点到别处就收起。刚显示那一下的 blur 是"焦点还没稳住"，要忽略
  win.on("blur", () => {
    if (Date.now() - panelShownAt < 250) return;
    if (win.isVisible()) cancelPending();
  });
  win.on("closed", () => {
    panel = null;
    panelReady = null;
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) win.loadURL(`${devUrl}#/fill`);
  else win.loadFile(join(__dirname, "../renderer/index.html"), { hash: "/fill" });

  panelReady = new Promise<void>((res) => {
    win.webContents.once("did-finish-load", () => res());
  });

  panel = win;
  return win;
}

function resizePanel(contentHeight: number): void {
  if (!panel || panel.isDestroyed()) return;
  const height = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, Math.round(contentHeight) || PANEL_MIN_H));
  const b = panel.getBounds();
  if (b.height === height) return;
  // 先按新高度放回去，再夹一次屏幕边界（变高后底部可能出屏）
  panel.setBounds({ ...b, height });
  placeNearCursor(panel);
}

/** 面板是不是正显示着 —— index.ts 的「失焦即锁」要用它让路，见 docs/AUTOTYPE-DESIGN.md 5.5 */
export function isPanelVisible(): boolean {
  return panel !== null && !panel.isDestroyed() && panel.isVisible();
}

/** 取消「等待选目标」并收起面板 */
export function cancelPending(): void {
  if (awaitToken) awaitToken.cancelled = true;
  awaitToken = null;
  if (awaitTimer) {
    clearTimeout(awaitTimer);
    awaitTimer = null;
  }
  if (panel && !panel.isDestroyed() && panel.isVisible()) panel.hide();
  armed = null;
}

// ============================================================ 唤出

/**
 * 唤出填充面板。
 *
 * ★ 抓目标窗口必须发生在**显示自己之前** —— 迟一步拿到的就是神盾自己。
 * （Python 版在 quick_fill.py:217 专门写了这条注释，是同一个坑。）
 */
export async function openPanel(preselect = ""): Promise<boolean> {
  if (!deps) return false;
  const vault = deps.getVault();
  if (!vault?.unlocked) {
    deps.notify("请先解锁密码库");
    return false;
  }

  const raw = atype.foregroundWindow();
  const targetIsSelf = isOwn(raw);
  const av = atype.availability();
  const s = deps.getSettings();

  const win = ensurePanel();
  await panelReady;
  if (panel !== win) return false; // 等待期间被关掉了

  armed = { target: raw, targetIsSelf };
  const theme = resolvedTheme(s);
  const payload: ArmState = {
    seq: ++armSeq,
    targetTitle: s.autotypeShowTargetTitle ? atype.windowTitle(raw) : "",
    canType: av.ok,
    canTypeReason: av.reason,
    fillingSelf: targetIsSelf,
    preselect,
    theme,
  };
  armedState = payload;
  // 主题可能在面板创建之后改过，每次唤出都同步一次底色
  win.setBackgroundColor(PANEL_BG[theme]);
  win.webContents.send("atype:arm", payload);

  placeNearCursor(win);
  panelShownAt = Date.now();
  win.show();
  win.focus();
  return true;
}

// ============================================================ 执行

function entryLabel(e: Entry): string {
  return e.title || "（无标题）";
}

/** 打不了字时的兜底：复制到剪贴板，并复用现有的定时清空 */
function copyPassword(entry: Entry, noticeText: string, ok: boolean): RunResult {
  if (!deps) return { ok: false, how: "failed", notice: noticeText };
  const pw = entry.password ?? "";
  if (!pw) {
    const notice = "这条没有密码可复制";
    deps.notify(notice);
    return { ok: false, how: "failed", notice };
  }
  const { clearIn } = deps.copyToClipboard(pw);
  const notice = clearIn > 0 ? `${noticeText}（${clearIn} 秒后自动清空剪贴板）` : noticeText;
  deps.notify(notice);
  return { ok, how: "copied", notice };
}

/** 降级路径：本来想打字，打不了，只好复制（ok=false，用户该知道没填进去） */
function copyFallback(entry: Entry, why: string): RunResult {
  return copyPassword(entry, why, false);
}

async function fillInto(entry: Entry, tokens: Token[], target: string): Promise<RunResult> {
  if (!deps) return { ok: false, how: "failed", notice: "内部状态丢失" };
  if (!(await atype.focusTarget(target, 140))) {
    return copyFallback(entry, "无法切回目标窗口，已改为复制密码");
  }
  const typed = await atype.runTokens(tokens, deps.getSettings().autotypeTypeDelayMs);
  if (!typed) {
    return copyFallback(entry, "目标窗口拒收了按键（可能是管理员权限窗口），已改为复制密码");
  }
  const notice = `已填入「${entryLabel(entry)}」（${modeSummary(entry, deps.getSettings().autotypeDefaultMode)}）`;
  deps.notify(notice);
  return { ok: true, how: "typed", notice };
}

/**
 * 「等待选目标」：从神盾内部唤起时前台就是自己，没有"刚才的窗口"可回。
 * 轮询 10 秒，用户点哪个非神盾窗口就填到哪。
 */
function startAwait(entry: Entry, tokens: Token[]): RunResult {
  if (!deps) return { ok: false, how: "failed", notice: "内部状态丢失" };
  const own = ownHwnds();
  const deadline = Date.now() + AWAIT_MS;
  const token = { cancelled: false };
  awaitToken = token;

  deps.notify(`请在 ${AWAIT_MS / 1000} 秒内点一下目标窗口的输入框，神盾会自动填入…`);

  const tick = async (): Promise<void> => {
    awaitTimer = null;
    if (token.cancelled || !deps) return;

    // ★ 超时优先判 —— 截止之后不再认任何前台窗口。
    //   否则截止那一瞬间刚好有窗口活动，就会在用户已经放弃之后突然往那儿打字。
    if (Date.now() > deadline) {
      copyFallback(entry, "超时没有切到其他窗口，已改为复制密码");
      return;
    }

    const hwnd = atype.foregroundWindow();
    // 用一开始就抓好的集合，轮询期间自己的窗口不会变；
    // 顺便省掉每 120ms 重新算一次句柄
    if (!hwnd || hwnd === "0" || own.has(hwnd)) {
      // 还是我们自己的窗口（用户还没点过去），继续等
      awaitTimer = setTimeout(() => void tick(), AWAIT_POLL_MS);
      return;
    }

    // 用户切过去了。等这一下点击彻底稳定再动手（Python 版这里同样是 250ms）
    await sleep(250);
    if (token.cancelled) return;

    if (!(await atype.focusTarget(hwnd, 120, 2))) {
      copyFallback(entry, "无法切到目标窗口，已改为复制密码");
      return;
    }
    const typed = await atype.runTokens(tokens, deps.getSettings().autotypeTypeDelayMs);
    if (typed) {
      const notice = `已填入「${entryLabel(entry)}」（${modeSummary(entry, deps.getSettings().autotypeDefaultMode)}）`;
      deps.notify(notice);
    } else {
      copyFallback(entry, "目标窗口拒收了按键（可能是管理员权限窗口），已改为复制密码");
    }
  };

  awaitTimer = setTimeout(() => void tick(), AWAIT_POLL_MS);
  return { ok: true, how: "waiting", notice: "等待你切换到目标窗口…" };
}

async function runFill(id: string, action: FillAction): Promise<RunResult> {
  if (!deps) return { ok: false, how: "failed", notice: "内部状态丢失" };
  deps.touch();
  const target = armed?.target ?? "0";
  cancelPending();

  const vault = deps.getVault();
  if (!vault?.unlocked) return { ok: false, how: "failed", notice: "密码库未解锁" };
  const entry = vault.get(id);
  if (!entry) return { ok: false, how: "failed", notice: "条目不存在（可能已被删除）" };

  // 显式"只复制密码"：不打字，所以管理员窗口也能用（Python 版的 Alt+C）
  if (action === "copy") return copyPassword(entry, "已复制密码", true);

  const s = deps.getSettings();
  let tokens: Token[];
  try {
    tokens = buildSequence(entry, {
      mode: action as FillMode | null,
      autoSubmit: s.autotypeAutoSubmit,
      defaultMode: s.autotypeDefaultMode,
    });
  } catch (e) {
    const notice = e instanceof Error ? e.message : String(e);
    deps.notify(notice);
    return { ok: false, how: "failed", notice };
  }

  const av = atype.availability();
  if (!av.ok) return copyFallback(entry, `${av.reason}，已改为复制密码`);

  if (isOwn(target)) return startAwait(entry, tokens);
  return fillInto(entry, tokens, target);
}

// ============================================================ 条目视图

function fillItems(): FillItem[] {
  if (!deps) return [];
  const vault = deps.getVault();
  if (!vault?.unlocked) return [];
  const dm = deps.getSettings().autotypeDefaultMode;
  return vault
    .list()
    .filter(isFillable)
    .map((e) => ({
      id: e.id,
      title: e.title,
      username: e.username,
      url: e.url,
      type: e.type,
      modeSummary: modeSummary(e, dm),
      // ★ 这里**不要**加 password。面板是"密码盲"的，
      //   打字所需的明文只在主进程里取（见 docs/AUTOTYPE-DESIGN.md 5.3）。
      //   scripts/shot-ui.mjs 有一条探针专门断言这个返回里没有 password 键 ——
      //   加一行 `password: e.password` 就能看到它变红。
    }));
}

// ============================================================ 热键

let registeredHotkey = "";
let hotkeyReason = "";

export function hotkeyStatus(): { hotkey: string; registered: boolean; reason: string } {
  return { hotkey: registeredHotkey, registered: Boolean(registeredHotkey), reason: hotkeyReason };
}

/** 换绑全局快捷键。返回是否成功 —— 失败必须在设置页显式报出来，不能静默 */
export function applyHotkey(hotkey: string, onTrigger: () => void): { ok: boolean; reason: string } {
  if (registeredHotkey) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch {
      /* 已经没了 */
    }
    registeredHotkey = "";
  }
  const key = (hotkey ?? "").trim();
  if (!key) {
    // 空 = 主动关掉（比如总开关关了）。不设 reason ——
    // 否则设置页会把"功能已关闭"渲染成一个红色错误。
    hotkeyReason = "";
    return { ok: false, reason: "" };
  }
  try {
    if (globalShortcut.register(key, onTrigger)) {
      registeredHotkey = key;
      hotkeyReason = "";
      return { ok: true, reason: "" };
    }
    hotkeyReason = "该快捷键已被其他程序占用";
  } catch (e) {
    hotkeyReason = `快捷键无效：${e instanceof Error ? e.message : String(e)}`;
  }
  return { ok: false, reason: hotkeyReason };
}

// ============================================================ 注册 IPC

export interface AutotypeHandle {
  openPanel: (preselect?: string) => Promise<boolean>;
  cancelPending: () => void;
  isPanelVisible: () => boolean;
  applyHotkey: (hotkey: string, onTrigger: () => void) => { ok: boolean; reason: string };
  hotkeyStatus: () => { hotkey: string; registered: boolean; reason: string };
}

export function registerAutotype(d: AutotypeDeps): AutotypeHandle {
  deps = d;

  ipcMain.handle("atype:available", () => atype.availability());

  // 面板挂载后主动拉一次当前状态（订阅可能晚于 send，见 ArmState.seq 的说明）
  ipcMain.handle("atype:armState", () => armedState);

  // 从界面里唤起（侧栏菜单）。preselect 一般是当前选中条目的标题 ——
  // 面板直接把列表过滤到那一条，回车即填，不用再搜一遍。
  ipcMain.handle("atype:open", (_e, preselect?: string) => openPanel(preselect ?? ""));

  ipcMain.handle("atype:entries", () => {
    d.touch();
    return fillItems();
  });

  ipcMain.handle("atype:preview", (_e, id: string, mode: FillMode | null) => {
    const s = d.getSettings();
    const entry = d.getVault()?.get(id);
    if (!entry) return { text: "条目不存在" };
    return {
      text: preview(entry, {
        mode,
        defaultMode: s.autotypeDefaultMode,
        autoSubmit: s.autotypeAutoSubmit,
      }),
    };
  });

  ipcMain.handle("atype:run", (_e, id: string, action: FillAction) => runFill(id, action));

  ipcMain.handle("atype:cancel", () => {
    cancelPending();
    return true;
  });

  ipcMain.handle("atype:resize", (_e, contentHeight: number) => {
    resizePanel(contentHeight);
    return true;
  });

  // 设置页要显示"热键到底注册上没有"
  ipcMain.handle("atype:hotkeyStatus", () => hotkeyStatus());

  return { openPanel, cancelPending, isPanelVisible, applyHotkey, hotkeyStatus };
}

/** 退出前清干净（keyup 卡住会让系统以为某个键一直按着） */
export function shutdownAutotype(): void {
  cancelPending();
  if (panel && !panel.isDestroyed()) {
    panel.destroy();
    panel = null;
  }
  if (registeredHotkey) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch {
      /* ignore */
    }
    registeredHotkey = "";
  }
}
