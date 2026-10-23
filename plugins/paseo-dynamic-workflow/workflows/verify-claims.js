export const meta = {
  name: 'verify-claims',
  description: 'Verify a list of claims or findings: each one judged by independent verifiers from distinct lenses, with a tri-state result (confirmed, refuted, unverified) where a failed or blocked verifier never counts as a refutation.',
  whenToUse: 'You already have claims, findings or conclusions (your own, a report, another run) and need each one checked independently before acting on it. args: { claims: [{ id?, claim, evidence?, locator? }] or ["claim", ...], context?, lenses?, votes?, size? }. About votes x claims agents. Leave size unset under Ultracode unless the user asked for a light run.',
  phases: [{ title: 'Verify', detail: 'independent verifiers per claim' }],
}

// verify-claims (paseo-dynamic-workflow built-in)
// args: { claims: [{ id?: 'C1', claim: '...', evidence?: '...', locator?: 'file:line or URL' }] or ['claim', ...],
//         context?: 'what the claims are about and where to look', lenses?: ['...'], votes?: 2-5, size?: ... }

const input = readArgs('claims')
const raw = Array.isArray(input.claims) ? input.claims : []
const usedIds = new Set()
const items = raw.map((c, i) => typeof c === 'string' ? { claim: c } : c).filter((c) => c && typeof c.claim === 'string' && c.claim.trim())
  .map((c, i) => {
    const preferred = clean(c.id || 'C' + (i + 1), 24) || 'C' + (i + 1)
    let id = preferred
    for (let suffix = 2; usedIds.has(id); suffix++) id = preferred + '-' + suffix
    usedIds.add(id)
    return { id, claim: clean(c.claim, 1500), evidence: clean(c.evidence, 2000), locator: clean(c.locator, 300) }
  })
if (!items.length) throw new Error("verify-claims needs args.claims: [{ claim, evidence?, locator? }] or a list of strings")
if (raw.length > items.length) log((raw.length - items.length) + ' entr(ies) without a claim skipped')
const SIZE = runSize(input)
const VOTES = int(input.votes, 2, 5, { small: 2, medium: 3, large: 3, unrestricted: 4 }[SIZE])
const CONTEXT = typeof input.context === 'string' && input.context.trim() ? data('Context', input.context.trim()) : ''
const DEFAULT_LENSES = [
  'Reproduce or recompute it yourself: run the code, the query or the calculation, or open the source it cites.',
  'Check intent and context: is the claim about what the author meant, the current version, the right scope? Read history, docs and surrounding material.',
  'Look for counter-evidence: guards, later changes, contradicting sources, cases where it does not hold.',
  'Build the strongest argument that it is wrong, then test that argument against the evidence.',
  'Judge whether the evidence is strong enough for a claim this strong.',
]
const LENSES = (Array.isArray(input.lenses) && input.lenses.length ? input.lenses.map((l) => clean(l, 400)) : DEFAULT_LENSES)
const VERDICT = { type: 'object', required: ['verdict', 'method', 'reason'], properties: {
  verdict: { enum: ['holds', 'refuted', 'cannot_check'] }, method: { enum: ['ran', 'read', 'searched', 'none'] },
  reason: { type: 'string' }, blocker: { type: 'string', description: 'What stopped you, when verdict is cannot_check.' } } }

phase('Verify')
const results = await checkBatches(items, (c) => parallel(Array.from({ length: VOTES }, (_, v) => () => checkAgent([
  'Independently verify one claim. ' + LENSES[v % LENSES.length],
  'verdict=holds when the evidence you examined supports it, refuted when it contradicts or fails to support it, cannot_check only when you could not examine it at all (say what blocked you). Do not guess.',
  CONTEXT,
  data('Claim ' + c.id, c),
  READ_ONLY,
].filter(Boolean).join('\n\n'), { label: 'verify:' + c.id + ':' + (v + 1), phase: 'Verify', schema: VERDICT, agentType: 'verification', timeoutMinutes: 40 })))
  .then((verdicts) => ({ ...c, ...tally(verdicts, VOTES, 'holds', 'refuted'), reasons: verdicts.filter(Boolean).map((x) => ({ verdict: x.verdict, method: x.method, reason: clean(x.reason, 500) })) })))
const done = results.filter(Boolean)
const by = (status) => done.filter((r) => r.status === status)
const coverage = done.filter((r) => r.missing > 0 || r.cannot > 0).map((r) => voteCoverage('verify:' + r.id, r))
return {
  schemaVersion: 1,
  status: done.length === items.length && !coverage.length ? 'complete' : 'partial',
  coverage,
  limit: runLimit(),
  confirmed: by('confirmed'), refuted: by('refuted'), unverified: by('unverified'),
  stats: { size: SIZE, claims: items.length, votesPerClaim: VOTES, confirmed: by('confirmed').length, refuted: by('refuted').length, unverified: by('unverified').length },
}
