import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getPermissionState: () => ipcRenderer.invoke('permissions:get-state'),
  requestMicrophonePermission: () => ipcRenderer.invoke('permissions:request-microphone'),
  openPermissionSettings: (pane: 'microphone' | 'screen' | 'system-audio') =>
    ipcRenderer.invoke('permissions:open-settings', pane),
  analyzeCall: (transcript: unknown[]) => ipcRenderer.invoke('ai:analyze-call', transcript),
  startMeeting: (title?: string) => ipcRenderer.invoke('meeting:start', title),
  pauseMeeting: () => ipcRenderer.invoke('meeting:pause'),
  stopMeeting: () => ipcRenderer.invoke('meeting:stop'),
  onMeetingUpdated: (callback: (session: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, session: unknown) => callback(session)
    ipcRenderer.on('meeting:updated', listener)

    return () => ipcRenderer.removeListener('meeting:updated', listener)
  },
}

contextBridge.exposeInMainWorld('salesCopilot', api)
