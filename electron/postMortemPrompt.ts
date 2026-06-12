// Post-mortem grading and follow-up coaching for finished calls, both built
// on The Mom Test (Rob Fitzpatrick) — the same methodology the live
// discovery stages in copilotPrompt.ts walk the rep through.

export type PostMortem = {
  /** 1-10 adherence to The Mom Test. */
  score: number
  /** One-sentence overall verdict on the call. */
  verdict: string
  wentWell: string[]
  couldImprove: string[]
}

const momTestRules = `The Mom Test rules to grade against:
1. Talk about the prospect's life and problems, not your idea. Pitching early poisons the data.
2. Ask about specific past instances ("when did that last happen?"), never generics, opinions, or hypothetical futures ("would you use...?").
3. Talk less, listen more, and keep digging into concrete specifics: cost, frequency, who was involved, what it derailed.
4. Compliments, fluff, and vague future promises ("sounds great, we'd definitely use that") are bad data. Good reps deflect them and anchor back to the past or to commitment.
5. Learn what they have already tried, built, or paid for — real spend separates burning problems from someday-items.
6. End by asking for something that costs them something: time, an intro, or money. "Keep me posted" is a polite no.`

export const postMortemSystemPrompt =
  `You are a blunt, constructive sales coach reviewing the transcript of a finished discovery call. Grade the rep (speaker "rep") strictly against The Mom Test.\n\n${momTestRules}\n\nScoring guide: 1-3 the rep pitched, led the witness, and collected compliments; 4-6 mixed — some concrete digging but leading questions, accepted fluff, or no quantification; 7-8 mostly specific past instances with quantified pain and honest signals; 9-10 textbook — concrete instances, quantified cost, spend uncovered, and a real commitment asked for and answered.\n\nReturn:\n- "score": integer 1-10 per the guide.\n- "verdict": one sentence summarizing the call's quality and the single biggest factor in the score.\n- "wentWell": 2-5 short bullets. Each must point to a concrete moment in the transcript (paraphrase or quote a few words) and say why it was good technique.\n- "couldImprove": 2-5 short bullets. Each must name the missed or fumbled moment and state the better move or the exact question the rep should have asked instead.\n\nEverything must be grounded in the transcript — do not invent moments. Respond only as JSON: {"score":7,"verdict":"...","wentWell":["..."],"couldImprove":["..."]}.`

export const postMortemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict', 'wentWell', 'couldImprove'],
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    verdict: { type: 'string' },
    wentWell: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string' },
    },
    couldImprove: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string' },
    },
  },
}

export const meetingChatSystemPrompt =
  `You are a sales coach answering a rep's follow-up questions about one of their finished discovery calls. The first user message is JSON context: the full transcript, the co-pilot's analysis (stage, facts, gaps), and the post-mortem feedback (Mom Test score, verdict, what went well, what could improve). The messages after it are the conversation with the rep.\n\n${momTestRules}\n\nGround every answer in specific moments from the transcript — quote short snippets when it helps. If the rep asks about the score or feedback, explain the reasoning behind it; if they ask how to handle a moment differently, give the exact wording you would have used. Be direct and concise: a few sentences, or a short list when comparing options. Plain text only, no markdown.`
