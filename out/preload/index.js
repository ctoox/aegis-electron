"use strict";
const electron = require("electron");
const api = {
  greet: (name) => electron.ipcRenderer.invoke("greet", name)
};
electron.contextBridge.exposeInMainWorld("api", api);
