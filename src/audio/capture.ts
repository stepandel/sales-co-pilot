// Taps the meeting's MediaStreams and ships 16kHz mono PCM frames to the main
// process for local transcription. One AudioContext pinned at 16kHz does the
// resampling (Chromium resamples MediaStream sources into the context rate);
// an AudioWorklet per channel batches the 128-frame render quanta into 100ms
// chunks so the IPC rate stays at ~10 messages/s per channel.

export type CaptureChannel = 'rep' | 'prospect'

const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = SAMPLE_RATE / 10 // 100ms

// Inlined and loaded via a Blob URL so the worklet needs no separate asset in
// the Vite build. It runs on the audio thread: copy samples, post when full.
const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(${CHUNK_SAMPLES})
    this.length = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.length++] = channel[i]
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer.slice())
          this.length = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

/**
 * Start pumping audio from both call streams. Returns a teardown function
 * that disconnects the graph and closes the AudioContext.
 */
export async function startAudioPump(
  streams: Record<CaptureChannel, MediaStream>,
  onChunk: (channel: CaptureChannel, samples: Float32Array) => void,
): Promise<() => void> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } catch (error) {
    void context.close()
    throw error
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }

  // A source node is only rendered when it reaches the destination, so each
  // tap drains into a muted gain node — the graph runs, nothing is audible.
  const silence = context.createGain()
  silence.gain.value = 0
  silence.connect(context.destination)

  for (const channel of ['rep', 'prospect'] as const) {
    const source = context.createMediaStreamSource(streams[channel])
    const tap = new AudioWorkletNode(context, 'pcm-tap')
    tap.port.onmessage = (event) => onChunk(channel, event.data as Float32Array)
    source.connect(tap)
    tap.connect(silence)
  }

  return () => {
    void context.close()
  }
}
