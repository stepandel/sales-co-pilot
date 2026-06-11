import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import type { CopilotAnalysis, MeetingSession, TranscriptTurn } from './types/electron'
import { DISCOVERY_STAGES } from './discovery'
import { CaptureSetup, type AudioAccessState } from './components/CaptureSetup'
import { CopilotView } from './components/CopilotView'
import { Titlebar } from './components/Titlebar'

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
  text: line.text,
  timestamp: line.time,
})) satisfies TranscriptTurn[]

type TestTranscriptLine = {
  speaker: string
  isRep: boolean
  seconds: number
  time: string
  text: string
}

type ParsedTestTranscript = {
  title: string | null
  lines: TestTranscriptLine[]
}

const WORDS_PER_SECOND = 2.5 // ~150 wpm conversational pace
const MIN_UTTERANCE_SECONDS = 2

// Test-mode transcript formats, one utterance per line:
//   - timestamped:     "MM:SS Speaker: text"  (or [MM:SS] / H:MM:SS)
//   - Granola export:  "Me: text" / "Them: text" with an optional metadata
//     header (Meeting Title / Date / Meeting participants / Transcript:) and
//     no timestamps — pacing is then estimated from word count.
// "You" / "Me" / "Rep" map to the rep side. Lines that match neither shape
// continue the previous utterance; blank lines and "#" comments are skipped.
function parseTestTranscript(raw: string): ParsedTestTranscript {
  const lines: TestTranscriptLine[] = []
  let title: string | null = null
  let clock = 0

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const titleMatch = line.match(/^meeting title:\s*(.+)$/i)
    if (titleMatch) {
      title = titleMatch[1].trim()
      continue
    }

    if (/^(date|meeting participants|attendees|transcript):/i.test(line)) {
      continue
    }

    const timeMatch = line.match(/^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s+(.+)$/)
    const body = timeMatch ? timeMatch[4] : line
    const explicitSeconds = timeMatch
      ? timeMatch[3] === undefined
        ? Number(timeMatch[1]) * 60 + Number(timeMatch[2])
        : Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])
      : null

    const speakerMatch = body.match(/^([A-Za-z][A-Za-z0-9 .'-]{0,24}):\s*(.+)$/)
    if (!speakerMatch) {
      if (lines.length > 0) {
        lines[lines.length - 1].text += ` ${body}`
      }
      continue
    }

    const speaker = speakerMatch[1].trim()
    const text = speakerMatch[2].trim()
    const seconds = explicitSeconds ?? clock
    clock =
      seconds +
      Math.max(MIN_UTTERANCE_SECONDS, Math.round(text.split(/\s+/).length / WORDS_PER_SECOND))

    lines.push({
      speaker,
      isRep: /^(you|me|rep)$/i.test(speaker),
      seconds,
      time: formatElapsed(seconds),
      text,
    })
  }

  return { title, lines: lines.sort((a, b) => a.seconds - b.seconds) }
}

const AUTO_ANALYZE_INTERVAL_MS = 12_000
const TEST_SPEEDS = [1, 4, 8] as const

function formatElapsed(seconds = 0) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
    .toString()
    .padStart(2, '0')}`
}

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
}

type AnalysisAction =
  | { type: 'start' }
  | { type: 'succeeded'; model: string; analysis: CopilotAnalysis }
  | { type: 'failed'; error: string }
  | { type: 'finished' }
  | { type: 'reset' }

const initialAnalysisState: AnalysisState = {
  analysis: null,
  error: '',
  model: 'gpt-5.4-mini',
  isAnalyzing: false,
}

function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case 'start':
      return { ...state, isAnalyzing: true, error: '' }
    case 'succeeded':
      return { ...state, model: action.model, analysis: action.analysis }
    case 'failed':
      return { ...state, error: action.error }
    case 'finished':
      return { ...state, isAnalyzing: false }
    case 'reset':
      return { ...state, analysis: null, error: '' }
    default:
      return state
  }
}

// All meeting/session/audio/analysis state and handlers live here so <App />
// stays a thin view layer.
function useCopilotSession() {
  const [meetingTitle, setMeetingTitle] = useState('Discovery call')
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [view, setView] = useState<'copilot' | 'transcript'>('copilot')
  const [isLoading, setIsLoading] = useState(false)
  const [analysisState, dispatchAnalysis] = useReducer(analysisReducer, initialAnalysisState)
  const { analysis: copilotAnalysis, error: copilotError, model: copilotModel, isAnalyzing } =
    analysisState
  const [audioAccess, setAudioAccess] = useState<AudioAccessState>({
    microphone: 'idle',
    systemAudio: 'idle',
    message: 'Audio access has not been requested yet.',
  })
  const [testLines, setTestLines] = useState<TestTranscriptLine[]>([])
  const [testSpeed, setTestSpeed] = useState<(typeof TEST_SPEEDS)[number]>(1)
  const [scrubOffset, setScrubOffset] = useState(0)
  const microphoneStreamRef = useRef<MediaStream | null>(null)
  const systemAudioStreamRef = useRef<MediaStream | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const lastAutoAnalyzeRef = useRef({ count: 0, at: 0 })

  const testMode = testLines.length > 0
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
  // In test mode the session timer drives a synthetic call clock that the
  // playback speed multiplies and the scrubber offsets; everything downstream
  // (timer, pacing, reveals) runs on call time so they stay coherent.
  const callSeconds = testMode
    ? Math.max(0, elapsedSeconds * testSpeed + scrubOffset)
    : elapsedSeconds
  const shouldWrapSoon = stageIdx >= 5 || callSeconds > TARGET_SECONDS - 90
  const transcriptDuration = testLines.length > 0 ? testLines[testLines.length - 1].seconds : 0

  // Test mode: the call clock "plays" the transcript — a line is revealed
  // once the clock passes its timestamp.
  const revealedLines = useMemo(
    () => (testMode && session ? testLines.filter((line) => line.seconds <= callSeconds) : []),
    [testMode, session, testLines, callSeconds],
  )

  const displayedTranscript = testMode
    ? revealedLines.map((line) => ({
        speaker: line.isRep ? 'You' : line.speaker,
        time: line.time,
        text: line.text,
      }))
    : transcriptPreview

  const analysisTurns: TranscriptTurn[] = testMode
    ? revealedLines.map((line) => ({
        speaker: line.isRep ? 'rep' : 'prospect',
        text: line.text,
        timestamp: line.time,
      }))
    : transcriptForAnalysis

  useEffect(() => {
    if (!window.salesCopilot) {
      return
    }

    const removeMeetingListener = window.salesCopilot.onMeetingUpdated(setSession)

    window.salesCopilot.getTestTranscript().then((raw) => {
      if (!raw) {
        return
      }

      const parsed = parseTestTranscript(raw)
      setTestLines(parsed.lines)
      if (parsed.title) {
        setMeetingTitle(parsed.title)
      }
    })

    return () => {
      removeMeetingListener()
      stopAudioStreams()
    }
  }, [])

  useEffect(() => {
    if (view === 'transcript' && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [view, displayedTranscript.length])

  // While a test call plays, re-run the co-pilot as new lines land (throttled),
  // exactly as live STT would.
  useEffect(() => {
    if (!testMode || !isRecording || isAnalyzing) {
      return
    }

    const last = lastAutoAnalyzeRef.current
    if (revealedLines.length > last.count && Date.now() - last.at >= AUTO_ANALYZE_INTERVAL_MS) {
      lastAutoAnalyzeRef.current = { count: revealedLines.length, at: Date.now() }
      void analyzeCall()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- analyzeCall is recreated every render; the throttle guard owns when it fires
  }, [testMode, isRecording, isAnalyzing, revealedLines.length])

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

  // Jump the test call to an absolute position. Playback continues from there;
  // the auto-analyze counter is rebased so the new position gets one fresh pass.
  function scrubTo(targetSeconds: number) {
    setScrubOffset(targetSeconds - elapsedSeconds * testSpeed)
    lastAutoAnalyzeRef.current = {
      count: Math.max(0, testLines.filter((line) => line.seconds <= targetSeconds).length - 1),
      at: lastAutoAnalyzeRef.current.at,
    }
  }

  function cycleTestSpeed() {
    const next = TEST_SPEEDS[(TEST_SPEEDS.indexOf(testSpeed) + 1) % TEST_SPEEDS.length]
    // Rebase the offset so changing speed never jumps the call position.
    setScrubOffset(callSeconds - elapsedSeconds * next)
    setTestSpeed(next)
  }

  async function startMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      if (testMode) {
        lastAutoAnalyzeRef.current = { count: 0, at: 0 }
        setScrubOffset(0)
        dispatchAnalysis({ type: 'reset' })
        setAudioAccess((current) => ({
          ...current,
          message: 'Test mode: playing the transcript file. Audio capture is bypassed.',
        }))
        setSession(await window.salesCopilot.startMeeting(meetingTitle))
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
    try {
      const result = await window.salesCopilot.analyzeCall(analysisTurns)
      dispatchAnalysis({ type: 'succeeded', model: result.model, analysis: result.analysis })
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
        if (!testMode) {
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
        if (!testMode) {
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
    if (testMode) {
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
    session,
    view,
    setView,
    isLoading,
    isAnalyzing,
    copilotModel,
    copilotAnalysis,
    copilotError,
    audioAccess,
    testSpeed,
    testMode,
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
    cycleTestSpeed,
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
    session,
    view,
    setView,
    isLoading,
    isAnalyzing,
    copilotModel,
    copilotAnalysis,
    copilotError,
    audioAccess,
    testSpeed,
    testMode,
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
    cycleTestSpeed,
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
        testMode={testMode}
        testSpeed={testSpeed}
        onCycleSpeed={cycleTestSpeed}
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

      {testMode && (
        <div className="scrub-row">
          <input
            type="range"
            min={0}
            max={transcriptDuration}
            step={1}
            value={Math.min(callSeconds, transcriptDuration)}
            onChange={(event) => scrubTo(Number(event.target.value))}
            disabled={!session}
            aria-label="Scrub through the test call"
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
          {testMode && displayedTranscript.length === 0 && (
            <p className="empty-state">
              {session ? 'Waiting for the first line…' : 'Press Start to play the test transcript.'}
            </p>
          )}
        </div>
      )}

      <CaptureSetup
        audioAccess={audioAccess}
        testMode={testMode}
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
