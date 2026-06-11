import {
  Bot,
  CheckCircle2,
  CircleDot,
  Clock3,
  Mic,
  MonitorUp,
  Pause,
  PhoneCall,
  Play,
  Radio,
  ShieldCheck,
  Square,
  Sparkles,
  Volume2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { CopilotAnalysis, MeetingSession, PermissionState, TranscriptTurn } from './types/electron'

const demoTranscript = [
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
].map((line) => ({
  speaker: line.speaker === 'You' ? 'rep' : 'prospect',
  text: line.text,
  timestamp: line.time,
})) satisfies TranscriptTurn[]

const visibleDemoTranscript = [
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

const coachingPrompts = [
  'Ask who owns the post-signature handoff today.',
  'Quantify the delay in days and revenue impact.',
  'Confirm whether legal approval is the buying trigger.',
]

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

function statusLabel(permission?: string) {
  if (!permission || permission === 'unknown') {
    return 'Ready to check'
  }

  return permission
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function App() {
  const [meetingTitle, setMeetingTitle] = useState('Discovery call')
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [permissions, setPermissions] = useState<PermissionState | null>(null)
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

  const isRecording = session?.status === 'recording'
  const canUseDesktopBridge = Boolean(window.salesCopilot)

  const meetingStatus = useMemo(() => {
    if (!session) {
      return 'Ready'
    }

    if (session.status === 'recording') {
      return 'Recording live'
    }

    return session.status.charAt(0).toUpperCase() + session.status.slice(1)
  }, [session])

  const visiblePrompts = copilotAnalysis?.nextQuestions.length
    ? copilotAnalysis.nextQuestions.map((prompt) => prompt.question)
    : coachingPrompts

  useEffect(() => {
    if (!window.salesCopilot) {
      return
    }

    window.salesCopilot.getPermissionState().then(setPermissions).catch(console.error)
    const removeMeetingListener = window.salesCopilot.onMeetingUpdated(setSession)

    return () => {
      removeMeetingListener()
      stopAudioStreams()
    }
  }, [])

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

  async function refreshPermissions() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      setPermissions(await window.salesCopilot.getPermissionState())
    } finally {
      setIsLoading(false)
    }
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
      setPermissions(await window.salesCopilot.requestMicrophonePermission())
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
      setPermissions(await window.salesCopilot.getPermissionState())
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
      const result = await window.salesCopilot.analyzeCall(demoTranscript)
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
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Radio size={19} />
          </div>
          <div>
            <strong>Sales Co-Pilot</strong>
            <span>Live call intelligence</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          <button className="nav-item active" type="button">
            <PhoneCall size={18} />
            Meetings
          </button>
          <button className="nav-item" type="button">
            <Bot size={18} />
            Coaching
          </button>
          <button className="nav-item" type="button">
            <ShieldCheck size={18} />
            Setup
          </button>
        </nav>

        <div className="setup-panel">
          <div className="panel-heading">
            <span>Capture Readiness</span>
            <button type="button" onClick={refreshPermissions} disabled={isLoading}>
              Check
            </button>
          </div>

          <div className="check-row">
            <Mic size={17} />
            <span>Microphone</span>
            <b>{statusLabel(permissions?.microphone)}</b>
          </div>
          <div className="check-row">
            <MonitorUp size={17} />
            <span>Screen source</span>
            <b>{statusLabel(permissions?.screen)}</b>
          </div>
          <div className="check-row">
            <Volume2 size={17} />
            <span>System audio</span>
            <b>{audioAccess.systemAudio === 'capturing' ? 'Capturing' : 'Loopback'}</b>
          </div>

          <button className="secondary-action" type="button" onClick={requestMicrophone} disabled={isLoading}>
            Request Mic Access
          </button>
          <button className="secondary-action" type="button" onClick={requestSystemAudio} disabled={isLoading}>
            Request System Audio
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Meeting console</p>
            <h1>Start a call, capture audio, and coach the conversation.</h1>
          </div>
          <div className={`status-pill ${isRecording ? 'live' : ''}`}>
            <CircleDot size={14} />
            {meetingStatus}
          </div>
        </header>

        <section className="meeting-control">
          <div className="meeting-title">
            <label htmlFor="meeting-title">Meeting name</label>
            <input
              id="meeting-title"
              value={meetingTitle}
              onChange={(event) => setMeetingTitle(event.target.value)}
              disabled={isRecording}
            />
          </div>

          <div className="timer">
            <Clock3 size={18} />
            <span>{formatElapsed(session?.elapsedSeconds)}</span>
          </div>

          <div className="meeting-actions">
            <button className="primary-action" type="button" onClick={startMeeting} disabled={isLoading || isRecording}>
              <Play size={18} />
              Start New Meeting
            </button>
            <button className="icon-action" type="button" onClick={pauseMeeting} disabled={isLoading || !session || session.status === 'stopped'}>
              <Pause size={18} />
            </button>
            <button className="icon-action stop" type="button" onClick={stopMeeting} disabled={!session || session.status === 'stopped'}>
              <Square size={17} />
            </button>
          </div>
        </section>

        <section className="audio-access-panel">
          <div className={`access-chip ${audioAccess.microphone}`}>
            <Mic size={16} />
            Mic: {audioAccess.microphone}
          </div>
          <div className={`access-chip ${audioAccess.systemAudio}`}>
            <Volume2 size={16} />
            System: {audioAccess.systemAudio}
          </div>
          <p>{audioAccess.message}</p>
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
        </section>

        {!canUseDesktopBridge && (
          <div className="browser-warning">
            Run this inside Electron with <code>deno task dev</code> to enable desktop capture APIs.
          </div>
        )}

        <section className="content-grid">
          <div className="transcript-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Live transcript</p>
                <h2>{session?.title ?? 'No active meeting'}</h2>
              </div>
              <span>{isRecording ? 'Streaming' : 'Standby'}</span>
            </div>

            <div className="waveform" aria-hidden="true">
              {Array.from({ length: 32 }).map((_, index) => (
                <i key={index} style={{ height: `${22 + ((index * 17) % 56)}px` }} />
              ))}
            </div>

            <div className="transcript-list">
              {visibleDemoTranscript.map((line) => (
                <article className="utterance" key={`${line.speaker}-${line.time}`}>
                  <div>
                    <strong>{line.speaker}</strong>
                    <span>{line.time}</span>
                  </div>
                  <p>{line.text}</p>
                </article>
              ))}
            </div>
          </div>

          <aside className="coach-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">AI co-pilot</p>
                <h2>{copilotAnalysis?.stage ?? 'Next best moves'}</h2>
              </div>
              <Sparkles size={20} />
            </div>

            <div className="model-row">
              <span>{copilotModel}</span>
              <button type="button" onClick={analyzeCall} disabled={isAnalyzing}>
                {isAnalyzing ? 'Thinking' : 'Analyze'}
              </button>
            </div>

            {copilotError && <p className="copilot-error">{copilotError}</p>}

            <div className="prompt-list">
              {visiblePrompts.map((prompt) => (
                <div className="prompt" key={prompt}>
                  <CheckCircle2 size={17} />
                  <span>{prompt}</span>
                </div>
              ))}
            </div>

            {copilotAnalysis?.facts.length ? (
              <div className="facts-list">
                <h3>Transcript facts</h3>
                {copilotAnalysis.facts.map((fact) => (
                  <span key={fact}>{fact}</span>
                ))}
              </div>
            ) : null}

            <div className="integration-card">
              <h3>LLM pipeline</h3>
              <p>Coaching is generated through the Electron main process using OpenAI Responses and the ycmoss discovery prompt.</p>
            </div>
          </aside>
        </section>
      </section>
    </main>
  )
}

export default App
