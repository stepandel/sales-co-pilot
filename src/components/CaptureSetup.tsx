import { useState } from 'react'
import { Mic, Settings2, Volume2 } from 'lucide-react'

export type AudioAccessState = {
  microphone: 'idle' | 'checking' | 'ready' | 'capturing' | 'denied'
  systemAudio: 'idle' | 'checking' | 'ready' | 'capturing' | 'denied'
  message: string
}

type CaptureSetupProps = {
  audioAccess: AudioAccessState
  testMode: boolean
  isLoading: boolean
  canUseDesktopBridge: boolean
  onCheckMic: () => void
  onCheckSystemAudio: () => void
  onOpenMicSettings: () => void
  onOpenScreenSettings: () => void
}

export function CaptureSetup({
  audioAccess,
  testMode,
  isLoading,
  canUseDesktopBridge,
  onCheckMic,
  onCheckSystemAudio,
  onOpenMicSettings,
  onOpenScreenSettings,
}: CaptureSetupProps) {
  // Drawer open/closed is purely local UI state, so it lives here rather than
  // in <App />.
  const [setupOpen, setSetupOpen] = useState(false)

  return (
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
            <button type="button" onClick={onCheckMic} disabled={isLoading}>
              Check Mic
            </button>
            <button type="button" onClick={onCheckSystemAudio} disabled={isLoading}>
              Check System Audio
            </button>
            <button type="button" onClick={onOpenMicSettings}>
              Mic Settings
            </button>
            <button type="button" onClick={onOpenScreenSettings}>
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
  )
}
