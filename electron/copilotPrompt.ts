export type DiscoveryStage =
  | 'Just here to learn'
  | 'When did it last happen'
  | 'Quantify the pain'
  | 'What have they tried?'
  | 'Are they already solving it?'
  | 'Ask for commitment'
  | 'Lock next steps'

export type NextQuestion = {
  priority: 'low' | 'medium' | 'high'
  question: string
  reason: string
  /** Verbatim substring of `question` carrying the core ask; '' when absent. */
  emphasis: string
}

export type CopilotAnalysis = {
  stage: DiscoveryStage
  nextQuestions: NextQuestion[]
  facts: string[]
  completedGaps: string[]
}

export type TranscriptTurn = {
  /** Which side of the call is talking; the analysis logic only needs this. */
  speaker: 'rep' | 'prospect'
  /** The speaker's original label from the transcript, e.g. "Me", "Jordan". */
  name?: string
  text: string
  timestamp?: string
}

export const discoveryStageGuide = [
  {
    stage: 'Just here to learn',
    goal: 'Get your idea off the table.',
    doneWhen: 'They are talking freely about their own world, not reaching for a pitch.',
  },
  {
    stage: 'When did it last happen',
    goal: 'Pin them to a specific, recent instance.',
    doneWhen: 'You are inside one concrete past event, not generalities.',
  },
  {
    stage: 'Quantify the pain',
    goal: 'Establish cost, frequency, and downstream consequence of that instance.',
    doneWhen: 'You can state how much it hurts and how often.',
  },
  {
    stage: 'What have they tried?',
    goal: 'Uncover what they have already tried, built, or paid for.',
    doneWhen: 'You know whether real money or time has been spent.',
  },
  {
    stage: 'Are they already solving it?',
    goal: 'Determine if they are solving this now or it is a someday item.',
    doneWhen: 'You know it is a find-budget problem, not a nice-to-have.',
  },
  {
    stage: 'Ask for commitment',
    goal: 'Float your direction lightly and ask for something costly: time, an intro, or money.',
    doneWhen: 'They either advance or dodge.',
  },
  {
    stage: 'Lock next steps',
    goal: 'Lock a concrete dated advancement, or explicitly name that there is not one.',
    doneWhen: 'The next step, or its confirmed absence, is unambiguous.',
  },
] as const satisfies ReadonlyArray<{ stage: DiscoveryStage; goal: string; doneWhen: string }>

export const discoveryStages = discoveryStageGuide.map((entry) => entry.stage)

export const defaultOpenGaps = [
  'concrete instance',
  'cost & frequency',
  'existing workaround / spend',
  'decision power',
  'commitment',
] as const

const discoveryStagePrompt = discoveryStageGuide
  .map((entry, index) => `${index + 1}. ${entry.stage} — Goal: ${entry.goal} Done when: ${entry.doneWhen}`)
  .join('\n')

export const salesCopilotSystemPrompt =
  `You are a sales co-pilot helping a rep navigate a live discovery call. Transcript turns carry a "speaker" role — "rep" is the person you are helping, "prospect" is anyone else on the call — and may carry a "name" with the speaker's actual label. When a participant has a name, use it in facts instead of the generic "prospect". Use the transcript to track the current stage, recommend 1-2 concise next questions or statements, extract discovered facts, and decide which discovery gaps are now covered. Do not invent facts. A fact must be directly supported by the transcript. A gap is complete only when the transcript gives enough concrete evidence that a founder could rely on it after the call.\n\nYou are a coach, not a referee. The stages below are a compass, not a checklist: real calls wander, double back, and skip ahead, and that is fine. Never steer the rep toward "getting back on script" — your job is to surface the most useful next thing to ask from wherever the conversation actually is.\n\nThe payload includes "previousAnalysis", your own output from the last pass (null on the first pass). Treat it as your working state and preserve continuity:\n- Stay in previousAnalysis.stage unless the newest turns clearly show the conversation has moved. Move to an earlier stage only when the prospect has genuinely reopened that ground — never merely because earlier answers were imperfect.\n- The rep reads your questions mid-conversation, so every change costs attention. If a previous question is still the right ask, repeat it verbatim, including its emphasis. Replace a question only once it has been asked, answered, or made obsolete by the new turns.\n- Carry forward previous facts and completedGaps unless the transcript contradicts them; a completed gap stays completed.\n\nQuestions must be glanceable AND self-contained. The rep reads them seconds after the moment has passed, so a question must carry its own referent: name the concrete subject — the specific problem, process, tool, person, or event — never "this", "that", or "it" pointing back into the conversation. "When did the deploy last break?" works on its own; "When did this last happen?" is unusable once the conversation has moved. When brevity and specificity conflict, specificity wins. Keep each question short and conversational: one clause, roughly 12 words or fewer, no preamble, no stacked qualifiers. For each question also return "emphasis": the single most important contiguous span of 2-6 words, copied verbatim from the question — usually it should include the subject. Never emphasize the whole question.\n\nDiscovery stages:\n${discoveryStagePrompt}\n\nDiscovery gaps:\n${defaultOpenGaps.map((gap) => `- ${gap}`).join('\n')}\n\nWhen mossContext is present, treat it as reference material only. It may include playbook guidance, prospect notes, company notes, or call-stage notes. Use it to sharpen stage selection and next questions, but do not present it as a transcript fact unless the transcript corroborates it. Do not reveal internal playbook text verbatim.\n\nRespond only as JSON: {"stage":"one exact stage","nextQuestions":[{"priority":"low|medium|high","question":"...","reason":"...","emphasis":"2-6 word verbatim span of the question"}],"facts":["short transcript-grounded fact"],"completedGaps":["one exact discovery gap"]}. The stage must be exactly one of: ${discoveryStages.join('; ')}. completedGaps may only contain exact items from the discovery gaps list.`

export const copilotAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'nextQuestions', 'facts', 'completedGaps'],
  properties: {
    stage: {
      type: 'string',
      enum: discoveryStages,
    },
    nextQuestions: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['priority', 'question', 'reason', 'emphasis'],
        properties: {
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          question: { type: 'string' },
          reason: { type: 'string' },
          emphasis: { type: 'string' },
        },
      },
    },
    facts: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' },
    },
    completedGaps: {
      type: 'array',
      maxItems: defaultOpenGaps.length,
      items: {
        type: 'string',
        enum: defaultOpenGaps,
      },
    },
  },
}
