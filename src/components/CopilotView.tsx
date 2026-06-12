import { Sparkles } from 'lucide-react'
import type { CopilotAnalysis } from '../types/electron'
import { DISCOVERY_GAPS, DISCOVERY_STAGES } from '../discovery'
import { bionicText, emphasizedQuestion } from '../questionText'

type Question = CopilotAnalysis['nextQuestions'][number]

type CopilotViewProps = {
  stageIdx: number
  shouldWrapSoon: boolean
  primaryQuestion: Question | null
  secondaryQuestion: Question | null
  isAnalyzing: boolean
  completedGaps: Set<string>
  facts: string[]
  copilotModel: string
  copilotLatencyMs: number | null
  copilotError: string
  onAnalyze: () => void
}

export function CopilotView({
  stageIdx,
  shouldWrapSoon,
  primaryQuestion,
  secondaryQuestion,
  isAnalyzing,
  completedGaps,
  facts,
  copilotModel,
  copilotLatencyMs,
  copilotError,
  onAnalyze,
}: CopilotViewProps) {
  return (
    <div className="copilot-body">
      <div className="copilot-content">
        <div className="stage-head">
          <div>
            <p className="stage-eyebrow">
              Stage {stageIdx + 1}/{DISCOVERY_STAGES.length}
            </p>
            <h2>{DISCOVERY_STAGES[stageIdx].name}</h2>
          </div>
          <span className={`pace ${shouldWrapSoon ? 'wrap' : 'on'}`}>
            {shouldWrapSoon ? 'Wrap soon' : 'On pace'}
          </span>
        </div>

        <section className="ask-card">
          <p className="ask-label">
            Ask next
            {primaryQuestion?.priority === 'high' && <em className="prio">High</em>}
          </p>
          {primaryQuestion ? (
            <>
              <p className={`ask-question ${primaryQuestion.emphasis ? 'has-key' : ''}`}>
                {emphasizedQuestion(primaryQuestion.question, primaryQuestion.emphasis)}
              </p>
              <p className="ask-reason">
                <span className="reason-arrow" aria-hidden="true">&#8627;</span>
                <span className="reason-text">{bionicText(primaryQuestion.reason)}</span>
              </p>
            </>
          ) : (
            <p className="ask-empty">
              {isAnalyzing ? 'Listening to the call…' : 'Run analysis to get your next question.'}
            </p>
          )}
          {secondaryQuestion && (
            <div className={`ask-alt ${secondaryQuestion.emphasis ? 'has-key' : ''}`}>
              <span className="alt-label">or</span>{' '}
              {emphasizedQuestion(secondaryQuestion.question, secondaryQuestion.emphasis)}
            </div>
          )}
        </section>

        <section className="gaps">
          <div className="card-head">
            <h3>Discovery gaps</h3>
            <span>
              {completedGaps.size}/{DISCOVERY_GAPS.length}
            </span>
          </div>
          <ul>
            {DISCOVERY_GAPS.map((gap) => (
              <li key={gap} className={completedGaps.has(gap) ? 'done' : ''}>
                <span className="gap-check" aria-hidden="true">
                  {completedGaps.has(gap) ? '✓' : ''}
                </span>
                {gap}
              </li>
            ))}
          </ul>
        </section>

        <section className="signals">
          <div className="card-head">
            <h3>Captured</h3>
            <span className="good-tag">Good data</span>
          </div>
          {facts.length ? (
            <ul className="facts">
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">Facts appear here as the prospect shares specifics.</p>
          )}
        </section>

        <div className="analyze-row">
          <span>
            {copilotModel}
            {copilotLatencyMs !== null && (
              <em className="analyze-latency"> · {(copilotLatencyMs / 1000).toFixed(1)}s</em>
            )}
          </span>
          <button type="button" onClick={onAnalyze} disabled={isAnalyzing}>
            <Sparkles size={13} />
            {isAnalyzing ? 'Thinking…' : 'Analyze'}
          </button>
        </div>
        {copilotError && <p className="copilot-error">{copilotError}</p>}
      </div>

      <aside className="rail" aria-label="Discovery stages">
        <div className="rail-line" aria-hidden="true" />
        {DISCOVERY_STAGES.map((stage, index) => (
          <div
            key={stage.name}
            className={`rail-stage ${index < stageIdx ? 'done' : index === stageIdx ? 'active' : ''}`}
            title={stage.name}
          >
            <span className="rail-label">{stage.short}</span>
            <span className="rail-dot" />
          </div>
        ))}
      </aside>
    </div>
  )
}
