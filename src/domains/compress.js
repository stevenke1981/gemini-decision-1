// Kind `compress` (docs/design.md §4.5): is compacting the context window now worth it, and for
// each old segment keep, summarize or drop it. Gemini answers the predicate `compact_now` and one
// choice per asked segment; the rules escalate toward targetRatio (gate) and decide alone in
// `heuristic` mode. Everything here is pure: finalize applies the actions to the segments it was
// given, and nothing mutates its input. The action helpers and summaries live in compress-apply.js.
import { verdict, certainty, mean, requireText, indexId, redact } from '../contract.js';
import { estimateTokens, excerpt } from '../text.js';
import { choiceAnswer, predicateProbability } from '../gemini/answers.js';
import {
  KEEP, SUMMARIZE, DROP, ACTIONS, isPosInt, totalTokens, actionOf, sizeAfter, summariesFor, applyCompression,
} from './compress-apply.js';

export { applyCompression, extractiveSummary } from './compress-apply.js';

/** Tool output older than this many turns is dropped by the rules. */
export const TOOL_DROP_AGE = 6;
/** Tool output above this many tokens is summarized by the rules. */
export const TOOL_SUMMARIZE_TOKENS = 500;
/** Assistant text above this many tokens is summarized by the rules. */
export const ASSISTANT_SUMMARIZE_TOKENS = 800;
/** Gemini's compact_now probability at or above which compaction is chosen. */
export const COMPACT_PROBABILITY = 0.5;

const ROLES = ['system', 'user', 'assistant', 'tool'];
const GOAL_CHARS = 1000;
const DECIMALS = 2;
const UNDER_SOFT = 'under the soft limit';
const NOTHING_ELIGIBLE = 'nothing eligible';
const ESCALATED = 'rules escalated to reach the target ratio';
const USER_GUARDED = 'rules protected user instructions: no user segment dropped, the first user segment kept';

const COMPACT_QUESTION = Object.freeze({
  type: 'predicate',
  name: 'compact_now',
  instructions: 'Is compacting the context now better than waiting: are old, bulky, finished segments dominating the window rather than the live working set?',
});

const ACTION_CHOICES = Object.freeze([
  { value: KEEP, description: 'still needed verbatim: the current goal, unresolved errors, code being edited, user instructions and constraints' },
  { value: SUMMARIZE, description: 'useful but verbose: long tool output whose conclusion matters, finished explorations, logs with a few key lines' },
  { value: DROP, description: 'no longer needed: superseded file reads, resolved failures, chit-chat, duplicated output' },
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const fmt = (x) => x.toFixed(DECIMALS);

// ---- normalize -----------------------------------------------------------------------------

/**
 * Validates the input and returns a new, normalized copy. Tokens default to estimateTokens(text).
 * @param {object} input `{ window, segments, goal?, force? }`
 * @returns {{window:number, segments:object[], goal:string, force:boolean}}
 * @throws {TypeError} on any bad field
 */
export function normalize(input) {
  if (!isPlainObject(input)) throw new TypeError('compress: input must be an object');
  if (!isPosInt(input.window)) throw new TypeError('compress: window must be a positive integer');
  if (!Array.isArray(input.segments)) throw new TypeError('compress: segments must be an array');
  if (input.goal !== undefined && typeof input.goal !== 'string') throw new TypeError('compress: goal must be a string');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new TypeError('compress: force must be a boolean');
  return {
    window: input.window,
    segments: normalizeSegments(input.segments),
    goal: (input.goal ?? '').trim(),
    force: input.force === true,
  };
}

function normalizeSegments(list) {
  const ids = new Set();
  return list.map((raw, i) => {
    const seg = normalizeSegment(raw, i);
    if (ids.has(seg.id)) throw new TypeError(`compress: duplicate segment id "${seg.id}"`);
    ids.add(seg.id);
    return seg;
  });
}

function normalizeSegment(raw, index) {
  if (!isPlainObject(raw)) throw new TypeError(`compress: segment ${index} must be an object`);
  const id = requireText(raw.id, 'compress: segment id');
  const label = `compress: segment "${id}"`;
  if (!ROLES.includes(raw.role)) throw new TypeError(`${label} role must be one of ${ROLES.join('|')}`);
  if (typeof raw.text !== 'string') throw new TypeError(`${label} text must be a string`);
  if (!isNonNegInt(raw.turn)) throw new TypeError(`${label} turn must be an integer >= 0`);
  if (raw.tokens !== undefined && !isNonNegInt(raw.tokens)) throw new TypeError(`${label} tokens must be an integer >= 0`);
  if (raw.pinned !== undefined && typeof raw.pinned !== 'boolean') throw new TypeError(`${label} pinned must be a boolean`);
  return {
    id,
    role: raw.role,
    text: raw.text,
    turn: raw.turn,
    tokens: raw.tokens ?? estimateTokens(raw.text),
    pinned: raw.pinned === true,
  };
}

// ---- shared helpers ------------------------------------------------------------------------

function currentTurn(segments) {
  return segments.reduce((max, s) => Math.max(max, s.turn), 0);
}

/** Segments compaction may touch: not pinned, not system, and older than the recent turns. */
function eligibleSegments(segments, keepRecentTurns) {
  const newest = currentTurn(segments) - keepRecentTurns;
  return segments.filter((s) => !s.pinned && s.role !== 'system' && s.turn <= newest);
}

/** The largest eligible segments, at most `maxAsked`; ties keep input order. */
function askedSegments(eligible, maxAsked) {
  return [...eligible].sort((a, b) => b.tokens - a.tokens).slice(0, maxAsked);
}

function oldestFirst(segments) {
  return [...segments].sort((a, b) => a.turn - b.turn);
}

/**
 * The id of the first user segment of the transcript (lowest turn, ties by input order), or null
 * when there is none. It usually holds the task statement, so the rules never change it from keep.
 */
function protectedId(segments) {
  const first = segments.reduce((best, s) => (s.role === 'user' && (!best || s.turn < best.turn) ? s : best), null);
  return first ? first.id : null;
}

function ratioOf(input) {
  return totalTokens(input.segments) / input.window;
}

function isUnderSoft(input, cfg) {
  return !input.force && ratioOf(input) < cfg.compress.softRatio;
}

// ---- rules: escalation and heuristic -------------------------------------------------------

/** The rule action for one eligible segment, given its age in turns. */
function ruleAction(seg, age) {
  if (seg.role === 'tool' && age > TOOL_DROP_AGE) return DROP;
  if (seg.role === 'tool' && seg.tokens > TOOL_SUMMARIZE_TOKENS) return SUMMARIZE;
  if (seg.role === 'assistant' && seg.tokens > ASSISTANT_SUMMARIZE_TOKENS) return SUMMARIZE;
  return KEEP;
}

/**
 * The escalation passes, in order: each turns `from` into `to` for the eligible segments of `role`,
 * oldest first. User segments come last, so user instructions are cut only as a last resort.
 */
const ESCALATION_PASSES = Object.freeze([
  Object.freeze({ role: 'tool', from: KEEP, to: SUMMARIZE }),
  Object.freeze({ role: 'assistant', from: KEEP, to: SUMMARIZE }),
  Object.freeze({ role: 'tool', from: SUMMARIZE, to: DROP }),
  Object.freeze({ role: 'user', from: KEEP, to: SUMMARIZE }),
]);

/**
 * Escalates `actions` until the projected usage is at or below targetRatio × window, or nothing
 * else helps. The passes (ESCALATION_PASSES) run in order, each oldest eligible first and only while
 * still above the target: tool keep to summarize, assistant keep to summarize, tool summarize to
 * drop, and last user keep to summarize. The first user segment (protectedId) is never touched.
 * @returns {{actions:Record<string,string>, changed:boolean}}
 */
export function escalate(actions, input, cfg) {
  const limit = cfg.compress.targetRatio * input.window;
  const summaries = summariesFor(input.segments, cfg.compress.summaryChars);
  const decided = new Map(Object.entries(actions));
  const actionFor = (seg) => decided.get(seg.id) ?? KEEP;
  const guarded = protectedId(input.segments);
  const eligible = oldestFirst(eligibleSegments(input.segments, cfg.compress.keepRecentTurns))
    .filter((s) => s.id !== guarded);
  let total = input.segments.reduce((sum, s) => sum + sizeAfter(s, actionFor(s), summaries), 0);
  let changed = false;
  const move = (seg, to) => {
    const delta = sizeAfter(seg, to, summaries) - sizeAfter(seg, actionFor(seg), summaries);
    if (delta >= 0) return;
    decided.set(seg.id, to);
    total += delta;
    changed = true;
  };
  for (const pass of ESCALATION_PASSES) {
    for (const seg of eligible) {
      if (total > limit && seg.role === pass.role && actionFor(seg) === pass.from) move(seg, pass.to);
    }
  }
  return { actions: Object.fromEntries(decided), changed };
}

/**
 * Gemini's actions with the user-instruction limits applied: a drop on a user segment becomes
 * summarize, and any non-keep on the protected first user segment becomes keep.
 * @returns {{actions:Record<string,string>, changed:boolean}}
 */
function guardUserSegments(actions, input) {
  const guarded = protectedId(input.segments);
  const users = new Set(input.segments.filter((s) => s.role === 'user').map((s) => s.id));
  let changed = false;
  const limited = Object.entries(actions).map(([id, action]) => {
    const allowed = id === guarded ? KEEP : users.has(id) && action === DROP ? SUMMARIZE : action;
    if (allowed !== action) changed = true;
    return [id, allowed];
  });
  return { actions: Object.fromEntries(limited), changed };
}

// ---- result shape --------------------------------------------------------------------------

/**
 * The result every path returns (Gemini, rules, settled): every segment gets an action when
 * compacting (keep by default); a summarize that would not shrink is reported as keep.
 */
function resultFrom(input, cfg, compact, decisions) {
  const tokensBefore = totalTokens(input.segments);
  if (!compact) return shapeResult(input, cfg, false, {}, tokensBefore, tokensBefore);
  const summaries = summariesFor(input.segments, cfg.compress.summaryChars);
  const realized = new Map(input.segments.map((s) => {
    const action = actionOf(decisions, s.id);
    return [s.id, action === SUMMARIZE && !summaries.get(s.id) ? KEEP : action];
  }));
  const tokensAfter = input.segments.reduce((sum, s) => sum + sizeAfter(s, realized.get(s.id), summaries), 0);
  return shapeResult(input, cfg, true, Object.fromEntries(realized), tokensBefore, tokensAfter);
}

function shapeResult(input, cfg, compact, actions, tokensBefore, tokensAfter) {
  return { compact, actions, segments: null, tokensBefore, ...usageAfter(input, cfg, tokensAfter) };
}

/** tokensAfter, ratioAfter and targetMet (ratioAfter at or below targetRatio) for a token count. */
function usageAfter(input, cfg, tokensAfter) {
  const ratioAfter = tokensAfter / input.window;
  return { tokensAfter, ratioAfter, targetMet: ratioAfter <= cfg.compress.targetRatio };
}

// ---- plan, interpret -----------------------------------------------------------------------

function stateSegment(seg, id, current, excerptChars) {
  return {
    id,
    role: seg.role,
    age: current - seg.turn,
    tokens: seg.tokens,
    text: excerpt(redact(seg.text), excerptChars, true),
  };
}

function actionQuestion(name) {
  return {
    type: 'choice',
    name,
    instructions: `Context segment ${name}: keep it verbatim, summarize it, or drop it?`,
    choices: ACTION_CHOICES,
  };
}

/**
 * Decides what Gemini must answer. Settled when the context is under the soft limit (unless forced)
 * or no segment is eligible; otherwise the state and questions for Gemini.
 * @returns {{settled:object} | {state:object, questions:object[], ctx:object}}
 */
export function plan(input, cfg) {
  const k = cfg.compress;
  if (isUnderSoft(input, cfg)) return settledVerdict(input, cfg, UNDER_SOFT);
  const eligible = eligibleSegments(input.segments, k.keepRecentTurns);
  if (eligible.length === 0) return settledVerdict(input, cfg, NOTHING_ELIGIBLE);
  const ratio = ratioOf(input);
  const compactAsked = !input.force && ratio < k.hardRatio;
  const asked = askedSegments(eligible, k.maxSegmentsAsked).map((seg, i) => ({ name: indexId('g', i), id: seg.id, seg }));
  const questions = [...(compactAsked ? [COMPACT_QUESTION] : []), ...asked.map((a) => actionQuestion(a.name))];
  if (questions.length === 0) throw new Error('compress: nothing to ask Gemini (maxSegmentsAsked is 0 and the context is above the hard limit)');
  const current = currentTurn(input.segments);
  const state = {
    goal: excerpt(redact(input.goal), GOAL_CHARS),
    usage: { tokens: totalTokens(input.segments), window: input.window },
    segments: asked.map((a) => stateSegment(a.seg, a.name, current, k.excerptChars)),
  };
  const ctx = { input, ratio, compactAsked, asked: asked.map(({ name, id }) => ({ name, id })) };
  return { state, questions, ctx };
}

function settledVerdict(input, cfg, reason) {
  return { settled: verdict(resultFrom(input, cfg, false, {}), null, [reason]) };
}

/**
 * Gemini's answers to a plan. Compacts when forced, at or above the hard limit, or when compact_now
 * reaches COMPACT_PROBABILITY; actions come from the segment choices and are empty otherwise.
 * Throws (via answers.js) on a refused or malformed answer.
 */
export function interpret(answers, ctx, cfg) {
  const { input, asked, compactAsked, ratio } = ctx;
  const { hardRatio } = cfg.compress;
  const pCompact = compactAsked ? predicateProbability(answers, 'compact_now') : null;
  const picks = asked.map(({ name, id }) => ({ id, ...choiceAnswer(answers, name, ACTIONS) }));
  const compact = input.force || ratio >= hardRatio || (pCompact !== null && pCompact >= COMPACT_PROBABILITY);
  const decisions = Object.fromEntries(picks.map((p) => [p.id, p.choice]));
  const confidence = pCompact !== null ? certainty(pCompact) : mean(picks.map((p) => p.confidence).filter((confidence) => confidence !== null));
  return verdict(resultFrom(input, cfg, compact, decisions), confidence, compactReasons(input, ratio, hardRatio, pCompact));
}

function compactReasons(input, ratio, hardRatio, pCompact) {
  const reasons = [];
  if (input.force) reasons.push('forced');
  else if (ratio >= hardRatio) reasons.push(`ratio ${fmt(ratio)} at or above the hard limit`);
  if (pCompact !== null) reasons.push(`compact_now ${fmt(pCompact)}`);
  return reasons;
}

// ---- heuristic, gate, finalize, summarize --------------------------------------------------

/**
 * Rules only. Compacts when forced or at or above the soft limit and something is eligible; the
 * rule actions are escalated toward targetRatio. User segments are summarized only as a last
 * resort, never dropped, and the first user segment is always kept.
 */
export function heuristic(input, cfg) {
  if (isUnderSoft(input, cfg)) return verdict(resultFrom(input, cfg, false, {}), null, [UNDER_SOFT]);
  const eligible = eligibleSegments(input.segments, cfg.compress.keepRecentTurns);
  if (eligible.length === 0) return verdict(resultFrom(input, cfg, false, {}), null, [NOTHING_ELIGIBLE]);
  const current = currentTurn(input.segments);
  const ruled = Object.fromEntries(eligible.map((s) => [s.id, ruleAction(s, current - s.turn)]));
  const { actions, changed } = escalate(ruled, input, cfg);
  const reasons = [input.force ? 'forced' : `ratio ${fmt(ratioOf(input))} at or above the soft limit`];
  if (changed) reasons.push(ESCALATED);
  return verdict(resultFrom(input, cfg, true, actions), null, reasons);
}

/**
 * Runs after Gemini: when Gemini compacts, first limits its actions on user segments (no user
 * segment is dropped, the first user segment is kept), then escalates toward targetRatio. The
 * verdict is source 'gemini+rules' only when either step changed an action; otherwise Gemini's
 * verdict is returned as it is. The rules argument is not needed: both steps are rules on their own.
 */
export function gate(gemini, rules, input, cfg) {
  if (!gemini.result.compact) return gemini;
  const guarded = guardUserSegments(gemini.result.actions, input);
  const escalated = escalate(guarded.actions, input, cfg);
  if (!guarded.changed && !escalated.changed) return gemini;
  const reasons = [...gemini.reasons, ...(guarded.changed ? [USER_GUARDED] : []), ...(escalated.changed ? [ESCALATED] : [])];
  return verdict(resultFrom(input, cfg, true, escalated.actions), gemini.confidence, reasons, 'gemini+rules');
}

/** Applies the actions when compacting and sets segments, tokensBefore, tokensAfter, ratioAfter, targetMet. */
export function finalize(v, input, cfg) {
  const { result } = v;
  const tokensBefore = totalTokens(input.segments);
  const applied = result.compact ? applyCompression(input.segments, result.actions, cfg.compress) : null;
  const tokensAfter = applied ? applied.tokensAfter : tokensBefore;
  return {
    ...v,
    result: {
      ...result,
      segments: applied ? applied.segments : null,
      tokensBefore,
      ...usageAfter(input, cfg, tokensAfter),
    },
  };
}

function countActions(actions) {
  return Object.values(actions).reduce((acc, a) => ({ ...acc, [a]: acc[a] + 1 }), { keep: 0, summarize: 0, drop: 0 });
}

/** One ledger line: counts and tokens only, never segment text. */
export function summarize(result) {
  if (!result.compact) return `no compaction: ${result.tokensBefore} tokens`;
  const n = countActions(result.actions);
  const after = result.tokensAfter ?? result.tokensBefore;
  return `compact: drop ${n.drop}, summarize ${n.summarize}, keep ${n.keep}; ${result.tokensBefore} → ${after} tokens`;
}

/** The kind module (frozen). */
export const compress = Object.freeze({
  name: 'compress',
  normalize,
  plan,
  interpret,
  heuristic,
  gate,
  finalize,
  summarize,
});
