// Preload: the only bridge between the pages and main. Kept small on purpose.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  press: () => ipcRenderer.invoke("press"),
  testScreenshot: () => ipcRenderer.invoke("test:screenshot"),
  openFolder: (which) => ipcRenderer.invoke("open:folder", which),
  openUrl: (url) => ipcRenderer.invoke("open:url", url),
  openControl: () => ipcRenderer.invoke("window:control"),
  showBigMap: (show) => ipcRenderer.invoke("window:bigmap", show),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  hide: () => ipcRenderer.invoke("window:hide"),
  setOverlayInteractive: (v) => ipcRenderer.invoke("overlay:interactive", v),
  toggleOverlayHidden: () => ipcRenderer.invoke("overlay:toggleHidden"),
  quit: () => ipcRenderer.invoke("app:quit"),
  detectInstall: () => ipcRenderer.invoke("detect:install"),
  fetchAllTiles: () => ipcRenderer.invoke("tiles:fetchAll"),
  clearTiles: () => ipcRenderer.invoke("tiles:clear"),
  markQuestDone: (id, done) => ipcRenderer.invoke("quest:markDone", id, done),
  listQuests: () => ipcRenderer.invoke("quest:list"),
  ping: (text) => ipcRenderer.invoke("squad:ping", text),
  squadStatus: (flag) => ipcRenderer.invoke("squad:status", flag),
  filterPrompt: (sentence) => ipcRenderer.invoke("filter:prompt", sentence),
  setLayers: (mapKey, on) => ipcRenderer.invoke("layers:set", mapKey, on),
  selectMap: (key) => ipcRenderer.invoke("map:select", key),
  onSnapshot: on("snapshot"),
  onTick: on("tick"),
  onTiles: on("tiles"),
  onLog: on("log"),
  onSender: on("sender"),
  onOverlayMode: on("overlay-mode"),
});
