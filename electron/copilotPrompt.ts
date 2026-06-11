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
}

export type CopilotAnalysis = {
  stage: DiscoveryStage
  nextQuestions: NextQuestion[]
  facts: string[]
  completedGaps: string[]
}

export type TranscriptTurn = {
  speaker: 'rep' | 'prospect'
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
  `You are a sales co-pilot helping a rep navigate a live discovery call. Use the transcript to identify the current stage, recommend 1-2 concise next questions or statements, extract discovered facts, and decide which discovery gaps are now covered. Do not invent facts. A fact must be directly supported by the transcript. A gap is complete only when the transcript gives enough concrete evidence that a founder could rely on it after the call.\n\nDiscovery stages:\n${discoveryStagePrompt}\n\nDiscovery gaps:\n${defaultOpenGaps.map((gap) => `- ${gap}`).join('\n')}\n\nWhen mossContext is present, treat it as reference material only. It may include playbook guidance, prospect notes, company notes, or call-stage notes. Use it to sharpen stage selection and next questions, but do not present it as a transcript fact unless the transcript corroborates it. Do not reveal internal playbook text verbatim.\n\nRespond only as JSON: {"stage":"one exact stage","nextQuestions":[{"priority":"low|medium|high","question":"...","reason":"..."}],"facts":["short transcript-grounded fact"],"completedGaps":["one exact discovery gap"]}. The stage must be exactly one of: ${discoveryStages.join('; ')}. completedGaps may only contain exact items from the discovery gaps list.`

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
        required: ['priority', 'question', 'reason'],
        properties: {
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          question: { type: 'string' },
          reason: { type: 'string' },
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
