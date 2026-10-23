export const meta = {
  name: 'deep-review',
  description: 'Exhaustive code review: scope the change, review it per dimension, verify every finding from independent lenses, chase gaps until a round finds nothing new, and return a ranked fix plan.',
  whenToUse: 'The user wants a thorough review or audit of a change, branch, pull request or set of files, with findings that survive independent verification; also to re-check earlier findings after fixes (recheck). args: a string saying what to review, or { target, focus?, size?, dimensions?, votes?, rounds?, recheck? }. Roughly: small 10-25 agents, medium 30-80, large 60-180, unrestricted 100-500 (the default under Ultracode); verification is capped at 10/20/40/120 findings by size. Built-in sizes are depth levels, not the agent counts of the size guideline.',
  phases: [
    { title: 'Scope', detail: 'map the change and pick review dimensions' },
    { title: 'Recheck', detail: 'earlier findings: fixed or still present' },
    { title: 'Review', detail: 'one reviewer per dimension' },
    { title: 'Verify', detail: 'each new finding judged by independent lenses' },
    { title: 'Gaps', detail: 'completeness critic adds targeted reviews until rounds are dry' },
    { title: 'Plan', detail: 'merge duplicates and rank a fix plan' },
  ],
}

// deep-review (paseo-dynamic-workflow built-in)
// args: "review the uncommitted changes"  or
//   { target: 'branch sw/x against origin/main', focus?: 'concurrency', size?: 'small'|'medium'|'large'|'unrestricted',
//     dimensions?: ['correctness', ...] or [{ key, prompt }], votes?: 2-5, rounds?: 0-6,
//     recheck?: [{ title, file, line?, scenario }] (findings from an earlier review, checked first) }
// Children only read the repository; reproductions go in a `mktemp -d` directory outside it.

const input = readArgs('target')
const SIZE = runSize(input)
const KNOBS = {
  small: { dims: 4, votes: 2, rounds: 0, extra: 0, dry: 1, verify: 10 },
  medium: { dims: 6, votes: 3, rounds: 1, extra: 1, dry: 1, verify: 20 },
  large: { dims: 9, votes: 3, rounds: 2, extra: 3, dry: 1, verify: 40 },
  unrestricted: { dims: 9, votes: 4, rounds: 6, extra: 3, dry: 2, verify: 120 },
}[SIZE]
const TARGET = typeof input.target === 'string' && input.target.trim() ? input.target.trim()
  : 'the uncommitted changes in the working tree and the commits on the current branch that are not on its upstream or main branch'
const FOCUS = typeof input.focus === 'string' ? input.focus.trim() : ''
const VOTES = int(input.votes, 2, 5, KNOBS.votes)
const ROUNDS = int(input.rounds, 0, 6, KNOBS.rounds)
const RECHECK = Array.isArray(input.recheck) ? input.recheck.filter((f) => f && typeof f === 'object').slice(0, 200) : []
log('Size ' + SIZE + ': up to ' + KNOBS.dims + ' dimensions, ' + VOTES + ' votes per finding, ' + ROUNDS + ' gap round(s)')

const DEFAULT_DIMENSIONS = {
  correctness: 'Logic errors, wrong conditions, off-by-one, null and undefined handling, wrong return values, broken invariants.',
  'concurrency-lifecycle': 'Races, ordering, cancellation, shutdown and restart, retries, timers, resource leaks, idempotency.',
  security: 'Injection, path traversal, unsafe deserialization, secrets, permission and trust boundaries, untrusted input reaching sensitive sinks.',
  'data-persistence': 'Data loss or corruption, migrations, atomic writes, compatibility with existing stored data, partial failure.',
  'api-contract': 'Callers and callees that disagree, compatibility with older clients or files, error contracts, documented behaviour versus actual.',
  'error-handling': 'Swallowed errors, misleading messages, failure paths that leave state inconsistent, missing user feedback.',
  tests: 'Tests that do not test what they claim, missing coverage of the changed behaviour, flaky timing, tests that would pass on the old code.',
  performance: 'Hot loops, unbounded growth, repeated I/O, polling, quadratic work on realistic sizes.',
  'ux-docs': 'User-visible text, UI states (loading, error, empty), accessibility labels, and docs that no longer match the code.',
}
const SEVERITY = { enum: ['critical', 'high', 'medium', 'low'] }
const SCOPE = { type: 'object', required: ['summary', 'files', 'dimensions'], properties: {
  summary: { type: 'string', description: 'What the change does and the exact git commands or paths that show it.' },
  files: { type: 'array', items: { type: 'object', required: ['path', 'role'], properties: { path: { type: 'string' }, role: { type: 'string' } } } },
  dimensions: { type: 'array', items: { type: 'object', required: ['key', 'why'], properties: { key: { type: 'string' }, why: { type: 'string' } } } },
  extra: { type: 'array', items: { type: 'object', required: ['key', 'prompt'], properties: { key: { type: 'string' }, prompt: { type: 'string' } } } },
} }
const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
  type: 'object', required: ['title', 'file', 'severity', 'scenario'], properties: {
    title: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, severity: SEVERITY,
    scenario: { type: 'string', description: 'Concrete inputs or state that lead to the wrong outcome.' }, evidence: { type: 'string' },
  } } } } }
const VERDICT = { type: 'object', required: ['verdict', 'method', 'reason'], properties: {
  verdict: { enum: ['real', 'not_real', 'cannot_check'] },
  method: { enum: ['ran', 'read', 'searched', 'none'] },
  severity: SEVERITY, reason: { type: 'string' }, blocker: { type: 'string', description: 'What stopped you, when verdict is cannot_check.' },
} }
const RECHECKED = { type: 'object', required: ['verdict', 'reason'], properties: {
  verdict: { enum: ['fixed', 'still_present', 'cannot_check'] }, reason: { type: 'string' } } }
const GAPS = { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', items: {
  type: 'object', required: ['key', 'prompt'], properties: { key: { type: 'string' }, prompt: { type: 'string' } } } } } }
const PLAN = { type: 'object', required: ['summary', 'fixes'], properties: {
  summary: { type: 'string' },
  fixes: { type: 'array', items: { type: 'object', required: ['title', 'severity', 'findings', 'files', 'change', 'test'], properties: {
    title: { type: 'string' }, severity: SEVERITY, findings: { type: 'array', items: { type: 'string' }, description: 'Finding ids (F1, R1, ...).' },
    files: { type: 'array', items: { type: 'string' } }, change: { type: 'string' }, test: { type: 'string', description: 'The regression test that fails before the fix.' },
  } } },
  notes: { type: 'array', items: { type: 'string' } },
} }
const LENSES = [
  { key: 'reproduce', prompt: 'Lens: reproduction. Trace the exact code path for the scenario line by line, and run a minimal reproduction (a scratch test or script) when that is feasible. verdict=real only if the path really produces the wrong outcome.' },
  { key: 'intent', prompt: 'Lens: intent. Check whether this behaviour is deliberate: the surrounding code, tests, docs and the history of these lines (git log -p, git blame). verdict=not_real if it is the designed behaviour or the premise about the code is wrong.' },
  { key: 'guards', prompt: 'Lens: existing guards. Look for code elsewhere (callers, validation layers, wrappers, retries) that already prevents the scenario. verdict=not_real if something upstream or downstream handles it.' },
  { key: 'counterexample', prompt: 'Lens: counterexample. Build the strongest argument that the finding is wrong, then check it against the code. verdict=real only if your counterargument fails.' },
  { key: 'impact', prompt: 'Lens: impact. Judge whether the mechanism can happen on realistic inputs and deployments. verdict=not_real only if it cannot happen in practice; otherwise real, and set severity.' },
]
const VERIFY_RULES = 'Answer real when the evidence you examined supports the finding, not_real when it contradicts it, and cannot_check only when you could not examine it at all (say what blocked you). Do not guess.'
const order = { critical: 0, high: 1, medium: 2, low: 3 }

phase('Scope')
const scope = await safe([
  'Map the change under review so reviewers can work independently.',
  'What to review: ' + TARGET + (FOCUS ? '\nUser focus: ' + FOCUS : ''),
  'Find the exact change set (git status, git log against the upstream or main branch, git diff --stat, or the named paths), read the project instruction files, and summarize what changed and why.',
  'Pick the review dimensions that apply from this list, most important first (drop only those that clearly cannot apply): ' + Object.keys(DEFAULT_DIMENSIONS).join(', ') + '. Add change-specific dimensions in `extra`, each with a precise prompt.',
  READ_ONLY,
].join('\n\n'), { label: 'scope', phase: 'Scope', schema: SCOPE, agentType: 'explore' })
const coverage = []
if (!scope) {
  log('Scope failed: reviewing with every default dimension and no file map')
  coverage.push({ key: 'scope', status: 'failed' })
}

let dimensions
if (Array.isArray(input.dimensions) && input.dimensions.length) {
  dimensions = input.dimensions.slice(0, 20).map((d) => typeof d === 'string'
    ? { key: clean(d, 40), prompt: DEFAULT_DIMENSIONS[d] || ('Review dimension: ' + clean(d, 200)) }
    : { key: clean(d && d.key, 40), prompt: clean(d && d.prompt || DEFAULT_DIMENSIONS[d && d.key] || (d && d.key), 1500) })
} else {
  const picked = (scope ? scope.dimensions : []).map((d) => d.key).filter((key, i, all) => DEFAULT_DIMENSIONS[key] && all.indexOf(key) === i)
  // The scope agent's picks first, then the remaining defaults, so a short pick list is topped up, not replaced.
  const keys = picked.concat(Object.keys(DEFAULT_DIMENSIONS).filter((key) => !picked.includes(key))).slice(0, KNOBS.dims)
  dimensions = keys.map((key) => ({ key, prompt: DEFAULT_DIMENSIONS[key] }))
    .concat((scope && scope.extra || []).slice(0, KNOBS.extra).map((d) => ({ key: clean(d.key, 40), prompt: clean(d.prompt, 1500) })))
  const skipped = Object.keys(DEFAULT_DIMENSIONS).filter((key) => !keys.includes(key))
  if (skipped.length) log('Dimensions not reviewed at size ' + SIZE + ': ' + skipped.join(', '))
}
const CONTEXT = scope
  ? data('Change under review (from the scope agent)', { what: TARGET, ...(FOCUS ? { focus: FOCUS } : {}), summary: scope.summary, files: scope.files.slice(0, 300) })
    + (scope.files.length > 300 ? '\n(' + (scope.files.length - 300) + ' more files; list them with the same git commands)' : '')
  : 'What to review: ' + TARGET + (FOCUS ? '. User focus: ' + FOCUS : '') + '. Find the change set yourself with git status, git log and git diff.'

let nextId = 1
let verifiedCount = 0
const findings = []
const duplicates = []
const seen = new Map()
// Same file, nearby line and the same words in the title: one defect reported twice. Distinct titles stay distinct.
const words = (title) => String(title || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ')
const keyOf = (f) => String(f.file || '').toLowerCase().replace(/^\.\//, '') + '#' + (Number.isFinite(f.line) ? Math.floor(f.line / 15) : '-') + '#' + words(f.title)

async function verify(batch) {
  await parallel(batch.map((f) => () => parallel(LENSES.slice(0, VOTES).map((lens) => () => agent([
    'Independently verify one code review finding.', lens.prompt, VERIFY_RULES, CONTEXT,
    data('Finding ' + f.id, { title: f.title, file: f.file, line: f.line, severity: f.severity, scenario: f.scenario, evidence: f.evidence }),
    READ_ONLY,
  ].join('\n\n'), { label: 'verify:' + f.id + ':' + lens.key, phase: 'Verify', schema: VERDICT, agentType: 'verification', timeoutMinutes: 40 })))
    .then((verdicts) => {
      const t = tally(verdicts, VOTES, 'real', 'not_real')
      const rated = verdicts.filter((v) => v && v.verdict === 'real' && v.severity).map((v) => v.severity)
      Object.assign(f, { status: t.status, votes: t.votes, why: t.why, reasons: verdicts.filter(Boolean).map((v) => clean(v.reason, 400)) })
      if (rated.length) f.severity = stableSort(rated, (s) => [order[s]])[Math.floor(rated.length / 2)]
    })))
}

// One round: every reviewer finishes, findings are deduplicated in a fixed order (so a resume
// builds the same prompts), and each new finding is verified.
async function round(tasks, phaseTitle) {
  const reviews = await parallel(tasks.map((task) => () => agent([
    'You are one reviewer in a multi-agent code review. Your dimension: ' + task.key + '. ' + task.prompt,
    CONTEXT,
    'Report only problems you can tie to specific code with a concrete failing scenario. Read the code; do not guess from names. Return an empty list when you find nothing: padding is worse than silence.',
    READ_ONLY,
  ].join('\n\n'), { label: 'review:' + task.key, phase: phaseTitle, schema: FINDINGS })))
  const fresh = []
  reviews.forEach((review, i) => {
    coverage.push({ key: tasks[i].key, status: review ? 'ok' : 'failed', findings: review ? review.findings.length : 0 })
    for (const f of stableSort(review ? review.findings : [], (x) => [String(x.file), Number(x.line) || 0, String(x.title)])) {
      const key = keyOf(f)
      if (seen.has(key)) { duplicates.push({ title: clean(f.title, 200), file: clean(f.file, 200), line: f.line, dupOf: seen.get(key), source: tasks[i].key }); continue }
      const entry = { id: 'F' + nextId++, title: clean(f.title, 300), file: clean(f.file, 300), line: f.line, severity: f.severity, scenario: f.scenario, evidence: f.evidence, source: tasks[i].key, status: 'unverified', why: 'missing votes', votes: '0-0' }
      seen.set(key, entry.id)
      findings.push(entry)
      fresh.push(entry)
    }
  })
  const failed = reviews.filter((r) => !r).length
  if (failed) log(failed + ' reviewer(s) failed in ' + phaseTitle + '; see coverage')
  // Verification is the expensive part: the most severe findings first, up to the size's cap.
  const ranked = stableSort(fresh, (f) => [order[f.severity] ?? 9, f.id])
  const room = Math.max(0, KNOBS.verify - verifiedCount)
  const skipped = ranked.slice(room)
  skipped.forEach((f) => { f.why = 'not verified: cap of ' + KNOBS.verify + ' at size ' + SIZE })
  if (skipped.length) log(skipped.length + ' finding(s) left unverified by the cap of ' + KNOBS.verify + ' at size ' + SIZE + '; rerun with a larger size to check them')
  verifiedCount += Math.min(room, ranked.length)
  await verify(ranked.slice(0, room))
  return fresh.length
}

let recheck = []
if (RECHECK.length) {
  phase('Recheck')
  recheck = await parallel(RECHECK.map((f, i) => () => parallel(['fixed', 'regression'].map((lens) => () => agent([
    lens === 'fixed'
      ? 'An earlier review reported this finding and someone has since changed the code. Check whether the defect is still present: trace the scenario through the current code and rerun its reproduction when feasible.'
      : 'An earlier review reported this finding and someone has since changed the code. Check whether the change fixed it without breaking nearby behaviour; report still_present if the fix is incomplete or regressed a neighbour.',
    'Answer fixed, still_present, or cannot_check when you could not examine it.', CONTEXT,
    data('Earlier finding R' + (i + 1), { title: f.title, file: f.file, line: f.line, scenario: f.scenario }), READ_ONLY,
  ].join('\n\n'), { label: 'recheck:R' + (i + 1) + ':' + lens, phase: 'Recheck', schema: RECHECKED, agentType: 'verification', timeoutMinutes: 40 })))
    .then((votes) => {
      // Recheck has its own words: 'fixed' and 'still_present' (both lenses agree), else 'unverified'.
      const t = tally(votes, 2, 'fixed', 'still_present')
      const status = t.status === 'confirmed' ? 'fixed' : t.status === 'refuted' ? 'still_present' : 'unverified'
      return { id: 'R' + (i + 1), title: clean(f.title, 300), file: clean(f.file, 300), line: f.line, scenario: clean(f.scenario, 600), status, votes: t.votes, ...(t.why ? { why: t.why } : {}) }
    })))
}

phase('Review')
await round(dimensions.map((d) => ({ key: d.key, prompt: d.prompt })), 'Review')
log('After review: ' + findings.filter((f) => f.status === 'confirmed').length + ' confirmed of ' + findings.length)

phase('Gaps')
let dry = 0
for (let r = 1; r <= ROUNDS && dry < KNOBS.dry; r++) {
  const gaps = await safe([
    'You are the completeness critic of a multi-agent code review. Decide what has not been covered: a changed file nobody examined closely, an interaction between components, a failure mode no dimension owned, a claim in the change description nobody checked.',
    CONTEXT,
    'Dimensions reviewed so far: ' + coverage.filter((c) => c.status === 'ok').map((c) => c.key).join(', ') + (coverage.some((c) => c.status === 'failed') ? '\nReviewers that failed (cover them again if they matter): ' + coverage.filter((c) => c.status === 'failed').map((c) => c.key).join(', ') : ''),
    data('Findings so far', findings.map((f) => ({ id: f.id, status: f.status, title: f.title, file: f.file }))),
    'Return targeted review tasks with precise prompts naming files and questions, or an empty list if the review is complete.',
    READ_ONLY,
  ].join('\n\n'), { label: 'critic:' + r, phase: 'Gaps', schema: GAPS })
  if (!gaps) { coverage.push({ key: 'critic:' + r, status: 'failed' }); break }
  const tasks = gaps.tasks.slice(0, 8).map((t, i) => ({ key: 'gap' + r + '.' + (i + 1) + '-' + clean(t.key, 32), prompt: clean(t.prompt, 1500) }))
  if (gaps.tasks.length > tasks.length) log('Round ' + r + ': ' + (gaps.tasks.length - tasks.length) + ' gap task(s) beyond 8 dropped')
  if (!tasks.length) { log('Round ' + r + ': the critic found no gaps'); break }
  const fresh = await round(tasks, 'Gaps')
  log('Round ' + r + ': ' + tasks.length + ' targeted review(s), ' + fresh + ' new finding(s)')
  dry = fresh === 0 ? dry + 1 : 0
}

phase('Plan')
const confirmed = stableSort(findings.filter((f) => f.status === 'confirmed'), (f) => [order[f.severity] ?? 9, f.id])
const brief = (f) => ({ id: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, scenario: clean(f.scenario, 600), votes: f.votes, source: f.source, ...(f.why ? { why: f.why } : {}) })
const stillPresent = recheck.filter((r) => r.status === 'still_present')
let plan = null
if (confirmed.length || stillPresent.length) {
  plan = await safe([
    'Turn verified code review findings into a fix plan. Merge findings that describe the same defect, group fixes that touch the same code, and order them by severity and dependency. For each fix give the concrete change and the regression test that would fail before it.',
    CONTEXT,
    data('Confirmed findings', confirmed.map(brief)),
    stillPresent.length ? data('Earlier findings that are still present after the last fix (ids R1, R2, ...)', stillPresent) : '',
    READ_ONLY,
  ].filter(Boolean).join('\n\n'), { label: 'plan', phase: 'Plan', schema: PLAN })
  if (!plan) coverage.push({ key: 'plan', status: 'failed' })
}
const unverified = findings.filter((f) => f.status === 'unverified')
const partial = coverage.some((c) => c.status === 'failed') || unverified.some((f) => f.why === 'missing votes' || String(f.why).startsWith('not verified')) || recheck.some((r) => r.status === 'unverified')

return {
  schemaVersion: 1,
  status: partial ? 'partial' : 'complete',
  target: TARGET,
  summary: scope ? clean(scope.summary, 1200) : null,
  plan,
  confirmed: confirmed.map((f) => ({ ...brief(f), reasons: f.reasons })),
  unverified: unverified.map(brief),
  refuted: findings.filter((f) => f.status === 'refuted').map(brief),
  recheck,
  coverage,
  duplicates,
  stats: { size: SIZE, findings: findings.length, confirmed: confirmed.length, unverified: unverified.length, verified: verifiedCount, verifyCap: KNOBS.verify, votesPerFinding: VOTES, gapRounds: ROUNDS, files: scope ? scope.files.length : null },
}
