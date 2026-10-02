import { app, shell, BrowserWindow, ipcMain } from "electron";
import { existsSync, readFileSync } from "node:fs";
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

function createWindow(): void {
  const win = new BrowserWindow({
    title: "神盾 Aegis (Electron)",
    width: 1000,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    frame: false, // 自绘标题栏 (VS Code 式), 拖拽用 -webkit-app-region
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
  // 锁定语义: 退出即清密钥 (进程结束自然清零; lock 兜底)
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
