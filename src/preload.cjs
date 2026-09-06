// Preload: the only bridge between the page and main. Kept tiny on purpose.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  getMap: () => ipcRenderer.invoke("map:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  selectMap: (key) => ipcRenderer.invoke("map:select", key),
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
  setOverlayHidden: (hidden) => ipcRenderer.invoke("overlay:setHidden", hidden),
  quit: () => ipcRenderer.invoke("app:quit"),
  detectInstall: () => ipcRenderer.invoke("detect:install"),
  fetchAllTiles: () => ipcRenderer.invoke("tiles:fetchAll"),
  clearTiles: () => ipcRenderer.invoke("tiles:clear"),
  refreshData: () => ipcRenderer.invoke("data:refresh"),
  markQuestDone: (id, done) => ipcRenderer.invoke("quest:markDone", id, done),
  listQuests: () => ipcRenderer.invoke("quest:list"),
  questProgression: () => ipcRenderer.invoke("quest:progression"),
  getQuests: () => ipcRenderer.invoke("quests:get"),
  markObjectiveDone: (id, done) => ipcRenderer.invoke("quest:markObjective", id, done),
  rescanQuests: () => ipcRenderer.invoke("quests:rescan"),
  ping: (text) => ipcRenderer.invoke("squad:ping", text),
  squadStatus: (flag) => ipcRenderer.invoke("squad:status", flag),
  filterPrompt: (text) => ipcRenderer.invoke("filter:prompt", text),
  setLayers: (mapKey, on) => ipcRenderer.invoke("layers:set", mapKey, on),
  re3mrInfo: (key) => ipcRenderer.invoke("re3mr:info", key),
  re3mrPrepare: (key) => ipcRenderer.invoke("re3mr:prepare", key),
  re3mrFit: (key, w, h, points) => ipcRenderer.invoke("re3mr:fit", key, w, h, points),
  re3mrSave: (reg) => ipcRenderer.invoke("re3mr:save", reg),
  onSnapshot: on("snapshot"),
  onMap: on("map"),
  onQuests: on("quests"),
  onTick: on("tick"),
  onTiles: on("tiles"),
  onLog: on("log"),
  onSender: on("sender"),
  onOverlayMode: on("overlay-mode"),
});
