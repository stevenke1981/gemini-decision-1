// Google Decisions API transport. The domains use an internal question format; this adapter
// translates it to Google's named questions and back into the domains' answer format.
import { createHash } from 'node:crypto';
import { RUBRIC } from '../rubric.js';
import { DecisionError } from '../errors.js';
import { redact, redactDeep } from '../contract.js';

// Google published this input price for gemini-decision-1; other models are not estimated.
export const USD_PER_INPUT_TOKEN = 0.10 / 1e6;
const PAUSE_MS = { timeout: 30_000, auth: 600_000, rate: 60_000 };
const MAX_RETRY_AFTER_MS = 600_000;
const QUESTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// What replaces the literal API key when a server echoes it back in an error message.
export const KEY_MARK = '[key]';

const pausedUntil = new Map();

/** Ends every pause; for tests. */
export function resetGeminiState() {
  pausedUntil.clear();
}

/**
 * Text from a response body, safe to put in an error message: the literal API key is replaced
 * by KEY_MARK first, then every secret-looking span is redacted.
 * @param {unknown} text
 * @param {string} [apiKey]
 * @returns {string}
 */
export function scrubDetail(text, apiKey) {
  const str = String(text);
  const withoutKey = apiKey ? str.split(apiKey).join(KEY_MARK) : str;
  return redact(withoutKey);
}

function pauseKey(opts) {
  return `${opts.url} ${createHash('sha256').update(opts.apiKey ?? '').digest('hex').slice(0, 16)}`;
}

function pause(opts, ms, code) {
  const key = pauseKey(opts);
  const until = Date.now() + ms;
  if (until > (pausedUntil.get(key)?.until ?? 0)) pausedUntil.set(key, { until, code });
}

function retryAfterMs(res) {
  const value = res.headers.get('retry-after')?.trim();
  if (!value) return PAUSE_MS.rate;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(ms) ? PAUSE_MS.rate : Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

/**
 * Checks a question list before it costs a call: unique valid names, a choice with at least
 * two distinct values, a score with 2 to 10 levels.
 */
export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('no questions to ask Gemini');
  const names = new Set();
  for (const q of questions) {
    if (!QUESTION_NAME.test(q?.name ?? '')) throw new Error(`invalid question name "${q?.name}"`);
    if (names.has(q.name)) throw new Error(`duplicate question name "${q.name}"`);
    names.add(q.name);
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) throw new Error(`question "${q.name}" has no instructions`);
    if (q.type === 'choice') {
      const values = (q.choices ?? []).map((c) => c?.value);
      if (values.length < 2 || values.length > 255 || new Set(values).size !== values.length || values.some((v) => typeof v !== 'string' || !v.trim() || v !== v.trim() || v.length > 128 || Buffer.byteLength(v, 'utf8') > 512 || /[\x00-\x1f\x7f-\x9f\s]/u.test(v.replaceAll(' ', '')))) throw new Error(`choice "${q.name}" needs 2 to 255 distinct valid choice keys`);
    } else if (q.type === 'score') {
      const n = q.levels?.length ?? 0;
      if (n < 2 || n > 10) throw new Error(`score "${q.name}" needs 2 to 10 levels`);
    } else if (q.type !== 'predicate') {
      throw new Error(`question "${q.name}" has unknown type "${q.type}"`);
    }
  }
}

/** The shared rubric and JSON state are input; Google evaluates each named question independently. */
export function requestBody(model, state, questions) {
  return {
    model,
    input: `${RUBRIC}\n\nDecision input (JSON):\n${JSON.stringify(state)}`,
    questions: Object.fromEntries(questions.map((q) => [q.name, {
      type: q.type === 'predicate' ? 'noul' : q.type,
      instructions: q.instructions,
      ...(q.type === 'choice' ? { criteria: Object.fromEntries(q.choices.map((c) => [c.value, c.description ?? ''])) } : {}),
      ...(q.type === 'score' ? { criteria: q.levels.map((level) => `${level.label}: ${level.description ?? ''}`) } : {}),
    }])),
  };
}

/** Input tokens and an estimate at the published gemini-decision-1 price. */
export function callCost(usage, model = 'gemini-decision-1') {
  const input = Number.isFinite(usage?.total_input_tokens) && usage.total_input_tokens >= 0 ? usage.total_input_tokens : null;
  if (input == null) return { cost: null, tokens: null };
  return { cost: model === 'gemini-decision-1' ? input * USD_PER_INPUT_TOKEN : null, tokens: { input } };
}

function headersFor(opts) {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': opts.apiKey,
  };
}

async function send(opts, body, signal) {
  try {
    const res = await fetch(opts.url, {
      method: 'POST', headers: headersFor(opts), body: JSON.stringify(body), signal, redirect: 'error',
    });
    const data = await res.json().catch((err) => {
      if (signal.aborted) throw signal.reason;
      if (err instanceof SyntaxError) return null;
      throw err;
    });
    return { res, data };
  } catch (err) {
    if (signal.aborted) {
      pause(opts, PAUSE_MS.timeout, 'GEMINI_TIMEOUT');
      const timeout = new DecisionError('GEMINI_TIMEOUT', 'Gemini request timed out', { cause: err });
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw new DecisionError('GEMINI_TRANSPORT', 'Gemini transport failed', { cause: err });
  }
}

/**
 * POSTs one Decisions request; resolves to the parsed body or throws.
 * @param {GeminiOptions} opts
 */
export async function postDecision(opts, state, questions) {
  if (!opts.apiKey) throw new DecisionError('GEMINI_AUTH', 'no Google API key (set GEMINI_API_KEY or GOOGLE_API_KEY)');
  const cooldown = pausedUntil.get(pauseKey(opts));
  if (cooldown && Date.now() < cooldown.until) {
    throw new DecisionError(cooldown.code, `Gemini paused for ${Math.ceil((cooldown.until - Date.now()) / 1000)} s after a failure`);
  }
  pausedUntil.delete(pauseKey(opts));
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const { res, data: body } = await send(opts, requestBody(opts.model, state, questions), signal);
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403;
    const rate = res.status === 429;
    const code = auth ? 'GEMINI_AUTH' : rate ? 'GEMINI_RATE_LIMIT' : 'GEMINI_HTTP';
    if (auth) pause(opts, PAUSE_MS.auth, code);
    if (rate) pause(opts, retryAfterMs(res), code);
    const detail = scrubDetail(body?.error?.message ?? 'no error body', opts.apiKey);
    throw new DecisionError(code, `Gemini HTTP ${res.status}: ${detail}`);
  }
  if (!body || typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) {
    return { ...body, answers: null };
  }
  return { ...body, answers: Object.entries(body.answers).map(([name, answer]) => (
    answer?.type === 'noul'
      ? { ...answer, name, type: 'predicate', probability: answer.noul }
      : { ...answer, name }
  )) };
}

/**
 * Asks every question, in batches of at most `opts.maxQuestionsPerCall` that share the state,
 * through `transport` (postDecision by default; tests inject a fake). Batches run in sequence
 * so a pause after a failure stops the rest.
 * @param {GeminiOptions} opts
 * @param {object} state the JSON state (must carry a "kind" field)
 * @param {object[]} questions
 * @param {(opts:GeminiOptions, state:object, questions:object[]) => Promise<object>} [transport]
 * @returns {Promise<{answers:object[], cost:number|null, tokens:{input:number}|null, calls:number}>}
 */
export async function askGemini(opts, state, questions, transport = postDecision) {
  validateQuestions(questions);
  const safeState = redactDeep(state, [opts.apiKey]);
  const safeQuestions = redactDeep(questions, [opts.apiKey]);
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].type === 'choice' && questions[i].choices.some((choice, j) => choice.value !== safeQuestions[i].choices[j].value)) {
      throw new DecisionError('GEMINI_SENSITIVE_CHOICE', 'a choice key contains a secret and cannot be sent to Gemini');
    }
  }
  const size = Math.max(1, opts.maxQuestionsPerCall ?? 16);
  const answers = [];
  let cost = null;
  let tokens = null;
  let calls = 0;
  for (let i = 0; i < questions.length; i += size) {
    const body = await transport(opts, safeState, safeQuestions.slice(i, i + size));
    calls++;
    if (!Array.isArray(body?.answers)) throw new DecisionError('GEMINI_MALFORMED_ANSWER', 'Gemini response has no answers array');
    answers.push(...body.answers);
    const c = callCost(body?.usage, opts.model);
    if (c.cost != null) cost = (cost ?? 0) + c.cost;
    if (c.tokens) tokens = { input: (tokens?.input ?? 0) + c.tokens.input };
  }
  return { answers, cost, tokens, calls };
}

/**
 * @typedef {{url:string, apiKey:string, model:string, timeoutMs:number, maxQuestionsPerCall?:number}} GeminiOptions
 */
