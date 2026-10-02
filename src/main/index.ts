import { app, shell, BrowserWindow, ipcMain } from "electron";
import { join } from "path";

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
