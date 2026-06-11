# Sales Co-Pilot

Electron desktop scaffold for a Granola-style sales call assistant. The app can start, pause, and stop a meeting session, checks desktop capture readiness, and exposes a typed bridge for native capture and transcription work.

## Run locally

```bash
deno install
deno task dev
```

For AI coaching, add an OpenAI key:

```bash
cp .env.example .env
```

Then set `OPENAI_API_KEY` in `.env`. The default model is `gpt-5.4-mini`.

## Build

```bash
deno task build
```

## Test Mode (transcript playback)

If `test-transcript.txt` exists at the project root (or `TEST_TRANSCRIPT` points to a file), the
app runs in test mode: pressing **Start** plays the transcript back against the meeting timer
instead of capturing audio. Lines appear in the Transcript view as their timestamps pass, and the
co-pilot re-analyzes the conversation as new lines land — pause, resume, stop, the stage rail,
gaps, and facts all behave exactly as in a live call. A "Test" badge shows in the titlebar.

Transcript format — one utterance per line:

```
MM:SS Speaker: what they said
00:05 You: Thanks for making time...
00:14 Prospect: Sure. We're a 40-person sales org...
```

`You` / `Me` / `Rep` map to the rep side; any other name is the prospect. `[MM:SS]` brackets and
`H:MM:SS` timestamps also work. Blank lines and `#` comments are skipped; a line without a
timestamp continues the previous utterance. Timestamps control pacing, so compress them for a
faster run-through. Delete the file to return to live capture. A sample call ships in the repo.

## Current Architecture

- `electron/main.ts` owns the desktop window, meeting session lifecycle, capture-source discovery, and OS permission helpers.
- `electron/copilotPrompt.ts` contains the ycmoss-derived discovery prompt and structured output schema.
- `electron/preload.ts` exposes a narrow `window.salesCopilot` API to the renderer through Electron IPC.
- `src/App.tsx` is the meeting console UI with capture readiness, meeting controls, transcript display, and AI coaching placeholders.
- `src/types/electron.d.ts` keeps the renderer API typed.
- `deno.json` is the primary task runner for development, linting, builds, and packaging.

## Capture Privacy

Permission checks may briefly open an audio stream to verify that the OS returned usable tracks, but those probe streams are stopped immediately. Persistent microphone and system-audio streams are only kept while a meeting is actively recording. Stopping or pausing a meeting releases all audio tracks.

## Native Capture Roadmap

Live mic capture can be handled with WebRTC media APIs or a main-process audio pipeline. System audio capture across FaceTime, WhatsApp, Google Meet, Zoom, and other apps will need an OS-specific implementation, commonly one of:

- macOS ScreenCaptureKit audio capture for supported versions.
- A virtual audio device such as BlackHole or a bundled/native driver flow.
- A native Node/Electron module that captures loopback audio on Windows.

Once raw audio frames are available, add a transcription adapter behind the meeting IPC layer, then stream transcript segments back to the renderer with `meeting:updated` or a dedicated `transcript:segment` channel.

## AI Coaching

The renderer sends transcript turns to Electron over `window.salesCopilot.analyzeCall`. Electron reads `OPENAI_API_KEY`, calls the OpenAI Responses API with `OPENAI_MODEL` or `gpt-5.4-mini`, and returns structured co-pilot guidance to the UI. API keys stay in the main process and are not exposed to the renderer.
