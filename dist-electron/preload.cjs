// electron/preload.ts
var import_electron = require("electron");
var api = {
  getPermissionState: () => import_electron.ipcRenderer.invoke("permissions:get-state"),
  requestMicrophonePermission: () => import_electron.ipcRenderer.invoke("permissions:request-microphone"),
  startMeeting: (title) => import_electron.ipcRenderer.invoke("meeting:start", title),
  pauseMeeting: () => import_electron.ipcRenderer.invoke("meeting:pause"),
  stopMeeting: () => import_electron.ipcRenderer.invoke("meeting:stop"),
  onMeetingUpdated: (callback) => {
    const listener = (_event, session) => callback(session);
    import_electron.ipcRenderer.on("meeting:updated", listener);
    return () => import_electron.ipcRenderer.removeListener("meeting:updated", listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("salesCopilot", api);
