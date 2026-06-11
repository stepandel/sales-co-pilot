import { History, Pause, Pin, Play, Square } from 'lucide-react'

type TitlebarProps = {
  isMac: boolean
  isRecording: boolean
  meetingStatus: string
  testMode: boolean
  testSpeed: number
  onCycleSpeed: () => void
  showStart: boolean
  isLoading: boolean
  canUseDesktopBridge: boolean
  onStart: () => void
  onPause: () => void
  onStop: () => void
  onOpenDashboard: () => void
}

export function Titlebar({
  isMac,
  isRecording,
  meetingStatus,
  testMode,
  testSpeed,
  onCycleSpeed,
  showStart,
  isLoading,
  canUseDesktopBridge,
  onStart,
  onPause,
  onStop,
  onOpenDashboard,
}: TitlebarProps) {
  return (
    <header className={`titlebar ${isMac ? 'mac' : ''}`}>
      <span className={`live-dot ${isRecording ? 'live' : ''}`} />
      <strong className="titlebar-name">Co-pilot</strong>
      <span className="titlebar-status">{meetingStatus}</span>
      {testMode && (
        <button
          type="button"
          className="test-badge"
          title="Test mode playback speed — click to change"
          onClick={onCycleSpeed}
        >
          Test {testSpeed}&times;
        </button>
      )}

      <div className="session-controls">
        {showStart ? (
          <button
            className="start-btn"
            type="button"
            onClick={onStart}
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
              onClick={onPause}
              disabled={isLoading}
              title={isRecording ? 'Pause meeting' : 'Resume meeting'}
            >
              {isRecording ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button className="tb-btn stop" type="button" onClick={onStop} title="Stop meeting">
              <Square size={11} />
            </button>
          </>
        )}
      </div>

      <button
        className="tb-btn"
        type="button"
        onClick={onOpenDashboard}
        disabled={!canUseDesktopBridge}
        title="Open meetings dashboard"
      >
        <History size={13} />
      </button>

      <Pin size={13} className="titlebar-pin" aria-label="Always on top" />
    </header>
  )
}
