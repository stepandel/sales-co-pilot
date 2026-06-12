// Spike: run NVIDIA Parakeet TDT 0.6B v2 (int8 ONNX) locally via sherpa-onnx.
// Usage: node transcribe.cjs [path/to/16khz-mono.wav]
const path = require('node:path');
const sherpa_onnx = require('sherpa-onnx-node');

const MODEL_DIR = path.join(__dirname, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');

const config = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
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
};

const waveFilename = process.argv[2] ?? path.join(__dirname, 'test.wav');

const loadStart = Date.now();
const recognizer = new sherpa_onnx.OfflineRecognizer(config);
console.log(`Model loaded in ${((Date.now() - loadStart) / 1000).toFixed(2)}s`);

const stream = recognizer.createStream();
const wave = sherpa_onnx.readWave(waveFilename);

const start = Date.now();
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
recognizer.decode(stream);
const result = recognizer.getResult(stream);
const elapsed = (Date.now() - start) / 1000;

const duration = wave.samples.length / wave.sampleRate;
console.log(`Audio duration: ${duration.toFixed(2)}s`);
console.log(`Decode time:    ${elapsed.toFixed(2)}s (RTF ${(elapsed / duration).toFixed(3)})`);
console.log('Transcript:', result.text);
