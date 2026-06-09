import { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences } from 'electron'
import path from 'node:path'

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: 'Sales Co-Pilot',
    backgroundColor: '#f6f5f1',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
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
    systemAudio: 'integration-required',
    captureSources: sources,
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
