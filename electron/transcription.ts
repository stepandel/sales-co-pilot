// Local speech-to-text for live calls: NVIDIA Parakeet TDT 0.6B (int8 ONNX)
// via sherpa-onnx, running entirely in the main process — no audio leaves the
// machine. Parakeet is an offline (non-streaming) model, so "live" means each
// channel runs Silero VAD over the incoming frames and decodes one utterance
// at a time as the speaker pauses. Decode is ~30x real-time on Apple Silicon,
// so a segment lands well under a second after the pause.
//
// Two independent channels map audio source to speaker identity: the
// microphone is the rep, system-audio loopback is the prospect. That makes
// diarization unnecessary.
import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type SttChannelId = 'rep' | 'prospect'

export type TranscriptSegment = {
  channel: SttChannelId
  text: string
  /** Offset of the utterance from STT start, in seconds of accepted audio. */
  startSeconds: number
  endSeconds: number
}

export type SttStatus =
  | { state: 'not-installed' }
  | { state: 'not-downloaded' }
  | { state: 'downloading'; progress: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }

const SAMPLE_RATE = 16000
const MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`
const VAD_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

// ——— sherpa-onnx-node surface (the package ships no types) ———

type SherpaOfflineStream = {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
}

type SherpaOfflineRecognizer = {
  createStream(): SherpaOfflineStream
  decode(stream: SherpaOfflineStream): void
  getResult(stream: SherpaOfflineStream): { text: string }
}

type SherpaSpeechSegment = { start: number; samples: Float32Array }

type SherpaVad = {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  /** enableExternalBuffer must be false under Electron (V8 memory cage). */
  front(enableExternalBuffer?: boolean): SherpaSpeechSegment
  pop(): void
  flush(): void
}

type SherpaModule = {
  OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizer
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad
}

// Native addon: loaded lazily so the app still boots (with STT reported as
// not-installed) when the optional dependency is missing, and kept external
// in the esbuild bundle.
let sherpaModule: SherpaModule | null | undefined
export function loadSherpa(): SherpaModule | null {
  if (sherpaModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sherpaModule = require('sherpa-onnx-node') as SherpaModule
    } catch (error) {
      console.error('sherpa-onnx-node failed to load; local STT disabled.', error)
      sherpaModule = null
    }
  }

  return sherpaModule
}

// ——— Model files (userData/models) ———

export type SttModelPaths = {
  modelDir: string
  vadModel: string
}

function defaultModelPaths(): SttModelPaths {
  const modelsRoot = path.join(app.getPath('userData'), 'models')
  return {
    modelDir: path.join(modelsRoot, MODEL_NAME),
    vadModel: path.join(modelsRoot, 'silero_vad.onnx'),
  }
}

function modelIsReady(paths: SttModelPaths) {
  return (
    fs.existsSync(paths.vadModel) &&
    MODEL_FILES.every((file) => fs.existsSync(path.join(paths.modelDir, file)))
  )
}

async function downloadFile(url: string, dest: string, onProgress?: (ratio: number) => void) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const body = Readable.fromWeb(response.body as never)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) {
      onProgress?.(received / total)
    }
  })

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  await pipeline(body, fs.createWriteStream(dest))
}

function extractTarBz2(archive: string, destDir: string) {
  return new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['xjf', archive, '-C', destDir])
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)),
    )
  })
}

let downloadInFlight: Promise<void> | null = null
let downloadProgress = 0
let downloadError: string | null = null

function broadcastStatus(status: SttStatus) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('stt:status', status)
  }
}

// One-time model fetch (~640 MB), deduped across concurrent callers. The
// tarball is the bulk of it, so its byte progress doubles as overall progress.
function ensureModelDownloaded(paths: SttModelPaths): Promise<void> {
  if (downloadInFlight) {
    return downloadInFlight
  }

  downloadError = null
  downloadProgress = 0
  downloadInFlight = (async () => {
    const modelsRoot = path.dirname(paths.modelDir)
    fs.mkdirSync(modelsRoot, { recursive: true })

    if (!fs.existsSync(paths.vadModel)) {
      await downloadFile(VAD_URL, paths.vadModel)
    }

    if (!MODEL_FILES.every((file) => fs.existsSync(path.join(paths.modelDir, file)))) {
      const tarPath = path.join(modelsRoot, `${MODEL_NAME}.tar.bz2`)
      let lastSent = 0
      await downloadFile(MODEL_URL, tarPath, (ratio) => {
        downloadProgress = ratio
        // Renderer only needs coarse progress; cap event volume.
        if (Date.now() - lastSent > 500) {
          lastSent = Date.now()
          broadcastStatus({ state: 'downloading', progress: ratio })
        }
      })
      try {
        await extractTarBz2(tarPath, modelsRoot)
      } finally {
        fs.rmSync(tarPath, { force: true })
      }
    }

    broadcastStatus({ state: 'ready' })
  })()

  downloadInFlight
    .catch((error) => {
      downloadError = error instanceof Error ? error.message : String(error)
      broadcastStatus({ state: 'error', message: downloadError })
    })
    .finally(() => {
      downloadInFlight = null
    })

  return downloadInFlight
}

// ——— Engine ———

export type SttEngineOptions = SttModelPaths & {
  onSegment: (segment: TranscriptSegment) => void
}

export class SttEngine {
  private readonly recognizer: SherpaOfflineRecognizer
  private readonly channels: Map<SttChannelId, SherpaVad>
  private readonly onSegment: (segment: TranscriptSegment) => void

  constructor(sherpa: SherpaModule, options: SttEngineOptions) {
    this.onSegment = options.onSegment
    this.recognizer = getRecognizer(sherpa, options.modelDir)

    const newVad = () =>
      new sherpa.Vad(
        {
          sileroVad: {
            model: options.vadModel,
            threshold: 0.5,
            minSpeechDuration: 0.25,
            // End-of-utterance after 600ms of silence: short enough that a
            // turn lands quickly, long enough not to split mid-sentence.
            minSilenceDuration: 0.6,
            maxSpeechDuration: 15,
            windowSize: 512,
          },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          debug: 0,
        },
        60,
      )
    this.channels = new Map([
      ['rep', newVad()],
      ['prospect', newVad()],
    ])
  }

  accept(channel: SttChannelId, samples: Float32Array) {
    const vad = this.channels.get(channel)
    if (!vad) {
      return
    }

    vad.acceptWaveform(samples)
    this.drain(channel, vad)
  }

  /** Flush both channels and return any trailing utterances. */
  finish(): TranscriptSegment[] {
    const flushed: TranscriptSegment[] = []
    for (const [channel, vad] of this.channels) {
      vad.flush()
      this.drain(channel, vad, flushed)
    }

    return flushed
  }

  private drain(channel: SttChannelId, vad: SherpaVad, collect?: TranscriptSegment[]) {
    while (!vad.isEmpty()) {
      const speech = vad.front(false)
      vad.pop()
      const text = this.decode(speech.samples)
      if (!text) {
        continue
      }

      const segment: TranscriptSegment = {
        channel,
        text,
        startSeconds: speech.start / SAMPLE_RATE,
        endSeconds: (speech.start + speech.samples.length) / SAMPLE_RATE,
      }
      if (collect) {
        collect.push(segment)
      } else {
        this.onSegment(segment)
      }
    }
  }

  private decode(samples: Float32Array): string {
    const stream = this.recognizer.createStream()
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    this.recognizer.decode(stream)
    return this.recognizer.getResult(stream).text.trim()
  }
}

// The recognizer holds ~700 MB of weights and takes ~1s to load, so it is
// created once per app run and shared by every meeting (decode itself is
// stateless — each utterance gets its own stream).
let recognizerCache: { modelDir: string; recognizer: SherpaOfflineRecognizer } | null = null
function getRecognizer(sherpa: SherpaModule, modelDir: string): SherpaOfflineRecognizer {
  if (recognizerCache?.modelDir !== modelDir) {
    recognizerCache = {
      modelDir,
      recognizer: new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: path.join(modelDir, 'encoder.int8.onnx'),
            decoder: path.join(modelDir, 'decoder.int8.onnx'),
            joiner: path.join(modelDir, 'joiner.int8.onnx'),
          },
          tokens: path.join(modelDir, 'tokens.txt'),
          numThreads: 4,
          provider: 'cpu',
          debug: 0,
          modelType: 'nemo_transducer',
        },
      }),
    }
  }

  return recognizerCache.recognizer
}

// ——— IPC ———

let engine: SttEngine | null = null

function getStatus(paths: SttModelPaths): SttStatus {
  if (!loadSherpa()) {
    return { state: 'not-installed' }
  }

  if (downloadInFlight) {
    return { state: 'downloading', progress: downloadProgress }
  }

  if (modelIsReady(paths)) {
    return { state: 'ready' }
  }

  return downloadError
    ? { state: 'error', message: downloadError }
    : { state: 'not-downloaded' }
}

export function registerSttIpc() {
  ipcMain.handle('stt:get-status', () => getStatus(defaultModelPaths()))

  ipcMain.handle('stt:download', async () => {
    const paths = defaultModelPaths()
    if (loadSherpa() && !modelIsReady(paths)) {
      try {
        await ensureModelDownloaded(paths)
      } catch {
        // Reported through getStatus as { state: 'error' }.
      }
    }

    return getStatus(paths)
  })

  ipcMain.handle('stt:start', (event) => {
    const sherpa = loadSherpa()
    if (!sherpa) {
      return { error: 'Local transcription engine (sherpa-onnx-node) is not installed.' }
    }

    const paths = defaultModelPaths()
    if (!modelIsReady(paths)) {
      return { error: 'Transcription model has not been downloaded yet.' }
    }

    const client = event.sender
    engine = new SttEngine(sherpa, {
      ...paths,
      onSegment: (segment) => {
        if (!client.isDestroyed()) {
          client.send('transcript:segment', segment)
        }
      },
    })

    return { ok: true as const }
  })

  // Returns trailing utterances (speech still buffered when the call ended)
  // so the renderer can fold them into the final saved transcript.
  ipcMain.handle('stt:stop', () => {
    const flushed = engine?.finish() ?? []
    engine = null
    return flushed
  })

  // Fire-and-forget audio path: ~10 chunks/s/channel of 100ms Float32 PCM.
  // VAD per chunk is sub-millisecond; the per-utterance decode (~0.1–0.4s)
  // runs here on the main process, which is acceptable because it fires only
  // when a speaker pauses.
  ipcMain.on('stt:audio', (_event, channel: SttChannelId, samples: Float32Array) => {
    if (engine && (channel === 'rep' || channel === 'prospect') && samples instanceof Float32Array) {
      engine.accept(channel, samples)
    }
  })
}
