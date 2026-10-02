import {
  app,
  shell,
  nativeTheme,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
} from "electron";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "path";
import {
  generatePassphrase,
  generatePassword,
  strengthOf,
  GenOptions,
} from "../core/generate";
import { VaultStore } from "../core/vault";
import { totpView } from "../core/totp";
import type { Entry, VaultStatus } from "../core/types";

let vault: VaultStore | null = null;

function vaultPath(): string {
  // UOS/Linux: ~/.config/aegis-next/...; Windows: %APPDATA%/aegis-next/...
  return join(app.getPath("userData"), "aegis.vault.json");
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

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS 习惯: 关窗不退出应用(Dock 保留), 其他平台退出
  if (process.platform !== "darwin") app.quit();
  vault?.lock();
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

ipcMain.handle("vault:create", async (_e, password: string, hint: string) => {
  if (vault) vault.lock();
  vault = await VaultStore.create(vaultPath(), password, hint ?? "");
  return vaultStatus();
});

ipcMain.handle("vault:unlock", async (_e, password: string) => {
  if (vault?.unlocked) return vaultStatus();
  vault = await VaultStore.open(vaultPath(), password);
  return vaultStatus();
});

ipcMain.handle("vault:lock", () => {
  vault?.lock();
  vault = null;
  return vaultStatus();
});

ipcMain.handle("vault:list", () => {
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.list().map((e) => ({ ...e, strength: strengthOf(e.password) }));
});

ipcMain.handle("vault:add", (_e, partial: Partial<Entry>) => {
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.add(partial);
});

ipcMain.handle("vault:update", (_e, id: string, patch: Partial<Entry>) => {
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.update(id, patch);
});

ipcMain.handle("vault:remove", (_e, id: string) => {
  if (!vault?.unlocked) throw new Error("密码库未解锁");
  return vault.remove(id);
});

// ---- IPC: 生成器 ----
ipcMain.handle("pw:generate", (_e, opts: GenOptions) => generatePassword(opts));
ipcMain.handle("pw:passphrase", () => generatePassphrase());
ipcMain.handle("totp:code", (_e, secret: string) => totpView(secret));
