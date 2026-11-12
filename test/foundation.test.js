import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askGemini, postDecision, requestBody, validateQuestions, callCost, resetGeminiState } from '../src/gemini/client.js';
import { answersByName, scoreLevel, choiceAnswer, predicateProbability, quantileIndex } from '../src/gemini/answers.js';
import { tokenize, estimateTokens, createBm25, excerpt, similarity } from '../src/text.js';
import { loadConfig, deepMerge } from '../src/config.js';
import { RUBRIC } from '../src/rubric.js';
import { SECRET } from '../src/contract.js';
import { fakeGemini, score, choice } from './helpers/fakeGemini.js';

const P = (name) => ({ type: 'predicate', name, instructions: `is ${name}?` });

test('validateQuestions rejects bad names, duplicates, one-choice and bad score levels', () => {
  assert.throws(() => validateQuestions([]), /no questions/);
  assert.throws(() => validateQuestions([P('Bad-Name')]), /invalid question name/);
  assert.throws(() => validateQuestions([P('a1'), P('a1')]), /duplicate/);
  assert.throws(() => validateQuestions([{ type: 'choice', name: 'c', instructions: 'x', choices: [{ value: 'a' }] }]), /2 to 255/);
  assert.throws(() => validateQuestions([{ type: 'score', name: 's', instructions: 'x', levels: [{ label: 'a' }] }]), /2 to 10/);
  validateQuestions([P('ok_1'), { type: 'choice', name: 'c', instructions: 'x', choices: [{ value: 'a' }, { value: 'b' }] }]);
});

test('requestBody includes the rubric and serialized state', () => {
  const b = requestBody('gemini-decision-1', { kind: 'route' }, [P('x')]);
  assert.ok(b.input.startsWith(RUBRIC));
  assert.ok(b.input.includes('{"kind":"route"}'));
  assert.equal(b.questions.x.type, 'noul');
});

test('askGemini batches questions sharing one state and sums the cost', async () => {
  const fake = fakeGemini({ predicates: { q0: 0.9 } });
  const qs = Array.from({ length: 5 }, (_, i) => P(`q${i}`));
  const r = await askGemini({ maxQuestionsPerCall: 2 }, { kind: 'skills' }, qs, fake.transport);
  assert.equal(r.calls, 3);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls.map((c) => c.questions.length), [2, 2, 1]);
  assert.equal(r.answers.length, 5);
  assert.equal(r.tokens.input, 3000);
  assert.ok(Math.abs(r.cost - 3000 * 0.1e-6) < 1e-12);
  assert.equal(predicateProbability(answersByName(r), 'q0'), 0.9);
});

test('callCost handles missing usage', () => {
  assert.deepEqual(callCost(undefined), { cost: null, tokens: null });
});

test('answers: score quantile, choice probabilities, refusal and type errors', () => {
  const a = answersByName({ answers: [score('effort', [0.1, 0.2, 0.4, 0.3]), choice('m', { x: 0.2, y: 0.8 }), { type: 'refusal', name: 'r' }, { type: 'predicate', name: 'p', probability: 2 }] });
  assert.equal(scoreLevel(a, 'effort', ['a', 'b', 'c', 'd'], 0.5).level, 2);
  assert.equal(scoreLevel(a, 'effort', ['a', 'b', 'c', 'd'], 0.1).level, 0);
  const c = choiceAnswer(a, 'm', ['x', 'y']);
  assert.equal(c.choice, 'y');
  assert.deepEqual(c.probs.map((v) => +v.toFixed(2)), [0.2, 0.8]);
  assert.throws(() => choiceAnswer(a, 'm', ['x', 'z']), /unknown choice/);
  assert.throws(() => predicateProbability(a, 'r'), /refused/);
  assert.throws(() => predicateProbability(a, 'p'), /no probability/);
  assert.throws(() => predicateProbability(a, 'missing'), /no predicate/);
  assert.equal(quantileIndex([0, 0.5, 0.5], 0), 1);
});

test('tokenize splits camelCase, snake_case and CJK bigrams', () => {
  const t = tokenize('parseConfig load_env 模型路由');
  for (const w of ['parseconfig', 'parse', 'config', 'load_env', 'load', 'env', '模型', '型路', '路由']) assert.ok(t.includes(w), w);
  assert.ok(estimateTokens('模型路由') === 4);
  assert.deepEqual(tokenize('answers queries class status'), ['answers', 'answer', 'queries', 'query', 'class', 'status']);
  assert.equal(excerpt('abcdefghij', 5), 'abcd…');
  assert.ok(excerpt('a'.repeat(50) + 'END', 20, true).endsWith('END'));
  assert.equal(similarity('use pnpm always', 'always use pnpm'), 1);
});

test('createBm25 ranks the matching document first', () => {
  const idx = createBm25([{ id: 'a', text: 'memory store jsonl atomic write' }, { id: 'b', text: 'route model effort ladder' }, { id: 'c', text: 'unrelated' }]);
  const r = idx.search('which model and effort');
  assert.equal(r[0].id, 'b');
  assert.equal(r.length, 1);
});

test('SECRET catches keys and passwords but not ordinary text', () => {
  assert.ok(SECRET.test('my key is sk-abcdefghijklmnopqrstuvwx'));
  assert.ok(SECRET.test('password: hunter2hunter2'));
  assert.ok(!SECRET.test('always run the tests before committing'));
});

test('loadConfig merges file and env, takes the key from env only, and validates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-'));
  try {
    fs.writeFileSync(path.join(dir, 'gemini-core.config.json'), JSON.stringify({ mode: 'heuristic', skills: { maxSkills: 2 } }));
    const c = loadConfig({ env: { GEMINI_CORE_HOME: dir, GOOGLE_API_KEY: 'sk-test', GEMINI_DECISION_TIMEOUT_MS: '900' }, cwd: dir });
    assert.equal(c.mode, 'heuristic');
    assert.equal(c.skills.maxSkills, 2);
    assert.equal(c.skills.shortlist, 12);
    assert.equal(c.gemini.timeoutMs, 900);
    assert.equal(c.apiKey, 'sk-test');
    assert.equal(c.memory.path, path.join(dir, 'memory.jsonl'));
    assert.ok(Object.isFrozen(c.route.models[0]));
    fs.writeFileSync(path.join(dir, 'gemini-core.config.json'), JSON.stringify({ gemini: { apiKey: 'x' } }));
    assert.throws(() => loadConfig({ env: { GEMINI_CORE_HOME: dir }, cwd: dir }), /not in the config file/);
    fs.writeFileSync(path.join(dir, 'gemini-core.config.json'), JSON.stringify({ ladder: ['high', 'low'] }));
    assert.throws(() => loadConfig({ env: { GEMINI_CORE_HOME: dir }, cwd: dir }), /least to most/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('postDecision pauses on 401 for that key while another key remains usable', async () => {
  resetGeminiState();
  const bodies = [];
  const server = await serve((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = JSON.parse(data);
      bodies.push(body);
      if (req.headers['x-goog-api-key'] === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { x: { type: 'noul', noul: 0.7 } }, usage: { total_input_tokens: 10 } }));
    });
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/decisions`;
    const opts = { url, apiKey: 'good', model: 'gemini-decision-1', timeoutMs: 2000 };
    const body = await postDecision(opts, { kind: 'route' }, [P('x')]);
    assert.equal(body.answers[0].probability, 0.7);
    assert.equal(bodies.length, 1);
    await postDecision(opts, { kind: 'route' }, [P('x')]);
    assert.equal(bodies.length, 2);
    const bad = { ...opts, apiKey: 'bad' };
    await assert.rejects(postDecision(bad, {}, [P('x')]), /HTTP 401/);
    await assert.rejects(postDecision(bad, {}, [P('x')]), /paused/);
    await postDecision(opts, {}, [P('x')]);
    await assert.rejects(postDecision({ ...opts, apiKey: '' }, {}, [P('x')]), /no Google API key/);
  } finally {
    server.close();
    resetGeminiState();
  }
});

test('validateQuestions refuses an unknown question type and a score above 10 levels', () => {
  assert.throws(() => validateQuestions([{ type: 'weird', name: 'w', instructions: 'x' }]), /unknown type "weird"/);
  const levels = Array.from({ length: 11 }, (_, i) => ({ value: i }));
  assert.throws(() => validateQuestions([{ type: 'score', name: 's', instructions: 'x', levels }]), /2 to 10/);
});

test('postDecision pauses for the Retry-After seconds on 429 and does not call again meanwhile', async () => {
  resetGeminiState();
  let hits = 0;
  const server = await serve((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end('{"error":{"message":"slow down"}}');
    });
  });
  try {
    const opts = { url: `http://127.0.0.1:${server.address().port}/v1beta/decisions`, apiKey: 'k-rate', model: 'gemini-decision-1', timeoutMs: 2000 };
    await assert.rejects(postDecision(opts, {}, [P('x')]), /HTTP 429: slow down/);
    await assert.rejects(postDecision(opts, {}, [P('x')]), /paused for 7 s/);
    assert.equal(hits, 1, 'the paused key sends no second request');
  } finally {
    server.close();
    resetGeminiState();
  }
});

test('postDecision pauses after a timeout and reports the pause', async () => {
  resetGeminiState();
  const server = await serve(() => {});
  try {
    const opts = { url: `http://127.0.0.1:${server.address().port}/v1beta/decisions`, apiKey: 'k-slow', model: 'gemini-decision-1', timeoutMs: 50 };
    await assert.rejects(postDecision(opts, {}, [P('x')]), (err) => err.name === 'TimeoutError');
    await assert.rejects(postDecision(opts, {}, [P('x')]), /paused for 30 s/);
  } finally {
    server.closeAllConnections();
    server.close();
    resetGeminiState();
  }
});

test('loadConfig refuses a config file that is not JSON or not an object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'gemini-core.config.json'), '{ not json');
    assert.throws(() => loadConfig({ env: { GEMINI_CORE_HOME: dir }, cwd: dir }), /is not valid JSON/);
    fs.writeFileSync(path.join(dir, 'gemini-core.config.json'), '[1, 2]');
    assert.throws(() => loadConfig({ env: { GEMINI_CORE_HOME: dir }, cwd: dir }), /must be a JSON object/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('answers reject invalid scores, confidence, distributions and duplicate names', () => {
  const invalid = { code: 'GEMINI_MALFORMED_ANSWER' };
  const scoreAnswer = { name: 's', type: 'score', score: 1 };
  assert.throws(() => scoreLevel({ s: { ...scoreAnswer, score: 99, probabilities: [0, 1] } }, 's', ['a', 'b']), invalid);
  assert.throws(() => scoreLevel({ s: { ...scoreAnswer, probabilities: [0, 0] } }, 's', ['a', 'b']), invalid);
  assert.throws(() => scoreLevel({ s: { ...scoreAnswer, probabilities: [{ value: 0, label: 'b', probability: 1 }] } }, 's', ['a', 'b']), invalid);
  assert.throws(() => choiceAnswer({ c: { name: 'c', type: 'choice', choice: 'a', confidence: 1.2 } }, 'c', ['a', 'b']), invalid);
  assert.throws(() => answersByName({ answers: [scoreAnswer, scoreAnswer] }), invalid);
  assert.equal(choiceAnswer({ c: { name: 'c', type: 'choice', choice: 'a' } }, 'c', ['a', 'b']).confidence, null);
});

test('postDecision applies an HTTP-date cooldown and preserves the rate-limit code', async () => {
  let hits = 0;
  const server = await serve((req, res) => {
    req.resume();
    hits++;
    res.writeHead(429, { 'retry-after': new Date(Date.now() + 10_000).toUTCString() });
    res.end('{}');
  });
  try {
    const opts = { url: `http://127.0.0.1:${server.address().port}/v1/decisions`, apiKey: 'date-test', timeoutMs: 2000 };
    await assert.rejects(postDecision(opts, {}, [P('x')]), { code: 'GEMINI_RATE_LIMIT' });
    await assert.rejects(postDecision(opts, {}, [P('x')]), { code: 'GEMINI_RATE_LIMIT', message: /paused for (9|10) s/ });
    assert.equal(hits, 1);
  } finally {
    server.closeAllConnections();
    server.close();
    resetGeminiState();
  }
});
