import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import type { CopilotAnalysis, MeetingSession, ReplayPayload, TranscriptTurn } from './types/electron'
import { DISCOVERY_STAGES } from './discovery'
import { CaptureSetup, type AudioAccessState } from './components/CaptureSetup'
import { CopilotView } from './components/CopilotView'
import { Titlebar } from './components/Titlebar'
import {
  formatElapsed,
  transcriptLinesFromTurns,
  type ParsedTranscriptLine,
} from '../shared/transcript'

const TARGET_SECONDS = 8 * 60

const transcriptPreview = [
  {
    speaker: 'Prospect',
    time: '00:18',
    text: 'We are trying to reduce handoffs between account executives and implementation.',
  },
  {
    speaker: 'You',
    time: '00:31',
    text: 'That makes sense. Where does the process slow down most today?',
  },
  {
    speaker: 'Prospect',
    time: '00:45',
    text: 'Usually right after legal approval. Everyone thinks someone else owns the next step.',
  },
]

const transcriptForAnalysis = transcriptPreview.map((line) => ({
  speaker: line.speaker === 'You' ? 'rep' : 'prospect',
  name: line.speaker,
  text: line.text,
  timestamp: line.time,
})) satisfies TranscriptTurn[]

const AUTO_ANALYZE_INTERVAL_MS = 5_000
const REPLAY_SPEEDS = [1, 4, 8] as const

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

// Pure capture helpers: they only touch global `navigator.mediaDevices`, so they
// live at module scope instead of being rebuilt on every render of <App />.
async function getMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  })
}

async function getSystemAudioStream() {
  return navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: {
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 5, max: 10 },
    },
  })
}

// The analysis cluster changes as one unit (start → succeeded/failed →
// finished), so it's a single reducer instead of four separate useState calls.
type AnalysisState = {
  analysis: CopilotAnalysis | null
  error: string
  model: string
  isAnalyzing: boolean
  /** Round-trip time of the last successful analysis, null before the first. */
  latencyMs: number | null
}

type AnalysisAction =
  | { type: 'start' }
  | { type: 'succeeded'; model: string; analysis: CopilotAnalysis; latencyMs: number }
  | { type: 'failed'; error: string }
  | { type: 'finished' }
  | { type: 'reset' }

const initialAnalysisState: AnalysisState = {
  analysis: null,
  error: '',
  model: 'gpt-5.4-mini',
  isAnalyzing: false,
  latencyMs: null,
}

function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case 'start':
      return { ...state, isAnalyzing: true, error: '' }
    case 'succeeded':
      return { ...state, model: action.model, analysis: action.analysis, latencyMs: action.latencyMs }
    case 'failed':
      return { ...state, error: action.error }
    case 'finished':
      return { ...state, isAnalyzing: false }
    case 'reset':
      return { ...state, analysis: null, error: '', latencyMs: null }
    default:
      return state
  }
}

// All meeting/session/audio/analysis state and handlers live here so <App />
// stays a thin view layer.
function useCopilotSession() {
  const [meetingTitle, setMeetingTitle] = useState('Discovery call')
  const [prospectName, setProspectName] = useState('')
  const [callNotes, setCallNotes] = useState('')
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [view, setView] = useState<'copilot' | 'transcript'>('copilot')
  const [isLoading, setIsLoading] = useState(false)
  const [analysisState, dispatchAnalysis] = useReducer(analysisReducer, initialAnalysisState)
  const {
    analysis: copilotAnalysis,
    error: copilotError,
    model: copilotModel,
    isAnalyzing,
    latencyMs: copilotLatencyMs,
  } = analysisState
  const [audioAccess, setAudioAccess] = useState<AudioAccessState>({
    microphone: 'idle',
    systemAudio: 'idle',
    message: 'Audio access has not been requested yet.',
  })
  const [replayLines, setReplayLines] = useState<ParsedTranscriptLine[]>([])
  const [replaySpeed, setReplaySpeed] = useState<(typeof REPLAY_SPEEDS)[number]>(1)
  const [scrubOffset, setScrubOffset] = useState(0)
  const microphoneStreamRef = useRef<MediaStream | null>(null)
  const systemAudioStreamRef = useRef<MediaStream | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const lastAutoAnalyzeRef = useRef({ count: 0, at: 0 })
  const lastSavedTurnCountRef = useRef(-1)
  // Mirrors whether a session is running, for the replay:load listener whose
  // closure would otherwise go stale.
  const sessionActiveRef = useRef(false)

  const replayMode = replayLines.length > 0
  const isRecording = session?.status === 'recording'
  const showStart = !session || session.status === 'stopped' || session.status === 'idle'
  const canUseDesktopBridge = Boolean(window.salesCopilot)

  const meetingStatus = useMemo(() => {
    if (!session) {
      return 'Ready'
    }

    if (session.status === 'recording') {
      return 'Live'
    }

    return session.status.charAt(0).toUpperCase() + session.status.slice(1)
  }, [session])

  const stageIdx = useMemo(() => {
    if (!copilotAnalysis) {
      return 0
    }

    const index = DISCOVERY_STAGES.findIndex((stage) => stage.name === copilotAnalysis.stage)
    return index === -1 ? 0 : index
  }, [copilotAnalysis])

  const primaryQuestion = copilotAnalysis?.nextQuestions[0] ?? null
  const secondaryQuestion = copilotAnalysis?.nextQuestions[1] ?? null
  const completedGaps = useMemo(
    () => new Set(copilotAnalysis?.completedGaps ?? []),
    [copilotAnalysis],
  )

  const elapsedSeconds = session?.elapsedSeconds ?? 0
  // In replay mode the session timer drives a synthetic call clock that the
  // playback speed multiplies and the scrubber offsets; everything downstream
  // (timer, pacing, reveals) runs on call time so they stay coherent.
  const callSeconds = replayMode
    ? Math.max(0, elapsedSeconds * replaySpeed + scrubOffset)
    : elapsedSeconds
  const shouldWrapSoon = stageIdx >= 5 || callSeconds > TARGET_SECONDS - 90
  const transcriptDuration = replayLines.length > 0 ? replayLines[replayLines.length - 1].seconds : 0

  // Replay: the call clock "plays" the saved transcript — a line is revealed
  // once the clock passes its timestamp.
  const revealedLines = useMemo(
    () => (replayMode && session ? replayLines.filter((line) => line.seconds <= callSeconds) : []),
    [replayMode, session, replayLines, callSeconds],
  )

  const displayedTranscript = replayMode
    ? revealedLines.map((line) => ({
        speaker: line.isRep ? 'You' : line.speaker,
        time: line.time,
        text: line.text,
      }))
    : transcriptPreview

  const analysisTurns: TranscriptTurn[] = replayMode
    ? revealedLines.map((line) => ({
        speaker: line.isRep ? 'rep' : 'prospect',
        name: line.speaker,
        text: line.text,
        timestamp: line.time,
      }))
    : transcriptForAnalysis

  useEffect(() => {
    sessionActiveRef.current = Boolean(
      session && session.status !== 'stopped' && session.status !== 'idle',
    )
  }, [session])

  useEffect(() => {
    if (!window.salesCopilot) {
      return
    }

    const removeMeetingListener = window.salesCopilot.onMeetingUpdated(setSession)

    // Load a meeting into the panel for replay (null = a fresh live meeting).
    // Ignored while a session is running so it can't yank the rug mid-call.
    const applyReplay = (payload: ReplayPayload | null) => {
      if (sessionActiveRef.current) {
        return
      }

      setReplayLines(payload ? transcriptLinesFromTurns(payload.turns) : [])
      setMeetingTitle(payload ? payload.title : 'Discovery call')
      setScrubOffset(0)
      dispatchAnalysis({ type: 'reset' })
    }

    window.salesCopilot.getPendingReplay().then((payload) => {
      if (payload) {
        applyReplay(payload)
      }
    })
    const removeReplayListener = window.salesCopilot.onReplayLoad(applyReplay)

    return () => {
      removeMeetingListener()
      removeReplayListener()
      stopAudioStreams()
    }
  }, [])

  useEffect(() => {
    if (view === 'transcript' && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [view, displayedTranscript.length])

  // While a replay plays, re-run the co-pilot as new lines land (throttled),
  // exactly as live STT would.
  useEffect(() => {
    if (!replayMode || !isRecording || isAnalyzing) {
      return
    }

    const last = lastAutoAnalyzeRef.current
    if (revealedLines.length > last.count && Date.now() - last.at >= AUTO_ANALYZE_INTERVAL_MS) {
      lastAutoAnalyzeRef.current = { count: revealedLines.length, at: Date.now() }
      void analyzeCall()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- analyzeCall is recreated every render; the throttle guard owns when it fires
  }, [replayMode, isRecording, isAnalyzing, revealedLines.length])

  // Checkpoint the transcript to disk whenever the turn list changes during a
  // call, so a crash or force-quit loses at most the line in flight. The final
  // authoritative write happens in stopMeeting.
  const sessionStatus = session?.status
  useEffect(() => {
    if (!sessionStatus || sessionStatus === 'stopped' || sessionStatus === 'idle') {
      lastSavedTurnCountRef.current = -1
      return
    }

    if (analysisTurns.length === lastSavedTurnCountRef.current) {
      return
    }

    lastSavedTurnCountRef.current = analysisTurns.length
    void window.salesCopilot?.saveTranscript(analysisTurns)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- analysisTurns is rebuilt every render; its length is the change signal
  }, [sessionStatus, analysisTurns.length])

  function stopAudioStreams() {
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop())
    systemAudioStreamRef.current?.getTracks().forEach((track) => track.stop())
    microphoneStreamRef.current = null
    systemAudioStreamRef.current = null
  }

  async function requestMicrophone() {
    if (!window.salesCopilot || !navigator.mediaDevices?.getUserMedia) {
      return
    }

    setIsLoading(true)
    setAudioAccess((current) => ({
      ...current,
      microphone: 'checking',
      message: 'Checking microphone permission...',
    }))

    try {
      await window.salesCopilot.requestMicrophonePermission()
      const stream = await getMicrophoneStream()
      const hasAudio = stream.getAudioTracks().length > 0
      stream.getTracks().forEach((track) => track.stop())

      setAudioAccess((current) => ({
        ...current,
        microphone: hasAudio ? 'ready' : 'denied',
        message:
          hasAudio
            ? 'Microphone is permitted. No mic stream is kept open until a meeting starts.'
            : 'Microphone access returned no audio tracks.',
      }))
    } catch (error) {
      setAudioAccess((current) => ({
        ...current,
        microphone: 'denied',
        message: error instanceof Error ? error.message : 'Microphone access was denied.',
      }))
    } finally {
      setIsLoading(false)
    }
  }

  async function requestSystemAudio() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setAudioAccess((current) => ({
        ...current,
        systemAudio: 'denied',
        message: 'Display media capture is not available in this runtime.',
      }))
      return
    }

    setIsLoading(true)
    setAudioAccess((current) => ({
      ...current,
      systemAudio: 'checking',
      message: 'Checking system audio through display capture...',
    }))

    try {
      const stream = await getSystemAudioStream()
      const audioTracks = stream.getAudioTracks()
      const hasAudio = audioTracks.length > 0
      stream.getTracks().forEach((track) => track.stop())

      setAudioAccess((current) => ({
        ...current,
        systemAudio: hasAudio ? 'ready' : 'denied',
        message:
          hasAudio
            ? 'System audio is permitted. No loopback stream is kept open until a meeting starts.'
            : 'Display capture started, but no system audio track was returned.',
      }))
    } catch (error) {
      setAudioAccess((current) => ({
        ...current,
        systemAudio: 'denied',
        message: error instanceof Error ? error.message : 'System audio access was denied.',
      }))
    } finally {
      setIsLoading(false)
    }
  }

  async function startAudioStreams() {
    if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Audio capture APIs are not available in this runtime.')
    }

    stopAudioStreams()

    const microphoneStream = await getMicrophoneStream()
    const systemAudioStream = await getSystemAudioStream()

    const hasMicrophone = microphoneStream.getAudioTracks().length > 0
    const hasSystemAudio = systemAudioStream.getAudioTracks().length > 0

    if (!hasMicrophone || !hasSystemAudio) {
      microphoneStream.getTracks().forEach((track) => track.stop())
      systemAudioStream.getTracks().forEach((track) => track.stop())
      throw new Error('Audio capture started, but one or more required audio tracks were missing.')
    }

    microphoneStreamRef.current = microphoneStream
    systemAudioStreamRef.current = systemAudioStream
    setAudioAccess({
      microphone: 'capturing',
      systemAudio: 'capturing',
      message: 'Meeting audio capture is active. Streams will stop when the meeting stops.',
    })
  }

  // Jump the replay to an absolute position. Playback continues from there;
  // the auto-analyze counter is rebased so the new position gets one fresh pass.
  function scrubTo(targetSeconds: number) {
    setScrubOffset(targetSeconds - elapsedSeconds * replaySpeed)
    lastAutoAnalyzeRef.current = {
      count: Math.max(0, replayLines.filter((line) => line.seconds <= targetSeconds).length - 1),
      at: lastAutoAnalyzeRef.current.at,
    }
  }

  function cycleReplaySpeed() {
    const next = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(replaySpeed) + 1) % REPLAY_SPEEDS.length]
    // Rebase the offset so changing speed never jumps the call position.
    setScrubOffset(callSeconds - elapsedSeconds * next)
    setReplaySpeed(next)
  }

  async function startMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      if (replayMode) {
        lastAutoAnalyzeRef.current = { count: 0, at: 0 }
        setScrubOffset(0)
        dispatchAnalysis({ type: 'reset' })
        setAudioAccess((current) => ({
          ...current,
          message: 'Replay: playing back the saved meeting. Audio capture is bypassed.',
        }))
        setSession(await window.salesCopilot.startMeeting(meetingTitle, { replay: true }))
        return
      }

      await startAudioStreams()
      setSession(await window.salesCopilot.startMeeting(meetingTitle))
      void analyzeCall()
    } catch (error) {
      stopAudioStreams()
      setAudioAccess((current) => ({
        ...current,
        microphone: microphoneStreamRef.current ? 'capturing' : current.microphone === 'capturing' ? 'ready' : current.microphone,
        systemAudio: systemAudioStreamRef.current ? 'capturing' : current.systemAudio === 'capturing' ? 'ready' : current.systemAudio,
        message: error instanceof Error ? error.message : 'Audio capture could not start.',
      }))
    } finally {
      setIsLoading(false)
    }
  }

  async function analyzeCall() {
    if (!window.salesCopilot) {
      return
    }

    dispatchAnalysis({ type: 'start' })
    const startedAt = performance.now()
    try {
      // Feed the previous analysis back as working state — the model holds
      // stage/questions steady across passes instead of re-deriving them.
      const result = await window.salesCopilot.analyzeCall(analysisTurns, copilotAnalysis, {
        prospectName: prospectName.trim() || null,
        notes: callNotes.trim() || null,
      })
      dispatchAnalysis({
        type: 'succeeded',
        model: result.model,
        analysis: result.analysis,
        latencyMs: performance.now() - startedAt,
      })
    } catch (error) {
      dispatchAnalysis({ type: 'failed', error: readableError(error) || 'Co-pilot analysis failed.' })
    } finally {
      dispatchAnalysis({ type: 'finished' })
    }
  }

  async function pauseMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      if (session?.status === 'recording') {
        if (!replayMode) {
          stopAudioStreams()
          setAudioAccess((current) => ({
            microphone: current.microphone === 'capturing' ? 'ready' : current.microphone,
            systemAudio: current.systemAudio === 'capturing' ? 'ready' : current.systemAudio,
            message: 'Meeting paused. Audio streams were released.',
          }))
        }
        setSession(await window.salesCopilot.pauseMeeting())
        return
      }

      if (session?.status === 'paused') {
        if (!replayMode) {
          await startAudioStreams()
        }
        setSession(await window.salesCopilot.pauseMeeting())
      }
    } catch (error) {
      stopAudioStreams()
      setAudioAccess((current) => ({
        microphone: current.microphone === 'capturing' ? 'ready' : current.microphone,
        systemAudio: current.systemAudio === 'capturing' ? 'ready' : current.systemAudio,
        message: error instanceof Error ? error.message : 'Audio capture could not resume.',
      }))
    } finally {
      setIsLoading(false)
    }
  }

  async function stopMeeting() {
    if (!window.salesCopilot) {
      return
    }

    // Persist the finished call (transcript + latest analysis) so it shows
    // up in the meetings dashboard.
    setSession(
      await window.salesCopilot.stopMeeting({
        durationSeconds: callSeconds,
        transcript: analysisTurns,
        analysis: copilotAnalysis,
        model: copilotAnalysis ? copilotModel : null,
      }),
    )
    if (replayMode) {
      return
    }

    stopAudioStreams()
    setAudioAccess((current) => ({
      microphone: current.microphone === 'capturing' ? 'ready' : current.microphone,
      systemAudio: current.systemAudio === 'capturing' ? 'ready' : current.systemAudio,
      message: 'Meeting stopped. Audio streams were released.',
    }))
  }

  return {
    meetingTitle,
    setMeetingTitle,
    prospectName,
    setProspectName,
    callNotes,
    setCallNotes,
    session,
    view,
    setView,
    isLoading,
    isAnalyzing,
    copilotModel,
    copilotLatencyMs,
    copilotAnalysis,
    copilotError,
    audioAccess,
    replaySpeed,
    replayMode,
    isRecording,
    showStart,
    canUseDesktopBridge,
    meetingStatus,
    stageIdx,
    primaryQuestion,
    secondaryQuestion,
    completedGaps,
    callSeconds,
    shouldWrapSoon,
    transcriptDuration,
    displayedTranscript,
    transcriptRef,
    requestMicrophone,
    requestSystemAudio,
    scrubTo,
    cycleReplaySpeed,
    startMeeting,
    analyzeCall,
    pauseMeeting,
    stopMeeting,
  }
}

function App() {
  const {
    meetingTitle,
    setMeetingTitle,
    prospectName,
    setProspectName,
    callNotes,
    setCallNotes,
    session,
    view,
    setView,
    isLoading,
    isAnalyzing,
    copilotModel,
    copilotLatencyMs,
    copilotAnalysis,
    copilotError,
    audioAccess,
    replaySpeed,
    replayMode,
    isRecording,
    showStart,
    canUseDesktopBridge,
    meetingStatus,
    stageIdx,
    primaryQuestion,
    secondaryQuestion,
    completedGaps,
    callSeconds,
    shouldWrapSoon,
    transcriptDuration,
    displayedTranscript,
    transcriptRef,
    requestMicrophone,
    requestSystemAudio,
    scrubTo,
    cycleReplaySpeed,
    startMeeting,
    analyzeCall,
    pauseMeeting,
    stopMeeting,
  } = useCopilotSession()

  return (
    <main className="panel">
      <Titlebar
        control={showStart ? 'idle' : isRecording ? 'recording' : 'paused'}
        meetingStatus={meetingStatus}
        replayMode={replayMode}
        replaySpeed={replaySpeed}
        onCycleSpeed={cycleReplaySpeed}
        isLoading={isLoading}
        canUseDesktopBridge={canUseDesktopBridge}
        onStart={startMeeting}
        onPause={pauseMeeting}
        onStop={stopMeeting}
        onOpenDashboard={() => window.salesCopilot?.openDashboard()}
      />

      <div className="meeting-row">
        <input
          id="meeting-title"
          value={meetingTitle}
          onChange={(event) => setMeetingTitle(event.target.value)}
          disabled={isRecording}
          placeholder="Meeting name"
          aria-label="Meeting name"
        />
        <span className="timer">
          {formatElapsed(callSeconds)} <em>/ {formatElapsed(TARGET_SECONDS)}</em>
        </span>
      </div>

      {showStart && (
        <div className="prep-fields">
          <input
            value={prospectName}
            onChange={(event) => setProspectName(event.target.value)}
            placeholder="Prospect name"
            aria-label="Prospect name"
          />
          <textarea
            value={callNotes}
            onChange={(event) => setCallNotes(event.target.value)}
            placeholder="Context for the call — who they are, why you're talking, what you want to learn"
            aria-label="Call context"
            rows={3}
          />
        </div>
      )}

      <div className="view-toggle">
        <button
          type="button"
          className={view === 'copilot' ? 'active' : ''}
          onClick={() => setView('copilot')}
        >
          Co-pilot
        </button>
        <button
          type="button"
          className={view === 'transcript' ? 'active' : ''}
          onClick={() => setView('transcript')}
        >
          Transcript
        </button>
      </div>

      {replayMode && (
        <div className="scrub-row">
          <input
            type="range"
            min={0}
            max={transcriptDuration}
            step={1}
            value={Math.min(callSeconds, transcriptDuration)}
            onChange={(event) => scrubTo(Number(event.target.value))}
            disabled={!session}
            aria-label="Scrub through the replay"
            style={{
              background: `linear-gradient(to right, var(--green) ${
                transcriptDuration > 0
                  ? Math.min(100, (callSeconds / transcriptDuration) * 100)
                  : 0
              }%, var(--line) 0)`,
            }}
          />
          <span className="scrub-total">{formatElapsed(transcriptDuration)}</span>
        </div>
      )}

      {view === 'copilot' ? (
        <CopilotView
          stageIdx={stageIdx}
          shouldWrapSoon={shouldWrapSoon}
          primaryQuestion={primaryQuestion}
          secondaryQuestion={secondaryQuestion}
          isAnalyzing={isAnalyzing}
          completedGaps={completedGaps}
          facts={copilotAnalysis?.facts ?? []}
          copilotModel={copilotModel}
          copilotLatencyMs={copilotLatencyMs}
          copilotError={copilotError}
          onAnalyze={analyzeCall}
        />
      ) : (
        <div className="transcript-body" ref={transcriptRef}>
          <p className="transcript-meta">{session?.title ?? 'No active meeting'}</p>
          {displayedTranscript.map((line, index) => (
            <article className="utterance" key={`${line.time}-${index}`}>
              <span className="t-time">{line.time}</span>
              <div>
                <strong className={line.speaker === 'You' ? 'you' : ''}>{line.speaker}</strong>
                <p>{line.text}</p>
              </div>
            </article>
          ))}
          {replayMode && displayedTranscript.length === 0 && (
            <p className="empty-state">
              {session ? 'Waiting for the first line…' : 'Press Start to replay this meeting.'}
            </p>
          )}
        </div>
      )}

      <CaptureSetup
        audioAccess={audioAccess}
        replayMode={replayMode}
        isLoading={isLoading}
        canUseDesktopBridge={canUseDesktopBridge}
        onCheckMic={requestMicrophone}
        onCheckSystemAudio={requestSystemAudio}
        onOpenMicSettings={() => window.salesCopilot?.openPermissionSettings('microphone')}
        onOpenScreenSettings={() => window.salesCopilot?.openPermissionSettings('screen')}
      />
    </main>
  )
}

export default App
