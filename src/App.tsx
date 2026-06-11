import { Mic, Pause, Pin, Play, Settings2, Sparkles, Square, Volume2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { MeetingSession, TranscriptTurn } from './types/electron'
import type { CopilotAnalysis } from './types/electron'

const DISCOVERY_STAGES = [
  { name: 'Just here to learn', short: 'Learn' },
  { name: 'When did it last happen', short: 'Last time' },
  { name: 'Quantify the pain', short: 'Pain' },
  { name: 'What have they tried?', short: 'Tried' },
  { name: 'Are they already solving it?', short: 'Solving?' },
  { name: 'Ask for commitment', short: 'Commit' },
  { name: 'Lock next steps', short: 'Next steps' },
] as const

const DISCOVERY_GAPS = [
  'concrete instance',
  'cost & frequency',
  'existing workaround / spend',
  'decision power',
  'commitment',
] as const

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

type AudioAccessState = {
  microphone: 'idle' | 'checking' | 'ready' | 'capturing' | 'denied'
  systemAudio: 'idle' | 'checking' | 'ready' | 'capturing' | 'denied'
  message: string
}

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

const isMac = navigator.platform.toUpperCase().includes('MAC')

function App() {
  const [meetingTitle, setMeetingTitle] = useState('Discovery call')
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [view, setView] = useState<'copilot' | 'transcript'>('copilot')
  const [setupOpen, setSetupOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [copilotModel, setCopilotModel] = useState('gpt-5.4-mini')
  const [copilotAnalysis, setCopilotAnalysis] = useState<CopilotAnalysis | null>(null)
  const [copilotError, setCopilotError] = useState('')
  const [audioAccess, setAudioAccess] = useState<AudioAccessState>({
    microphone: 'idle',
    systemAudio: 'idle',
    message: 'Audio access has not been requested yet.',
  })
  const microphoneStreamRef = useRef<MediaStream | null>(null)
  const systemAudioStreamRef = useRef<MediaStream | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

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
  const shouldWrapSoon = stageIdx >= 5 || elapsedSeconds > TARGET_SECONDS - 90

  useEffect(() => {
    if (!window.salesCopilot) {
      return
    }

    const removeMeetingListener = window.salesCopilot.onMeetingUpdated(setSession)

    return () => {
      removeMeetingListener()
      stopAudioStreams()
    }
  }, [])

  useEffect(() => {
    if (view === 'transcript' && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [view])

  function stopAudioStreams() {
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop())
    systemAudioStreamRef.current?.getTracks().forEach((track) => track.stop())
    microphoneStreamRef.current = null
    systemAudioStreamRef.current = null
  }

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

  async function startMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
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

    setIsAnalyzing(true)
    setCopilotError('')
    try {
      const result = await window.salesCopilot.analyzeCall(transcriptForAnalysis)
      setCopilotModel(result.model)
      setCopilotAnalysis(result.analysis)
    } catch (error) {
      setCopilotError(readableError(error) || 'Co-pilot analysis failed.')
    } finally {
      setIsAnalyzing(false)
    }
  }

  async function pauseMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      if (session?.status === 'recording') {
        stopAudioStreams()
        setAudioAccess((current) => ({
          microphone: current.microphone === 'capturing' ? 'ready' : current.microphone,
          systemAudio: current.systemAudio === 'capturing' ? 'ready' : current.systemAudio,
          message: 'Meeting paused. Audio streams were released.',
        }))
        setSession(await window.salesCopilot.pauseMeeting())
        return
      }

      if (session?.status === 'paused') {
        await startAudioStreams()
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

    setSession(await window.salesCopilot.stopMeeting())
    stopAudioStreams()
    setAudioAccess((current) => ({
      microphone: current.microphone === 'capturing' ? 'ready' : current.microphone,
      systemAudio: current.systemAudio === 'capturing' ? 'ready' : current.systemAudio,
      message: 'Meeting stopped. Audio streams were released.',
    }))
  }

  return (
    <main className="panel">
      <header className={`titlebar ${isMac ? 'mac' : ''}`}>
        <span className={`live-dot ${isRecording ? 'live' : ''}`} />
        <strong className="titlebar-name">Co-pilot</strong>
        <span className="titlebar-status">{meetingStatus}</span>

        <div className="session-controls">
          {showStart ? (
            <button
              className="start-btn"
              type="button"
              onClick={startMeeting}
              disabled={isLoading || !canUseDesktopBridge}
            >
              <Play size={12} />
              Start
            </button>
          ) : (
            <>
              <button
                className="tb-btn"
                type="button"
                onClick={pauseMeeting}
                disabled={isLoading}
                title={isRecording ? 'Pause meeting' : 'Resume meeting'}
              >
                {isRecording ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <button className="tb-btn stop" type="button" onClick={stopMeeting} title="Stop meeting">
                <Square size={11} />
              </button>
            </>
          )}
        </div>

        <Pin size={13} className="titlebar-pin" aria-label="Always on top" />
      </header>

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
          {formatElapsed(elapsedSeconds)} <em>/ {formatElapsed(TARGET_SECONDS)}</em>
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

      {view === 'copilot' ? (
        <div className="copilot-body">
          <div className="copilot-content">
            <div className="stage-head">
              <div>
                <p className="stage-eyebrow">
                  Stage {stageIdx + 1}/{DISCOVERY_STAGES.length}
                </p>
                <h2>{DISCOVERY_STAGES[stageIdx].name}</h2>
              </div>
              <span className={`pace ${shouldWrapSoon ? 'wrap' : 'on'}`}>
                {shouldWrapSoon ? 'Wrap soon' : 'On pace'}
              </span>
            </div>

            <section className="ask-card">
              <p className="ask-label">
                Ask next
                {primaryQuestion?.priority === 'high' && <em className="prio">High</em>}
              </p>
              {primaryQuestion ? (
                <>
                  <p className="ask-question">{primaryQuestion.question}</p>
                  <p className="ask-reason">
                    <span aria-hidden="true">&#8627;</span> {primaryQuestion.reason}
                  </p>
                </>
              ) : (
                <p className="ask-empty">
                  {isAnalyzing ? 'Listening to the call\u2026' : 'Run analysis to get your next question.'}
                </p>
              )}
              {secondaryQuestion && (
                <div className="ask-alt">
                  <span>or</span> {secondaryQuestion.question}
                </div>
              )}
            </section>

            <section className="gaps">
              <div className="card-head">
                <h3>Discovery gaps</h3>
                <span>
                  {completedGaps.size}/{DISCOVERY_GAPS.length}
                </span>
              </div>
              <ul>
                {DISCOVERY_GAPS.map((gap) => (
                  <li key={gap} className={completedGaps.has(gap) ? 'done' : ''}>
                    <span className="gap-check" aria-hidden="true">
                      {completedGaps.has(gap) ? '\u2713' : ''}
                    </span>
                    {gap}
                  </li>
                ))}
              </ul>
            </section>

            <section className="signals">
              <div className="card-head">
                <h3>Captured</h3>
                <span className="good-tag">Good data</span>
              </div>
              {copilotAnalysis?.facts.length ? (
                <ul className="facts">
                  {copilotAnalysis.facts.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              ) : (
                <p className="empty-state">Facts appear here as the prospect shares specifics.</p>
              )}
            </section>

            <div className="analyze-row">
              <span>{copilotModel}</span>
              <button type="button" onClick={analyzeCall} disabled={isAnalyzing}>
                <Sparkles size={13} />
                {isAnalyzing ? 'Thinking\u2026' : 'Analyze'}
              </button>
            </div>
            {copilotError && <p className="copilot-error">{copilotError}</p>}
          </div>

          <aside className="rail" aria-label="Discovery stages">
            <div className="rail-line" aria-hidden="true" />
            {DISCOVERY_STAGES.map((stage, index) => (
              <div
                key={stage.name}
                className={`rail-stage ${index < stageIdx ? 'done' : index === stageIdx ? 'active' : ''}`}
                title={stage.name}
              >
                <span className="rail-label">{stage.short}</span>
                <span className="rail-dot" />
              </div>
            ))}
          </aside>
        </div>
      ) : (
        <div className="transcript-body" ref={transcriptRef}>
          <p className="transcript-meta">{session?.title ?? 'No active meeting'}</p>
          {transcriptPreview.map((line) => (
            <article className="utterance" key={`${line.speaker}-${line.time}`}>
              <span className="t-time">{line.time}</span>
              <div>
                <strong className={line.speaker === 'You' ? 'you' : ''}>{line.speaker}</strong>
                <p>{line.text}</p>
              </div>
            </article>
          ))}
        </div>
      )}

      <footer className="setup">
        <button className="setup-toggle" type="button" onClick={() => setSetupOpen((open) => !open)}>
          <Settings2 size={13} />
          Capture setup
          <span className={`access-chip ${audioAccess.microphone}`}>
            <Mic size={11} />
            {audioAccess.microphone}
          </span>
          <span className={`access-chip ${audioAccess.systemAudio}`}>
            <Volume2 size={11} />
            {audioAccess.systemAudio}
          </span>
        </button>

        {setupOpen && (
          <div className="setup-drawer">
            <p>{audioAccess.message}</p>
            <div className="setup-actions">
              <button type="button" onClick={requestMicrophone} disabled={isLoading}>
                Check Mic
              </button>
              <button type="button" onClick={requestSystemAudio} disabled={isLoading}>
                Check System Audio
              </button>
              <button
                type="button"
                onClick={() => window.salesCopilot?.openPermissionSettings('microphone')}
              >
                Mic Settings
              </button>
              <button
                type="button"
                onClick={() => window.salesCopilot?.openPermissionSettings('screen')}
              >
                Screen Settings
              </button>
            </div>
            {!canUseDesktopBridge && (
              <p className="browser-warning">
                Run this inside Electron with <code>deno task dev</code> to enable desktop capture APIs.
              </p>
            )}
          </div>
        )}
      </footer>
    </main>
  )
}

export default App
