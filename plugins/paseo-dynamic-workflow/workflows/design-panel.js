export const meta = {
  name: 'design-panel',
  description: 'Judge panel for a design or plan: independent designs from different angles, scored by judges who see them anonymized and in rotated order, then one synthesis built on the winner with the best ideas of the others grafted in.',
  whenToUse: 'The user wants a design, architecture, migration plan or approach chosen carefully when several reasonable solutions exist. Scout the relevant code first and pass what you found as context. To review an existing draft instead, use critique. args: the problem as a string, or { problem, context?, angles?, criteria?, judges?, size? }. Roughly: small 5 agents, medium 7, large 11, unrestricted 14. Leave size unset under Ultracode unless the user asked for a light run.',
  phases: [
    { title: 'Draft', detail: 'one independent design per angle' },
    { title: 'Judge', detail: 'each judge scores every design' },
    { title: 'Synthesize', detail: 'build on the winner, graft the best of the rest' },
    { title: 'Red team', detail: 'large and unrestricted: attack the final design, then revise' },
  ],
}

// design-panel (paseo-dynamic-workflow built-in)
// args: "design X"  or
//   { problem, context?: 'paths, constraints, what you found while scouting', angles?: ['smallest change', ...],
//     criteria?: ['correctness', ...], judges?: 2-5, size?: 'small'|'medium'|'large'|'unrestricted' }

const input = readArgs('problem')
const PROBLEM = typeof input.problem === 'string' ? input.problem.trim() : ''
if (!PROBLEM) throw new Error("design-panel needs a problem: workflow({ name: 'design-panel', args: { problem, context } })")
const SIZE = runSize(input)
const K = { small: { angles: 2, judges: 2, red: 0 }, medium: { angles: 3, judges: 3, red: 0 }, large: { angles: 4, judges: 3, red: 2 }, unrestricted: { angles: 5, judges: 5, red: 2 } }[SIZE]
const CONTEXT = typeof input.context === 'string' ? input.context.trim() : ''
const ALL_ANGLES = ['smallest change that fully solves it', 'most robust under failure, concurrency and future change', 'best experience for the user and for operators', 'reuse of what already exists in the codebase and ecosystem', 'simplest design to explain, test and delete later']
const ANGLES = (Array.isArray(input.angles) && input.angles.length ? input.angles.map((a) => clean(a, 200)) : ALL_ANGLES.slice(0, K.angles)).slice(0, 6)
const CRITERIA = (Array.isArray(input.criteria) && input.criteria.length ? input.criteria.map((c) => clean(c, 120))
  : ['correctness and completeness', 'risk and failure handling', 'fit with the existing code and constraints', 'cost to build and maintain', 'user-visible quality']).slice(0, 8)
const JUDGES = int(input.judges, 2, 5, K.judges)
const LETTERS = 'ABCDEF'.split('')

const DESIGN = { type: 'object', required: ['title', 'summary', 'design', 'risks', 'steps'], properties: {
  title: { type: 'string' }, summary: { type: 'string' }, design: { type: 'string' },
  risks: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } },
  evidence: { type: 'array', items: { type: 'string' }, description: 'Files, docs or facts you checked.' },
} }
const FINAL = { type: 'object', required: ['title', 'design', 'steps', 'risks', 'grafted', 'rejected'], properties: {
  title: { type: 'string' }, design: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } },
  grafted: { type: 'array', items: { type: 'string' }, description: 'Ideas taken from runner-up designs.' },
  rejected: { type: 'array', items: { type: 'string' }, description: 'Ideas deliberately left out, with why.' },
  openQuestions: { type: 'array', items: { type: 'string' } },
} }
const ATTACK = { type: 'object', required: ['flaws'], properties: { flaws: { type: 'array', items: {
  type: 'object', required: ['flaw', 'severity', 'evidence'], properties: { flaw: { type: 'string' }, severity: { enum: ['critical', 'high', 'medium', 'low'] }, evidence: { type: 'string' } } } } } }
const BRIEF = data('Problem', PROBLEM) + (CONTEXT ? '\n\n' + data('Context from the orchestrator', CONTEXT) : '')
const READ_CODE = 'Read code and docs as needed; do not modify files, commit or install anything.'

phase('Draft')
const draftResults = await parallel(ANGLES.map((angle, i) => () => safe([
  'Design a solution independently. Your angle: ' + angle + '. Other designers work from other angles; do not hedge toward a compromise, make the strongest case for your angle.',
  BRIEF,
  'Check the real code and constraints before you commit to a design, and list what you checked as evidence.',
  READ_CODE,
].join('\n\n'), { label: 'draft:' + (i + 1), phase: 'Draft', schema: DESIGN, agentType: 'plan' })))
const drafts = draftResults
  .map((d, i) => (d ? { ...d, angle: ANGLES[i] } : null)).filter(Boolean)
  .map((d, i) => ({ ...d, id: LETTERS[i] }))
if (!drafts.length) throw new Error(runLimit() || 'Every designer failed; retry with a narrower problem or more context.')
const coverage = ANGLES.map((angle, i) => ({ key: 'draft:' + (i + 1), status: draftResults[i] ? 'ok' : 'failed' }))
if (drafts.length < ANGLES.length) log((ANGLES.length - drafts.length) + ' designer(s) failed')

phase('Judge')
const ids = drafts.map((d) => d.id)
const SCORES = { type: 'object', required: ['scores'], properties: { scores: { type: 'array', items: {
  type: 'object', required: ['design', 'total', 'strengths', 'flaws'], properties: {
    design: { enum: ids }, total: { type: 'number', description: '0 to 10' },
    perCriterion: { type: 'array', items: { type: 'object', required: ['criterion', 'score'], properties: { criterion: { type: 'string' }, score: { type: 'number' } } } },
    strengths: { type: 'array', items: { type: 'string' } }, flaws: { type: 'array', items: { type: 'string' } },
  } } } } }
// Barrier on purpose: each judge compares every design. Anonymous ids and a rotated order per
// judge keep position and angle names from steering the scores.
const judged = await parallel(Array.from({ length: JUDGES }, (_, j) => () => {
  const rotated = drafts.map((_, i) => drafts[(i + j) % drafts.length])
  return safe([
    'You are judge ' + (j + 1) + ' of ' + JUDGES + '. Score every design from 0 to 10 overall and on each criterion. Check claims against the code where a score depends on them, and be specific about flaws. Score each design on its own merits; their order means nothing.',
    'Criteria: ' + CRITERIA.join('; '),
    BRIEF,
    data('Designs', rotated.map((d) => ({ design: d.id, title: d.title, summary: d.summary, design_text: d.design, risks: d.risks, steps: d.steps }))),
    READ_CODE,
  ].join('\n\n'), { label: 'judge:' + (j + 1), phase: 'Judge', schema: SCORES, agentType: 'plan' })
}))
judged.forEach((p, j) => coverage.push({ key: 'judge:' + (j + 1), status: p && ids.every((id) => p.scores.some((score) => score.design === id)) ? 'ok' : 'failed' }))
const panels = judged.filter(Boolean)
if (!panels.length) return { schemaVersion: 1, status: 'partial', problem: PROBLEM, final: null, coverage, limit: runLimit(), designs: drafts.map((d) => ({ id: d.id, title: d.title, angle: d.angle, summary: d.summary })), error: 'Every judge failed; designs are returned unscored.' }

const totals = stableSort(drafts.map((d) => {
  const scores = panels.map((p) => p.scores.find((s) => s.design === d.id)).filter(Boolean)
  const mean = scores.length ? Math.round(scores.reduce((sum, s) => sum + s.total, 0) / scores.length * 10) / 10 : null
  return { id: d.id, title: d.title, mean, judged: scores.length, strengths: scores.flatMap((s) => s.strengths), flaws: scores.flatMap((s) => s.flaws) }
}), (t) => [t.judged >= 2 || panels.length < 2 ? 0 : 1, -(t.mean ?? -1), t.id])
const unscored = totals.filter((t) => t.mean === null || (panels.length >= 2 && t.judged < 2))
if (unscored.length) log('Too few judges scored: ' + unscored.map((t) => t.id).join(', ') + ' (ranked last, not zero)')
log('Ranking: ' + totals.map((t) => t.id + ' ' + (t.mean ?? '?')).join(', '))
if (totals[0].mean === null) return { schemaVersion: 1, status: 'partial', problem: PROBLEM, final: null, coverage, ranking: totals, limit: runLimit(), error: 'No judge scored a design; no winner was selected.' }
const winner = drafts.find((d) => d.id === totals[0].id)

phase('Synthesize')
let final = await safe([
  'Produce the final design. Start from the winning design, fix the flaws the judges found, and graft in the strongest ideas from the runner-ups where they fit. Say what you grafted and what you rejected and why.',
  BRIEF,
  data('Winner', { id: winner.id, title: winner.title, design: winner.design, judgeFlaws: totals[0].flaws }),
  data('Runner-ups', totals.slice(1).map((t) => ({ id: t.id, title: t.title, mean: t.mean, strengths: t.strengths, design: drafts.find((d) => d.id === t.id).design }))),
  READ_CODE,
].join('\n\n'), { label: 'synthesize', phase: 'Synthesize', schema: FINAL })

let redTeam = []
let unaddressedRedTeam = false
if (final && K.red) {
  phase('Red team')
  const LENSES = ['failure modes, concurrency and data loss', 'fit with the existing code, migrations and compatibility']
  const attacks = await parallel(LENSES.slice(0, K.red).map((lens, i) => () => safe([
    'Attack this final design through one lens: ' + lens + '. Check each flaw against the code and give evidence; return an empty list if it holds up.',
    BRIEF, data('Final design', final), READ_CODE,
  ].join('\n\n'), { label: 'red-team:' + (i + 1), phase: 'Red team', schema: ATTACK, agentType: 'verification' })))
  attacks.forEach((a, i) => coverage.push({ key: 'red-team:' + (i + 1), status: a ? 'ok' : 'failed' }))
  redTeam = attacks.filter(Boolean).flatMap((r) => r.flaws)
  if (redTeam.some((f) => f.severity === 'critical' || f.severity === 'high')) {
    const revised = await safe([
      'Revise the final design to address the serious flaws the red team found; keep everything that was not challenged.',
      BRIEF, data('Final design', final), data('Red-team flaws', redTeam), READ_CODE,
    ].join('\n\n'), { label: 'revise', phase: 'Red team', schema: FINAL })
    if (revised) final = revised
    else { unaddressedRedTeam = true; coverage.push({ key: 'revise', status: 'failed', ...(runLimit() ? { reason: runLimit() } : {}) }) }
  }
}

if (!final) coverage.push({ key: 'synthesize', status: 'failed' })
return {
  schemaVersion: 1,
  status: final && coverage.every((c) => c.status === 'ok') ? 'complete' : 'partial',
  problem: PROBLEM,
  final,
  ranking: totals.map((t) => ({ id: t.id, title: t.title, mean: t.mean, judged: t.judged })),
  redTeam,
  unaddressedRedTeam,
  coverage,
  limit: runLimit(),
  designs: drafts.map((d) => ({ id: d.id, title: d.title, angle: d.angle, summary: d.summary })),
  stats: { size: SIZE, designers: ANGLES.length, designs: drafts.length, judges: panels.length },
}
