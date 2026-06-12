import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, systemPreferences } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  meetingChatSystemPrompt,
  type PostMortem,
  postMortemSchema,
  postMortemSystemPrompt,
} from './postMortemPrompt'
import { parseTranscript } from '../shared/transcript'
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

// Persisted in meetings.json. Transcript turns live in their own file under
// userData/transcripts/<id>.json; `transcript` is only present on legacy
// records saved before that split, and `turnCount` is missing on them.
type MeetingRecord = {
  id: string
  title: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  turnCount?: number
  transcript?: TranscriptTurn[]
  analysis: CopilotAnalysis | null
  postMortem?: PostMortem | null
  model: string | null
}

type MeetingChatMessage = {
  role: 'user' | 'assistant'
  content: string
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
  const turns = Array.isArray(payload.transcript) ? payload.transcript : []
  writeTranscriptFile(session, turns)

  const record: MeetingRecord = {
    id: session.id,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds: Math.max(0, Math.round(payload.durationSeconds ?? session.elapsedSeconds)),
    turnCount: turns.length,
    analysis: payload.analysis ?? null,
    model: payload.model ?? null,
  }

  const records = readMeetingRecords().filter((existing) => existing.id !== record.id)
  records.unshift(record)
  writeMeetingRecords(records)
  broadcastMeetingsChanged()
}

// ——— Transcript store (userData/transcripts/<meetingId>.json) ———
// One file per meeting, rewritten as turns land during the call, so a crash
// or force-quit mid-call loses at most the line in flight.

function transcriptFilePath(meetingId: string) {
  return path.join(app.getPath('userData'), 'transcripts', `${meetingId}.json`)
}

function writeTranscriptFile(
  session: Pick<MeetingSession, 'id' | 'title' | 'startedAt'>,
  turns: TranscriptTurn[],
) {
  const filePath = transcriptFilePath(session.id)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        meetingId: session.id,
        title: session.title,
        startedAt: session.startedAt,
        updatedAt: new Date().toISOString(),
        turns,
      },
      null,
      2,
    ),
  )
}

function readTranscriptTurns(meetingId: string): TranscriptTurn[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(transcriptFilePath(meetingId), 'utf8'))
    return Array.isArray(parsed?.turns) ? (parsed.turns as TranscriptTurn[]) : null
  } catch {
    return null
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

// The emphasis is only usable if it is a real span of the question; return it
// in the question's exact casing, or '' so the UI renders the question plain.
function parseQuestionEmphasis(question: string, value: unknown): string {
  const emphasis = typeof value === 'string' ? value.trim() : ''
  if (!emphasis || emphasis.length >= question.length) {
    return ''
  }

  const index = question.toLowerCase().indexOf(emphasis.toLowerCase())
  return index === -1 ? '' : question.slice(index, index + emphasis.length)
}

function parseCopilotAnalysis(value: unknown): CopilotAnalysis {
  if (!value || typeof value !== 'object') {
    throw new Error('Co-pilot response was not an object.')
  }

  const record = value as Record<string, unknown>
  const stage = discoveryStages.includes(record.stage as DiscoveryStage)
    ? (record.stage as DiscoveryStage)
    : 'Just here to learn'
  // Single pass: validate, shape, and cap at 2 in one loop instead of
  // filter().map().filter().slice() walking the list four times.
  const nextQuestions: CopilotAnalysis['nextQuestions'] = []
  if (Array.isArray(record.nextQuestions)) {
    for (const entry of record.nextQuestions) {
      if (!entry || typeof entry !== 'object') {
        continue
      }

      const item = entry as Record<string, unknown>
      const question = typeof item.question === 'string' ? item.question.trim() : ''
      const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
      if (!question || !reason) {
        continue
      }

      nextQuestions.push({
        priority: parseQuestionPriority(item.priority),
        question,
        reason,
        emphasis: parseQuestionEmphasis(question, item.emphasis),
      })
      if (nextQuestions.length >= 2) {
        break
      }
    }
  }
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
              emphasis: 'the last time this happened',
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

// Live in-call analysis runs every few seconds, so it stays on a mini model
// to keep latency low. Post-call review — Dashboard analysis, the post-mortem,
// and the coach chat — is one-shot and quality-sensitive, so it gets the
// stronger model.
function liveModel() {
  return process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'
}

function reviewModel() {
  return process.env.OPENAI_REVIEW_MODEL ?? 'gpt-5.5'
}

async function requestOpenAI(
  model: string,
  input: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  format?: Record<string, unknown>,
) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY. Add it to .env or your shell environment.')
  }

  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const requestBody: Record<string, unknown> = { model, store: false, input }
  if (format) {
    requestBody.text = { format }
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

  return { model, text: extractResponseText(body) }
}

async function runCopilotAnalysis(transcript: TranscriptTurn[], requestedModel: string) {
  const { model, text } = await requestOpenAI(
    requestedModel,
    [
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
          // Full transcript, never truncated: the turns array only grows at
          // the tail, so provider prompt caching keeps repeat analyses cheap.
          transcript,
        }),
      },
    ],
    {
      type: 'json_schema',
      name: 'sales_copilot_analysis',
      strict: true,
      schema: copilotAnalysisSchema,
    },
  )

  return {
    model,
    analysis: parseCopilotAnalysis(parseJsonModelContent(text)),
  }
}

function parsePostMortemBullets(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 5)
    : []
}

function parsePostMortem(value: unknown): PostMortem {
  if (!value || typeof value !== 'object') {
    throw new Error('Post-mortem response was not an object.')
  }

  const record = value as Record<string, unknown>
  return {
    score:
      typeof record.score === 'number' ? Math.min(10, Math.max(1, Math.round(record.score))) : 5,
    verdict: typeof record.verdict === 'string' ? record.verdict.trim() : '',
    wentWell: parsePostMortemBullets(record.wentWell),
    couldImprove: parsePostMortemBullets(record.couldImprove),
  }
}

async function runPostMortemAnalysis(transcript: TranscriptTurn[]) {
  const { model, text } = await requestOpenAI(
    reviewModel(),
    [
      { role: 'system', content: postMortemSystemPrompt },
      { role: 'user', content: JSON.stringify({ transcript }) },
    ],
    {
      type: 'json_schema',
      name: 'sales_call_post_mortem',
      strict: true,
      schema: postMortemSchema,
    },
  )

  return {
    model,
    postMortem: parsePostMortem(parseJsonModelContent(text)),
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
  return runCopilotAnalysis(Array.isArray(transcript) ? transcript : [], liveModel())
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

  // Create the transcript file up front so the meeting is on disk from the
  // first second, even if no turns ever land.
  writeTranscriptFile(meeting, [])

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

// Live checkpoint: the renderer pushes the full turn list as lines land so
// the transcript survives a crash; the final write happens on meeting:stop.
ipcMain.handle('meeting:transcript', (_event, turns: TranscriptTurn[]) => {
  if (meeting && meeting.status !== 'stopped') {
    writeTranscriptFile(meeting, Array.isArray(turns) ? turns : [])
    return true
  }

  return false
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

// Import a transcript file (same formats as test mode) as a finished meeting:
// parse it into turns, store them in the per-meeting transcript file, and add
// a record to the meetings index.
ipcMain.handle('meetings:import', async () => {
  const parent = dashboardWindow ?? mainWindow
  const dialogOptions: Electron.OpenDialogOptions = {
    title: 'Import transcript',
    properties: ['openFile'],
    filters: [
      { name: 'Transcripts', extensions: ['txt', 'md', 'text', 'log'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  }
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  const filePath = filePaths[0]
  if (canceled || !filePath) {
    return null
  }

  try {
    const parsed = parseTranscript(fs.readFileSync(filePath, 'utf8'))
    if (parsed.lines.length === 0) {
      return { error: 'No transcript lines could be parsed from that file.' }
    }

    const turns: TranscriptTurn[] = parsed.lines.map((line) => ({
      speaker: line.isRep ? 'rep' : 'prospect',
      text: line.text,
      timestamp: line.time,
    }))

    // Best date available: the file's "Date:" header, else its modified time.
    const headerDate = parsed.date ? new Date(parsed.date) : null
    const startedAtDate =
      headerDate && !Number.isNaN(headerDate.getTime()) ? headerDate : fs.statSync(filePath).mtime
    const record: MeetingRecord = {
      id: crypto.randomUUID(),
      title: parsed.title ?? path.basename(filePath, path.extname(filePath)),
      startedAt: startedAtDate.toISOString(),
      endedAt: new Date(startedAtDate.getTime() + parsed.durationSeconds * 1000).toISOString(),
      durationSeconds: parsed.durationSeconds,
      turnCount: turns.length,
      analysis: null,
      model: null,
    }

    writeTranscriptFile(record, turns)

    // Imported calls can predate existing ones, so keep the index sorted by
    // start time instead of unshifting like a just-finished call.
    const records = readMeetingRecords()
    records.push(record)
    records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    writeMeetingRecords(records)
    broadcastMeetingsChanged()

    return { id: record.id }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not import that file.' }
  }
})

ipcMain.handle('meetings:list', () => {
  return readMeetingRecords().map(({ id, title, startedAt, endedAt, durationSeconds, turnCount, transcript, analysis }) => ({
    id,
    title,
    startedAt,
    endedAt,
    durationSeconds,
    turnCount: turnCount ?? transcript?.length ?? 0,
    stage: analysis?.stage ?? null,
    completedGaps: analysis?.completedGaps ?? [],
    factCount: analysis?.facts.length ?? 0,
  }))
})

ipcMain.handle('meetings:get', (_event, id: string) => {
  const record = readMeetingRecords().find((entry) => entry.id === id)
  if (!record) {
    return null
  }

  return {
    ...record,
    transcript: readTranscriptTurns(id) ?? record.transcript ?? [],
    postMortem: record.postMortem ?? null,
  }
})

// Run the co-pilot and the Mom Test post-mortem over a stored meeting's
// transcript (imported calls, or re-analysis of any finished one) and
// persist both results on its record.
ipcMain.handle('meetings:analyze', async (_event, id: string) => {
  const records = readMeetingRecords()
  const record = records.find((entry) => entry.id === id)
  if (!record) {
    return { error: 'Meeting not found.' }
  }

  const turns = readTranscriptTurns(id) ?? record.transcript ?? []
  if (turns.length === 0) {
    return { error: 'This meeting has no transcript to analyze.' }
  }

  try {
    const [copilot, post] = await Promise.all([
      runCopilotAnalysis(turns, reviewModel()),
      runPostMortemAnalysis(turns),
    ])
    record.analysis = copilot.analysis
    record.postMortem = post.postMortem
    record.model = copilot.model
    writeMeetingRecords(records)
    broadcastMeetingsChanged()
    return { record: { ...record, transcript: turns } }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Analysis failed.' }
  }
})

// Follow-up coaching chat about a finished call. Stateless: the renderer owns
// the chat history and sends it whole; we prepend the meeting context.
ipcMain.handle('meetings:chat', async (_event, id: string, messages: MeetingChatMessage[]) => {
  const record = readMeetingRecords().find((entry) => entry.id === id)
  if (!record) {
    return { error: 'Meeting not found.' }
  }

  const history = (Array.isArray(messages) ? messages : [])
    .filter(
      (message): message is MeetingChatMessage =>
        Boolean(message) &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0,
    )
    .slice(-20)
  if (history.length === 0) {
    return { error: 'Ask a question about the call.' }
  }

  try {
    const turns = readTranscriptTurns(id) ?? record.transcript ?? []
    const { text } = await requestOpenAI(reviewModel(), [
      { role: 'system', content: meetingChatSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          transcript: turns,
          analysis: record.analysis,
          postMortem: record.postMortem ?? null,
        }),
      },
      ...history,
    ])
    return { reply: text.trim() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Chat request failed.' }
  }
})

ipcMain.handle('meetings:delete', (_event, id: string) => {
  const records = readMeetingRecords()
  const remaining = records.filter((record) => record.id !== id)
  if (remaining.length !== records.length) {
    writeMeetingRecords(remaining)
    fs.rmSync(transcriptFilePath(id), { force: true })
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
