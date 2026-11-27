// The `retrieve` decision (docs/design.md §4.3): does this query need repository or memory
// context, and which candidate chunks are relevant. Gemini answers one predicate for the need and
// one relevance predicate per candidate; the rules rank the candidates by their BM25 score.
// Candidates come from the caller or from the repository index (prepare). The text sent to Gemini
// is cut to excerptChars, and each span that looks like a secret is replaced by [redacted].
import path from 'node:path';
import { GREETING, redact, certainty, indexId, mean, requireText, verdict } from '../contract.js';
import { predicateProbability } from '../gemini/answers.js';
import { isWithin, realWithinAny } from '../paths.js';
import { estimateTokens, excerpt, tokenize } from '../text.js';

/** Lexical rule: a chunk is kept when its score is at least this share of the best score. */
export const LEXICAL_RATIO = 0.3;
/** The rules never return more than this many chunks. */
export const MAX_RULE_CHUNKS = 6;

const NEED_THRESHOLD = 0.5;
const MIN_QUERY_TERMS = 2;
const QUERY_CHARS = 2000;
const NEED_QUESTION = {
  type: 'predicate',
  name: 'need_retrieval',
  instructions: 'Does the agent need repository or memory context beyond the query itself to answer or act on it?',
};

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/** The candidate's line range as { startLine, endLine }: both positive integers, or both null. */
function lineRange(c, where) {
  const { startLine: s, endLine: e } = c;
  if (s == null && e == null) return { startLine: null, endLine: null };
  if (!Number.isInteger(s) || s < 1 || !Number.isInteger(e) || e < s) {
    throw new TypeError(`${where} needs startLine <= endLine as positive integers, or neither`);
  }
  return { startLine: s, endLine: e };
}

function normalizeCandidate(c, i) {
  const where = `retrieve: candidates[${i}]`;
  if (!isPlainObject(c)) throw new TypeError(`${where} must be an object`);
  if (!nonEmpty(c.id) || !nonEmpty(c.source)) throw new TypeError(`${where} needs a non-empty id and source`);
  if (typeof c.text !== 'string') throw new TypeError(`${where}.text must be a string`);
  if (c.score != null && !(Number.isFinite(c.score) && c.score >= 0)) throw new TypeError(`${where}.score must be a number >= 0`);
  return {
    id: c.id,
    source: c.source,
    text: c.text,
    ...lineRange(c, where),
    ...(c.score != null ? { score: c.score } : {}),
  };
}

function normalizeCandidates(list) {
  if (!Array.isArray(list)) throw new TypeError('retrieve: candidates must be an array');
  const out = list.map((c, i) => normalizeCandidate(c, i));
  if (new Set(out.map((c) => c.id)).size !== out.length) throw new TypeError('retrieve: candidate ids must be unique');
  return out;
}

function positiveIntOr(v, fallback, field) {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1) throw new TypeError(`${field} must be a positive integer`);
  return v;
}

/**
 * The root as an absolute path. It must lie in one of retrieve.allowedRoots, or, when that list
 * is empty, in the working folder of the process. Chunk text from it may be sent to Gemini.
 */
function allowedBases(cfg) {
  const listed = cfg.retrieve.allowedRoots;
  return listed.length > 0 ? listed : [cfg.cwd ?? process.cwd()];
}

function allowedRootOf(root, cfg) {
  const abs = path.resolve(root);
  const listed = cfg.retrieve.allowedRoots;
  const bases = allowedBases(cfg);
  if (bases.some((base) => isWithin(path.resolve(base), abs))) return abs;
  const scope = listed.length > 0 ? 'retrieve.allowedRoots' : 'the working folder (retrieve.allowedRoots is empty)';
  throw new TypeError(`retrieve: root ${abs} is outside ${scope}`);
}

/** Validates a retrieve input and returns a new object with defaults applied; root is absolute. */
function normalize(input, cfg) {
  if (!isPlainObject(input)) throw new TypeError('retrieve: input must be an object');
  const query = requireText(input.query, 'retrieve: query');
  if (input.root != null && (typeof input.root !== 'string' || !input.root.trim())) {
    throw new TypeError('retrieve: root must be a non-empty string');
  }
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new TypeError('retrieve: force must be a boolean');
  return {
    query,
    root: input.root == null ? undefined : allowedRootOf(input.root, cfg),
    candidates: input.candidates == null ? undefined : normalizeCandidates(input.candidates),
    budgetTokens: positiveIntOr(input.budgetTokens, cfg.retrieve.budgetTokens, 'retrieve: budgetTokens'),
    force: input.force ?? false,
  };
}

/** At most `n` candidates, ranked by score when every candidate has one (input order otherwise). */
function shortlistOf(candidates, n) {
  if (candidates.length <= n) return candidates;
  const scored = candidates.every((c) => Number.isFinite(c.score));
  return (scored ? [...candidates].sort((a, b) => b.score - a.score) : candidates).slice(0, n);
}

/** A root that is a link (symlink, junction) must still resolve inside the allowed folders. */
function assertRealRootAllowed(root, cfg) {
  const { ok, real } = realWithinAny(allowedBases(cfg), root);
  if (!ok) throw new TypeError(`retrieve: root ${root} resolves to ${real}, outside the allowed folders`);
}

/** What the index says about its own completeness; missing values count as complete. */
function completenessOf(index) {
  const skipped = Number.isInteger(index.skipped) && index.skipped > 0 ? index.skipped : 0;
  return { truncated: index.truncated === true, skipped };
}

const COMPLETE = Object.freeze({ truncated: false, skipped: 0 });

/** The candidates from the repository index, with its completeness, when none were given and a root is. */
async function searchRepo(input, cfg, deps) {
  if (typeof deps?.repoIndex !== 'function') throw new Error('retrieve: root given but no repoIndex dependency');
  assertRealRootAllowed(input.root, cfg);
  const index = await deps.repoIndex(input.root);
  return { candidates: index.search(input.query, cfg.retrieve.shortlist), ...completenessOf(index) };
}

/**
 * Fills `candidates` from the repository index when absent and a root is given, and records
 * whether that index was truncated and how many entries it skipped (false and 0 otherwise).
 */
async function prepare(input, cfg, deps) {
  if (input.candidates !== undefined) return { ...input, ...COMPLETE };
  if (input.root === undefined) return { ...input, candidates: [], ...COMPLETE };
  return { ...input, ...(await searchRepo(input, cfg, deps)) };
}

/** The text as Gemini may see it: each secret-looking span replaced, then cut to `max`. */
function safeText(text, max) {
  return excerpt(redact(text), max);
}

const locate = (c) => (c.startLine == null ? c.source : `${c.source}:${c.startLine}-${c.endLine}`);

const chunkName = (i) => indexId('c', i);

function chunkQuestion(i) {
  const name = chunkName(i);
  return { type: 'predicate', name, instructions: `Is chunk ${name} relevant to the query?` };
}

function stateChunk(c, i, cfg) {
  return { id: chunkName(i), source: locate(c), text: safeText(c.text, cfg.retrieve.excerptChars) };
}

/** The completeness fields of a result, from an input or ctx that may predate them. */
const completeOf = (x) => ({ truncated: x?.truncated === true, skipped: x?.skipped ?? 0 });

const TRUNCATED_REASON = 'index was truncated; results may be incomplete';

/** The reasons of a verdict, plus the truncation warning when the index was cut short. */
const withTruncation = (reasons, x) => (x?.truncated === true ? [...reasons, TRUNCATED_REASON] : reasons);

function emptyResult(x) {
  return { needed: false, chunks: [], tokens: 0, considered: 0, ...completeOf(x) };
}

/**
 * Builds the questions and state; the rules settle the call when there is nothing to choose
 * from. The need predicate is left out when the caller forces retrieval.
 */
function plan(input, cfg) {
  // Each candidate costs one predicate: Gemini sees at most `shortlist` of them, best score first.
  const candidates = shortlistOf(input.candidates ?? [], cfg.retrieve.shortlist);
  if (candidates.length === 0) return { settled: verdict(emptyResult(input), null, withTruncation(['no candidates'], input)) };
  const need = input.force ? [] : [NEED_QUESTION];
  return {
    state: { query: safeText(input.query, QUERY_CHARS), chunks: candidates.map((c, i) => stateChunk(c, i, cfg)) },
    questions: [...need, ...candidates.map((_, i) => chunkQuestion(i))],
    ctx: { candidates, force: input.force, budgetTokens: input.budgetTokens, ...completeOf(input) },
  };
}

/**
 * Takes items in order while their chunk text fits the token budget; an item that does not fit
 * is skipped and the next one tried.
 */
function fillBudget(items, budgetTokens, limit = Infinity) {
  const picked = [];
  let used = 0;
  for (const item of items) {
    if (picked.length >= limit) break;
    const cost = estimateTokens(item.candidate.text);
    if (used + cost > budgetTokens) continue;
    picked.push(item);
    used += cost;
  }
  return picked;
}

/** The chunks Gemini rates at or above the threshold, most probable first (ties keep input order). */
function pickByGemini(candidates, probs, threshold, budgetTokens) {
  const ranked = candidates
    .map((candidate, i) => ({ candidate, probability: probs[i] }))
    .filter((x) => x.probability >= threshold)
    .sort((a, b) => b.probability - a.probability);
  return fillBudget(ranked, budgetTokens);
}

/**
 * The chunks the rules keep: by score, at least LEXICAL_RATIO of the best score (every chunk
 * when none has a score, so input order decides), within the budget and at most MAX_RULE_CHUNKS.
 */
function pickByRules(candidates, budgetTokens) {
  const ranked = candidates
    .map((candidate) => ({ candidate, probability: null, score: candidate.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ?? 0;
  const eligible = ranked.filter((x) => x.score >= LEXICAL_RATIO * top);
  return fillBudget(eligible, budgetTokens, MAX_RULE_CHUNKS);
}

/** The shared result shape of interpret and heuristic. */
function resultOf(needed, picks, considered, complete) {
  return {
    needed,
    chunks: picks.map(({ candidate: c, probability }) => ({
      id: c.id,
      source: c.source,
      startLine: c.startLine ?? null,
      endLine: c.endLine ?? null,
      text: c.text,
      probability: probability ?? null,
    })),
    tokens: picks.reduce((sum, { candidate }) => sum + estimateTokens(candidate.text), 0),
    considered,
    ...completeOf(complete),
  };
}

/**
 * Gemini's answers to a verdict. Every relevance predicate is read, so a malformed answer throws
 * even when the chunks are not needed. With force, the need predicate is not asked and the
 * confidence is the mean certainty of the relevance answers.
 */
function interpret(answers, ctx, cfg) {
  const { candidates, budgetTokens } = ctx;
  const threshold = cfg.retrieve.threshold;
  const probs = candidates.map((_, i) => predicateProbability(answers, chunkName(i)));
  if (ctx.force) {
    const picks = pickByGemini(candidates, probs, threshold, budgetTokens);
    return verdict(resultOf(true, picks, candidates.length, ctx), mean(probs.map(certainty)), withTruncation(['forced: retrieval on'], ctx));
  }
  const pNeed = predicateProbability(answers, NEED_QUESTION.name);
  const needed = pNeed >= NEED_THRESHOLD;
  const picks = needed ? pickByGemini(candidates, probs, threshold, budgetTokens) : [];
  const reason = needed ? 'gemini: retrieval needed' : 'gemini: no retrieval needed';
  return verdict(resultOf(needed, picks, candidates.length, ctx), certainty(pNeed), withTruncation([reason], ctx));
}

/** Terms of a query, counted once each. */
const distinctTerms = (query) => new Set(tokenize(query)).size;

/** Rules-only answer: retrieval when forced, or for a non-greeting with at least two terms. */
function heuristic(input) {
  const candidates = input.candidates ?? [];
  const needed = input.force || (!GREETING.test(input.query) && distinctTerms(input.query) >= MIN_QUERY_TERMS);
  if (!needed) return verdict(resultOf(false, [], candidates.length, input), null, withTruncation(['rules: no retrieval needed'], input));
  const picks = pickByRules(candidates, input.budgetTokens);
  return verdict(resultOf(true, picks, candidates.length, input), null, withTruncation([`rules: ${picks.length} chunk(s) by score`], input));
}

/** One line for the ledger and the CLI; no text from the query or the chunks. */
function summarize(result) {
  const partial = result.truncated ? '; index truncated' : '';
  if (!result.needed) return `not needed; ${result.considered} considered${partial}`;
  return `${result.chunks.length} of ${result.considered} chunks, ${result.tokens} tokens${partial}`;
}

/** The `retrieve` kind module (see src/contract.js). */
export const retrieve = Object.freeze({
  name: 'retrieve',
  normalize,
  prepare,
  plan,
  interpret,
  heuristic,
  summarize,
});
