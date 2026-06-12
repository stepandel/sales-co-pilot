// Bring-your-own-key settings. The OpenAI key is encrypted with Electron's
// safeStorage — the encryption key lives in the user's macOS Keychain, scoped
// to this app — and only the ciphertext is written to userData/settings.json.
// The key itself never leaves the main process; the renderer only ever sees
// a masked preview.
import { app, ipcMain, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type SettingsState = {
  hasKey: boolean
  /** e.g. "sk-…h3Qk" — enough to recognize the key, never the key itself. */
  maskedKey: string | null
  /** True when the key came from the OPENAI_API_KEY env var (dev .env). */
  fromEnv: boolean
  secureStorageAvailable: boolean
}

type StoredSettings = {
  /** base64 of the safeStorage ciphertext. */
  openaiApiKey?: string
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings(): StoredSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as StoredSettings
  } catch {
    return {}
  }
}

function writeSettings(settings: StoredSettings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}

function decryptStoredKey(): string | null {
  const stored = readSettings().openaiApiKey
  if (!stored) {
    return null
  }

  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (error) {
    // Wrong Keychain item (e.g. settings file copied from another machine):
    // treat as no key rather than wedging every analysis call.
    console.error('Failed to decrypt stored OpenAI key:', error)
    return null
  }
}

/** Stored key first, OPENAI_API_KEY env var (dev .env) as fallback. */
export function getOpenAiApiKey(): string | null {
  return decryptStoredKey() ?? process.env.OPENAI_API_KEY ?? null
}

function maskKey(key: string) {
  return key.length <= 8 ? 'sk-…' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

function getState(): SettingsState {
  const storedKey = decryptStoredKey()
  const envKey = process.env.OPENAI_API_KEY ?? null
  const effective = storedKey ?? envKey
  return {
    hasKey: Boolean(effective),
    maskedKey: effective ? maskKey(effective) : null,
    fromEnv: !storedKey && Boolean(envKey),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  }
}

export function registerSettingsIpc() {
  ipcMain.handle('settings:get', () => getState())

  ipcMain.handle('settings:set-openai-key', (_event, key: string) => {
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (!trimmed) {
      return { error: 'Enter an API key first.' }
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { error: 'Secure storage is unavailable on this system; key was not saved.' }
    }

    writeSettings({
      ...readSettings(),
      openaiApiKey: safeStorage.encryptString(trimmed).toString('base64'),
    })
    return { state: getState() }
  })

  ipcMain.handle('settings:clear-openai-key', () => {
    const settings = readSettings()
    delete settings.openaiApiKey
    writeSettings(settings)
    return { state: getState() }
  })

  // Cheap end-to-end check that the effective key actually works.
  ipcMain.handle('settings:test-openai-key', async () => {
    const apiKey = getOpenAiApiKey()
    if (!apiKey) {
      return { error: 'No API key configured.' }
    }

    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!response.ok) {
        return {
          error:
            response.status === 401
              ? 'OpenAI rejected this key (401). Double-check it and save again.'
              : `OpenAI returned status ${response.status}.`,
        }
      }

      return { ok: true as const }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not reach OpenAI.' }
    }
  })
}
