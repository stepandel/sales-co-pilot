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
import { useEffect, useMemo, useState } from 'react'
import './App.css'
import type { MeetingSession, PermissionState } from './types/electron'

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
]

const coachingPrompts = [
  'Ask who owns the post-signature handoff today.',
  'Quantify the delay in days and revenue impact.',
  'Confirm whether legal approval is the buying trigger.',
]

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

function App() {
  const [meetingTitle, setMeetingTitle] = useState('Discovery call')
  const [session, setSession] = useState<MeetingSession | null>(null)
  const [permissions, setPermissions] = useState<PermissionState | null>(null)
  const [isLoading, setIsLoading] = useState(false)

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

  useEffect(() => {
    if (!window.salesCopilot) {
      return
    }

    window.salesCopilot.getPermissionState().then(setPermissions).catch(console.error)
    return window.salesCopilot.onMeetingUpdated(setSession)
  }, [])

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
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      setPermissions(await window.salesCopilot.requestMicrophonePermission())
    } finally {
      setIsLoading(false)
    }
  }

  async function startMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setIsLoading(true)
    try {
      setSession(await window.salesCopilot.startMeeting(meetingTitle))
      setPermissions(await window.salesCopilot.getPermissionState())
    } finally {
      setIsLoading(false)
    }
  }

  async function pauseMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setSession(await window.salesCopilot.pauseMeeting())
  }

  async function stopMeeting() {
    if (!window.salesCopilot) {
      return
    }

    setSession(await window.salesCopilot.stopMeeting())
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
            <b>Native slot</b>
          </div>

          <button className="secondary-action" type="button" onClick={requestMicrophone}>
            Request Mic Access
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
            <button className="icon-action" type="button" onClick={pauseMeeting} disabled={!session || session.status === 'stopped'}>
              <Pause size={18} />
            </button>
            <button className="icon-action stop" type="button" onClick={stopMeeting} disabled={!session || session.status === 'stopped'}>
              <Square size={17} />
            </button>
          </div>
        </section>

        {!canUseDesktopBridge && (
          <div className="browser-warning">
            Run this inside Electron with <code>npm run dev</code> to enable desktop capture APIs.
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
              {demoTranscript.map((line) => (
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
                <h2>Next best moves</h2>
              </div>
              <Sparkles size={20} />
            </div>

            <div className="prompt-list">
              {coachingPrompts.map((prompt) => (
                <div className="prompt" key={prompt}>
                  <CheckCircle2 size={17} />
                  <span>{prompt}</span>
                </div>
              ))}
            </div>

            <div className="integration-card">
              <h3>Scaffolded pipeline</h3>
              <p>Desktop capture bridge, transcription adapter, meeting memory, and coaching engine boundaries are ready for implementation.</p>
            </div>
          </aside>
        </section>
      </section>
    </main>
  )
}

export default App
