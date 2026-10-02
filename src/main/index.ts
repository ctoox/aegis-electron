import {
  app,
  shell,
  nativeTheme,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
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
import * as os from "node:os";
import { basename, join } from "node:path";
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

let vault: VaultStore | null = null;
let mainWindow: BrowserWindow | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };

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
    if (settings.lockOnBlur && vault?.unlocked) lockVault("blur");
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
  mainWindow?.webContents.send("vault:locked", reason);
  return vaultStatus();
}

// ============================================================ 剪贴板

let clipTimer: NodeJS.Timeout | null = null;
/** 最后一次由我们写入剪贴板的明文; 用于判断"用户是否已经复制了别的东西" */
let clipToken: string | null = null;

function readClipboardSafe(): string {
  try {
    return clipboard.readText();
  } catch {
    // Windows 下别的进程正持有剪贴板时会抛错
    return "";
  }
}

/** 清空剪贴板; force=true 时不管内容是否被改过 */
function wipeClipboard(force = false): void {
  if (clipTimer) {
    clearTimeout(clipTimer);
    clipTimer = null;
  }
  if (!force && clipToken !== null && readClipboardSafe() !== clipToken) {
    // 用户已经复制了新内容, 不要去动它
    clipToken = null;
    return;
  }
  try {
    clipboard.clear();
  } catch {
    /* 剪贴板被占用, 忽略 */
  }
  clipToken = null;
  mainWindow?.webContents.send("clip:cleared");
}

function copyToClipboard(text: string): { clearIn: number } {
  try {
    clipboard.writeText(text);
  } catch {
    return { clearIn: 0 };
  }
  clipToken = text;
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
        mainWindow?.webContents.send("clip:cleared");
      } else {
        clipToken = null;
      }
    }, secs * 1000);
  }
  return { clearIn: secs };
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

// ============================================================ 启动

app.whenReady().then(() => {
  userDataDir = app.getPath("userData");
  settings = loadSettings(userDataDir);
  buildMenu();
  createWindow();
  startLockWatcher();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS 习惯: 关窗不退出应用(Dock 保留), 其他平台退出
  if (process.platform !== "darwin") app.quit();
  vault?.lock();
  vault = null;
});

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
  kdf: { ...KDF_PARAMS },
  vaultPath: vaultPath(),
  settingsPath: join(userDataDir, "aegis.settings.json"),
}));

ipcMain.handle("app:openDataDir", async () => {
  await shell.openPath(userDataDir);
});

ipcMain.handle("vault:create", async (_e, password: string, hint: string) => {
  touch();
  if (vault) vault.lock();
  vault = await VaultStore.create(vaultPath(), password, hint ?? "");
  return vaultStatus();
});

ipcMain.handle("vault:unlock", async (_e, password: string) => {
  touch();
  if (vault?.unlocked) return vaultStatus();
  vault = await VaultStore.open(vaultPath(), password);
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
  settings = saveSettings(userDataDir, patch ?? {});
  // 改完锁定策略立刻按新值判断一次, 不用等下一分钟
  touch();
  return settings;
});
