import { contextBridge, ipcRenderer } from "electron";

const api = {
  greet: (name: string): Promise<string> => ipcRenderer.invoke("greet", name),
};

export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
