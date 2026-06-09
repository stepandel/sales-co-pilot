# Sales Co-Pilot

Electron desktop scaffold for a Granola-style sales call assistant. The app can start, pause, and stop a meeting session, checks desktop capture readiness, and exposes a typed bridge for native capture and transcription work.

## Run locally

```bash
deno install
deno task dev
```

## Build

```bash
deno task build
```

## Current Architecture

- `electron/main.ts` owns the desktop window, meeting session lifecycle, capture-source discovery, and OS permission helpers.
- `electron/preload.ts` exposes a narrow `window.salesCopilot` API to the renderer through Electron IPC.
- `src/App.tsx` is the meeting console UI with capture readiness, meeting controls, transcript display, and AI coaching placeholders.
- `src/types/electron.d.ts` keeps the renderer API typed.
- `deno.json` is the primary task runner for development, linting, builds, and packaging.

## Native Capture Roadmap

Live mic capture can be handled with WebRTC media APIs or a main-process audio pipeline. System audio capture across FaceTime, WhatsApp, Google Meet, Zoom, and other apps will need an OS-specific implementation, commonly one of:

- macOS ScreenCaptureKit audio capture for supported versions.
- A virtual audio device such as BlackHole or a bundled/native driver flow.
- A native Node/Electron module that captures loopback audio on Windows.

Once raw audio frames are available, add a transcription adapter behind the meeting IPC layer, then stream transcript segments back to the renderer with `meeting:updated` or a dedicated `transcript:segment` channel.
