export const meta = {
  name: 'design-panel',
  description: 'Judge panel for a design or plan: independent designs from different angles, scored by parallel judges against shared criteria, then one synthesis built on the winner with the best ideas of the others grafted in.',
  whenToUse: 'The user wants a design, architecture, migration plan or approach chosen carefully when several reasonable solutions exist. Scout the relevant code first and pass what you found as context. args: the problem as a string, or { problem, context?, angles?, criteria?, judges? }.',
  phases: [
    { title: 'Draft', detail: 'one independent design per angle' },
    { title: 'Judge', detail: 'each judge scores every design' },
    { title: 'Synthesize', detail: 'build on the winner, graft the best of the rest' },
  ],
}

// design-panel (paseo-dynamic-workflow built-in)
// args: "design X"  or
//       { problem, context?: 'paths, constraints, what you found while scouting',
//         angles?: ['minimal change first', ...], criteria?: ['correctness', ...], judges?: 3 (2-5) }

const input = typeof args === 'string' ? { problem: args } : (args && typeof args === 'object' ? args : {})
const PROBLEM = typeof input.problem === 'string' ? input.problem.trim() : ''
if (!PROBLEM) return { error: "No problem statement. Launch with workflow({ name: 'design-panel', args: { problem, context } })." }
const CONTEXT = typeof input.context === 'string' && input.context.trim() ? input.context.trim() : ''
const ANGLES = Array.isArray(input.angles) && input.angles.length
  ? input.angles.slice(0, 6).map(String)
  : ['smallest change that fully solves it', 'most robust under failure, concurrency and future change', 'best experience for the user and for operators', 'reuse of what already exists in the codebase and ecosystem']
const CRITERIA = Array.isArray(input.criteria) && input.criteria.length
  ? input.criteria.slice(0, 8).map(String)
  : ['correctness and completeness', 'risk and failure handling', 'fit with the existing code and constraints', 'cost to build and maintain', 'user-visible quality']
const JUDGES = Math.min(5, Math.max(2, Number.isInteger(input.judges) ? input.judges : 3))

const DESIGN = { type: 'object', required: ['title', 'summary', 'design', 'risks', 'steps'], properties: {
  title: { type: 'string' }, summary: { type: 'string' }, design: { type: 'string' },
  risks: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } },
  evidence: { type: 'array', items: { type: 'string' }, description: 'Files, docs or facts you checked.' },
} }
const SCORES = { type: 'object', required: ['scores'], properties: { scores: { type: 'array', items: {
  type: 'object', required: ['design', 'total', 'perCriterion', 'strengths', 'flaws'], properties: {
    design: { type: 'number', description: 'Index of the design.' }, total: { type: 'number', description: '0-10' },
    perCriterion: { type: 'array', items: { type: 'object', required: ['criterion', 'score'], properties: { criterion: { type: 'string' }, score: { type: 'number' } } } },
    strengths: { type: 'array', items: { type: 'string' } }, flaws: { type: 'array', items: { type: 'string' } },
  } } } } }
const FINAL = { type: 'object', required: ['title', 'design', 'steps', 'risks', 'grafted', 'rejected'], properties: {
  title: { type: 'string' }, design: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } },
  risks: { type: 'array', items: { type: 'string' } },
  grafted: { type: 'array', items: { type: 'string' }, description: 'Ideas taken from runner-up designs.' },
  rejected: { type: 'array', items: { type: 'string' }, description: 'Ideas deliberately left out, with why.' },
  openQuestions: { type: 'array', items: { type: 'string' } },
} }
const BRIEF = 'Problem: ' + PROBLEM + (CONTEXT ? '\n\nContext from the orchestrator:\n' + CONTEXT : '')
const READ_ONLY = 'Read code and docs as needed but do not modify files.'

phase('Draft')
const drafts = (await parallel(ANGLES.map((angle, i) => () => agent([
  'Design a solution independently. Your angle: ' + angle + '. Other designers work from other angles; do not hedge toward a compromise, make the strongest case for your angle.',
  BRIEF,
  'Check the real code and constraints before you commit to a design, and list what you checked as evidence.',
  READ_ONLY,
].join('\n\n'), { label: 'draft:' + (i + 1), phase: 'Draft', schema: DESIGN, agentType: 'plan' })))).map((d, i) => (d ? { ...d, angle: ANGLES[i] } : null)).filter(Boolean)
if (drafts.length === 0) return { problem: PROBLEM, error: 'Every designer failed.' }
log(drafts.length + ' design(s): ' + drafts.map((d) => d.title).join(' | '))

phase('Judge')
// Barrier on purpose: judges compare every design with the others.
const listing = drafts.map((d, i) => '### Design ' + i + ': ' + d.title + ' (angle: ' + d.angle + ')\n' + d.summary + '\n\n' + d.design + '\nRisks: ' + d.risks.join('; ') + '\nSteps: ' + d.steps.join('; ')).join('\n\n')
const panels = (await parallel(Array.from({ length: JUDGES }, (_, j) => () => agent([
  'You are judge ' + (j + 1) + ' of ' + JUDGES + '. Score every design from 0 to 10 on each criterion and overall. Check claims against the code where a score depends on them. Be specific about flaws.',
  'Criteria: ' + CRITERIA.join('; '),
  BRIEF,
  listing,
  READ_ONLY,
].join('\n\n'), { label: 'judge:' + (j + 1), phase: 'Judge', schema: SCORES, agentType: 'verification' })))).filter(Boolean)
if (panels.length === 0) return { problem: PROBLEM, designs: drafts, error: 'Every judge failed; designs are returned unscored.' }

const totals = drafts.map((d, i) => {
  const scores = panels.map((p) => p.scores.find((s) => s.design === i)).filter(Boolean)
  const mean = scores.length ? scores.reduce((sum, s) => sum + s.total, 0) / scores.length : 0
  return { index: i, title: d.title, mean: Math.round(mean * 10) / 10, judged: scores.length, strengths: scores.flatMap((s) => s.strengths), flaws: scores.flatMap((s) => s.flaws) }
}).sort((a, b) => b.mean - a.mean)
log('Ranking: ' + totals.map((t) => t.title + ' ' + t.mean).join(', '))
const winner = drafts[totals[0].index]

phase('Synthesize')
const final = await agent([
  'Produce the final design. Start from the winning design, fix the flaws the judges found, and graft in the strongest ideas from the runner-ups where they fit. Say what you grafted and what you rejected and why.',
  BRIEF,
  '## Winner: ' + winner.title + '\n' + winner.design + '\nJudge flaws: ' + totals[0].flaws.join('; '),
  '## Runner-ups\n' + totals.slice(1).map((t) => '- ' + t.title + ' (' + t.mean + '): strengths ' + t.strengths.join('; ') + '\n' + drafts[t.index].design).join('\n\n'),
  READ_ONLY,
].join('\n\n'), { label: 'synthesize', phase: 'Synthesize', schema: FINAL })

return {
  problem: PROBLEM,
  final: final || null,
  ranking: totals.map((t) => ({ title: t.title, mean: t.mean, judged: t.judged })),
  designs: drafts.map((d) => ({ title: d.title, angle: d.angle, summary: d.summary })),
  stats: { designers: ANGLES.length, designs: drafts.length, judges: panels.length },
}
