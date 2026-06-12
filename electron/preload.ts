import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getPermissionState: () => ipcRenderer.invoke('permissions:get-state'),
  requestMicrophonePermission: () => ipcRenderer.invoke('permissions:request-microphone'),
  openPermissionSettings: (pane: 'microphone' | 'screen' | 'system-audio') =>
    ipcRenderer.invoke('permissions:open-settings', pane),
  analyzeCall: (transcript: unknown[], previous?: unknown, callContext?: unknown) =>
    ipcRenderer.invoke('ai:analyze-call', transcript, previous ?? null, callContext ?? null),
  startMeeting: (title?: string, options?: unknown) =>
    ipcRenderer.invoke('meeting:start', title, options),
  saveTranscript: (turns: unknown[]) => ipcRenderer.invoke('meeting:transcript', turns),
  pauseMeeting: () => ipcRenderer.invoke('meeting:pause'),
  stopMeeting: (payload?: unknown) => ipcRenderer.invoke('meeting:stop', payload),
  importTranscript: () => ipcRenderer.invoke('meetings:import'),
  importTranscriptText: (raw: string) => ipcRenderer.invoke('meetings:import-text', raw),
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  getMeeting: (id: string) => ipcRenderer.invoke('meetings:get', id),
  analyzeMeeting: (id: string) => ipcRenderer.invoke('meetings:analyze', id),
  chatAboutMeeting: (id: string, messages: unknown[]) =>
    ipcRenderer.invoke('meetings:chat', id, messages),
  deleteMeeting: (id: string) => ipcRenderer.invoke('meetings:delete', id),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  openCopilot: (meetingId?: string) => ipcRenderer.invoke('copilot:open', meetingId),
  getPendingReplay: () => ipcRenderer.invoke('replay:get-pending'),
  onReplayLoad: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('replay:load', listener)

    return () => ipcRenderer.removeListener('replay:load', listener)
  },
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
  sttGetStatus: () => ipcRenderer.invoke('stt:get-status'),
  sttDownloadModel: () => ipcRenderer.invoke('stt:download'),
  sttStart: () => ipcRenderer.invoke('stt:start'),
  sttStop: () => ipcRenderer.invoke('stt:stop'),
  // Fire-and-forget: ~10 chunks/s/channel of 100ms 16kHz PCM while recording.
  sendAudioChunk: (channel: 'rep' | 'prospect', samples: Float32Array) =>
    ipcRenderer.send('stt:audio', channel, samples),
  onSttStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('stt:status', listener)

    return () => ipcRenderer.removeListener('stt:status', listener)
  },
  onTranscriptSegment: (callback: (segment: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, segment: unknown) => callback(segment)
    ipcRenderer.on('transcript:segment', listener)

    return () => ipcRenderer.removeListener('transcript:segment', listener)
  },
}

contextBridge.exposeInMainWorld('salesCopilot', api)
