// The decision engine (docs/design.md §2, §5). A decision runs: normalize → prepare → plan
// (settled, or questions for Gemini) → Gemini → interpret → abstain below minConfidence → gate against
// the rules → finalize → ledger. Modes: `auto` falls back to the rules on any Gemini error; `gemini`
// fails the decision after it is logged; `heuristic` is rules only and never calls the transport.
// The registry and the default deps are imported lazily, only when they are not injected.
import { DecisionError, InputError, asInputError, errorCode } from './errors.js';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { askGemini, callCost, postDecision, validateQuestions } from './gemini/client.js';
import { answersByName } from './gemini/answers.js';
import { geminiOptions } from './config.js';
import { createLedger } from './ledger.js';

const MODE_HEURISTIC = 'heuristic';
const MODE_STRICT = 'gemini';
const SOURCE_GEMINI = 'gemini';
const SOURCE_RULES = 'rules';
const SOURCE_SETTLED = 'settled';
// Decision source → the stats bucket it counts in.
const BUCKET_OF_SOURCE = Object.freeze({ settled: 'settled', rules: 'rules', gemini: 'gemini', 'gemini+rules': 'gemini' });
const DEP_KEYS = Object.freeze(['store', 'loadCatalog', 'repoIndex']);
const NO_SPEND = Object.freeze({ calls: 0, cost: null, tokens: null });
const EMPTY_KIND_STATS = Object.freeze({ decisions: 0, gemini: 0, rules: 0, settled: 0, fallbacks: 0 });
// The most entries one cache keeps; each repository index holds all of its chunk text.
const MAX_CACHE_ENTRIES = 8;
const geminiFailures = new WeakSet();

/** Recognizes strict Gemini failures without changing the error rethrown to library callers. */
export function isGeminiFailure(error) {
  return geminiFailures.has(error);
}

/** Memoizes an async loader; a failed load is forgotten, so the next call retries it. */
function once(load) {
  let pending = null;
  return () => {
    pending ??= load().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

const loadRegistry = once(async () => (await import('./registry.js')).KIND_MODULES);

/** True for a thenable, such as the promise an async index build returns. */
function isPromise(v) {
  return v != null && typeof v.then === 'function';
}

/**
 * A cache of built values by key. An entry older than `ttlMs` is built again, so a long-running
 * serve or mcp sees edited files; `ttlMs` 0 keeps nothing and every call builds afresh. Expired
 * entries are dropped on every use, and at most MAX_CACHE_ENTRIES are kept (the oldest goes first).
 * A value may be a promise: concurrent callers then share one build, and a promise that rejects is
 * removed (if its entry is still the one cached), so the next call builds again.
 * @returns {(key: string, make: () => *) => *}
 */
function ttlCache(ttlMs, now) {
  const entries = new Map();
  return (key, make) => {
    const at = now();
    for (const [k, e] of entries) if (at - e.at > ttlMs) entries.delete(k);
    const hit = entries.get(key);
    if (ttlMs > 0 && hit) return hit.value;
    const value = make();
    if (ttlMs > 0) {
      const entry = { value, at };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value);
      if (isPromise(value)) {
        value.then(undefined, () => {
          if (entries.get(key) === entry) entries.delete(key);
        });
      }
    }
    return value;
  };
}

function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function elapsedSince(t0) {
  return Math.round(performance.now() - t0);
}

/**
 * The default deps, built from factories (the real ones, or stubs in tests). Injected entries win.
 * The store is created on first use; the catalog is cached by its dirs, the index by resolved root,
 * and each cached entry is rebuilt once older than config.cacheTtlMs (0: never cached). A repository
 * index factory may return a promise (createRepoIndexAsync); the cache then holds the promise.
 * @param {object} config
 * @param {{createMemoryStore: Function, loadCatalog: Function, createRepoIndex: Function}} factories
 * @param {{store?: object, loadCatalog?: Function, repoIndex?: Function}} injected
 * @param {() => number} [now] clock in milliseconds (default Date.now), injected by tests
 */
export function buildDeps(config, factories, injected = {}, now = Date.now) {
  const catalogs = ttlCache(config.cacheTtlMs, now);
  const indexes = ttlCache(config.cacheTtlMs, now);
  let store = null;
  return Object.freeze({
    get store() {
      return injected.store ?? (store ??= factories.createMemoryStore(config.memory.path));
    },
    loadCatalog: injected.loadCatalog
      ?? ((dirs) => catalogs(dirs.join('|'), () => factories.loadCatalog(dirs))),
    repoIndex: injected.repoIndex
      ?? ((root) => indexes(path.resolve(root), () => factories.createRepoIndex(root, config.retrieve))),
  });
}

/** The deps for prepare and finalize: the injected object as given when complete, else defaults. */
async function resolveDeps(config, injected, now) {
  if (DEP_KEYS.every((k) => injected[k] !== undefined)) return injected;
  const [store, catalog, index] = await Promise.all([
    import('./memory/store.js'), import('./skills/catalog.js'), import('./index/repo.js'),
  ]);
  return buildDeps(config, {
    createMemoryStore: store.createMemoryStore,
    loadCatalog: catalog.loadCatalog,
    createRepoIndex: index.createRepoIndexAsync ?? index.createRepoIndex,
  }, injected, now);
}

/** Counts the Gemini calls that answered and what they cost, whether or not the decision succeeds. */
function createMeter() {
  let spend = NO_SPEND;
  return {
    wrap: (send) => async (opts, state, questions) => {
      const body = await send(opts, state, questions);
      spend = addCall(spend, callCost(body?.usage, opts.model));
      return body;
    },
    snapshot: () => spend,
  };
}

function addCall(spend, { cost, tokens }) {
  return {
    calls: spend.calls + 1,
    cost: cost == null ? spend.cost : (spend.cost ?? 0) + cost,
    tokens: tokens == null ? spend.tokens : {
      input: (spend.tokens?.input ?? 0) + tokens.input,
    },
  };
}

/** One upstream attempt, with local planning and policy outside its fallback boundary. */
async function attempt(ctx, kind, mod, input) {
  if (ctx.config.mode === MODE_HEURISTIC) {
    return { source: SOURCE_RULES, spend: NO_SPEND };
  }
  const p = mod.plan(input, ctx.config);
  if (p.settled) return { verdict: p.settled, source: SOURCE_SETTLED, spend: NO_SPEND };
  validateQuestions(p.questions);
  const state = { ...p.state, kind };
  const meter = createMeter();
  let batch;
  try {
    batch = await askGemini(ctx.opts, state, p.questions, meter.wrap(ctx.send));
  } catch (err) {
    return upstreamFailure(ctx, err, meter);
  }
  try {
    const gemini = mod.interpret(answersByName(batch), p.ctx, ctx.config);
    if (gemini.confidence != null && gemini.confidence < ctx.config.minConfidence) {
      throw new DecisionError('GEMINI_LOW_CONFIDENCE',
        `${kind}: Gemini abstained (confidence ${gemini.confidence} < minConfidence ${ctx.config.minConfidence})`);
    }
    return { verdict: gemini, source: SOURCE_GEMINI, spend: meter.snapshot() };
  } catch (err) {
    if (!(err instanceof DecisionError)) throw err;
    return upstreamFailure(ctx, err, meter);
  }
}

function upstreamFailure(ctx, err, meter) {
  const error = toError(err);
  const source = ctx.config.mode === MODE_STRICT ? null : SOURCE_RULES;
  return { error, source, spend: meter.snapshot() };
}

/** The kind's normalize, with its TypeError marked as the caller's mistake (an InputError). */
function normalizeInput(mod, input, config) {
  try {
    return mod.normalize(input, config);
  } catch (err) {
    throw asInputError(err);
  }
}

export function decisionErrorCode(error, fallback) {
  return errorCode(error, isGeminiFailure(error) ? 'GEMINI_TRANSPORT' : fallback);
}

function buildDecision(kind, step, verdict, latencyMs) {
  return Object.freeze({
    kind,
    source: step.source,
    result: verdict.result,
    confidence: verdict.confidence ?? null,
    reasons: Object.freeze([...(verdict.reasons ?? [])]),
    cost: step.spend.cost,
    tokens: step.spend.tokens,
    calls: step.spend.calls,
    latencyMs,
    ...(step.error ? { error: step.error.message, errorCode: errorCode(step.error, 'GEMINI_TRANSPORT') } : {}),
  });
}

/** The ledger entry for a strict-mode failure: no decision, so no result and no summary. */
function failureDecision(kind, step, latencyMs) {
  return {
    kind,
    source: null,
    result: null,
    confidence: null,
    reasons: [],
    cost: step.spend.cost,
    tokens: step.spend.tokens,
    calls: step.spend.calls,
    latencyMs,
    error: step.error.message,
    errorCode: decisionErrorCode(step.error),
    summary: null,
  };
}

function initialStats() {
  return { decisions: 0, geminiCalls: 0, cost: 0, fallbacks: 0, errors: 0, byKind: {} };
}

function countSpend(s, spend) {
  return { ...s, geminiCalls: s.geminiCalls + spend.calls, cost: s.cost + (spend.cost ?? 0) };
}

function countError(s) {
  return { ...s, errors: s.errors + 1 };
}

function countDecision(s, kind, decision) {
  const prev = Object.hasOwn(s.byKind, kind) ? s.byKind[kind] : EMPTY_KIND_STATS;
  const bucket = BUCKET_OF_SOURCE[decision.source];
  const fellBack = decision.error != null ? 1 : 0;
  return {
    ...s,
    decisions: s.decisions + 1,
    fallbacks: s.fallbacks + fellBack,
    byKind: {
      ...s.byKind,
      [kind]: {
        ...prev,
        decisions: prev.decisions + 1,
        [bucket]: prev[bucket] + 1,
        fallbacks: prev.fallbacks + fellBack,
      },
    },
  };
}

/**
 * The engine: `decide(kind, input)` and one shortcut per kind. Every returned decision is logged.
 * @param {{config: object, transport?: Function, kinds?: Record<string, object>,
 *   deps?: {store?: object, loadCatalog?: Function, repoIndex?: Function}, ledger?: {append: Function},
 *   now?: () => number}} options
 *   `config` from loadConfig; `kinds` defaults to the registry; `deps` defaults to the real store,
 *   catalog and index, loaded on first use; `ledger` defaults to the config's ledger; `now` is the
 *   clock in milliseconds for the cache TTL (default Date.now), injected by tests.
 * @returns {Readonly<{decide: Function, route: Function, skills: Function, retrieve: Function,
 *   recall: Function, remember: Function, compress: Function, stats: () => object}>}
 */
export function createEngine({ config, transport = postDecision, kinds, deps, ledger, now = Date.now } = {}) {
  if (!config) throw new TypeError('createEngine: config is required');
  if (typeof now !== 'function') throw new TypeError('createEngine: now must be a function');
  const ctx = Object.freeze({ config, opts: geminiOptions(config), send: transport });
  const log = ledger ?? createLedger({ path: config.ledger.path, enabled: config.ledger.enabled, maxBytes: config.ledger.maxBytes });
  const getKinds = kinds ? async () => kinds : loadRegistry;
  const getDeps = once(() => resolveDeps(config, deps ?? {}, now));
  let stats = initialStats();

  async function moduleFor(kind) {
    const modules = await getKinds();
    if (!Object.hasOwn(modules, kind)) throw new InputError(`unknown kind "${String(kind)}"`);
    return modules[kind];
  }

  async function decide(kind, input) {
    const mod = await moduleFor(kind);
    const t0 = performance.now();
    const normalized = normalizeInput(mod, input, config);
    const d = (mod.prepare || mod.finalize) ? await getDeps() : undefined;
    const prepared = (await mod.prepare?.(normalized, config, d)) ?? normalized;
    const step = await attempt(ctx, kind, mod, prepared);
    stats = countSpend(stats, step.spend);
    if (step.error) stats = countError(stats);
    if (step.error && config.mode === MODE_STRICT) {
      geminiFailures.add(step.error);
      log.append(failureDecision(kind, step, elapsedSince(t0)));
      throw step.error;
    }
    try {
      if (step.source === SOURCE_GEMINI && mod.gate) {
        step.verdict = mod.gate(step.verdict, mod.heuristic(prepared, config), prepared, config);
        step.source = step.verdict.source ?? SOURCE_GEMINI;
      } else {
        step.verdict ??= mod.heuristic(prepared, config);
      }
    } catch (err) {
      if (!step.error) stats = countError(stats);
      log.append(failureDecision(kind, { ...step, error: toError(err) }, elapsedSince(t0)));
      throw err;
    }
    if (!Object.hasOwn(BUCKET_OF_SOURCE, step.source)) throw new Error(`${kind}: invalid source "${step.source}"`);
    let decision;
    let summary;
    try {
      const finished = (await mod.finalize?.(step.verdict, prepared, config, d)) ?? step.verdict;
      decision = buildDecision(kind, step, finished, elapsedSince(t0));
      summary = mod.summarize(decision.result);
    } catch (err) {
      if (!step.error) stats = countError(stats);
      log.append(failureDecision(kind, { ...step, error: toError(err) }, elapsedSince(t0)));
      throw err;
    }
    stats = countDecision(stats, kind, decision);
    log.append({ ...decision, summary });
    return decision;
  }

  return Object.freeze({
    decide,
    route: (input) => decide('route', input),
    skills: (input) => decide('skills', input),
    retrieve: (input) => decide('retrieve', input),
    recall: (input) => decide('memory_recall', input),
    remember: (input) => decide('memory_write', input),
    compress: (input) => decide('compress', input),
    stats: () => structuredClone(stats),
  });
}
