import { CalendarDays, Clock3, Inbox, MessageSquareText, Play, Plus, Send, Sparkles, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './Dashboard.css'
import type { MeetingChatMessage, MeetingRecord, MeetingSummary } from './types/electron'

const DISCOVERY_GAPS = [
  'concrete instance',
  'cost & frequency',
  'existing workaround / spend',
  'decision power',
  'commitment',
] as const

const isMac = navigator.platform.toUpperCase().includes('MAC')

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`
  }

  return `${minutes.toString().padStart(2, '0')}:${remaining.toString().padStart(2, '0')}`
}

function formatDay(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) {
    return 'Today'
  }

  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday'
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function Dashboard() {
  const [summaries, setSummaries] = useState<MeetingSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadedRecord, setLoadedRecord] = useState<MeetingRecord | null>(null)
  // Without the desktop bridge there is nothing to load, so start "loaded".
  const [isLoaded, setIsLoaded] = useState(() => !window.salesCopilot)
  const [importError, setImportError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
  // Keyed by meeting id so the message only shows on the meeting it belongs to.
  const [analyzeError, setAnalyzeError] = useState<{ id: string; message: string } | null>(null)
  // Coach chats live per meeting for the lifetime of the window; they are not persisted.
  const [chats, setChats] = useState<Record<string, MeetingChatMessage[]>>({})
  const [chatInput, setChatInput] = useState('')
  const [chattingId, setChattingId] = useState<string | null>(null)
  const [chatError, setChatError] = useState<{ id: string; message: string } | null>(null)
  const chatLogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const bridge = window.salesCopilot
    if (!bridge) {
      return
    }

    let disposed = false
    const refresh = () => {
      void bridge.listMeetings().then((meetings) => {
        if (disposed) {
          return
        }

        setSummaries(meetings)
        setSelectedId((current) =>
          current && meetings.some((meeting) => meeting.id === current)
            ? current
            : meetings[0]?.id ?? null,
        )
        setIsLoaded(true)
      })
    }

    refresh()
    const removeListener = bridge.onMeetingsChanged(refresh)

    return () => {
      disposed = true
      removeListener()
    }
  }, [])

  useEffect(() => {
    if (!selectedId || !window.salesCopilot) {
      return
    }

    let cancelled = false
    window.salesCopilot.getMeeting(selectedId).then((meeting) => {
      if (!cancelled && meeting) {
        setLoadedRecord(meeting)
      }
    })

    return () => {
      cancelled = true
    }
  }, [selectedId, summaries])

  async function deleteMeeting(id: string) {
    await window.salesCopilot?.deleteMeeting(id)
    // The meetings:changed broadcast triggers refresh; nothing else to do.
  }

  // Run the co-pilot over a stored meeting's transcript; works for imported
  // calls and re-analyzes already-analyzed ones.
  async function analyzeMeeting(id: string) {
    if (!window.salesCopilot) {
      return
    }

    setAnalyzingId(id)
    setAnalyzeError(null)
    try {
      const result = await window.salesCopilot.analyzeMeeting(id)
      if ('error' in result) {
        setAnalyzeError({ id, message: result.error })
        return
      }

      setLoadedRecord(result.record)
    } finally {
      setAnalyzingId(null)
    }
  }

  async function sendChatMessage(id: string) {
    const question = chatInput.trim()
    if (!question || chattingId || !window.salesCopilot) {
      return
    }

    const messages: MeetingChatMessage[] = [...(chats[id] ?? []), { role: 'user', content: question }]
    setChats((current) => ({ ...current, [id]: messages }))
    setChatInput('')
    setChattingId(id)
    setChatError(null)
    try {
      const result = await window.salesCopilot.chatAboutMeeting(id, messages)
      if ('error' in result) {
        setChatError({ id, message: result.error })
        return
      }

      setChats((current) => ({
        ...current,
        [id]: [...messages, { role: 'assistant', content: result.reply }],
      }))
    } finally {
      setChattingId(null)
    }
  }

  // Both import paths: the main process parses and stores the transcript, and
  // the meetings:changed broadcast brings it into the list — we just select it.
  function applyImportResult(result: { id: string } | { error: string } | null | undefined) {
    if (!result) {
      return
    }

    if ('error' in result) {
      setImportError(result.error)
      return
    }

    setImportError('')
    setImportOpen(false)
    setPasteText('')
    setSelectedId(result.id)
  }

  async function importTranscriptFile() {
    applyImportResult(await window.salesCopilot?.importTranscript())
  }

  async function importPastedTranscript() {
    if (!pasteText.trim()) {
      return
    }

    applyImportResult(await window.salesCopilot?.importTranscriptText(pasteText))
  }

  // List rows grouped by calendar day, newest first (the store is already sorted).
  const groups = useMemo(() => {
    const byDay: Array<{ day: string; meetings: MeetingSummary[] }> = []
    for (const meeting of summaries) {
      const day = formatDay(meeting.startedAt)
      const group = byDay[byDay.length - 1]
      if (group && group.day === day) {
        group.meetings.push(meeting)
      } else {
        byDay.push({ day, meetings: [meeting] })
      }
    }

    return byDay
  }, [summaries])

  // Show the loaded record only while it matches the selection; a stale
  // record (just-deleted or mid-switch) falls back to the empty state.
  const record = loadedRecord && loadedRecord.id === selectedId ? loadedRecord : null
  const completedGaps = new Set(record?.analysis?.completedGaps ?? [])
  const chatMessages = record ? chats[record.id] ?? [] : []

  // Keep the newest chat message (or the thinking indicator) in view.
  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight })
  }, [chatMessages.length, chattingId])

  return (
    <main className="dash">
      <header className={`dash-titlebar ${isMac ? 'mac' : ''}`}>
        <strong>Meetings</strong>
        <span className="dash-count">
          {summaries.length} {summaries.length === 1 ? 'call' : 'calls'}
        </span>
        {importError && !importOpen && (
          <span className="dash-import-error" role="alert">
            {importError}
          </span>
        )}
        {window.salesCopilot && (
          <>
            <button
              type="button"
              className="dash-import"
              title="Import a transcript by pasting it or from a file"
              onClick={() => {
                setImportError('')
                setImportOpen(true)
              }}
            >
              <Upload size={12} /> Import transcript
            </button>
            <button
              type="button"
              className="dash-new"
              title="Open the co-pilot panel for a new meeting"
              onClick={() => void window.salesCopilot?.openCopilot()}
            >
              <Plus size={12} /> New meeting
            </button>
          </>
        )}
      </header>

      {importOpen && (
        <div
          className="dash-modal-backdrop"
          onClick={() => setImportOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setImportOpen(false)
            }
          }}
        >
          <div
            className="dash-modal"
            role="dialog"
            aria-label="Import transcript"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>Import transcript</h2>
            <p className="dash-modal-hint">
              Paste a transcript below — timestamped "MM:SS Speaker: text" lines or a
              Granola-style "Me:/Them:" export, with an optional "Meeting Title:" / "Date:"
              header.
            </p>
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder={'Meeting Title: Acme discovery call\nMe: Thanks for making time today.\nThem: Of course. We have been struggling with…'}
              autoFocus
            />
            {importError && (
              <p className="dash-import-error" role="alert">
                {importError}
              </p>
            )}
            <div className="dash-modal-actions">
              <button type="button" className="dash-import" onClick={() => void importTranscriptFile()}>
                <Upload size={12} /> From file…
              </button>
              <span className="dash-modal-spacer" />
              <button type="button" className="dash-import" onClick={() => setImportOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="dash-new"
                disabled={!pasteText.trim()}
                onClick={() => void importPastedTranscript()}
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="dash-body">
        <aside className="dash-list">
          {!isLoaded ? null : summaries.length === 0 ? (
            <div className="dash-list-empty">
              <Inbox size={20} />
              <p>No meetings yet</p>
              <span>Finished calls land here automatically, transcript and notes included.</span>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.day}>
                <h2 className="dash-day">{group.day}</h2>
                {group.meetings.map((meeting) => (
                  <button
                    key={meeting.id}
                    type="button"
                    className={`dash-item ${meeting.id === selectedId ? 'selected' : ''}`}
                    onClick={() => setSelectedId(meeting.id)}
                  >
                    <span className="dash-item-title">{meeting.title}</span>
                    <span className="dash-item-meta">
                      {formatTime(meeting.startedAt)} · {formatDuration(meeting.durationSeconds)}
                      {meeting.stage && <em className="dash-item-stage">{meeting.stage}</em>}
                    </span>
                    <span className="dash-item-gaps" aria-hidden="true">
                      {DISCOVERY_GAPS.map((gap) => (
                        <i key={gap} className={meeting.completedGaps.includes(gap) ? 'done' : ''} />
                      ))}
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
        </aside>

        <section className="dash-detail">
          {!record ? (
            <div className="dash-detail-empty">
              {isLoaded && summaries.length === 0
                ? 'Run a call from the co-pilot panel — it will show up here when you stop it.'
                : 'Select a meeting to review it.'}
            </div>
          ) : (
            <>
              <header className="dash-detail-head">
                <div>
                  <h1>{record.title}</h1>
                  <p className="dash-detail-meta">
                    <span>
                      <CalendarDays size={12} /> {formatDay(record.startedAt)},{' '}
                      {formatTime(record.startedAt)}
                    </span>
                    <span>
                      <Clock3 size={12} /> {formatDuration(record.durationSeconds)}
                    </span>
                    <span>
                      <MessageSquareText size={12} /> {record.transcript.length} turns
                    </span>
                    {record.model && (
                      <span>
                        <Sparkles size={12} /> {record.model}
                      </span>
                    )}
                  </p>
                </div>
                <div className="dash-detail-actions">
                  <button
                    type="button"
                    className="dash-analyze"
                    disabled={record.transcript.length === 0}
                    title="Replay this meeting in the co-pilot panel"
                    onClick={() => void window.salesCopilot?.openCopilot(record.id)}
                  >
                    <Play size={13} />
                    Replay
                  </button>
                  <button
                    type="button"
                    className="dash-analyze"
                    disabled={analyzingId !== null}
                    title="Run the co-pilot over this transcript"
                    onClick={() => void analyzeMeeting(record.id)}
                  >
                    <Sparkles size={13} />
                    {analyzingId === record.id
                      ? 'Analyzing…'
                      : record.analysis
                        ? 'Re-analyze'
                        : 'Analyze'}
                  </button>
                  <button
                    type="button"
                    className="dash-delete"
                    title="Delete meeting"
                    onClick={() => void deleteMeeting(record.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </header>

              {analyzeError?.id === record.id && (
                <p className="dash-analyze-error" role="alert">
                  {analyzeError.message}
                </p>
              )}

              <div className="dash-columns">
                <div className="dash-col">
                  <section className="dash-card">
                    <div className="dash-card-head">
                      <h3>Post-mortem</h3>
                      {record.postMortem && (
                        <span className="dash-score" title="Mom Test adherence">
                          {record.postMortem.score}/10
                        </span>
                      )}
                    </div>
                    {record.postMortem ? (
                      <>
                        {record.postMortem.verdict && (
                          <p className="dash-verdict">{record.postMortem.verdict}</p>
                        )}
                        <h4 className="dash-pm-label">What went well</h4>
                        <ul className="dash-pm-list good">
                          {record.postMortem.wentWell.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        <h4 className="dash-pm-label">What could've been better</h4>
                        <ul className="dash-pm-list bad">
                          {record.postMortem.couldImprove.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="dash-empty-note">
                        {record.analysis ? 'Re-analyze' : 'Analyze'} this call to grade it against
                        The Mom Test and get what-went-well / what-to-fix feedback.
                      </p>
                    )}
                  </section>

                  <section className="dash-card">
                    <div className="dash-card-head">
                      <h3>Discovery gaps</h3>
                      <span>
                        {completedGaps.size}/{DISCOVERY_GAPS.length}
                      </span>
                    </div>
                    {record.analysis ? (
                      <>
                        <p className="dash-stage-line">
                          Reached stage: <strong>{record.analysis.stage}</strong>
                        </p>
                        <ul className="dash-gaps">
                          {DISCOVERY_GAPS.map((gap) => (
                            <li key={gap} className={completedGaps.has(gap) ? 'done' : ''}>
                              <span aria-hidden="true">{completedGaps.has(gap) ? '✓' : ''}</span>
                              {gap}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="dash-empty-note">This call was never analyzed by the co-pilot.</p>
                    )}
                  </section>

                  <section className="dash-card">
                    <div className="dash-card-head">
                      <h3>Captured facts</h3>
                      <span>{record.analysis?.facts.length ?? 0}</span>
                    </div>
                    {record.analysis?.facts.length ? (
                      <ul className="dash-facts">
                        {record.analysis.facts.map((fact) => (
                          <li key={fact}>{fact}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="dash-empty-note">No facts were captured on this call.</p>
                    )}
                  </section>

                  <section className="dash-card dash-chat">
                    <div className="dash-card-head">
                      <h3>Ask the coach</h3>
                    </div>
                    {chatMessages.length > 0 || chattingId === record.id ? (
                      <div className="dash-chat-log" ref={chatLogRef}>
                        {chatMessages.map((message, index) => (
                          <p
                            key={`${message.role}-${index}`}
                            className={`dash-chat-msg ${message.role}`}
                          >
                            {message.content}
                          </p>
                        ))}
                        {chattingId === record.id && (
                          <p className="dash-chat-msg assistant pending">Thinking…</p>
                        )}
                      </div>
                    ) : (
                      <p className="dash-empty-note">
                        Ask follow-up questions about this call and its feedback — e.g. "why did I
                        lose points on commitment?"
                      </p>
                    )}
                    {chatError?.id === record.id && (
                      <p className="dash-chat-error" role="alert">
                        {chatError.message}
                      </p>
                    )}
                    <form
                      className="dash-chat-input"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void sendChatMessage(record.id)
                      }}
                    >
                      <input
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        placeholder="Ask about this call…"
                        aria-label="Ask the coach about this call"
                      />
                      <button
                        type="submit"
                        title="Send"
                        disabled={chattingId !== null || !chatInput.trim()}
                      >
                        <Send size={13} />
                      </button>
                    </form>
                  </section>
                </div>

                <section className="dash-transcript">
                  <h3>Transcript</h3>
                  {record.transcript.length === 0 ? (
                    <p className="dash-empty-note">No transcript was recorded for this call.</p>
                  ) : (
                    record.transcript.map((turn, index) => (
                      <article className="dash-utterance" key={`${turn.timestamp ?? ''}-${index}`}>
                        <span className="dash-t-time">{turn.timestamp ?? ''}</span>
                        <div>
                          <strong className={turn.speaker === 'rep' ? 'you' : ''}>
                            {turn.speaker === 'rep' ? 'You' : turn.name ?? 'Prospect'}
                          </strong>
                          <p>{turn.text}</p>
                        </div>
                      </article>
                    ))
                  )}
                </section>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}

export default Dashboard
