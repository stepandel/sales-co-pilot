// Transcript text parsing, shared by the renderer (test-mode playback) and the
// main process (importing transcript files into the meetings store). Pure
// string handling only — no DOM or Node APIs, since both tsconfig projects
// type-check this file.
//
// Supported formats, one utterance per line:
//   - timestamped:     "MM:SS Speaker: text"  (or [MM:SS] / H:MM:SS)
//   - Granola export:  "Me: text" / "Them: text" with an optional metadata
//     header (Meeting Title / Date / Meeting participants / Transcript:) and
//     no timestamps — pacing is then estimated from word count.
// "You" / "Me" / "Rep" map to the rep side. Lines that match neither shape
// continue the previous utterance; blank lines and "#" comments are skipped.

export type ParsedTranscriptLine = {
  speaker: string
  isRep: boolean
  seconds: number
  time: string
  text: string
}

export type ParsedTranscript = {
  title: string | null
  /** Raw value of a "Date: ..." header line, if present. */
  date: string | null
  /** Estimated call length: end of the latest utterance. */
  durationSeconds: number
  lines: ParsedTranscriptLine[]
}

const WORDS_PER_SECOND = 2.5 // ~150 wpm conversational pace
const MIN_UTTERANCE_SECONDS = 2

function estimateUtteranceSeconds(text: string) {
  return Math.max(MIN_UTTERANCE_SECONDS, Math.round(text.split(/\s+/).length / WORDS_PER_SECOND))
}

export function formatElapsed(seconds = 0) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
    .toString()
    .padStart(2, '0')}`
}

export function parseTranscript(raw: string): ParsedTranscript {
  const lines: ParsedTranscriptLine[] = []
  let title: string | null = null
  let date: string | null = null
  let clock = 0

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const titleMatch = line.match(/^meeting title:\s*(.+)$/i)
    if (titleMatch) {
      title = titleMatch[1].trim()
      continue
    }

    const dateMatch = line.match(/^date:\s*(.+)$/i)
    if (dateMatch) {
      date = dateMatch[1].trim()
      continue
    }

    if (/^(meeting participants|attendees|transcript):/i.test(line)) {
      continue
    }

    const timeMatch = line.match(/^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s+(.+)$/)
    const body = timeMatch ? timeMatch[4] : line
    const explicitSeconds = timeMatch
      ? timeMatch[3] === undefined
        ? Number(timeMatch[1]) * 60 + Number(timeMatch[2])
        : Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])
      : null

    const speakerMatch = body.match(/^([A-Za-z][A-Za-z0-9 .'-]{0,24}):\s*(.+)$/)
    if (!speakerMatch) {
      if (lines.length > 0) {
        lines[lines.length - 1].text += ` ${body}`
      }
      continue
    }

    const speaker = speakerMatch[1].trim()
    const text = speakerMatch[2].trim()
    const seconds = explicitSeconds ?? clock
    clock = seconds + estimateUtteranceSeconds(text)

    lines.push({
      speaker,
      isRep: /^(you|me|rep)$/i.test(speaker),
      seconds,
      time: formatElapsed(seconds),
      text,
    })
  }

  return {
    title,
    date,
    durationSeconds: lines.reduce(
      (end, line) => Math.max(end, line.seconds + estimateUtteranceSeconds(line.text)),
      0,
    ),
    lines: lines.sort((a, b) => a.seconds - b.seconds),
  }
}
