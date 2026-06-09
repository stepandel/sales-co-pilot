var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// electron/main.ts
var import_electron = require("electron");
var import_node_path = __toESM(require("node:path"), 1);
var isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
var mainWindow = null;
var meeting = null;
var meetingTimer = null;
function createWindow() {
  mainWindow = new import_electron.BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: "Sales Co-Pilot",
    backgroundColor: "#f6f5f1",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: import_node_path.default.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(import_node_path.default.join(__dirname, "../dist/index.html"));
  }
}
function publishMeeting() {
  mainWindow?.webContents.send("meeting:updated", meeting);
}
function stopTimer() {
  if (meetingTimer) {
    clearInterval(meetingTimer);
    meetingTimer = null;
  }
}
async function getCaptureSources() {
  const sources = await import_electron.desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 360, height: 220 },
    fetchWindowIcons: true
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id
  }));
}
async function getPermissionState() {
  const microphone = process.platform === "darwin" ? import_electron.systemPreferences.getMediaAccessStatus("microphone") : "unknown";
  const screen = process.platform === "darwin" ? import_electron.systemPreferences.getMediaAccessStatus("screen") : "unknown";
  const sources = await getCaptureSources();
  return {
    microphone,
    screen,
    systemAudio: "integration-required",
    captureSources: sources
  };
}
import_electron.ipcMain.handle("permissions:get-state", getPermissionState);
import_electron.ipcMain.handle("permissions:request-microphone", async () => {
  if (process.platform !== "darwin") {
    return getPermissionState();
  }
  await import_electron.systemPreferences.askForMediaAccess("microphone");
  return getPermissionState();
});
import_electron.ipcMain.handle("meeting:start", async (_event, title) => {
  meeting = {
    id: crypto.randomUUID(),
    title: title?.trim() || "Untitled sales call",
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: "recording",
    elapsedSeconds: 0
  };
  stopTimer();
  meetingTimer = setInterval(() => {
    if (!meeting || meeting.status !== "recording") {
      return;
    }
    meeting = {
      ...meeting,
      elapsedSeconds: meeting.elapsedSeconds + 1
    };
    publishMeeting();
  }, 1e3);
  publishMeeting();
  return meeting;
});
import_electron.ipcMain.handle("meeting:pause", () => {
  if (meeting) {
    meeting = { ...meeting, status: meeting.status === "paused" ? "recording" : "paused" };
    publishMeeting();
  }
  return meeting;
});
import_electron.ipcMain.handle("meeting:stop", () => {
  if (meeting) {
    meeting = { ...meeting, status: "stopped" };
    stopTimer();
    publishMeeting();
  }
  return meeting;
});
import_electron.app.whenReady().then(() => {
  import_electron.session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "display-capture"].includes(permission));
  });
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
import_electron.app.on("window-all-closed", () => {
  stopTimer();
  if (process.platform !== "darwin") {
    import_electron.app.quit();
  }
});
