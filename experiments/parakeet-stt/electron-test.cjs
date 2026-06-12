// Verify sherpa-onnx-node (N-API addon) loads and decodes inside Electron's main process.
// Usage: ../../node_modules/.bin/electron electron-test.cjs
const { app } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  const sherpa_onnx = require('sherpa-onnx-node');
  const MODEL_DIR = path.join(__dirname, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8');

  const recognizer = new sherpa_onnx.OfflineRecognizer({
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
  });

  // Electron's V8 memory cage forbids N-API external buffers — pass false here
  // (and to vad.front()) when running under Electron.
  const wave = sherpa_onnx.readWave(path.join(__dirname, 'test.wav'), false);
  const stream = recognizer.createStream();
  const start = Date.now();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  console.log(`ELECTRON OK (${process.versions.electron}), decoded in ${((Date.now() - start) / 1000).toFixed(2)}s:`);
  console.log(result.text);
  app.quit();
});
