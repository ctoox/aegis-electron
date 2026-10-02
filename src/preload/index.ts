import { contextBridge, ipcRenderer } from "electron";

const api = {
  greet: (name: string): Promise<string> => ipcRenderer.invoke("greet", name),
  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke("win:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("win:toggleMaximize"),
    close: (): Promise<void> => ipcRenderer.invoke("win:close"),
  },
  vault: {
    status: () => ipcRenderer.invoke("vault:status"),
    create: (password: string, hint: string) =>
      ipcRenderer.invoke("vault:create", password, hint),
    unlock: (password: string) => ipcRenderer.invoke("vault:unlock", password),
    lock: () => ipcRenderer.invoke("vault:lock"),
    list: () => ipcRenderer.invoke("vault:list"),
    add: (partial: Record<string, unknown>) =>
      ipcRenderer.invoke("vault:add", partial),
    update: (id: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke("vault:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("vault:remove", id),
    exportBackup: () => ipcRenderer.invoke("vault:exportBackup"),
  },
  pw: {
    generate: (opts: Record<string, unknown>) =>
      ipcRenderer.invoke("pw:generate", opts),
    passphrase: () => ipcRenderer.invoke("pw:passphrase"),
  },
  totp: {
    code: (secret: string) => ipcRenderer.invoke("totp:code", secret),
  },
  app: {
    platform: (): Promise<string> => ipcRenderer.invoke("app:platform"),
    material: () => ipcRenderer.invoke("app:material"),
    info: () => ipcRenderer.invoke("app:info"),
    openDataDir: () => ipcRenderer.invoke("app:openDataDir"),
    /** 活动心跳: 渲染层节流调用, 主进程据此做自动锁定计时 */
    activity: () => ipcRenderer.invoke("app:activity"),
    /** 主进程锁库时通知渲染层 (闲置超时/失焦) */
    onLocked: (cb: (reason: string) => void) => {
      const h = (_e: unknown, reason: string) => cb(reason);
      ipcRenderer.on("vault:locked", h);
      return () => ipcRenderer.removeListener("vault:locked", h);
    },
    /** 剪贴板被定时清空时通知渲染层提示用户 */
    onClipboardCleared: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on("clip:cleared", h);
      return () => ipcRenderer.removeListener("clip:cleared", h);
    },
  },
  clip: {
    copy: (text: string) => ipcRenderer.invoke("clip:copy", text),
    clear: () => ipcRenderer.invoke("clip:clear"),
  },
  health: {
    report: (deep: boolean) => ipcRenderer.invoke("health:report", deep),
  },
  portable: {
    formats: () => ipcRenderer.invoke("portable:formats"),
    pickImport: () => ipcRenderer.invoke("portable:pickImport"),
    commitImport: (entries: unknown[], opts: { skipDuplicates?: boolean }) =>
      ipcRenderer.invoke("portable:commitImport", entries, opts),
    export: (format: string) => ipcRenderer.invoke("portable:export", format),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke("settings:set", patch),
  },
};

export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
