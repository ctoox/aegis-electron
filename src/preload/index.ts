import { contextBridge, ipcRenderer } from "electron";

const api = {
  greet: (name: string): Promise<string> => ipcRenderer.invoke("greet", name),
  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke("win:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("win:toggleMaximize"),
    close: (): Promise<void> => ipcRenderer.invoke("win:close"),
  },
};

export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
