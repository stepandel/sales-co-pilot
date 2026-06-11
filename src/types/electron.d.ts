export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export type CaptureSource = {
  id: string
  name: string
  displayId: string
}

export type PermissionState = {
  microphone: MediaAccessStatus
  screen: MediaAccessStatus
  systemAudio: 'available-with-display-capture' | 'available' | 'unavailable'
  platform: NodeJS.Platform
  macAudioCaptureRequiresUsageDescription: boolean
  captureSources: CaptureSource[]
}

export type MeetingStatus = 'idle' | 'checking-permissions' | 'recording' | 'paused' | 'stopped'

export type MeetingSession = {
  id: string
  title: string
  startedAt: string
  status: MeetingStatus
  elapsedSeconds: number
}

export type TranscriptTurn = {
  speaker: 'rep' | 'prospect'
  text: string
  timestamp?: string
}

export type CopilotAnalysis = {
  stage: string
  nextQuestions: Array<{
    priority: 'low' | 'medium' | 'high'
    question: string
    reason: string
    /** Verbatim span of `question` carrying the core ask; '' when absent. */
    emphasis: string
  }>
  facts: string[]
  completedGaps: string[]
}

export type AnalyzeCallResult = {
  model: string
  analysis: CopilotAnalysis
}

export type SalesCopilotApi = {
  getPermissionState: () => Promise<PermissionState>
  requestMicrophonePermission: () => Promise<PermissionState>
  openPermissionSettings: (pane: 'microphone' | 'screen' | 'system-audio') => Promise<boolean>
  analyzeCall: (transcript: TranscriptTurn[]) => Promise<AnalyzeCallResult>
  getTestTranscript: () => Promise<string | null>
  startMeeting: (title?: string) => Promise<MeetingSession>
  pauseMeeting: () => Promise<MeetingSession | null>
  stopMeeting: () => Promise<MeetingSession | null>
  onMeetingUpdated: (callback: (session: MeetingSession | null) => void) => () => void
}

declare global {
  interface Window {
    salesCopilot?: SalesCopilotApi
  }
}
