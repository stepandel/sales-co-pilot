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

/** The rep's pre-call prep, injected into every analysis pass. */
export type CallContext = {
  prospectName: string | null
  notes: string | null
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

/** One VAD-segmented utterance decoded by the local STT engine. */
export type TranscriptSegment = {
  /** Which capture stream it came from: mic = rep, system audio = prospect. */
  channel: 'rep' | 'prospect'
  text: string
  /** Offset from STT start, in seconds of accepted audio. */
  startSeconds: number
  endSeconds: number
}

export type SttStatus =
  | { state: 'not-installed' }
  | { state: 'not-downloaded' }
  | { state: 'downloading'; progress: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }

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

export type SettingsState = {
  hasKey: boolean
  /** Masked preview like "sk-…h3Qk" — the full key never reaches the renderer. */
  maskedKey: string | null
  /** True when the key comes from the OPENAI_API_KEY env var (dev .env). */
  fromEnv: boolean
  secureStorageAvailable: boolean
}

export type SalesCopilotApi = {
  getSettings: () => Promise<SettingsState>
  setOpenAiKey: (key: string) => Promise<{ state: SettingsState } | { error: string }>
  clearOpenAiKey: () => Promise<{ state: SettingsState }>
  testOpenAiKey: () => Promise<{ ok: true } | { error: string }>
  openSettings: () => Promise<boolean>
  getPermissionState: () => Promise<PermissionState>
  requestMicrophonePermission: () => Promise<PermissionState>
  openPermissionSettings: (pane: 'microphone' | 'screen' | 'system-audio') => Promise<boolean>
  analyzeCall: (
    transcript: TranscriptTurn[],
    /** Last analysis fed back as working state so consecutive passes stay stable. */
    previous?: CopilotAnalysis | null,
    /** Pre-call prep (prospect name + notes) to ground suggestions. */
    callContext?: CallContext | null,
  ) => Promise<AnalyzeCallResult>
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
  sttGetStatus: () => Promise<SttStatus>
  /** Resolves once the model is downloaded (or with the failure state). */
  sttDownloadModel: () => Promise<SttStatus>
  sttStart: () => Promise<{ ok: true } | { error: string }>
  /** Stops the engine; resolves with any trailing utterances still buffered. */
  sttStop: () => Promise<TranscriptSegment[]>
  sendAudioChunk: (channel: 'rep' | 'prospect', samples: Float32Array) => void
  onSttStatus: (callback: (status: SttStatus) => void) => () => void
  onTranscriptSegment: (callback: (segment: TranscriptSegment) => void) => () => void
}

declare global {
  interface Window {
    salesCopilot?: SalesCopilotApi
  }
}
