import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell, systemPreferences } from 'electron'
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

type MeetingRecord = {
  id: string
  title: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  transcript: TranscriptTurn[]
  analysis: CopilotAnalysis | null
  model: string | null
}

type StopMeetingPayload = {
  durationSeconds?: number
  transcript?: TranscriptTurn[]
  analysis?: CopilotAnalysis | null
  model?: string | null
}

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
let mainWindow: BrowserWindow | null = null
let dashboardWindow: BrowserWindow | null = null
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

const PANEL_WIDTH = 340

function createWindow() {
  // Dock the panel full-height against the right edge of the primary display
  // so it sits beside a Zoom / Google Meet window like a side rail.
  const { workArea } = screen.getPrimaryDisplay()
  const panelHeight = workArea.height

  mainWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: panelHeight,
    x: workArea.x + workArea.width - PANEL_WIDTH,
    y: workArea.y,
    minWidth: 300,
    minHeight: 560,
    maxWidth: 420,
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

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.focus()
    return
  }

  dashboardWindow = new BrowserWindow({
    width: 1020,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    title: 'Meetings — Sales Co-Pilot',
    backgroundColor: '#faf8f3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  dashboardWindow.on('closed', () => {
    dashboardWindow = null
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    dashboardWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#dashboard`)
  } else {
    dashboardWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'dashboard' })
  }
}

// ——— Meeting history store (userData/meetings.json) ———

function meetingsStorePath() {
  return path.join(app.getPath('userData'), 'meetings.json')
}

function readMeetingRecords(): MeetingRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(meetingsStorePath(), 'utf8'))
    return Array.isArray(parsed) ? (parsed as MeetingRecord[]) : []
  } catch {
    return []
  }
}

function writeMeetingRecords(records: MeetingRecord[]) {
  fs.mkdirSync(path.dirname(meetingsStorePath()), { recursive: true })
  fs.writeFileSync(meetingsStorePath(), JSON.stringify(records, null, 2))
}

function broadcastMeetingsChanged() {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('meetings:changed')
  }
}

function saveMeetingRecord(session: MeetingSession, payload: StopMeetingPayload) {
  const record: MeetingRecord = {
    id: session.id,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds: Math.max(0, Math.round(payload.durationSeconds ?? session.elapsedSeconds)),
    transcript: Array.isArray(payload.transcript) ? payload.transcript : [],
    analysis: payload.analysis ?? null,
    model: payload.model ?? null,
  }

  const records = readMeetingRecords().filter((existing) => existing.id !== record.id)
  records.unshift(record)
  writeMeetingRecords(records)
  broadcastMeetingsChanged()
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

// Test mode: when test-transcript.txt exists at the project root, the renderer
// plays it back as the meeting source instead of live audio capture.
ipcMain.handle('test:get-transcript', () => {
  const transcriptPath = process.env.TEST_TRANSCRIPT ?? path.join(process.cwd(), 'test-transcript.txt')
  try {
    return fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }
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

ipcMain.handle('meeting:stop', (_event, payload?: StopMeetingPayload) => {
  if (meeting) {
    const wasActive = meeting.status !== 'stopped'
    meeting = { ...meeting, status: 'stopped' }
    stopTimer()
    publishMeeting()

    if (wasActive) {
      saveMeetingRecord(meeting, payload ?? {})
    }
  }

  return meeting
})

ipcMain.handle('meetings:list', () => {
  return readMeetingRecords().map(({ id, title, startedAt, endedAt, durationSeconds, transcript, analysis }) => ({
    id,
    title,
    startedAt,
    endedAt,
    durationSeconds,
    turnCount: transcript.length,
    stage: analysis?.stage ?? null,
    completedGaps: analysis?.completedGaps ?? [],
    factCount: analysis?.facts.length ?? 0,
  }))
})

ipcMain.handle('meetings:get', (_event, id: string) => {
  return readMeetingRecords().find((record) => record.id === id) ?? null
})

ipcMain.handle('meetings:delete', (_event, id: string) => {
  const records = readMeetingRecords()
  const remaining = records.filter((record) => record.id !== id)
  if (remaining.length !== records.length) {
    writeMeetingRecords(remaining)
    broadcastMeetingsChanged()
  }

  return remaining.length !== records.length
})

ipcMain.handle('dashboard:open', () => {
  createDashboardWindow()
  return true
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
