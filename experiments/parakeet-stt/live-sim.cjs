// Spike: simulate live transcription — feed a wav in 100ms chunks through
// Silero VAD; decode each detected utterance with Parakeet TDT.
// This mirrors the real pipeline: renderer audio frames -> VAD -> per-utterance decode.
// Usage: node live-sim.cjs [path/to/16khz-mono.wav]
const path = require('node:path');
const sherpa_onnx = require('sherpa-onnx-node');

const MODEL_DIR = path.join(__dirname, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');
const SAMPLE_RATE = 16000;
const CHUNK = SAMPLE_RATE / 10; // 100ms

const recognizer = new sherpa_onnx.OfflineRecognizer({
  featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(MODEL_DIR, 'encoder.int8.onnx'),
      decoder: path.join(MODEL_DIR, 'decoder.int8.onnx'),
      joiner: path.join(MODEL_DIR, 'joiner.int8.onnx'),
    },
    tokens: path.join(MODEL_DIR, 'tokens.txt'),
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
    modelType: 'nemo_transducer',
  },
});

const vad = new sherpa_onnx.Vad(
  {
    sileroVad: {
      model: path.join(__dirname, 'silero_vad.onnx'),
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.6, // end-of-utterance after 600ms silence
      maxSpeechDuration: 15,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  },
  60, // buffer seconds
);

function decodeSegment(segment) {
  const start = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment.samples });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const elapsed = (Date.now() - start) / 1000;
  const segDuration = segment.samples.length / SAMPLE_RATE;
  const at = (segment.start / SAMPLE_RATE).toFixed(1);
  console.log(
    `[utterance @${at}s, ${segDuration.toFixed(1)}s audio, decoded in ${elapsed.toFixed(2)}s] ${result.text}`,
  );
}

const waveFilename = process.argv[2] ?? path.join(__dirname, 'test.wav');
const wave = sherpa_onnx.readWave(waveFilename);

for (let offset = 0; offset < wave.samples.length; offset += CHUNK) {
  vad.acceptWaveform(wave.samples.subarray(offset, offset + CHUNK));
  while (!vad.isEmpty()) {
    decodeSegment(vad.front());
    vad.pop();
  }
}
vad.flush();
while (!vad.isEmpty()) {
  decodeSegment(vad.front());
  vad.pop();
}
