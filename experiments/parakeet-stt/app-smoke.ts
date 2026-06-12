// Smoke test for the app's real STT engine (electron/transcription.ts) under
// Electron: feeds a wav in 100ms chunks into both channels and prints the
// segments, mimicking what the renderer audio pump sends over IPC.
//
//   ../../node_modules/.bin/esbuild app-smoke.ts --bundle --platform=node \
//     --format=cjs --external:electron --external:sherpa-onnx-node --outfile=app-smoke.cjs
//   ../../node_modules/.bin/electron app-smoke.cjs
import { app } from 'electron'
import path from 'node:path'
import { loadSherpa, SttEngine, type TranscriptSegment } from '../../electron/transcription'

const SAMPLE_RATE = 16000
const CHUNK = SAMPLE_RATE / 10

app.whenReady().then(() => {
  const sherpa = loadSherpa()
  if (!sherpa) {
    console.error('FAIL: sherpa-onnx-node did not load')
    app.exit(1)
    return
  }

  const print = (label: string) => (segment: TranscriptSegment) =>
    console.log(
      `${label} [${segment.channel} @${segment.startSeconds.toFixed(1)}-${segment.endSeconds.toFixed(1)}s] ${segment.text}`,
    )

  const engine = new SttEngine(sherpa, {
    modelDir: path.join(__dirname, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'),
    vadModel: path.join(__dirname, 'silero_vad.onnx'),
    onSegment: print('live'),
  })

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readWave } = require('sherpa-onnx-node') as {
    readWave: (file: string, enableExternalBuffer: boolean) => { samples: Float32Array }
  }
  const wave = readWave(path.join(__dirname, 'multi.wav'), false)

  // Same audio into both channels, offset so utterance interleaving is exercised.
  for (let offset = 0; offset < wave.samples.length; offset += CHUNK) {
    const chunk = wave.samples.subarray(offset, offset + CHUNK)
    engine.accept('rep', chunk)
    if (offset >= SAMPLE_RATE) {
      engine.accept('prospect', wave.samples.subarray(offset - SAMPLE_RATE, offset - SAMPLE_RATE + CHUNK))
    }
  }

  for (const segment of engine.finish()) {
    print('flush')(segment)
  }

  console.log('SMOKE OK')
  app.quit()
})
