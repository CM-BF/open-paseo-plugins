export const meta = {
  name: 'deep-research',
  description: 'Multi-source research: probe the available search tools, split the question into angles, read and extract checkable claims from each new source, verify the important claims with independent skeptics, fill gaps, and write up the answer with citations.',
  whenToUse: 'The user wants a deep, fact-checked, multi-source answer from web pages, documents or named local files and repositories (to map a codebase, write an Understand workflow instead). If the question is underspecified (no budget, region, version or use case), ask two or three clarifying questions first and fold the answers into the question. args: the question as a string, or { question, sources?: [urls or absolute paths], size?, angles?, maxSources?, claims?, votes?, gapRounds? }. Roughly: small 25 agents, medium 70, large 110, unrestricted 200+ (the default under Ultracode); built-in sizes are depth levels, not the agent counts of the size guideline. Claude children may ask permission for web search and fetch. Leave size unset under Ultracode unless the user asked for a light run.',
  phases: [
    { title: 'Scope', detail: 'probe search and fetch, split the question into angles' },
    { title: 'Search', detail: 'one searcher per angle' },
    { title: 'Read', detail: 'read each new source and extract checkable claims' },
    { title: 'Verify', detail: 'independent skeptics per important claim' },
    { title: 'Gaps', detail: 'targeted rounds for what is still missing' },
    { title: 'Synthesize', detail: 'merge, grade confidence and cite' },
  ],
}

// deep-research (paseo-dynamic-workflow built-in)
// args: "how do X and Y compare for Z?"  or
//   { question, sources?: ['https://...', '/abs/path/doc.md', '/abs/repo'], size?: 'small'|'medium'|'large'|'unrestricted',
//     angles?: 3-8, maxSources?: 4-60, claims?: 5-80, votes?: 2-5, gapRounds?: 0-3 }
// Children use the search, fetch and file tools their provider offers. Text from sources reaches
// later prompts only JSON-encoded inside a data block.

const input = readArgs('question')
const QUESTION = typeof input.question === 'string' ? input.question.trim() : ''
if (!QUESTION) throw new Error("deep-research needs a question: workflow({ name: 'deep-research', args: '<question>' })")
const SIZE = runSize(input)
const K = {
  small: { angles: 3, sources: 6, claims: 8, votes: 2, gaps: 0 },
  medium: { angles: 4, sources: 10, claims: 15, votes: 3, gaps: 1 },
  large: { angles: 5, sources: 16, claims: 25, votes: 3, gaps: 1 },
  unrestricted: { angles: 6, sources: 28, claims: 45, votes: 3, gaps: 2 },
}[SIZE]
const ANGLES = int(input.angles, 3, 8, K.angles)
const MAX_SOURCES = int(input.maxSources, 4, 60, K.sources)
const MAX_CLAIMS = int(input.claims, 5, 80, K.claims)
const VOTES = int(input.votes, 2, 5, K.votes)
const GAP_ROUNDS = int(input.gapRounds, 0, 3, K.gaps)
const GIVEN = Array.isArray(input.sources) ? input.sources.filter((s) => typeof s === 'string' && s.trim()).slice(0, 40).map((s) => s.trim()) : []
log('Size ' + SIZE + ': ' + ANGLES + ' angles, up to ' + MAX_SOURCES + ' sources, ' + MAX_CLAIMS + ' claims x ' + VOTES + ' votes, ' + GAP_ROUNDS + ' gap round(s)')

const TOOL = { enum: ['works', 'unavailable', 'blocked'] }
const SCOPE = { type: 'object', required: ['tools', 'angles'], properties: {
  tools: { type: 'object', required: ['search', 'fetch'], properties: { search: TOOL, fetch: TOOL, note: { type: 'string' } } },
  angles: { type: 'array', items: { type: 'object', required: ['label', 'query', 'kind'], properties: {
    label: { type: 'string' }, query: { type: 'string' }, kind: { enum: ['web', 'local'] }, why: { type: 'string' } } } },
} }
const SOURCES = { type: 'object', required: ['sources'], properties: { sources: { type: 'array', items: {
  type: 'object', required: ['url', 'title', 'relevance'], properties: {
    url: { type: 'string', description: 'URL, or an absolute file path for local sources.' }, title: { type: 'string' },
    relevance: { enum: ['high', 'medium', 'low'] } } } } } }
const CLAIMS = { type: 'object', required: ['quality', 'claims'], properties: {
  quality: { enum: ['primary', 'secondary', 'opinion', 'forum', 'unusable'] }, date: { type: 'string' },
  claims: { type: 'array', items: { type: 'object', required: ['claim', 'quote', 'weight'], properties: {
    claim: { type: 'string', description: 'One concrete, checkable statement.' },
    quote: { type: 'string', description: 'The supporting passage, verbatim.' },
    locator: { type: 'string', description: 'Section, line range or anchor.' },
    weight: { enum: ['central', 'supporting', 'side'] } } } } } }
const VERDICT = { type: 'object', required: ['verdict', 'method', 'evidence'], properties: {
  verdict: { enum: ['holds', 'refuted', 'cannot_check'] }, method: { enum: ['ran', 'read', 'searched', 'none'] },
  confidence: { enum: ['high', 'medium', 'low'] }, evidence: { type: 'string' }, counterSource: { type: 'string' }, blocker: { type: 'string' } } }
const GAPS = { type: 'object', required: ['angles'], properties: { angles: { type: 'array', items: {
  type: 'object', required: ['label', 'query', 'kind'], properties: { label: { type: 'string' }, query: { type: 'string' }, kind: { enum: ['web', 'local'] }, why: { type: 'string' } } } } } }
const REPORT = { type: 'object', required: ['answer', 'findings', 'caveats'], properties: {
  answer: { type: 'string', description: 'A direct answer in three to six sentences.' },
  findings: { type: 'array', items: { type: 'object', required: ['finding', 'confidence', 'claims'], properties: {
    finding: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] },
    claims: { type: 'array', items: { type: 'string' }, description: 'Claim ids (C1, C2, ...) it rests on.' } } } },
  caveats: { type: 'array', items: { type: 'string' } }, openQuestions: { type: 'array', items: { type: 'string' } },
} }
const NO_WRITES = 'Do not modify files, commit or install anything. Scratch files go in a fresh `mktemp -d` directory that you delete before you answer.'
const rank = { high: 0, medium: 1, low: 2, central: 0, supporting: 1, side: 2, primary: 0, secondary: 1, opinion: 2, forum: 3, unusable: 4 }
// The same page once, but distinct pages that differ only in their query (?id=1, ?v=abc) stay distinct.
const urlKey = (url) => {
  const [base, query = ''] = String(url).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').split('?')
  const kept = query.split('&').filter((pair) => pair && !/^(utm_[a-z]+|ref|fbclid|gclid|source)=/.test(pair)).sort().join('&')
  return base.replace(/\/+$/, '') + (kept ? '?' + kept : '')
}
const hostOf = (url) => { const m = String(url).match(/^[a-z]+:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i); return m ? m[1].toLowerCase().slice(0, 40) : 'local' }
const claimKey = (claim) => String(claim).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 12).join(' ')
const coverage = []

phase('Scope')
const scope = await safe([
  'Prepare a research run. First check your tools: run one real web search for the question and open one result. Report search and fetch as works, unavailable (you have no such tool) or blocked (a permission prompt or sandbox stopped it).',
  'Then split the question into ' + ANGLES + ' complementary angles that together cover it: for example primary sources and official documentation, independent measurements, recent changes, critical or contrarian views, practitioner experience. Use kind "local" for angles answered from files or repositories on this machine, "web" otherwise. Pick angles that suit the domain; avoid overlap.',
  data('Question', QUESTION) + (GIVEN.length ? '\n' + data('Sources the user named', GIVEN) : ''),
  NO_WRITES,
].join('\n\n'), { label: 'scope', phase: 'Scope', schema: SCOPE })
if (!scope) throw new Error('The scope agent failed, so the run has no angles; retry or pass a narrower question.')
// Web angles need both: a search whose results cannot be opened yields no claims.
const webOk = scope.tools.search === 'works' && scope.tools.fetch === 'works'
const webState = scope.tools.search !== 'works' ? 'search is ' + scope.tools.search : 'fetch is ' + scope.tools.fetch
let angles = scope.angles.slice(0, ANGLES).map((a, i) => ({ id: 'A' + (i + 1), label: clean(a.label, 60), query: clean(a.query, 400), kind: a.kind, why: clean(a.why, 300) }))
if (!webOk) {
  const dropped = angles.filter((a) => a.kind === 'web').length
  angles = angles.filter((a) => a.kind === 'local')
  if (dropped) log('Web ' + webState + ': ' + dropped + ' web angle(s) dropped. ' + clean(scope.tools.note, 300))
  if (!angles.length && !GIVEN.length) {
    return { schemaVersion: 1, status: 'blocked', question: QUESTION, answer: null,
      remediation: 'Child agents cannot use the web (' + webState + '). Allow web search and fetch for the provider (Claude: approve WebSearch and WebFetch; Codex: enable web_search), or pass local paths as args.sources, then rerun.',
      tools: scope.tools }
  }
}

const sources = []
const seenUrls = new Map()
let slots = MAX_SOURCES
let nextSource = 1
function admit(found, round) {
  // Fixed order: angle order, then relevance, then URL. Each angle gets a fair share of the slots first.
  const share = Math.max(1, Math.ceil(slots / Math.max(1, found.length)))
  const queue = found.map(({ angle, list }) => ({ angle, list: stableSort(list, (s) => [rank[s.relevance] ?? 3, urlKey(s.url)]) }))
  const admitted = []
  for (const pass of [share, Infinity]) {
    for (const entry of queue) {
      let taken = admitted.filter((s) => s.firstAngle === entry.angle.id).length
      while (entry.list.length && taken < pass && slots > 0) {
        const s = entry.list.shift()
        const key = urlKey(s.url)
        if (!key) continue
        if (seenUrls.has(key)) { seenUrls.get(key).angles.add(entry.angle.label); continue }
        const source = { id: 'S' + nextSource++, url: clean(s.url, 500), title: clean(s.title, 200), firstAngle: entry.angle.id, angles: new Set([entry.angle.label]), round }
        seenUrls.set(key, source)
        admitted.push(source)
        taken++
        slots--
      }
    }
  }
  const leftover = queue.reduce((n, e) => n + e.list.filter((s) => !seenUrls.has(urlKey(s.url))).length, 0)
  if (leftover) log(leftover + ' further source(s) not read: the ' + MAX_SOURCES + '-source cap is reached')
  return admitted
}

async function readAll(batch) {
  const reads = await parallel(batch.map((s) => () => agent([
    'Read one source and extract what it says about a research question. Open it with your fetch or browse tool, or read the file. Grade its quality. Extract two to five concrete, checkable claims that bear on the question, each with the verbatim supporting passage. If it cannot be read or is irrelevant, return quality "unusable" and no claims.',
    data('Question', QUESTION),
    data('Source ' + s.id, { location: s.url, title: s.title, foundBy: [...s.angles].sort() }),
    NO_WRITES,
  ].join('\n\n'), { label: 'read:' + s.id + ':' + hostOf(s.url), phase: 'Read', schema: CLAIMS, timeoutMinutes: 30 })))
  reads.forEach((r, i) => {
    const s = batch[i]
    if (!r) { coverage.push({ key: 'read:' + s.id, status: 'failed' }); return }
    Object.assign(s, { quality: r.quality, date: clean(r.date, 40), claims: r.claims })
    sources.push(s)
  })
}

async function explore(list, round) {
  const searches = await parallel(list.map((a) => () => agent([
    a.kind === 'local'
      ? 'Find local sources for one angle of a research question: files, docs or repositories on this machine (search with your file and shell tools). Return the most relevant absolute paths for the ORIGINAL question.'
      : 'Search the web for one angle of a research question. Return the four to six most relevant results for the ORIGINAL question, skipping spam and content farms. Prefer primary sources.',
    data('Question', QUESTION),
    data('Angle ' + a.id, { label: a.label, query: a.query, why: a.why }),
    NO_WRITES,
  ].join('\n\n'), { label: 'search:' + a.id, phase: 'Search', schema: SOURCES, timeoutMinutes: 20 })))
  const found = []
  searches.forEach((r, i) => {
    coverage.push({ key: 'search:' + list[i].id, status: r ? 'ok' : 'failed', results: r ? r.sources.length : 0 })
    if (r) found.push({ angle: list[i], list: r.sources.slice() })
  })
  const given = round === 0 && GIVEN.length ? [{ angle: { id: 'A0', label: 'named by the user' }, list: GIVEN.map((url) => ({ url, title: url, relevance: 'high' })) }] : []
  await readAll(admit(given.concat(found), round))
}

phase('Search')
await explore(angles, 0)

let nextClaim = 1
const claims = []
const seenClaims = new Set()
async function verifyNew(round) {
  const pool = []
  for (const s of stableSort(sources, (x) => [x.id.length, x.id])) {
    for (const c of s.claims || []) {
      const key = claimKey(c.claim)
      if (!key || seenClaims.has(key)) continue
      seenClaims.add(key)
      pool.push({ claim: clean(c.claim, 600), quote: clean(c.quote, 1500), locator: clean(c.locator, 200), weight: c.weight, source: s.id, url: s.url, quality: s.quality, date: s.date })
    }
  }
  // Rank every new claim together, in a fixed order, before paying for the votes.
  const ranked = stableSort(pool, (c) => [rank[c.weight] ?? 3, rank[c.quality] ?? 5, c.url, c.claim])
  // Round 0 may use most of the cap; each gap round keeps an equal share, so gap sources get checked.
  const reserve = GAP_ROUNDS ? Math.floor(MAX_CLAIMS / (GAP_ROUNDS + 2)) : 0
  const room = Math.max(0, (round === 0 ? MAX_CLAIMS - reserve * GAP_ROUNDS : MAX_CLAIMS - reserve * (GAP_ROUNDS - round)) - claims.length)
  if (ranked.length > room) log((ranked.length - room) + ' lower-ranked claim(s) not verified (round ' + round + ' budget; cap ' + MAX_CLAIMS + ')')
  const batch = ranked.slice(0, room).map((c) => ({ id: 'C' + nextClaim++, ...c }))
  await parallel(batch.map((c) => () => parallel(Array.from({ length: VOTES }, (_, v) => () => agent([
    'You are skeptic ' + (v + 1) + ' of ' + VOTES + '. Try to show that this claim does not hold: check that the quoted passage really supports it, look for contradicting or more recent evidence, and judge whether the source is strong enough for a claim this strong.',
    'verdict=refuted when the evidence you examined contradicts it or does not support it (overreach, outdated, marketing). verdict=holds when it is supported, current and the source fits its strength. verdict=cannot_check only when you could not examine it at all; say what blocked you.',
    data('Question', QUESTION),
    data('Claim ' + c.id, { claim: c.claim, quote: c.quote, locator: c.locator, source: c.url, quality: c.quality, date: c.date }),
    NO_WRITES,
  ].join('\n\n'), { label: 'verify:' + c.id + ':' + (v + 1), phase: 'Verify', schema: VERDICT, agentType: 'verification', timeoutMinutes: 30 })))
    .then((verdicts) => Object.assign(c, tally(verdicts, VOTES, 'holds', 'refuted'), { evidence: verdicts.filter(Boolean).map((x) => clean(x.evidence, 300)) }))))
  claims.push(...batch)
}

phase('Verify')
await verifyNew(0)
const count = (status) => claims.filter((c) => c.status === status).length
log('Verified: ' + count('confirmed') + ' confirmed, ' + count('refuted') + ' refuted, ' + count('unverified') + ' unverified')

phase('Gaps')
for (let r = 1; r <= GAP_ROUNDS; r++) {
  const gaps = await safe([
    'You are the completeness critic of a research run. Decide which parts of the question are still unanswered or rest on a single weak source, and return new angles that would close those gaps (kind web or local), or an empty list if the answer is complete.',
    data('Question', QUESTION),
    data('Angles searched', angles.map((a) => a.label)),
    data('Confirmed claims', claims.filter((c) => c.status === 'confirmed').map((c) => ({ id: c.id, claim: c.claim, source: c.url }))),
    data('Unverified or refuted claims', claims.filter((c) => c.status !== 'confirmed').map((c) => ({ id: c.id, claim: c.claim, status: c.status }))),
  ].join('\n\n'), { label: 'gaps:' + r, phase: 'Gaps', schema: GAPS })
  if (!gaps) { coverage.push({ key: 'gaps:' + r, status: 'failed' }); break }
  const more = gaps.angles.filter((a) => webOk || a.kind === 'local').slice(0, 4)
    .map((a, i) => ({ id: 'G' + r + '.' + (i + 1), label: clean(a.label, 60), query: clean(a.query, 400), kind: a.kind, why: clean(a.why, 300) }))
  if (!more.length) { log('Gap round ' + r + ': nothing missing'); break }
  slots = Math.max(slots, Math.ceil(MAX_SOURCES / 3))
  const before = sources.length
  const verifiedBefore = claims.length
  angles = angles.concat(more)
  await explore(more, r)
  await verifyNew(r)
  log('Gap round ' + r + ': ' + more.length + ' angle(s), ' + (sources.length - before) + ' source(s), ' + (claims.length - verifiedBefore) + ' claim(s) verified')
  if (sources.length === before) break
}

phase('Synthesize')
const brief = (c) => ({ id: c.id, claim: c.claim, source: c.url, quality: c.quality, votes: c.votes, ...(c.why ? { why: c.why } : {}) })
const confirmed = claims.filter((c) => c.status === 'confirmed')
const partial = coverage.some((c) => c.status === 'failed') || claims.some((c) => c.why === 'missing votes')
const tail = {
  confirmed: confirmed.map(brief), unverified: claims.filter((c) => c.status === 'unverified').map(brief), refuted: claims.filter((c) => c.status === 'refuted').map(brief),
  sources: sources.map((s) => ({ id: s.id, url: s.url, title: s.title, quality: s.quality, foundBy: [...s.angles].sort() })),
  coverage, tools: scope.tools,
  stats: { size: SIZE, angles: angles.length, sources: sources.length, claimsVerified: claims.length, confirmed: confirmed.length, refuted: count('refuted'), unverified: count('unverified') },
}
if (!confirmed.length) {
  // "Nothing survived" is a finding only when claims were actually refuted on the merits and
  // nothing failed along the way; otherwise the run could not answer.
  const refutedOnly = claims.length > 0 && count('refuted') === claims.length && !partial
  return { schemaVersion: 1, status: refutedOnly ? 'complete' : 'inconclusive', question: QUESTION,
    answer: refutedOnly
      ? 'Every checked claim was refuted; the question stays open.'
      : claims.length === 0
        ? 'No claim was extracted (' + (sources.length ? 'the sources yielded none' : 'no source could be searched or read') + '). This is a tooling or coverage problem, not a finding; see coverage and tools, then retry.'
        : 'No claim could be confirmed, and some could not be checked (verifiers failed or were blocked). This is not a finding; see coverage and tools, then retry.',
    ...tail }
}
const report = await safe([
  'Answer the question from the confirmed claims below; every one of them survived independent checks. Combine claims that overlap into one finding, organize the findings around the question, and rate how much each can be trusted: high when strong sources agree and the votes were clear, medium when the support is indirect or the votes were divided, low when it rests on a single source. Cite the claim ids behind each finding, and put what is uncertain or may change soon into caveats.',
  data('Question', QUESTION),
  data('Confirmed claims', confirmed.map(brief)),
  data('Refuted claims (context only; do not assert them)', claims.filter((c) => c.status === 'refuted').map((c) => c.claim)),
].join('\n\n'), { label: 'synthesize', phase: 'Synthesize', schema: REPORT })
return {
  schemaVersion: 1,
  status: report ? (partial ? 'partial' : 'complete') : 'partial',
  question: QUESTION,
  ...(report || { answer: 'The synthesis failed; the verified claims are listed unmerged.', findings: [], caveats: ['synthesis agent failed'] }),
  ...tail,
}
