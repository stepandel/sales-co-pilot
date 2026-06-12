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
  /** Replays of saved meetings are never persisted as new records. */
  replay?: boolean
}

export type ReplayPayload = {
  id: string
  title: string
  turns: TranscriptTurn[]
}

export type TranscriptTurn = {
  /** Which side of the call is talking; the analysis logic only needs this. */
  speaker: 'rep' | 'prospect'
  /** The speaker's original label from the transcript, e.g. "Me", "Jordan". */
  name?: string
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

export type StopMeetingPayload = {
  durationSeconds?: number
  transcript?: TranscriptTurn[]
  analysis?: CopilotAnalysis | null
  model?: string | null
}

export type PostMortem = {
  /** 1-10 adherence to The Mom Test. */
  score: number
  verdict: string
  wentWell: string[]
  couldImprove: string[]
}

export type MeetingChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type MeetingRecord = {
  id: string
  title: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  transcript: TranscriptTurn[]
  analysis: CopilotAnalysis | null
  postMortem: PostMortem | null
  model: string | null
}

export type MeetingSummary = {
  id: string
  title: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  turnCount: number
  stage: string | null
  completedGaps: string[]
  factCount: number
}

export type SalesCopilotApi = {
  getPermissionState: () => Promise<PermissionState>
  requestMicrophonePermission: () => Promise<PermissionState>
  openPermissionSettings: (pane: 'microphone' | 'screen' | 'system-audio') => Promise<boolean>
  analyzeCall: (transcript: TranscriptTurn[]) => Promise<AnalyzeCallResult>
  startMeeting: (title?: string, options?: { replay?: boolean }) => Promise<MeetingSession>
  saveTranscript: (turns: TranscriptTurn[]) => Promise<boolean>
  pauseMeeting: () => Promise<MeetingSession | null>
  stopMeeting: (payload?: StopMeetingPayload) => Promise<MeetingSession | null>
  /** Resolves null when the file picker is cancelled. */
  importTranscript: () => Promise<{ id: string } | { error: string } | null>
  importTranscriptText: (raw: string) => Promise<{ id: string } | { error: string }>
  listMeetings: () => Promise<MeetingSummary[]>
  getMeeting: (id: string) => Promise<MeetingRecord | null>
  analyzeMeeting: (id: string) => Promise<{ record: MeetingRecord } | { error: string }>
  chatAboutMeeting: (
    id: string,
    messages: MeetingChatMessage[],
  ) => Promise<{ reply: string } | { error: string }>
  deleteMeeting: (id: string) => Promise<boolean>
  openDashboard: () => Promise<boolean>
  openCopilot: (meetingId?: string) => Promise<boolean>
  getPendingReplay: () => Promise<ReplayPayload | null>
  onReplayLoad: (callback: (payload: ReplayPayload | null) => void) => () => void
  onMeetingUpdated: (callback: (session: MeetingSession | null) => void) => () => void
  onMeetingsChanged: (callback: () => void) => () => void
}

declare global {
  interface Window {
    salesCopilot?: SalesCopilotApi
  }
}
