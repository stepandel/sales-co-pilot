export const DISCOVERY_STAGES = [
  { name: 'Just here to learn', short: 'Learn' },
  { name: 'When did it last happen', short: 'Last time' },
  { name: 'Quantify the pain', short: 'Pain' },
  { name: 'What have they tried?', short: 'Tried' },
  { name: 'Are they already solving it?', short: 'Solving?' },
  { name: 'Ask for commitment', short: 'Commit' },
  { name: 'Lock next steps', short: 'Next steps' },
] as const

export const DISCOVERY_GAPS = [
  'concrete instance',
  'cost & frequency',
  'existing workaround / spend',
  'decision power',
  'commitment',
] as const
