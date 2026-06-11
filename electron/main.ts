import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  copilotAnalysisSchema,
  defaultOpenGaps,
  type CopilotAnalysis,
  type DiscoveryStage,
  discoveryStages,
  salesCopilotSystemPrompt,
  type TranscriptTurn,
} from './copilotPrompt'

type MeetingStatus = 'idle' | 'checking-permissions' | 'recording' | 'paused' | 'stopped'

type MeetingSession = {
  id: string
  title: string
  startedAt: string
  status: MeetingStatus
  elapsedSeconds: number
}

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
let mainWindow: BrowserWindow | null = null
let meeting: MeetingSession | null = null
let meetingTimer: NodeJS.Timeout | null = null

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) {
    return
  }

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    const value = rawValue.replace(/^['"]|['"]$/g, '')
    if (key && !process.env[key]) {
      process.env[key] = value
    }
  }
}

loadLocalEnv()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 384,
    height: 860,
    minWidth: 344,
    minHeight: 600,
    maxWidth: 520,
    title: 'Sales Co-Pilot',
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.setAlwaysOnTop(true, 'floating')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        })
        .then((sources) => {
          callback({
            video: sources[0],
            audio: 'loopback',
          })
        })
        .catch(() => {
          callback({})
        })
    },
    { useSystemPicker: false },
  )
}

function publishMeeting() {
  mainWindow?.webContents.send('meeting:updated', meeting)
}

function stopTimer() {
  if (meetingTimer) {
    clearInterval(meetingTimer)
    meetingTimer = null
  }
}

async function getCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 360, height: 220 },
    fetchWindowIcons: true,
  })

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
  }))
}

async function getPermissionState() {
  const microphone =
    process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('microphone')
      : 'unknown'

  const screen =
    process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('screen')
      : 'unknown'

  const sources = await getCaptureSources()

  return {
    microphone,
    screen,
    systemAudio: process.platform === 'darwin' ? 'available-with-display-capture' : 'available-with-display-capture',
    platform: process.platform,
    macAudioCaptureRequiresUsageDescription: process.platform === 'darwin',
    captureSources: sources,
  }
}

function parseJsonModelContent(rawContent: string) {
  try {
    return JSON.parse(rawContent)
  } catch {
    const jsonStart = rawContent.search(/[[{]/)
    const jsonEnd = Math.max(rawContent.lastIndexOf('}'), rawContent.lastIndexOf(']'))
    if (jsonStart === -1 || jsonEnd < jsonStart) {
      throw new Error(`Model response was not JSON: ${rawContent}`)
    }

    return JSON.parse(rawContent.slice(jsonStart, jsonEnd + 1))
  }
}

function parseQuestionPriority(value: unknown): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium'
}

function parseCopilotAnalysis(value: unknown): CopilotAnalysis {
  if (!value || typeof value !== 'object') {
    throw new Error('Co-pilot response was not an object.')
  }

  const record = value as Record<string, unknown>
  const stage = discoveryStages.includes(record.stage as DiscoveryStage)
    ? (record.stage as DiscoveryStage)
    : 'Just here to learn'
  const nextQuestions = Array.isArray(record.nextQuestions)
    ? record.nextQuestions
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          priority: parseQuestionPriority(item.priority),
          question: typeof item.question === 'string' ? item.question.trim() : '',
          reason: typeof item.reason === 'string' ? item.reason.trim() : '',
        }))
        .filter((item) => item.question && item.reason)
        .slice(0, 2)
    : []
  const facts = Array.isArray(record.facts)
    ? record.facts
        .filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0)
        .map((fact) => fact.trim())
        .slice(0, 8)
    : []
  const completedGaps = Array.isArray(record.completedGaps)
    ? record.completedGaps
        .filter((gap): gap is string => typeof gap === 'string' && defaultOpenGaps.includes(gap as never))
        .slice(0, defaultOpenGaps.length)
    : []

  return {
    stage,
    nextQuestions:
      nextQuestions.length > 0
        ? nextQuestions
        : [
            {
              priority: 'medium',
              question: 'Can you walk me through the last time this happened?',
              reason: 'Gets the call back to a concrete recent instance.',
            },
          ],
    facts,
    completedGaps,
  }
}

function extractResponseText(response: Record<string, unknown>) {
  if (typeof response.output_text === 'string') {
    return response.output_text
  }

  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : []
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== 'object') {
        continue
      }

      const contentRecord = contentItem as Record<string, unknown>
      if (typeof contentRecord.text === 'string') {
        return contentRecord.text
      }
    }
  }

  throw new Error('OpenAI response did not include output text.')
}

function logJson(label: string, value: unknown) {
  console.info(label, JSON.stringify(value, null, 2))
}

async function runCopilotAnalysis(transcript: TranscriptTurn[]) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY. Add it to .env or your shell environment.')
  }

  const model = process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const transcriptForPrompt = transcript.slice(-40)
  const requestBody = {
    model,
    store: false,
    input: [
      {
        role: 'system',
        content: salesCopilotSystemPrompt,
      },
      {
        role: 'user',
        content: JSON.stringify({
          currentStage: 'Just here to learn',
          facts: [],
          gaps: [...defaultOpenGaps],
          mossContext: [],
          transcript: transcriptForPrompt,
        }),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'sales_copilot_analysis',
        strict: true,
        schema: copilotAnalysisSchema,
      },
    },
  }

  logJson('openai_request_body', requestBody)

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  const body = (await response.json()) as Record<string, unknown>
  logJson('openai_response_body', body)

  if (!response.ok) {
    const error =
      body.error && typeof body.error === 'object' && 'message' in body.error
        ? String((body.error as Record<string, unknown>).message)
        : `OpenAI request failed with status ${response.status}`
    throw new Error(error)
  }

  const rawContent = extractResponseText(body)
  const parsedAnalysis = parseCopilotAnalysis(parseJsonModelContent(rawContent))

  return {
    model,
    analysis: parsedAnalysis,
  }
}

ipcMain.handle('permissions:get-state', getPermissionState)

ipcMain.handle('permissions:request-microphone', async () => {
  if (process.platform !== 'darwin') {
    return getPermissionState()
  }

  await systemPreferences.askForMediaAccess('microphone')
  return getPermissionState()
})

ipcMain.handle('permissions:open-settings', async (_event, pane: 'microphone' | 'screen' | 'system-audio') => {
  if (process.platform !== 'darwin') {
    return false
  }

  const paneUrl =
    pane === 'microphone'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

  await shell.openExternal(paneUrl)
  return true
})

ipcMain.handle('ai:analyze-call', async (_event, transcript: TranscriptTurn[]) => {
  return runCopilotAnalysis(Array.isArray(transcript) ? transcript : [])
})

ipcMain.handle('meeting:start', async (_event, title?: string) => {
  meeting = {
    id: crypto.randomUUID(),
    title: title?.trim() || 'Untitled sales call',
    startedAt: new Date().toISOString(),
    status: 'recording',
    elapsedSeconds: 0,
  }

  stopTimer()
  meetingTimer = setInterval(() => {
    if (!meeting || meeting.status !== 'recording') {
      return
    }

    meeting = {
      ...meeting,
      elapsedSeconds: meeting.elapsedSeconds + 1,
    }
    publishMeeting()
  }, 1000)

  publishMeeting()
  return meeting
})

ipcMain.handle('meeting:pause', () => {
  if (meeting) {
    meeting = { ...meeting, status: meeting.status === 'paused' ? 'recording' : 'paused' }
    publishMeeting()
  }

  return meeting
})

ipcMain.handle('meeting:stop', () => {
  if (meeting) {
    meeting = { ...meeting, status: 'stopped' }
    stopTimer()
    publishMeeting()
  }

  return meeting
})

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'display-capture'].includes(permission))
  })
  configureDisplayCapture()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  stopTimer()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
