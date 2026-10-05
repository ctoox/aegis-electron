import {
  app,
  shell,
  nativeTheme,
  nativeImage,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  Tray,
  clipboard,
  dialog,
} from "electron";
import {
  existsSync,
  copyFileSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isCompositingAccelerated } from "../core/gpu";
import * as os from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  generatePassphrase,
  generatePassword,
  strengthOf,
  GenOptions,
} from "../core/generate";
import { VaultStore } from "../core/vault";
import { totpView } from "../core/totp";
import { KDF_PARAMS } from "../core/crypto";
import { analyzeWithBreach } from "../core/health";
import { makeBreachChecker } from "../core/hibp";
import { listHistory } from "../core/history";
import {
  backupDirFor,
  backupNow,
  listSnapshots,
  restoreSnapshot,
} from "../core/backup";
import {
  bundleFingerprint,
  bundleToJson,
  defaultShareFilename,
  describeBundle,
  exportBundle,
  importBundle,
} from "../core/share";
import {
  FORMATS,
  buildExport,
  parseImport,
  suggestFileName,
  type ExportResult,
  type FormatId,
  type ImportPreview,
} from "../core/portable";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "../core/settings";
import type { Entry, VaultStatus } from "../core/types";
import { Updater } from "./updater";
import { registerAutotype, isPanelVisible, shutdownAutotype } from "./autotype";

let vault: VaultStore | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
/** 自动更新。打包态才构造 (开发态 npm run dev 不该去查线上版本) */
let updater: Updater | null = null;
/** 快速填充编排层 (app ready 之后才有) */
let autotype: ReturnType<typeof registerAutotype> | null = null;
/** 真正要退出时才置 true —— 区分「关窗进托盘」与「退出应用」 */
let isQuitting = false;

/** 用户数据目录 (延迟到 app ready 后取, 保证 app.getPath 可用) */
let userDataDir = "";

function vaultPath(): string {
  // UOS/Linux: ~/.config/aegis-next/...; Windows: %APPDATA%/aegis-next/...
  return join(userDataDir, "aegis.vault.json");
}

function vaultStatus(): VaultStatus {
  return {
    exists: vault !== null || existsSync(vaultPath()),
    unlocked: vault?.unlocked ?? false,
    hint: vault?.hint ?? readHint(vaultPath()),
  };
}

function readHint(p: string): string {
  try {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    return String(doc?.header?.hint ?? "");
  } catch {
    return "";
  }
}

const IS_MAC = process.platform === "darwin";

/**
 * 玻璃材质能力探测 (三层降级):
 *  vibrancy → macOS 系统毛玻璃 (vibrancy: under-window)
 *  acrylic  → Windows 11 22H2+ 系统亚克力 (backgroundMaterial)
 *  mica     → Windows 11 21H2 云母 (backgroundMaterial, 亚克力的前身)
 *  inapp    → 其他 (Win10 / Win7 / Linux/UOS): 系统没有可调用的窗口模糊 API,
 *             改由前端用 backdrop-filter 做"页内玻璃" —— 窗口内自己糊自己
 */
type Material = "vibrancy" | "acrylic" | "mica" | "inapp";

function detectMaterial(): Material {
  if (IS_MAC) return "vibrancy";
  if (process.platform === "win32") {
    const build = Number(os.release().split(".")[2] ?? 0);
    if (build >= 22621) return "acrylic"; // Win11 22H2+
    if (build >= 22000) return "mica"; // Win11 21H2
  }
  return "inapp";
}

const MATERIAL = detectMaterial();
/** 有系统级材质时, 窗口底色必须全透明, 否则系统画的模糊会被不透明底色盖住 */
const NATIVE_MATERIAL = MATERIAL === "vibrancy" || MATERIAL === "acrylic" || MATERIAL === "mica";

/**
 * 硬件加速能力探测。
 *
 * 为什么要专门探这个：浏览器在没有可用 GPU 时会退到 SwiftShader（纯 CPU 软件渲染），
 * 玻璃需要的模糊/渐变/阴影全部按像素在 CPU 上算。表现出来不只是"卡"——
 * 页面切换要重画一大片，CPU 一帧画不完时，合成器会先把**已经画好的分块**呈现出来
 * （栅格顺序大致从左往右、从上往下），肉眼看着就像"整块内容先从左上角冒出来、
 * 再慢慢铺满变大"。用户很容易把它当成布局/动画坏了，其实是没启用硬件加速。
 *
 * **信创机型最容易撞上这条**：兆芯/飞腾等平台的集显驱动常没装，设备管理器里
 * 显示的是"Microsoft 基本显示适配器"，Chromium 就拿不到 GPU。
 * 这不是把某张显卡拉黑，是系统里根本没有可用的 GPU —— 代码层面改不了，只能装驱动。
 *
 * 实测（2026-10-05，兆芯 KX-7000 + Microsoft 基本显示适配器）:
 *   gpu_compositing=rasterization=disabled_software, glRenderer=SwiftShader
 */
function detectAcceleration(): { accelerated: boolean; status: string } {
  // getGPUFeatureStatus 在个别平台/极端情况下会抛 —— 探测类代码不该把应用带崩
  let status: Record<string, string> = {};
  try {
    status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  } catch {
    return { accelerated: true, status: "unknown" }; // 探不出来就不吓唬用户
  }
  const compositing = status.gpu_compositing ?? "unknown";
  return {
    // 判定规则在 src/core/gpu.ts 里, 有单测盯着 —— 别在这里手写 equals,
    // Chromium 还会给 enabled_force / enabled_force_on, 写死会把好机器误报成没加速
    accelerated: isCompositingAccelerated(compositing),
    status: compositing,
  };
}


/**
 * 菜单. macOS 必须要有 App/编辑菜单 —— 否则 Cmd+C/V/X/Q 这些标准快捷键
 * 全都不生效 (Electron 在 mac 上的经典坑: 没有菜单就没有编辑快捷键)。
 * Windows/Linux 自绘标题栏, 不需要原生菜单栏。
 */
function buildMenu(): void {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "编辑",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" }, { role: "zoom" }, { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;

  const win = new BrowserWindow({
    title: "神盾 Aegis",
    width: 1000,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    // 原生材质下窗口底色必须全透明 (系统在窗口背后画模糊);
    // 页内玻璃模式下则给一个与主题一致的实底, 避免启动瞬间白闪
    backgroundColor: NATIVE_MATERIAL ? "#00000000" : dark ? "#1c1c1e" : "#f5f5f7",
    // 系统级毛玻璃: macOS 用 vibrancy, Windows 11 用 backgroundMaterial
    ...(MATERIAL === "vibrancy"
      ? { vibrancy: "under-window" as const, visualEffectState: "active" as const }
      : {}),
    ...(MATERIAL === "acrylic" ? { backgroundMaterial: "acrylic" as const } : {}),
    ...(MATERIAL === "mica" ? { backgroundMaterial: "mica" as const } : {}),
    // 标题栏按平台分支:
    //  macOS → hiddenInset: 保留系统红黄绿圆点(最原生), 内容顶到窗口顶
    //  Windows/Linux → frame:false: 全自绘右三键
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 13 },
        }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 外链走系统浏览器, 不在应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 失焦即锁 (可选)
  win.on("blur", () => {
    // 填充面板是**独立窗口**，一显示就抢走主窗口焦点。不在这里让路的话，
    // 开了「失焦即锁」的用户会在正要填密码的瞬间被锁出去 —— 这不是理论问题，
    // 是必然发生（docs/AUTOTYPE-DESIGN.md 5.5）。
    // scripts/shot-ui.mjs 有一条探针专门盯这个（"开了失焦即锁时弹出填充面板，库仍解锁"）。
    if (isPanelVisible()) return;
    if (settings.lockOnBlur && vault?.unlocked) lockVault("blur");
  });

  // 关窗: 默认退出应用; 开了「关闭时最小化到托盘」就只藏起来 (托盘还在,
  // 点托盘图标能叫回来). 注意必须 preventDefault, 否则窗口真被销毁了,
  // 托盘上就没了可以 show() 的目标.
  win.on("close", (e) => {
    if (!isQuitting && settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// ============================================================ 自动锁定

/** 最后一次用户活动 (渲染层节流上报 + 任何一次 IPC 调用都会刷新) */
let lastActivity = Date.now();
let lockWatcher: NodeJS.Timeout | null = null;

function touch(): void {
  lastActivity = Date.now();
}

function startLockWatcher(): void {
  if (lockWatcher) return;
  // 用 1s 轮询而不是 setTimeout 重置: 设置页改时长后立即生效, 不需要重建定时器
  lockWatcher = setInterval(() => {
    if (!vault?.unlocked) return;
    const mins = settings.autoLockMinutes;
    if (mins <= 0) return;
    if (Date.now() - lastActivity >= mins * 60_000) lockVault("idle");
  }, 1000);
}

type LockReason = "idle" | "manual" | "blur";

function lockVault(reason: LockReason): VaultStatus {
  vault?.lock();
  vault = null;
  if (settings.clearClipboardOnLock) wipeClipboard(true);
  // 锁库时把「等待选目标」也停掉 —— 否则 10 秒内点到某个窗口，
  // 会往那儿打一个已经锁了的库的密码
  autotype?.cancelPending();
  mainWindow?.webContents.send("vault:locked", reason);
  refreshTrayMenu();
  return vaultStatus();
}

// ============================================================ 剪贴板

let clipTimer: NodeJS.Timeout | null = null;
/** 最后一次由我们写入剪贴板的明文; 用于判断"用户是否已经复制了别的东西" */
let clipToken: string | null = null;

/** 剪贴板里是否还躺着我们写进去的秘密 —— 托盘菜单据此决定要不要给「清除」那一项 */
function clipboardHoldsSecret(): boolean {
  return clipToken !== null;
}

function readClipboardSafe(): string {
  try {
    return clipboard.readText();
  } catch {
    // Windows 下别的进程正持有剪贴板时会抛错
    return "";
  }
}

/** 清空剪贴板; force=true 时不管内容是否被改过。返回**是否真的清掉了** */
function wipeClipboard(force = false): boolean {
  if (clipTimer) {
    clearTimeout(clipTimer);
    clipTimer = null;
  }
  if (!force && clipToken !== null && readClipboardSafe() !== clipToken) {
    // 用户已经复制了新内容, 不要去动它
    clipToken = null;
    refreshTrayMenu();
    return false;
  }
  try {
    clipboard.clear();
  } catch {
    /* 剪贴板被占用, 忽略 */
  }
  clipToken = null;
  refreshTrayMenu();
  mainWindow?.webContents.send("clip:cleared");
  return true;
}

function copyToClipboard(text: string): { clearIn: number } {
  try {
    clipboard.writeText(text);
  } catch {
    return { clearIn: 0 };
  }
  clipToken = text;
  // 托盘多出一项「清除剪贴板中的密码」—— 时长设成「不清空」的人需要
  // 一个随时能收尾的地方, 否则密码会一直留在剪贴板里且界面上看不出来
  refreshTrayMenu();
  if (clipTimer) clearTimeout(clipTimer);
  const secs = settings.clipboardClearSeconds;
  if (secs > 0) {
    clipTimer = setTimeout(() => {
      clipTimer = null;
      if (readClipboardSafe() === text) {
        try {
          clipboard.clear();
        } catch {
          /* ignore */
        }
        clipToken = null;
        refreshTrayMenu();
        mainWindow?.webContents.send("clip:cleared");
      } else {
        clipToken = null;
        refreshTrayMenu();
      }
    }, secs * 1000);
  }
  return { clearIn: secs };
}

/**
 * 往渲染层推一条提示（App.tsx 用现有的 Toast 显示）。
 * 主窗口不在时退化成写日志 —— 快速填充常常发生在主窗口被最小化到托盘的时候，
 * 至少留个痕迹，别静默。
 */
function notifyRenderer(msg: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("atype:notice", msg);
  } else {
    console.log(`[autotype] ${msg}`);
  }
}

// ============================================================ 系统托盘

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * 托盘图标. 打包后 build/ 被塞进 app.asar (见 package.json 的 build.files),
 * 开发时 app.getAppPath() 就是项目根 —— 两种情况同一个拼接方式.
 * createFromPath 能读 asar 内的路径, 不需要额外解包.
 *
 * ⚠ 这里是"静默失败"高发区: 图标不在包里时 createFromPath 不抛错, 只返回空图,
 * 表现是"打包后托盘一片空白"而控制台干干净净。所以空图必须吼一声 ——
 * 排查这类问题最费时间的就是"没有任何线索"。
 */
function trayIcon(): Electron.NativeImage {
  const file = join(app.getAppPath(), "build", "icon.png");
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    console.warn(
      `[tray] 托盘图标读不出来, 托盘会是空白的: ${file}\n` +
        `        检查 package.json 的 build.files 有没有把 "build/icon.png" 打进去`,
    );
    return img;
  }
  return img.resize({ width: 16, height: 16 });
}

function buildTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
  } catch {
    // 某些 Linux 桌面没有 StatusNotifier 宿主, 创建托盘会直接抛错 —— 静默降级
    tray = null;
    return;
  }
  refreshTrayMenu(); // 提示语也由它设置, 别在这之后覆写
  // 左键点托盘图标: 把窗口叫回来 (Windows/Linux 的常规习惯)
  tray.on("click", showMainWindow);
}

/**
 * 库的解锁状态变了就重建菜单, 让「锁定密码库」的可用态跟着变;
 * 剪贴板里还躺着我们写进去的密码时, 再多给一项「清除剪贴板中的密码」。
 *
 * 为什么需要这一项: 跨机粘贴（无界鼠标之类）的人必须把自动清空调长或直接选「不清空」,
 * 否则清空的瞬间会被同步过去、对面粘不出东西。可一旦选了「不清空」, 密码就无声地
 * 一直留在剪贴板里 —— 界面和托盘都得能看见这件事, 并且能一键收尾。
 */
function refreshTrayMenu(): void {
  if (!tray) return;
  const hold = clipboardHoldsSecret();
  const items: MenuItemConstructorOptions[] = [
    { label: "显示主窗口", click: showMainWindow },
    {
      label: "锁定密码库",
      enabled: vault?.unlocked ?? false,
      click: () => lockVault("manual"),
    },
  ];
  if (hold) {
    items.push(
      { type: "separator" },
      {
        label: "清除剪贴板中的密码",
        // 故意**不加 force**: 菜单可能是刚打开前那一眼的状态, 期间用户可能又复制了
        // 别的东西。force 会连用户的新内容一起清掉 —— 宁可少清, 不能误清。
        click: () => {
          if (!wipeClipboard()) {
            notifyRenderer("剪贴板里已经不是神盾写入的密码了，未做改动");
          }
        },
      },
    );
  }
  items.push(
    { type: "separator" },
    {
      label: "退出神盾",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  // 提示语也带上状态: 窗口缩在托盘里时, 悬停是唯一能看见「还有密码在剪贴板里」的地方
  tray.setToolTip(hold ? "神盾 Aegis — 剪贴板中还有密码" : "神盾 Aegis");
}

// ============================================================ 泄露检测

const breachChecker = makeBreachChecker();

// ============================================================ 文件对话框

/** Electron 的 showSaveDialog 有「有父窗/无父窗」两个重载, 包装一下免得每处都判断 */
function saveDialog(opts: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  return mainWindow ? dialog.showSaveDialog(mainWindow, opts) : dialog.showSaveDialog(opts);
}
function openDialog(opts: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts);
}

// ============================================================ 单实例保护

/**
 * 为什么必须有: 两个实例同时打开**同一个库文件**时, 各自在内存里持有一份
 * 独立副本, 而 save() 是整文件覆盖 —— 后保存的那个会把先前实例写入的
 * 内容全部抹掉。
 *
 * 这不是理论风险: 2026-10-02 就因此把用户的密码库写成了空库
 * (桌面快捷方式被双击两次, 09:40:30 与 09:40:46 各起了一个进程,
 *  09:41:17 库文件变成 551 B / 0 条目)。加锁是防这类数据丢失的正解。
 *
 * 行为: 拿不到锁 → 本进程直接退出; 已持有锁的进程收到 second-instance →
 * 把已有窗口还原并置前 (用户第二次双击的表现是"窗口跳到面前", 而不是
 * "没反应"或"开了第二个")。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// ============================================================ 启动

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      // 窗口被关掉但进程还在 (macOS 习惯): 重新开一个
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    userDataDir = app.getPath("userData");
    settings = loadSettings(userDataDir);
    buildMenu();
    createWindow();
    buildTray();
    startLockWatcher();

    // —— 快速填充（Auto-Type）——
    // 面板窗口**不在这里建**：它到第一次唤出时才 lazy 创建，
    // 免得每个用户启动时都白付一个渲染进程的内存。
    autotype = registerAutotype({
      getVault: () => vault,
      getSettings: () => settings,
      getMainWindow: () => mainWindow,
      copyToClipboard,
      touch,
      notify: notifyRenderer,
    });
    if (settings.autotypeEnabled) {
      const r = autotype.applyHotkey(settings.autotypeHotkey, () => void autotype?.openPanel());
      // 注册失败不能静默 —— 设置页会读 hotkeyStatus() 显示"已被占用"
      if (!r.ok) console.warn(`[autotype] 全局快捷键未注册：${r.reason}`);
    }

    // —— 自动更新 ——
    // 只在打包态构造。检查延后 10 秒: 启动那一瞬间在抢磁盘 IO (解锁页、读设置),
    // 再叠一个网络请求只会让冷启动更慢, 而且用户这时候也不关心有没有新版本。
    updater = new Updater(app.isPackaged);
    updater.subscribe((s) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update:status", s);
      }
    });
    if (app.isPackaged) {
      setTimeout(() => void updater?.check(), 10_000);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 退出前把 isQuitting 立起来, 否则 close-to-tray 的 preventDefault 会
  // 把「退出神盾」也挡下来, 应用永远退不掉
  app.on("before-quit", () => {
    isQuitting = true;
  });

  // 摘掉全局快捷键 + 销毁面板。做晚了会让系统以为某个组合键一直被按着
  app.on("will-quit", () => {
    shutdownAutotype();
  });

  app.on("window-all-closed", () => {
    // macOS 习惯: 关窗不退出应用(Dock 保留), 其他平台退出
    if (process.platform !== "darwin") app.quit();
    vault?.lock();
    vault = null;
  });
}

// ---- IPC: 冒烟 + 自绘标题栏的窗口控制 ----
ipcMain.handle("greet", (_e, name: string) => `后端已连通, ${name}!`);

ipcMain.handle("win:minimize", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.handle("win:toggleMaximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  // Electron 没有 toggleMaximize, 手动判断
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.handle("win:close", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// ---- IPC: 密码库 (加密核心在主进程, 渲染层只拿明文视图) ----
ipcMain.handle("vault:status", () => vaultStatus());
ipcMain.handle("app:platform", () => process.platform);
// 渲染层据此决定玻璃画法: native 材质交给系统, 否则自己 backdrop-filter
ipcMain.handle("app:material", () => ({
  material: MATERIAL,
  platform: process.platform,
  native: NATIVE_MATERIAL,
}));

/** 关于页: 版本 + 只读 KDF 参数 (让用户能自己核对加密基线) */
ipcMain.handle("app:info", () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  os: `${os.type()} ${os.release()} (${os.arch()})`,
  material: MATERIAL,
  // 渲染加速状态: 没启用时界面要提示"装显卡驱动", 见 detectAcceleration() 的注释。
  // 故意**现算**而不是模块加载时算一次 —— GPU 进程可能那时还没起来, 会探成 unknown。
  gpu: detectAcceleration(),
  kdf: { ...KDF_PARAMS },
  vaultPath: vaultPath(),
  settingsPath: join(userDataDir, "aegis.settings.json"),
}));

ipcMain.handle("app:openDataDir", async () => {
  await shell.openPath(userDataDir);
});

// ---- IPC: 自动更新 ----
// 状态是"拉 + 推"两条路: 界面挂载时拉一次拿当前快照, 之后靠 update:status 推。
// 只拉不推的话, 后台检查发现新版本时界面已经挂好了, 就永远看不到。
ipcMain.handle("update:status", () => updater?.current ?? null);
ipcMain.handle("update:check", () => updater?.check() ?? null);
ipcMain.handle("update:download", () => updater?.download() ?? null);
ipcMain.handle("update:install", () => updater?.install() ?? false);

ipcMain.handle("vault:create", async (_e, password: string, hint: string) => {
  touch();
  if (vault) vault.lock();
  vault = await VaultStore.create(vaultPath(), password, hint ?? "");
  refreshTrayMenu();
  return vaultStatus();
});

ipcMain.handle("vault:unlock", async (_e, password: string) => {
  touch();
  if (vault?.unlocked) return vaultStatus();
  vault = await VaultStore.open(vaultPath(), password);
  refreshTrayMenu();
  return vaultStatus();
});

ipcMain.handle("vault:lock", () => lockVault("manual"));

ipcMain.handle("vault:list", () => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.list().map((e) => ({ ...e, strength: strengthOf(e.password) }));
});

ipcMain.handle("vault:add", (_e, partial: Partial<Entry>) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.add(partial);
});

ipcMain.handle("vault:update", (_e, id: string, patch: Partial<Entry>) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.update(id, patch);
});

ipcMain.handle("vault:remove", (_e, id: string) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.remove(id);
});

/** 批量删除 (列表多选). 只在最后落盘一次; 返回真正删掉的条数 */
ipcMain.handle("vault:removeMany", (_e, ids: string[]) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.removeMany(Array.isArray(ids) ? ids : []);
});

/** 二次校验主密码: 批量删除前的防误触确认 (重新派生一次 Argon2id, 有半秒开销) */
ipcMain.handle("vault:verify", async (_e, password: string) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.verifyMasterPassword(String(password ?? ""));
});

/** 加密库文件整体备份 (复制 aegis.vault.json, 仍是密文) */
ipcMain.handle("vault:exportBackup", async () => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  const src = vaultPath();
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await saveDialog({
    title: "备份加密库文件",
    defaultPath: join(app.getPath("documents"), `aegis-vault-backup-${stamp}.json`),
    filters: [{ name: "神盾密码库 (密文)", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePath) return null;
  copyFileSync(src, r.filePath);
  const doc = JSON.parse(readFileSync(src, "utf8"));
  return { path: r.filePath, count: (doc.entries ?? []).length };
});

// ---- IPC: 主密码的三种命运 ----
//
// 三个操作经常被混淆, 语义差别很大, 这里写清楚:
//   changePassword  还记得旧密码, 只想换一个 → 只重包 DEK, **密文一条不动**
//   reset           旧密码忘了 → 换掉整把钥匙 (新 DEK), 旧数据放弃, 新库为空
//   clearAll        密码照旧, 只是把条目清空 → 可从自动快照退回

ipcMain.handle(
  "vault:changePassword",
  async (_e, oldPw: string, newPw: string, hint: string) => {
    touch();
    if (!vault?.unlocked) throw new Error("密码库未解锁");
    await vault.changePassword(
      String(oldPw ?? ""),
      String(newPw ?? ""),
      String(hint ?? ""),
    );
    return vaultStatus();
  },
);

/** 重置: **不需要解锁** —— 这正是"密码忘了进不去"时用的 */
ipcMain.handle(
  "vault:reset",
  async (_e, newPw: string, hint: string, keepBackup: boolean) => {
    touch();
    vault?.lock();
    vault = null;
    const { store, backupPath } = await VaultStore.reset(
      vaultPath(),
      String(newPw ?? ""),
      String(hint ?? ""),
      keepBackup !== false,
    );
    vault = store;
    refreshTrayMenu();
    return { ...vaultStatus(), backupPath };
  },
);

/** 清空全部条目: 破坏性操作, 要求二次校验主密码 (不是"库已解锁"就够) */
ipcMain.handle("vault:clearAll", async (_e, password: string) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  if (!(await vault.verifyMasterPassword(String(password ?? "")))) {
    throw new Error("主密码不正确, 未执行清空");
  }
  return vault.clearAll();
});

// ---- IPC: 条目历史版本 ----
ipcMain.handle("vault:history", (_e, id: string) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  const e = vault.get(String(id ?? ""));
  return e ? listHistory(e) : [];
});

ipcMain.handle("vault:restoreHistory", (_e, id: string, index: number) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.restoreHistory(String(id ?? ""), Number(index));
});

// ---- IPC: 库文件快照 (backups/ 下的自动滚动备份) ----

ipcMain.handle("backup:list", () => {
  touch();
  // 新的排前面 (listSnapshots 按文件名升序 → 反转)
  return listSnapshots(vaultPath())
    .reverse()
    .map((p) => {
      let bytes = 0;
      let mtime = 0;
      try {
        const st = statSync(p);
        bytes = st.size;
        mtime = st.mtimeMs;
      } catch {
        /* 刚被轮换掉, 忽略 */
      }
      return { path: p, name: basename(p), bytes, mtime };
    });
});

ipcMain.handle("backup:restore", async (_e, snapPath: string) => {
  touch();
  // 只允许恢复 backups/ 目录里的东西 —— 否则渲染层递个任意路径过来
  // 就等于拿到了"写任意文件"的能力
  const dir = resolve(backupDirFor(vaultPath()));
  const target = resolve(String(snapPath ?? ""));
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new Error("快照路径不在备份目录内");
  }
  if (!existsSync(target)) throw new Error("快照不存在");

  // 恢复前先把"当前状态"也留一份 —— 恢复错了还能回来
  backupNow(vaultPath());
  vault?.lock();
  vault = null;
  restoreSnapshot(vaultPath(), target);
  refreshTrayMenu();
  mainWindow?.webContents.send("vault:locked", "restore");
  return vaultStatus();
});

/** 打开 backups/ 目录, 让用户自己看一眼那些 .bak */
ipcMain.handle("backup:openDir", async () => {
  const dir = backupDirFor(vaultPath());
  await shell.openPath(existsSync(dir) ? dir : userDataDir);
});

// ---- IPC: 加密分享包 ----

ipcMain.handle(
  "share:export",
  async (
    _e,
    ids: string[],
    opts: {
      password?: string;
      title?: string;
      sender?: string;
      note?: string;
      hint?: string;
    } = {},
  ) => {
    touch();
    if (!vault?.unlocked) throw new Error("密码库未解锁");
    const all = vault.list();
    const wanted = Array.isArray(ids) ? new Set(ids) : null;
    const picked = wanted?.size ? all.filter((e) => wanted.has(e.id)) : all;
    if (!picked.length) throw new Error("没有可分享的条目");

    const bundle = await exportBundle(picked, String(opts.password ?? ""), {
      title: opts.title,
      sender: opts.sender,
      note: opts.note,
      hint: opts.hint,
    });
    const r = await saveDialog({
      title: "导出加密分享包",
      defaultPath: join(
        app.getPath("documents"),
        defaultShareFilename(opts.title ?? "神盾分享包"),
      ),
      filters: [{ name: "神盾分享包 (密文)", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, bundleToJson(bundle), "utf8");
    return {
      path: r.filePath,
      count: bundle.entries.length,
      fingerprint: bundleFingerprint(bundle),
    };
  },
);

/** 选一个分享包并读出**明文**元信息 (不解密, 不需要口令) */
ipcMain.handle("share:pickImport", async () => {
  touch();
  if (!vault?.unlocked) throw new Error("请先解锁密码库");
  const r = await openDialog({
    title: "选择神盾分享包",
    properties: ["openFile"],
    filters: [{ name: "神盾分享包", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const size = statSync(p).size;
  if (size > 64 * 1024 * 1024) {
    throw new Error(`文件 ${(size / 1048576).toFixed(1)} MB 超过 64 MB 上限`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error("分享包损坏 (JSON 解析失败)");
  }
  // describeBundle 内部会做格式校验, 不是神盾分享包会在这里被挡下
  const info = describeBundle(doc);
  return { info, fileName: basename(p), bytes: size, doc };
});

ipcMain.handle(
  "share:commitImport",
  async (
    _e,
    doc: unknown,
    password: string,
    opts: { forceNewIds?: boolean } = {},
  ) => {
    touch();
    if (!vault?.unlocked) throw new Error("密码库未解锁");
    const existing = vault.list().map((e) => e.id);
    const res = await importBundle(doc, String(password ?? ""), {
      existingIds: existing,
      forceNewIds: !!opts.forceNewIds,
    });
    // addMany 里 newEntry 先生成随机 id 再被 spread 覆盖 → 分享包里的 id 得以保留
    const created = vault.addMany(res.entries);
    return {
      added: created.length,
      skipped: res.skipped,
      rekeyed: res.rekeyed,
      title: res.title,
      sender: res.sender,
    };
  },
);

// ---- IPC: 生成器 ----
ipcMain.handle("pw:generate", (_e, opts: GenOptions) => generatePassword(opts));
ipcMain.handle("pw:passphrase", () => generatePassphrase());
ipcMain.handle("totp:code", (_e, secret: string) => totpView(secret));

// ---- IPC: 活动上报 (渲染层节流调用, 用于自动锁定计时) ----
ipcMain.handle("app:activity", () => {
  touch();
  return Date.now();
});

// ---- IPC: 剪贴板 (统一走主进程, 才能做「未被改动才清空」+ 定时清理) ----
ipcMain.handle("clip:copy", (_e, text: string) => {
  touch();
  return copyToClipboard(String(text ?? ""));
});
ipcMain.handle("clip:clear", () => {
  wipeClipboard(true);
  return true;
});

// ---- IPC: 密码健康检查 ----
ipcMain.handle("health:report", async (_e, deep: boolean) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  const list = vault.list();
  if (!deep || !settings.hibpEnabled) {
    // 只做本地体检 (不联网); breachDisabled 让 UI 知道"不是没泄露, 是没查"
    return analyzeWithBreach(list, { enabled: false });
  }
  const report = await analyzeWithBreach(list, { enabled: true, checker: breachChecker });
  // 记一下最近一次体检时间 (仅展示用)
  settings = saveSettings(userDataDir, { lastHealthCheck: Date.now() });
  return report;
});

// ---- IPC: 导入 / 导出 ----
ipcMain.handle("portable:formats", () => FORMATS);

ipcMain.handle("portable:pickImport", async () => {
  touch();
  if (!vault?.unlocked) throw new Error("请先解锁密码库");
  const r = await openDialog({
    title: "选择要导入的文件",
    properties: ["openFile"],
    filters: [
      { name: "全部支持的格式", extensions: ["json", "csv", "xml"] },
      { name: "CSV", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
      { name: "KeePass 2 XML", extensions: ["xml"] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const size = statSync(p).size;
  // 防止误选几百 MB 的文件把主进程撑爆
  if (size > 64 * 1024 * 1024) throw new Error(`文件 ${(size / 1048576).toFixed(1)} MB 超过 64 MB 上限`);
  const text = readFileSync(p, "utf8");
  const preview: ImportPreview = parseImport(text);
  return { ...preview, fileName: basename(p), filePath: p, bytes: size };
});

ipcMain.handle(
  "portable:commitImport",
  (_e, entries: Entry[], opts: { skipDuplicates?: boolean } = {}) => {
    touch();
    if (!vault?.unlocked) throw new Error("密码库未解锁");
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    const seen = new Set(
      opts.skipDuplicates
        ? vault.list().map((e) => `${norm(e.title)}\u0000${norm(e.username)}`)
        : [],
    );
    const toAdd: Partial<Entry>[] = [];
    let skipped = 0;
    for (const raw of entries ?? []) {
      if (!raw || typeof raw !== "object") continue;
      if (opts.skipDuplicates) {
        const k = `${norm(String(raw.title ?? ""))}\u0000${norm(String(raw.username ?? ""))}`;
        if (seen.has(k)) {
          skipped++;
          continue;
        }
        seen.add(k);
      }
      // 只接受已知字段 (丢掉来源 id → 让库自己发新 id, 同时挡住文件里的意外字段)
      toAdd.push({
        type: raw.type,
        title: raw.title,
        username: raw.username,
        password: raw.password,
        url: raw.url,
        notes: raw.notes,
        favorite: raw.favorite,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        extra: raw.extra,
      });
    }
    const created = vault.addMany(toAdd);
    return { added: created.length, skipped };
  },
);

ipcMain.handle("portable:export", async (_e, format: FormatId) => {
  touch();
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  let result: ExportResult;
  try {
    result = buildExport(vault.list(), format);
  } catch (e) {
    throw new Error(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = await saveDialog({
    title: `导出为 ${result.label}`,
    defaultPath: join(app.getPath("documents"), suggestFileName(format)),
    filters: [{ name: result.label, extensions: [result.ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  writeFileSync(r.filePath, result.content, "utf8");
  return { path: r.filePath, count: result.count, label: result.label, format };
});

// ---- IPC: 设置 ----
ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
  const prevHotkey = settings.autotypeHotkey;
  const prevEnabled = settings.autotypeEnabled;
  settings = saveSettings(userDataDir, patch ?? {});
  // 改完锁定策略立刻按新值判断一次, 不用等下一分钟
  touch();

  // 快捷键或总开关变了就重新注册（注册结果由设置页读 atype:hotkeyStatus 显示）。
  // 只有真的变了才动 —— 否则每改一个无关设置都会先解绑再绑定，
  // 那一瞬间的热键是失效的。
  if (autotype && (settings.autotypeHotkey !== prevHotkey || settings.autotypeEnabled !== prevEnabled)) {
    if (settings.autotypeEnabled) {
      const r = autotype.applyHotkey(settings.autotypeHotkey, () => void autotype?.openPanel());
      if (!r.ok) console.warn(`[autotype] 全局快捷键未注册：${r.reason}`);
    } else {
      autotype.applyHotkey("", () => {});
    }
  }
  return settings;
});
