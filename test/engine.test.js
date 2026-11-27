import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, buildDeps } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { InputError } from '../src/errors.js';
import { verdict } from '../src/contract.js';
import { predicateProbability } from '../src/gemini/answers.js';
import { USD_PER_INPUT_TOKEN } from '../src/gemini/client.js';
import { LEDGER_FIELDS } from '../src/ledger.js';
import { fakeGemini } from './helpers/fakeGemini.js';

const OK = { type: 'predicate', name: 'ok', instructions: 'Is the answer right?' };
const DEPS = Object.freeze({ store: Object.freeze({ marker: 'store-marker' }), loadCatalog: () => [], repoIndex: () => ({}) });
const STUB_USD = 1000 * USD_PER_INPUT_TOKEN;

/** A temp home folder, removed afterwards. The ledger and memory default into it. */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-engine-'));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function configFor(home, overrides = {}) {
  return loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd: home, overrides });
}

function readLedger(home) {
  const text = fs.readFileSync(path.join(home, 'decisions.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

/** A stub kind module: Gemini answers the predicate `ok`, the rules answer `rules`. */
function stub(name, extra = {}) {
  return Object.freeze({
    name,
    normalize(input) {
      if (typeof input?.task !== 'string' || !input.task.trim()) throw new TypeError(`${name}: task must be a non-empty string`);
      return { ...input };
    },
    plan: (input) => ({ state: { task: input.task }, questions: [OK], ctx: {} }),
    interpret(answers) {
      const p = predicateProbability(answers, 'ok');
      return verdict({ value: 'gemini', p }, Math.max(p, 1 - p), ['gemini answered']);
    },
    heuristic: () => verdict({ value: 'rules' }, null, ['rules']),
    summarize: (r) => `${name}: ${r.value}`,
    ...extra,
  });
}

const settledPlan = () => ({ settled: verdict({ value: 'settled' }, 1, ['already known']) });

test('settled source: a plan that settles makes no Gemini call', () => withHome(async (home) => {
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  const kinds = { alpha: stub('alpha', { plan: settledPlan }) };
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'settled');
  assert.deepEqual(d.result, { value: 'settled' });
  assert.equal(d.confidence, 1);
  assert.deepEqual(d.reasons, ['already known']);
  assert.equal(d.calls, 0);
  assert.equal(d.cost, null);
  assert.equal(d.tokens, null);
  assert.equal(fake.calls.length, 0);
  assert.ok(Number.isFinite(d.latencyMs) && d.latencyMs >= 0);
  assert.equal('error' in d, false);
}));

test('gemini source: cost, tokens and calls come from askGemini, and state carries the kind', () => withHome(async (home) => {
  const fake = fakeGemini({ predicates: { ok: 0.95 } });
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'pick a model' });
  assert.equal(d.source, 'gemini');
  assert.deepEqual(d.result, { value: 'gemini', p: 0.95 });
  assert.equal(d.confidence, 0.95);
  assert.deepEqual(d.reasons, ['gemini answered']);
  assert.equal(d.calls, 1);
  assert.deepEqual(d.tokens, { input: 1000 });
  assert.ok(Math.abs(d.cost - STUB_USD) < 1e-12);
  assert.equal(fake.calls[0].state.kind, 'alpha');
  assert.equal(fake.calls[0].state.task, 'pick a model');
}));

test('gemini+rules source: the gate sees Gemini and the rules and its verdict is kept', () => withHome(async (home) => {
  const gate = (gemini, rules) => verdict({ value: 'gated', gemini: gemini.result.value, rules: rules.result.value }, 0.5, ['gated'], 'gemini+rules');
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds: { alpha: stub('alpha', { gate }) } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'gemini+rules');
  assert.deepEqual(d.result, { value: 'gated', gemini: 'gemini', rules: 'rules' });
  assert.deepEqual(d.reasons, ['gated']);
  assert.equal(d.calls, 1);
}));

test('rules source: a gate that takes the rules over keeps the Gemini call in the spend', () => withHome(async (home) => {
  const gate = (gemini, rules) => verdict(rules.result, null, ['rules win'], 'rules');
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds: { alpha: stub('alpha', { gate }) } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.deepEqual(d.result, { value: 'rules' });
  assert.equal(d.calls, 1);
  assert.equal(d.confidence, null);
}));

test('heuristic mode answers from the rules and never calls the transport or plans', () => withHome(async (home) => {
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  let plans = 0;
  const kinds = { alpha: stub('alpha', { plan: () => { plans++; throw new Error('plan must not run in heuristic mode'); } }) };
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), transport: fake.transport, kinds });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.deepEqual(d.result, { value: 'rules' });
  assert.equal(d.calls, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(plans, 0);
}));

test('auto fallback: a transport error falls back to the rules and records the error', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home),
    transport: async () => { throw new Error('Gemini HTTP 503: busy'); },
    kinds: { alpha: stub('alpha') },
  });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.deepEqual(d.result, { value: 'rules' });
  assert.equal(d.error, 'Gemini HTTP 503: busy');
  assert.equal(d.calls, 0);
  assert.equal(d.cost, null);
}));

test('auto fallback: a malformed answer falls back and keeps the cost of the call that returned it', () => withHome(async (home) => {
  const transport = async () => ({ answers: [], usage: { total_input_tokens: 500 } });
  const engine = createEngine({ config: configFor(home), transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.match(d.error, /no predicate answer for "ok"/);
  assert.equal(d.calls, 1);
  assert.ok(Math.abs(d.cost - 500 * USD_PER_INPUT_TOKEN) < 1e-12);
}));

test('auto fallback: abstaining below minConfidence falls back with the abstention as the error', () => withHome(async (home) => {
  const fake = fakeGemini({ predicates: { ok: 0.25 } });
  const engine = createEngine({ config: configFor(home, { minConfidence: 0.8 }), transport: fake.transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.match(d.error, /^alpha: Gemini abstained/);
  assert.equal(d.calls, 1);
}));

test('abstention only below minConfidence: equal is accepted, and a null confidence never abstains', () => withHome(async (home) => {
  const equal = fakeGemini({ predicates: { ok: 0.25 } });
  const atBoundary = createEngine({ config: configFor(home, { minConfidence: 0.75 }), transport: equal.transport, kinds: { alpha: stub('alpha') } });
  assert.equal((await atBoundary.decide('alpha', { task: 'x' })).source, 'gemini');

  const nullConfidence = stub('alpha', { interpret: () => verdict({ value: 'gemini' }, null, []) });
  const engine = createEngine({ config: configFor(home, { minConfidence: 0.99 }), transport: fakeGemini().transport, kinds: { alpha: nullConfidence } });
  assert.equal((await engine.decide('alpha', { task: 'x' })).source, 'gemini');
}));

test('strict gemini mode: a Gemini failure is logged, then rethrown unchanged', () => withHome(async (home) => {
  const thrown = new Error('Gemini HTTP 500: boom');
  const engine = createEngine({
    config: configFor(home, { mode: 'gemini' }),
    transport: async () => { throw thrown; },
    kinds: { alpha: stub('alpha') },
  });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), (err) => err === thrown);
  const lines = readLedger(home);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'alpha');
  assert.equal(lines[0].source, null);
  assert.equal(lines[0].error, 'Gemini HTTP 500: boom');
  assert.equal(lines[0].summary, null);
  assert.equal(engine.stats().errors, 1);
  assert.equal(engine.stats().decisions, 0);
}));

test('strict gemini mode: an abstention fails the decision too', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home, { mode: 'gemini', minConfidence: 0.9 }),
    transport: fakeGemini({ predicates: { ok: 0.5 } }).transport,
    kinds: { alpha: stub('alpha') },
  });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), /abstained/);
  assert.match(readLedger(home)[0].error, /abstained/);
}));

test('normalize TypeError propagates in every mode, without a Gemini call', () => withHome(async (home) => {
  for (const mode of ['auto', 'gemini', 'heuristic']) {
    const fake = fakeGemini({ predicates: { ok: 0.9 } });
    const engine = createEngine({ config: configFor(home, { mode }), transport: fake.transport, kinds: { alpha: stub('alpha') } });
    await assert.rejects(engine.decide('alpha', { task: '   ' }), TypeError);
    assert.equal(fake.calls.length, 0, mode);
  }
}));

test('prepare and finalize receive the deps and run in every mode', () => withHome(async (home) => {
  const seen = [];
  const kinds = {
    alpha: stub('alpha', {
      async prepare(input, cfg, deps) {
        seen.push(deps);
        return { ...input, marker: deps.store.marker };
      },
      async finalize(v, input, cfg, deps) {
        seen.push(deps);
        return { ...v, result: { ...v.result, marker: input.marker, finalized: true } };
      },
    }),
  };
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  for (const mode of ['auto', 'heuristic']) {
    const engine = createEngine({ config: configFor(home, { mode }), transport: fake.transport, kinds, deps: DEPS });
    const d = await engine.decide('alpha', { task: 'x' });
    assert.equal(d.result.marker, 'store-marker', mode);
    assert.equal(d.result.finalized, true, mode);
  }
  assert.equal(fake.calls.length, 1);
  assert.equal(seen.length, 4);
  assert.ok(seen.every((deps) => deps === DEPS));
}));

test('a prepare failure propagates without a Gemini call or a fallback', () => withHome(async (home) => {
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  const kinds = { alpha: stub('alpha', { prepare: async () => { throw new Error('index unreadable'); } }) };
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds, deps: DEPS });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), /index unreadable/);
  assert.equal(fake.calls.length, 0);
}));

test('unknown kind is a TypeError, from decide and from a shortcut whose kind is not injected', () => withHome(async (home) => {
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), kinds: { alpha: stub('alpha') } });
  await assert.rejects(engine.decide('nope', { task: 'x' }), (err) => err instanceof TypeError && /unknown kind/.test(err.message));
  await assert.rejects(engine.compress({ task: 'x' }), TypeError);
}));

test('a TypeError from normalize reaches the caller as an InputError (INVALID_INPUT); one thrown later stays a plain TypeError', () => withHome(async (home) => {
  const bad = { ...stub('alpha'), normalize: () => { throw new TypeError('alpha: task must be a non-empty string'); } };
  const buggy = { ...stub('beta'), heuristic: () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); } };
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), kinds: { alpha: bad, beta: buggy } });
  await assert.rejects(engine.decide('alpha', {}), (err) => err instanceof InputError && err instanceof TypeError
    && err.code === 'INVALID_INPUT' && err.message === 'alpha: task must be a non-empty string' && err.cause instanceof TypeError);
  await assert.rejects(engine.decide('nope', {}), (err) => err instanceof InputError && err.code === 'INVALID_INPUT');
  await assert.rejects(engine.decide('beta', { task: 'x' }), (err) => err instanceof TypeError && !(err instanceof InputError));
}));

test('stats count decisions, calls, cost and fallbacks by kind, and return a copy', () => withHome(async (home) => {
  let failNext = false;
  const fake = fakeGemini({ predicates: { ok: 0.95 } });
  const send = (...args) => {
    if (failNext) {
      failNext = false;
      throw new Error('Gemini HTTP 503: busy');
    }
    return fake.transport(...args);
  };
  const kinds = {
    alpha: stub('alpha'),
    beta: stub('beta', { plan: settledPlan }),
  };
  const engine = createEngine({ config: configFor(home), transport: send, kinds });
  await engine.decide('alpha', { task: 'one' });
  await engine.decide('beta', { task: 'two' });
  failNext = true;
  await engine.decide('alpha', { task: 'three' });
  await engine.decide('alpha', { task: 'four' });

  const s = engine.stats();
  assert.equal(s.decisions, 4);
  assert.equal(s.geminiCalls, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.fallbacks, 1);
  assert.ok(Math.abs(s.cost - 2 * STUB_USD) < 1e-12);
  assert.deepEqual(s.byKind.alpha, { decisions: 3, gemini: 2, rules: 1, settled: 0, fallbacks: 1 });
  assert.deepEqual(s.byKind.beta, { decisions: 1, gemini: 0, rules: 0, settled: 1, fallbacks: 0 });

  s.decisions = 99;
  s.byKind.alpha.gemini = 99;
  const again = engine.stats();
  assert.equal(again.decisions, 4);
  assert.equal(again.byKind.alpha.gemini, 2);
}));

test('batching respects gemini.maxQuestionsPerCall and the decision reports every call', () => withHome(async (home) => {
  const questions = ['q0', 'q1', 'q2', 'q3', 'q4'].map((name) => ({ type: 'predicate', name, instructions: `Is ${name}?` }));
  const kinds = {
    alpha: stub('alpha', {
      plan: (input) => ({ state: { task: input.task }, questions, ctx: {} }),
      interpret: (answers) => verdict({ answered: Object.keys(answers).length }, 0.9, []),
    }),
  };
  const fake = fakeGemini({ predicates: { q0: 0.9 } });
  const engine = createEngine({ config: configFor(home, { gemini: { maxQuestionsPerCall: 2 } }), transport: fake.transport, kinds });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.deepEqual(fake.calls.map((c) => c.questions.length), [2, 2, 1]);
  assert.equal(d.calls, 3);
  assert.equal(d.result.answered, 5);
  assert.equal(d.tokens.input, 3000);
}));

test('a gate that returns an unknown source fails the decision (a kind bug, not a fallback)', () => withHome(async (home) => {
  const gate = () => verdict({ value: 'x' }, 0.5, [], 'bogus');
  const engine = createEngine({ config: configFor(home), transport: fakeGemini({ predicates: { ok: 0.9 } }).transport, kinds: { alpha: stub('alpha', { gate }) } });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), /invalid source "bogus"/);
}));

test('the ledger line carries the summary and no input text', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home),
    transport: fakeGemini({ predicates: { ok: 0.9 } }).transport,
    kinds: { alpha: stub('alpha') },
  });
  await engine.decide('alpha', { task: 'PRIVATE-TASK-TEXT-42' });
  const raw = fs.readFileSync(path.join(home, 'decisions.jsonl'), 'utf8');
  assert.equal(raw.includes('PRIVATE'), false);
  const [line] = readLedger(home);
  assert.deepEqual(Object.keys(line).sort(), ['ts', ...LEDGER_FIELDS].sort());
  assert.equal(line.summary, 'alpha: gemini');
  assert.equal(line.source, 'gemini');
  assert.equal(line.calls, 1);
}));

test('a disabled ledger writes nothing', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home, { mode: 'heuristic', ledger: { enabled: false } }),
    kinds: { alpha: stub('alpha') },
  });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.equal(fs.existsSync(path.join(home, 'decisions.jsonl')), false);
}));

test('the shortcuts dispatch to their kinds', () => withHome(async (home) => {
  const names = ['route', 'skills', 'retrieve', 'memory_recall', 'memory_write', 'compress'];
  const kinds = Object.fromEntries(names.map((name) => [name, stub(name)]));
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), kinds });
  const shortcuts = { route: 'route', skills: 'skills', retrieve: 'retrieve', recall: 'memory_recall', remember: 'memory_write', compress: 'compress' };
  for (const [method, kind] of Object.entries(shortcuts)) {
    assert.equal((await engine[method]({ task: 'x' })).kind, kind, method);
  }
}));

test('a kind without prepare or finalize needs no deps, so none are loaded', () => withHome(async (home) => {
  const engine = createEngine({ config: configFor(home), transport: fakeGemini({ predicates: { ok: 0.9 } }).transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'gemini');
}));

test('a gate verdict without a source keeps the gemini source', () => withHome(async (home) => {
  const gate = (gemini) => verdict(gemini.result, gemini.confidence, ['kept']);
  const engine = createEngine({ config: configFor(home), transport: fakeGemini({ predicates: { ok: 0.9 } }).transport, kinds: { alpha: stub('alpha', { gate }) } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'gemini');
  assert.deepEqual(d.reasons, ['kept']);
}));

test('default deps create the store on first use and cache catalogs by dirs and indexes by resolved root', () => withHome(async (home) => {
  const made = { stores: [], catalogs: 0, indexes: 0 };
  const factories = {
    createMemoryStore: (file) => { made.stores.push(file); return { file }; },
    loadCatalog: (dirs) => { made.catalogs++; return dirs.map((d) => ({ name: d })); },
    createRepoIndex: (root) => { made.indexes++; return { root }; },
  };
  const config = configFor(home);
  const deps = buildDeps(config, factories, {});
  assert.deepEqual(made.stores, [], 'no store before first use');
  assert.equal(deps.store, deps.store);
  assert.deepEqual(made.stores, [config.memory.path]);

  assert.equal(deps.loadCatalog(['a', 'b']), deps.loadCatalog(['a', 'b']));
  deps.loadCatalog(['a']);
  assert.equal(made.catalogs, 2);

  assert.equal(deps.repoIndex(path.join(home, 'sub', '..')), deps.repoIndex(home));
  assert.equal(made.indexes, 1);
  assert.equal(made.stores.length, 1);
}));

test('injected deps win over the factories', () => withHome(async (home) => {
  const injectedStore = { search: () => [] };
  const factories = {
    createMemoryStore: () => { throw new Error('must not create a store'); },
    loadCatalog: () => { throw new Error('must not load a catalog'); },
    createRepoIndex: () => { throw new Error('must not index'); },
  };
  const loadCatalog = () => [{ name: 'injected' }];
  const deps = buildDeps(configFor(home), factories, { store: injectedStore, loadCatalog });
  assert.equal(deps.store, injectedStore);
  assert.equal(deps.loadCatalog, loadCatalog);
  assert.equal(typeof deps.repoIndex, 'function');
}));

test('createEngine requires a config and a clock that is a function', () => withHome(async (home) => {
  assert.throws(() => createEngine({ kinds: {} }), (err) => err instanceof TypeError && /config is required/.test(err.message));
  assert.throws(() => createEngine({ config: configFor(home), now: 5 }), (err) => err instanceof TypeError && /now must be a function/.test(err.message));
}));

test('cached catalogs and indexes are rebuilt once older than cacheTtlMs; a TTL of 0 keeps none', () => withHome(async (home) => {
  let clock = 1000;
  const now = () => clock;
  const made = { catalogs: 0, indexes: 0 };
  const factories = {
    createMemoryStore: () => ({}),
    loadCatalog: (dirs) => { made.catalogs++; return dirs.map((d) => ({ name: d })); },
    createRepoIndex: (root) => { made.indexes++; return { root }; },
  };
  const deps = buildDeps(configFor(home, { cacheTtlMs: 100 }), factories, {}, now);
  const first = deps.loadCatalog(['a']);
  clock = 1100;
  assert.equal(deps.loadCatalog(['a']), first, 'exactly cacheTtlMs old is still cached');
  clock = 1101;
  assert.notEqual(deps.loadCatalog(['a']), first, 'older than cacheTtlMs is rebuilt');
  assert.equal(made.catalogs, 2);

  assert.equal(deps.repoIndex(home), deps.repoIndex(home));
  assert.equal(made.indexes, 1);

  const none = buildDeps(configFor(home, { cacheTtlMs: 0 }), factories, {}, now);
  none.repoIndex(home);
  none.repoIndex(home);
  assert.equal(made.indexes, 3, 'with cacheTtlMs 0 every call indexes again');
}));

test('the engine re-reads a repository once its cached index is older than cacheTtlMs', () => withHome(async (home) => {
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const alpha = 1;\n');
  let clock = 0;
  const engine = createEngine({
    config: configFor(home, { mode: 'heuristic', cacheTtlMs: 100, retrieve: { allowedRoots: [home] } }),
    transport: fakeGemini({}).transport,
    now: () => clock,
  });
  const ask = () => engine.retrieve({ query: 'zanzibarfrob usage', root: repo });
  assert.equal((await ask()).result.chunks.length, 0, 'nothing matches yet');
  fs.writeFileSync(path.join(repo, 'b.js'), 'export const beta = zanzibarfrob();\n');
  clock = 100;
  assert.equal((await ask()).result.chunks.length, 0, 'the index is still within cacheTtlMs');
  clock = 101;
  const fresh = await ask();
  assert.deepEqual(fresh.result.chunks.map((c) => c.source), ['b.js']);
}));

test('auto mode propagates gate programming errors without returning a fallback', () => withHome(async (home) => {
  const problem = new Error('gate bug');
  const fake = fakeGemini({ predicates: { ok: 0.95 } });
  const engine = createEngine({
    config: configFor(home),
    transport: fake.transport,
    kinds: { alpha: stub('alpha', { gate: () => { throw problem; } }) },
  });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), (err) => err === problem);
  assert.equal(engine.stats().geminiCalls, 1);
  assert.equal(engine.stats().fallbacks, 0);
  assert.equal(readLedger(home)[0].errorCode, 'INTERNAL_ERROR');
}));

test('the cache drops expired entries whenever it is used and keeps at most a few entries', () => withHome(async (home) => {
  let clock = 0;
  const made = [];
  const factories = {
    createMemoryStore: () => ({}),
    loadCatalog: () => [],
    createRepoIndex: (root) => { made.push(root); return { root }; },
  };
  const deps = buildDeps(configFor(home, { cacheTtlMs: 100 }), factories, {}, () => clock);
  const roots = Array.from({ length: 20 }, (_, i) => path.join(home, `r${i}`));
  for (const r of roots) deps.repoIndex(r);
  assert.equal(made.length, 20);
  deps.repoIndex(roots[19]);
  assert.equal(made.length, 20, 'the newest entry is still cached');
  deps.repoIndex(roots[0]);
  assert.equal(made.length, 21, 'the oldest entry was evicted by the cap');
  // An expired entry is dropped when another key is used, not only when it is asked for again.
  clock = 1000;
  deps.repoIndex(roots[5]);
  deps.repoIndex(roots[19]);
  assert.equal(made.length, 23, 'every expired entry was dropped, so both are built again');
  deps.repoIndex(roots[19]);
  assert.equal(made.length, 23);
}));

test('a failure in finalize after Gemini was paid for is logged with the spend, counted once, and rethrown unchanged', () => withHome(async (home) => {
  const boom = new Error('memory store is locked');
  const kinds = { alpha: stub('alpha', { finalize: () => { throw boom; } }) };
  const fake = fakeGemini({ predicates: { ok: 0.9 } });
  const engine = createEngine({ config: configFor(home), kinds, deps: DEPS, transport: fake.transport });
  await assert.rejects(() => engine.decide('alpha', { task: 't' }), (err) => err === boom);
  const [entry] = readLedger(home);
  assert.equal(entry.kind, 'alpha');
  assert.equal(entry.error, 'memory store is locked');
  assert.ok(entry.result == null);
  assert.ok(entry.calls >= 1);
  const stats = engine.stats();
  assert.equal(stats.errors, 1);
  assert.equal(stats.decisions, 0);
  assert.equal(stats.geminiCalls, entry.calls);
}));

test('a failure in summarize is recorded the same way', () => withHome(async (home) => {
  const boom = new Error('summary broke');
  const kinds = { alpha: stub('alpha', { summarize: () => { throw boom; } }) };
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), kinds, deps: DEPS });
  await assert.rejects(() => engine.decide('alpha', { task: 't' }), (err) => err === boom);
  assert.equal(readLedger(home).length, 1);
  assert.equal(engine.stats().errors, 1);
}));

test('concurrent index requests for one root share one build', () => withHome(async (home) => {
  let builds = 0;
  const factories = {
    createMemoryStore: () => ({}),
    loadCatalog: () => [],
    createRepoIndex: async (root) => { builds++; await new Promise((r) => setTimeout(r, 10)); return { root }; },
  };
  const deps = buildDeps(configFor(home), factories, {});
  const [a, b, c] = await Promise.all([deps.repoIndex(home), deps.repoIndex(home), deps.repoIndex(path.join(home, 'x', '..'))]);
  assert.equal(builds, 1);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(await deps.repoIndex(home), a, 'a settled build stays cached');
  assert.equal(builds, 1);
}));

test('an index build that rejects is not cached: the next request builds again', () => withHome(async (home) => {
  let builds = 0;
  const factories = {
    createMemoryStore: () => ({}),
    loadCatalog: () => [],
    createRepoIndex: async (root) => {
      builds++;
      if (builds === 1) throw new Error('walk failed');
      return { root };
    },
  };
  const deps = buildDeps(configFor(home), factories, {});
  await assert.rejects(deps.repoIndex(home), /walk failed/);
  assert.deepEqual(await deps.repoIndex(home), { root: home });
  assert.equal(builds, 2);
  await deps.repoIndex(home);
  assert.equal(builds, 2, 'the good build is cached');
}));

test('a rejected build does not evict a newer entry for the same root', () => withHome(async (home) => {
  let clock = 0;
  let rejectFirst;
  let builds = 0;
  const factories = {
    createMemoryStore: () => ({}),
    loadCatalog: () => [],
    createRepoIndex: (root) => {
      builds++;
      if (builds === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return Promise.resolve({ root, build: builds });
    },
  };
  const deps = buildDeps(configFor(home, { cacheTtlMs: 100 }), factories, {}, () => clock);
  const first = deps.repoIndex(home);
  first.catch(() => {});
  clock = 200;
  const second = await deps.repoIndex(home);
  rejectFirst(new Error('late failure'));
  await assert.rejects(first, /late failure/);
  assert.equal(await deps.repoIndex(home), second, 'the newer entry is still cached');
  assert.equal(builds, 2);
}));

test('a synchronous index factory still works through the cache', () => withHome(async (home) => {
  let builds = 0;
  const factories = {
    createMemoryStore: () => ({}),
    loadCatalog: () => [],
    createRepoIndex: (root) => { builds++; return { root }; },
  };
  const deps = buildDeps(configFor(home), factories, {});
  assert.deepEqual(deps.repoIndex(home), { root: home });
  assert.equal(deps.repoIndex(home), deps.repoIndex(home));
  assert.equal(builds, 1);
}));
