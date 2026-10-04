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
    removeMany: (ids: string[]) => ipcRenderer.invoke("vault:removeMany", ids),
    verify: (password: string) => ipcRenderer.invoke("vault:verify", password),
    exportBackup: () => ipcRenderer.invoke("vault:exportBackup"),
    changePassword: (oldPw: string, newPw: string, hint: string) =>
      ipcRenderer.invoke("vault:changePassword", oldPw, newPw, hint),
    reset: (newPw: string, hint: string, keepBackup: boolean) =>
      ipcRenderer.invoke("vault:reset", newPw, hint, keepBackup),
    clearAll: (password: string) => ipcRenderer.invoke("vault:clearAll", password),
    history: (id: string) => ipcRenderer.invoke("vault:history", id),
    restoreHistory: (id: string, index: number) =>
      ipcRenderer.invoke("vault:restoreHistory", id, index),
  },
  backup: {
    list: () => ipcRenderer.invoke("backup:list"),
    restore: (snapPath: string) => ipcRenderer.invoke("backup:restore", snapPath),
    openDir: () => ipcRenderer.invoke("backup:openDir"),
  },
  share: {
    export: (ids: string[], opts: Record<string, unknown>) =>
      ipcRenderer.invoke("share:export", ids, opts),
    pickImport: () => ipcRenderer.invoke("share:pickImport"),
    commitImport: (
      doc: unknown,
      password: string,
      opts: { forceNewIds?: boolean },
    ) => ipcRenderer.invoke("share:commitImport", doc, password, opts),
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
  update: {
    /** 当前状态快照 (界面挂载时拉一次) */
    status: () => ipcRenderer.invoke("update:status"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    /** 重启并装上已下载的版本 */
    install: () => ipcRenderer.invoke("update:install"),
    /** 主进程后台查到新版本时推过来 */
    onStatus: (cb: (status: unknown) => void) => {
      const h = (_e: unknown, status: unknown) => cb(status);
      ipcRenderer.on("update:status", h);
      return () => ipcRenderer.removeListener("update:status", h);
    },
  },
};

export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
