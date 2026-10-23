export const meta = {
  name: 'critique',
  description: 'Critique an existing draft (a design, plan, proposal or document) from independent lenses, verify each must-change against the evidence, and return a revised draft with the decisions made.',
  whenToUse: 'You or the user have a draft and want it challenged before acting on it: a design doc, implementation plan, migration plan, RFC or report. args: { draft: absolute path or text, goal?, lenses?, votes?, size? }. Size small is about 6 agents, medium 15, large 25, unrestricted 40+.',
  phases: [
    { title: 'Critique', detail: 'one critic per lens' },
    { title: 'Verify', detail: 'each must-change checked against its evidence' },
    { title: 'Revise', detail: 'decisions and a revised draft' },
  ],
}

// critique (paseo-dynamic-workflow built-in)
// args: { draft: '/abs/path/design.md' or the text itself, goal?: 'what the draft must achieve',
//         lenses?: ['compatibility', ...], votes?: 1-3, size?: 'small'|'medium'|'large'|'unrestricted' }

const input = readArgs('draft')
const DRAFT = typeof input.draft === 'string' ? input.draft.trim() : ''
if (!DRAFT) throw new Error("critique needs args.draft: an absolute path or the draft text")
const SIZE = runSize(input)
const K = { small: { lenses: 3, votes: 1 }, medium: { lenses: 4, votes: 2 }, large: { lenses: 5, votes: 2 }, unrestricted: { lenses: 6, votes: 3 } }[SIZE]
const DEFAULT_LENSES = [
  'correctness: does it actually solve the stated problem; which claims about the current code or system are wrong?',
  'compatibility and state: existing data, running processes, older clients, migrations and rollback',
  'failure modes: concurrency, partial failure, retries, cleanup, limits',
  'behaviour and users: what users or models will actually do with it, and what will surprise them',
  'gap audit: requirements, files or scenarios the draft never addresses',
  'simplicity: what can be removed or reused instead of built',
]
const LENSES = (Array.isArray(input.lenses) && input.lenses.length ? input.lenses.map((l) => clean(l, 400)) : DEFAULT_LENSES.slice(0, K.lenses))
const VOTES = int(input.votes, 1, 3, K.votes)
const GOAL = typeof input.goal === 'string' && input.goal.trim() ? data('Goal of the draft', input.goal.trim()) : ''
const SOURCE = DRAFT.startsWith('/') && !DRAFT.includes('\n') ? 'The draft is the file ' + JSON.stringify(DRAFT) + '; read it first, together with every file it names.' : data('Draft', DRAFT)
const NO_WRITES = 'Read whatever you need; do not modify files, commit or install anything. Scratch files go in a fresh `mktemp -d` directory that you delete before you answer.'

const CRITIQUE = { type: 'object', required: ['verdict', 'mustChange', 'shouldAdd', 'risks'], properties: {
  verdict: { type: 'string', description: 'Is the draft sound from your lens? What is wrong or missing?' },
  mustChange: { type: 'array', items: { type: 'object', required: ['item', 'why', 'proposal', 'evidence'], properties: {
    item: { type: 'string' }, why: { type: 'string' }, proposal: { type: 'string' }, evidence: { type: 'string', description: 'file:line, URL or a command and its output' } } } },
  shouldAdd: { type: 'array', items: { type: 'object', required: ['item', 'why'], properties: { item: { type: 'string' }, why: { type: 'string' }, proposal: { type: 'string' } } } },
  risks: { type: 'array', items: { type: 'string' } },
} }
const CHECK = { type: 'object', required: ['verdict', 'reason'], properties: {
  verdict: { enum: ['holds', 'refuted', 'cannot_check'] }, reason: { type: 'string' } } }
const REVISION = { type: 'object', required: ['decisions', 'revised'], properties: {
  decisions: { type: 'array', items: { type: 'object', required: ['item', 'decision', 'why'], properties: { item: { type: 'string' }, decision: { type: 'string' }, why: { type: 'string' } } } },
  revised: { type: 'string', description: 'The revised draft, complete.' },
  openQuestions: { type: 'array', items: { type: 'string' } },
} }

phase('Critique')
const critiques = await parallel(LENSES.map((lens, i) => () => agent([
  'Critique a draft from one lens before anyone acts on it. Lens: ' + lens,
  SOURCE, GOAL,
  'Cite evidence for every must-change (file:line, URL, or a command you ran and what it printed). Separate what you verified from what you infer. An empty list is fine when the draft holds up from your lens.',
  NO_WRITES,
].filter(Boolean).join('\n\n'), { label: 'critic:' + (i + 1), phase: 'Critique', schema: CRITIQUE })))
const coverage = critiques.map((c, i) => ({ lens: clean(LENSES[i], 80), status: c ? 'ok' : 'failed' }))
const items = []
critiques.forEach((c, i) => { if (c) c.mustChange.forEach((m) => items.push({ id: 'M' + (items.length + 1), lens: i + 1, ...m })) })
log(items.length + ' must-change item(s) from ' + critiques.filter(Boolean).length + ' critic(s)')

phase('Verify')
const checked = await parallel(items.map((m) => () => parallel(Array.from({ length: VOTES }, (_, v) => () => agent([
  'A critic says this draft must change. Check the critic\'s evidence and premise yourself. verdict=holds when the problem is real and the evidence supports it, refuted when the evidence is wrong or the problem does not exist, cannot_check only when you could not examine it.',
  SOURCE,
  data('Must-change ' + m.id, { item: m.item, why: m.why, proposal: m.proposal, evidence: m.evidence }),
  NO_WRITES,
].join('\n\n'), { label: 'check:' + m.id + ':' + (v + 1), phase: 'Verify', schema: CHECK, agentType: 'verification', timeoutMinutes: 40 })))
  .then((votes) => ({ ...m, ...tally(votes, VOTES, 'holds', 'refuted'), reasons: votes.filter(Boolean).map((x) => clean(x.reason, 400)) }))))
const verified = checked.filter(Boolean)

phase('Revise')
const revision = await safe([
  'Revise the draft. Apply every confirmed must-change, decide each unverified one explicitly, ignore refuted ones, and fold in the should-add items that fit. Where critics disagree, make the decision and say why.',
  SOURCE, GOAL,
  data('Must-change items with verification', verified.map((m) => ({ id: m.id, status: m.status, item: m.item, proposal: m.proposal, votes: m.votes }))),
  data('Should-add and risks', critiques.filter(Boolean).map((c) => ({ shouldAdd: c.shouldAdd, risks: c.risks }))),
  NO_WRITES,
].join('\n\n'), { label: 'revise', phase: 'Revise', schema: REVISION })

return {
  schemaVersion: 1,
  status: revision && coverage.every((c) => c.status === 'ok') ? 'complete' : 'partial',
  decisions: revision ? revision.decisions : [],
  revised: revision ? revision.revised : null,
  openQuestions: revision ? revision.openQuestions || [] : [],
  mustChange: verified.map((m) => ({ id: m.id, status: m.status, votes: m.votes, item: clean(m.item, 400), proposal: clean(m.proposal, 800) })),
  coverage,
  stats: { size: SIZE, lenses: LENSES.length, mustChange: items.length, confirmed: verified.filter((m) => m.status === 'confirmed').length },
}
