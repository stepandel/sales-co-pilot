import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getPermissionState: () => ipcRenderer.invoke('permissions:get-state'),
  requestMicrophonePermission: () => ipcRenderer.invoke('permissions:request-microphone'),
  openPermissionSettings: (pane: 'microphone' | 'screen' | 'system-audio') =>
    ipcRenderer.invoke('permissions:open-settings', pane),
  analyzeCall: (transcript: unknown[]) => ipcRenderer.invoke('ai:analyze-call', transcript),
  getTestTranscript: () => ipcRenderer.invoke('test:get-transcript'),
  startMeeting: (title?: string) => ipcRenderer.invoke('meeting:start', title),
  saveTranscript: (turns: unknown[]) => ipcRenderer.invoke('meeting:transcript', turns),
  pauseMeeting: () => ipcRenderer.invoke('meeting:pause'),
  stopMeeting: (payload?: unknown) => ipcRenderer.invoke('meeting:stop', payload),
  importTranscript: () => ipcRenderer.invoke('meetings:import'),
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  getMeeting: (id: string) => ipcRenderer.invoke('meetings:get', id),
  analyzeMeeting: (id: string) => ipcRenderer.invoke('meetings:analyze', id),
  deleteMeeting: (id: string) => ipcRenderer.invoke('meetings:delete', id),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  onMeetingUpdated: (callback: (session: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, session: unknown) => callback(session)
    ipcRenderer.on('meeting:updated', listener)

    return () => ipcRenderer.removeListener('meeting:updated', listener)
  },
  onMeetingsChanged: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('meetings:changed', listener)

    return () => ipcRenderer.removeListener('meetings:changed', listener)
  },
}

contextBridge.exposeInMainWorld('salesCopilot', api)
