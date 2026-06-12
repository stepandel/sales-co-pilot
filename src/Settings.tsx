import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import './Settings.css'
import type { SettingsState } from './types/electron'

type TestResult = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string }

export default function Settings() {
  const [state, setState] = useState<SettingsState | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const [test, setTest] = useState<TestResult>({ kind: 'idle' })
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    void window.salesCopilot?.getSettings().then(setState)
  }, [])

  if (!window.salesCopilot) {
    return <main className="settings">Run inside the desktop app to manage settings.</main>
  }

  async function saveKey() {
    if (!draft.trim() || !window.salesCopilot) {
      return
    }

    setIsBusy(true)
    setStatus('')
    setTest({ kind: 'idle' })
    try {
      const result = await window.salesCopilot.setOpenAiKey(draft)
      if ('error' in result) {
        setStatus(result.error)
        return
      }

      setState(result.state)
      setDraft('')
      setStatus('Key saved.')
    } finally {
      setIsBusy(false)
    }
  }

  async function clearKey() {
    if (!window.salesCopilot) {
      return
    }

    setIsBusy(true)
    setTest({ kind: 'idle' })
    try {
      const { state: next } = await window.salesCopilot.clearOpenAiKey()
      setState(next)
      setStatus('Key removed.')
    } finally {
      setIsBusy(false)
    }
  }

  async function testKey() {
    if (!window.salesCopilot) {
      return
    }

    setTest({ kind: 'testing' })
    const result = await window.salesCopilot.testOpenAiKey()
    setTest('error' in result ? { kind: 'error', message: result.error } : { kind: 'ok' })
  }

  return (
    <main className="settings">
      <header className="settings-titlebar">Settings</header>

      <section>
        <h2>
          <KeyRound size={14} /> OpenAI API key
        </h2>
        <p className="settings-hint">
          AI coaching runs on your own OpenAI account. Transcription is fully local and needs no
          key.
        </p>

        {state?.hasKey ? (
          <p className="settings-current">
            Using key <code>{state.maskedKey}</code>
            {state.fromEnv ? ' (from the development .env, not saved here)' : ''}
          </p>
        ) : (
          <p className="settings-current none">No API key configured.</p>
        )}

        <div className="settings-key-row">
          <input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="sk-…"
            aria-label="OpenAI API key"
            autoFocus
          />
          <button type="button" onClick={saveKey} disabled={isBusy || !draft.trim()}>
            Save
          </button>
        </div>

        <div className="settings-actions">
          <button type="button" onClick={testKey} disabled={isBusy || !state?.hasKey || test.kind === 'testing'}>
            {test.kind === 'testing' ? 'Testing…' : 'Test key'}
          </button>
          {state?.hasKey && !state.fromEnv && (
            <button type="button" className="danger" onClick={clearKey} disabled={isBusy}>
              Remove key
            </button>
          )}
        </div>

        {status && <p className="settings-status">{status}</p>}
        {test.kind === 'ok' && <p className="settings-status ok">Key works — OpenAI accepted it.</p>}
        {test.kind === 'error' && <p className="settings-status error">{test.message}</p>}
      </section>

      <footer className="settings-footnote">
        <ShieldCheck size={13} />
        <span>
          Stored encrypted on this Mac via the system Keychain (Electron safeStorage). It is only
          ever sent to OpenAI&apos;s API.
        </span>
      </footer>
    </main>
  )
}
