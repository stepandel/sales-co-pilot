import type { ReactNode } from 'react'

const QUESTION_WORDS =
  /\b(?:how(?:\s+(?:much|many|often|long|soon))?|what|when|where|who|whom|whose|why|which)\b/gi
const LEADING_AUXILIARY =
  /^(?:do|does|did|can|could|would|will|should|is|are|was|were|have|has|had)\b/i
const WORD_TOKEN = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’]+)(.*)$/u

// Bionic reading: bold the first ~40% of each word as a fixation anchor so
// the eye can skim the question instead of reading it.
export function bionicText(text: string): ReactNode[] {
  return text.split(/(\s+)/).map((token, index) => {
    const match = token.match(WORD_TOKEN)
    if (!match) {
      return token
    }

    const [, lead, core, rest] = match
    const split = core.length <= 3 ? 1 : Math.ceil(core.length * 0.4)

    return (
      <span key={index}>
        {lead}
        <b className="bx">{core.slice(0, split)}</b>
        {core.slice(split)}
        {rest}
      </span>
    )
  })
}

// Interrogative words signal the question's purpose, so they always keep full
// ink (see .qw in App.css) even when the rest of the question dims.
function withQuestionWords(text: string, atQuestionStart: boolean): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0

  const lead = atQuestionStart ? text.match(LEADING_AUXILIARY) : null
  if (lead) {
    nodes.push(
      <b className="qw" key="lead">
        {bionicText(lead[0])}
      </b>,
    )
    cursor = lead[0].length
  }

  for (const match of text.matchAll(QUESTION_WORDS)) {
    const index = match.index ?? 0
    if (index < cursor) {
      continue
    }

    if (index > cursor) {
      nodes.push(<span key={`t${cursor}`}>{bionicText(text.slice(cursor, index))}</span>)
    }
    nodes.push(
      <b className="qw" key={index}>
        {bionicText(match[0])}
      </b>,
    )
    cursor = index + match[0].length
  }

  if (cursor < text.length) {
    nodes.push(<span key={`t${cursor}`}>{bionicText(text.slice(cursor))}</span>)
  }

  return nodes
}

// The key span stays full-ink while the rest of the question dims (see
// .has-key in App.css), so the rep can catch the ask without reading it all.
export function emphasizedQuestion(question: string, emphasis: string) {
  const index = emphasis ? question.indexOf(emphasis) : -1
  if (index === -1) {
    return <>{withQuestionWords(question, true)}</>
  }

  return (
    <>
      {withQuestionWords(question.slice(0, index), true)}
      <mark>{bionicText(emphasis)}</mark>
      {withQuestionWords(question.slice(index + emphasis.length), false)}
    </>
  )
}
