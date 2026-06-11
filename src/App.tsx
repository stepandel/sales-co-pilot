import { History, Mic, Pause, Pin, Play, Settings2, Sparkles, Square, Volume2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

const QUESTION_WORDS =
  /\b(?:how(?:\s+(?:much|many|often|long|soon))?|what|when|where|who|whom|whose|why|which)\b/gi
const LEADING_AUXILIARY =
  /^(?:do|does|did|can|could|would|will|should|is|are|was|were|have|has|had)\b/i
const WORD_TOKEN = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’]+)(.*)$/u

// Bionic reading: bold the first ~40% of each word as a fixation anchor so
// the eye can skim the question instead of reading it.
function bionicText(text: string): ReactNode[] {
  return text.split(/(\s+)/).map((token, index) => {
    const match = token.match(WORD_TOKEN)
    if (!match) {
      return token
    }

    const [, lead, core, rest] = match
    const split = core.length <= 3 ? 1 : Math.ceil(core.length * 0.4)

    return (
      <span key={index}>
        {lead}
        <b className="bx">{core.slice(0, split)}</b>
        {core.slice(split)}
        {rest}
      </span>
    )
  })
}

// Interrogative words signal the question's purpose, so they always keep full
// ink (see .qw in App.css) even when the rest of the question dims.
function withQuestionWords(text: string, atQuestionStart: boolean): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0

  const lead = atQuestionStart ? text.match(LEADING_AUXILIARY) : null
  if (lead) {
    nodes.push(
      <b className="qw" key="lead">
        {bionicText(lead[0])}
      </b>,
    )
    cursor = lead[0].length
  }

  for (const match of text.matchAll(QUESTION_WORDS)) {
    const index = match.index ?? 0
    if (index < cursor) {
      continue
    }

    if (index > cursor) {
      nodes.push(<span key={`t${cursor}`}>{bionicText(text.slice(cursor, index))}</span>)
    }
    nodes.push(
      <b className="qw" key={index}>
        {bionicText(match[0])}
      </b>,
    )
    cursor = index + match[0].length
  }

  if (cursor < text.length) {
    nodes.push(<span key={`t${cursor}`}>{bionicText(text.slice(cursor))}</span>)
  }

  return nodes
}

// The key span stays full-ink while the rest of the question dims (see
// .has-key in App.css), so the rep can catch the ask without reading it all.
function emphasizedQuestion(question: string, emphasis: string) {
  const index = emphasis ? question.indexOf(emphasis) : -1
  if (index === -1) {
    return <>{withQuestionWords(question, true)}</>
  }

  return (
    <>
      {withQuestionWords(question.slice(0, index), true)}
      <mark>{bionicText(emphasis)}</mark>
      {withQuestionWords(question.slice(index + emphasis.length), false)}
    </>
  )
}

const isMac = navigator.platform.toUpperCase().includes('MAC')

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
        setCopilotAnalysis(null)
        setCopilotError('')
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

    setIsAnalyzing(true)
    setCopilotError('')
    try {
      const result = await window.salesCopilot.analyzeCall(analysisTurns)
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

  return (
    <main className="panel">
      <header className={`titlebar ${isMac ? 'mac' : ''}`}>
        <span className={`live-dot ${isRecording ? 'live' : ''}`} />
        <strong className="titlebar-name">Co-pilot</strong>
        <span className="titlebar-status">{meetingStatus}</span>
        {testMode && (
          <button
            type="button"
            className="test-badge"
            title="Test mode playback speed — click to change"
            onClick={cycleTestSpeed}
          >
            Test {testSpeed}&times;
          </button>
        )}

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

        <button
          className="tb-btn"
          type="button"
          onClick={() => window.salesCopilot?.openDashboard()}
          disabled={!canUseDesktopBridge}
          title="Open meetings dashboard"
        >
          <History size={13} />
        </button>

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
                  <p className={`ask-question ${primaryQuestion.emphasis ? 'has-key' : ''}`}>
                    {emphasizedQuestion(primaryQuestion.question, primaryQuestion.emphasis)}
                  </p>
                  <p className="ask-reason">
                    <span className="reason-arrow" aria-hidden="true">&#8627;</span>
                    <span className="reason-text">{bionicText(primaryQuestion.reason)}</span>
                  </p>
                </>
              ) : (
                <p className="ask-empty">
                  {isAnalyzing ? 'Listening to the call\u2026' : 'Run analysis to get your next question.'}
                </p>
              )}
              {secondaryQuestion && (
                <div className={`ask-alt ${secondaryQuestion.emphasis ? 'has-key' : ''}`}>
                  <span className="alt-label">or</span>{' '}
                  {emphasizedQuestion(secondaryQuestion.question, secondaryQuestion.emphasis)}
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
            {testMode && (
              <p className="test-note">
                <code>test-transcript.txt</code> found — meetings play this transcript instead of
                capturing audio. Remove the file to go back to live capture.
              </p>
            )}
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
