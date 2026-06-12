# Parakeet TDT local STT spike

Feasibility spike: run NVIDIA Parakeet TDT 0.6B locally for live-call
transcription, fully offline, inside the Electron main process.

**Verdict: works.** Parakeet TDT 0.6B v2 (int8 ONNX) via
[sherpa-onnx-node](https://www.npmjs.com/package/sherpa-onnx-node) decodes
12.25s of audio in ~0.4s (RTF ≈ 0.034, ~30x real-time) on an Apple Silicon
CPU, with perfect accuracy on synthesized sales-call speech. Verified in
plain Node 22 and inside Electron 42's main process.

## Setup

```sh
npm install   # sherpa-onnx-node + darwin-arm64 prebuilt binaries

# Model (~660 MB extracted, not committed):
curl -sL -o parakeet-v2-int8.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
tar xjf parakeet-v2-int8.tar.bz2 && rm parakeet-v2-int8.tar.bz2

# Silero VAD (~630 KB, for utterance segmentation):
curl -sL -o silero_vad.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx

# Test audio:
say -v Samantha -o test-raw.aiff "Thanks for taking the time today..." \
  && afconvert -f WAVE -d LEI16@16000 -c 1 test-raw.aiff test.wav
```

## Scripts

- `transcribe.cjs` — one-shot file transcription with RTF measurement
- `live-sim.cjs` — simulated live pipeline: 100ms chunks → Silero VAD →
  per-utterance Parakeet decode (the shape the real integration would take)
- `electron-test.cjs` — same decode inside Electron's main process
  (`../../node_modules/.bin/electron electron-test.cjs`)

## Key findings

- Parakeet TDT is an **offline (non-streaming) model**. Live use =
  VAD-segmented decode per utterance. With decode at ~0.1–0.4s per
  utterance, transcript lines land well under a second after the speaker
  pauses — fine for the co-pilot's 5s analysis cadence.
- sherpa-onnx-node is an N-API addon → ABI-stable, loads in Electron with
  **no rebuild**.
- **Electron gotcha:** Electron's V8 memory cage forbids N-API external
  buffers. Pass `false` as the `enableExternalBuffer` arg to
  `readWave()` / `vad.front()` or decoding throws
  `External buffers are not allowed`. (Float32Arrays passed *into*
  `acceptWaveform` are unaffected.)
- Two parallel pipelines needed in the real integration (mic = rep,
  system audio = prospect), which doubles CPU but RTF 0.034 leaves huge
  headroom. Speaker labels come free from which stream the audio came from
  — no diarization needed.
- Packaging: model (~660 MB) should be downloaded on first run, not bundled
  in the DMG; native modules need `asarUnpack` in electron-builder config.
- Multilingual alternative: parakeet-tdt-0.6b-**v3** (25 languages), same
  sherpa-onnx release page, drop-in.
