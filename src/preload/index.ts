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
  },
  pw: {
    generate: (opts: Record<string, unknown>) =>
      ipcRenderer.invoke("pw:generate", opts),
    passphrase: () => ipcRenderer.invoke("pw:passphrase"),
  },
};

export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
