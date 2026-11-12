import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askGemini, requestBody } from '../src/gemini/client.js';
import { answersByName, choiceAnswer, predicateProbability, scoreLevel } from '../src/gemini/answers.js';
import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';
import { loadEnvFiles } from '../src/envfile.js';

const questions = [
  { type: 'predicate', name: 'relevant', instructions: 'Is this relevant?' },
  { type: 'choice', name: 'model', instructions: 'Which model?', choices: [
    { value: 'small', description: 'Simple tasks' }, { value: 'large', description: 'Hard tasks' },
  ] },
  { type: 'score', name: 'effort', instructions: 'How much effort?', levels: [
    { label: 'low', description: 'Routine' }, { label: 'high', description: 'Complex' },
  ] },
];

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/v1beta/decisions`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Google Decisions wire format and all three answer types pass through the real transport', async () => {
  const state = { kind: 'route', task: 'Choose a model' };
  const expected = requestBody('gemini-decision-1', state, questions);
  assert.equal(expected.model, 'gemini-decision-1');
  assert.match(expected.input, /Choose a model/);
  assert.deepEqual(expected.questions, {
    relevant: { type: 'noul', instructions: 'Is this relevant?' },
    model: { type: 'choice', instructions: 'Which model?', criteria: { small: 'Simple tasks', large: 'Hard tasks' } },
    effort: { type: 'score', instructions: 'How much effort?', criteria: ['low: Routine', 'high: Complex'] },
  });
  assert.equal(expected.prompt_cache_key, undefined);

  await withServer((req, res) => {
    let data = '';
    req.on('data', (part) => { data += part; });
    req.on('end', () => {
      assert.equal(req.headers['x-goog-api-key'], 'test-key');
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(JSON.parse(data), expected);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: {
        relevant: { type: 'noul', noul: 0.91, confidence: 0.91 },
        model: { type: 'choice', choice: 'large', probabilities: { small: 0.2, large: 0.8 }, confidence: 0.8 },
        effort: { type: 'score', score: 0.75, probabilities: { 0: 0.25, 1: 0.75 }, legend: { 0: 'low', 1: 'high' }, confidence: 0.75 },
      }, usage: { total_input_tokens: 1000, total_output_tokens: 0 } }));
    });
  }, async (url) => {
    const result = await askGemini({ url, apiKey: 'test-key', model: 'gemini-decision-1', timeoutMs: 2000 }, state, questions);
    const answers = answersByName(result);
    assert.equal(predicateProbability(answers, 'relevant'), 0.91);
    assert.equal(choiceAnswer(answers, 'model', ['small', 'large']).choice, 'large');
    assert.equal(scoreLevel(answers, 'effort', ['low', 'high']).level, 1);
    assert.deepEqual(result.tokens, { input: 1000 });
    assert.ok(Math.abs(result.cost - 0.0001) < 1e-12);
  });
});

test('a Google-shaped response drives an actual strict route decision', async () => {
  await withServer((req, res) => {
    let data = '';
    req.on('data', (part) => { data += part; });
    req.on('end', () => {
      const request = JSON.parse(data);
      const models = Object.keys(request.questions.model.criteria);
      const levels = request.questions.effort.criteria;
      const probabilities = Object.fromEntries(models.map((model, index) => [model, index === 0 ? 1 : 0]));
      const scores = Object.fromEntries(levels.map((_, index) => [index, index === 0 ? 1 : 0]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: {
        model: { type: 'choice', choice: models[0], probabilities, confidence: 1 },
        effort: { type: 'score', score: 0, probabilities: scores, confidence: 1 },
      }, usage: { total_input_tokens: 321, total_output_tokens: 0 } }));
    });
  }, async (url) => {
    const config = loadConfig({ env: { GEMINI_API_KEY: 'test-key' }, overrides: {
      mode: 'gemini', gemini: { url }, ledger: { enabled: false },
    } });
    const result = await createEngine({ config }).route({ task: 'Rename a local variable' });
    assert.equal(result.source, 'gemini');
    assert.equal(result.calls, 1);
    assert.deepEqual(result.tokens, { input: 321 });
    assert.ok(result.result.model);
  });
});

test('a redirect cannot forward the Google API key to another endpoint', async () => {
  let received = false;
  await withServer((req, res) => {
    received = true;
    req.resume();
    res.end('{}');
  }, async (destination) => {
    await withServer((req, res) => {
      req.resume();
      res.writeHead(302, { location: destination });
      res.end();
    }, async (url) => {
      await assert.rejects(askGemini({ url, apiKey: 'test-key', model: 'gemini-decision-1', timeoutMs: 2000 }, {}, [questions[0]]), { code: 'GEMINI_TRANSPORT' });
    });
  });
  assert.equal(received, false);
});

test('an unknown model keeps token usage without inventing a price', async () => {
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers: { relevant: { type: 'noul', noul: 0.8 } }, usage: { total_input_tokens: 42 } }));
  }, async (url) => {
    const result = await askGemini({ url, apiKey: 'test-key', model: 'other-model', timeoutMs: 2000 }, {}, [questions[0]]);
    assert.equal(result.cost, null);
    assert.deepEqual(result.tokens, { input: 42 });
  });
});

test('configuration refuses batches larger than the Google limit', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { gemini: { maxQuestionsPerCall: 1001 } } }), /1 to 1000/);
});

test('the env file loads the Google key without overriding existing values or importing unrelated variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-env-'));
  try {
    const file = path.join(dir, '.env.local');
    fs.writeFileSync(file, 'GOOGLE_API_KEY=from-file\nGEMINI_CORE_MODE=heuristic\nUNRELATED=value\n');
    const env = { GEMINI_CORE_MODE: 'auto' };
    loadEnvFiles(env, [file]);
    assert.deepEqual(env, { GOOGLE_API_KEY: 'from-file', GEMINI_CORE_MODE: 'auto' });
    assert.equal(loadConfig({ env, cwd: dir }).apiKey, 'from-file');
    assert.equal(loadConfig({ env: { ...env, GEMINI_API_KEY: 'preferred' }, cwd: dir }).apiKey, 'preferred');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed Google response falls back while preserving reported usage', async () => {
  await withServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers: [], usage: { total_input_tokens: 55 } }));
  }, async (url) => {
    const config = loadConfig({ env: { GEMINI_API_KEY: 'test-key' }, overrides: {
      mode: 'auto', gemini: { url }, ledger: { enabled: false },
    } });
    const result = await createEngine({ config }).route({ task: 'Rename a local variable' });
    assert.equal(result.source, 'rules');
    assert.equal(result.errorCode, 'GEMINI_MALFORMED_ANSWER');
    assert.deepEqual(result.tokens, { input: 55 });
    assert.equal(result.calls, 1);
  });
});

test('route choice descriptions are scrubbed while model IDs still match the answer', async () => {
  const key = 'private-key-for-test';
  let sent;
  await withServer((req, res) => {
    let data = '';
    req.on('data', (part) => { data += part; });
    req.on('end', () => {
      sent = JSON.parse(data);
      const models = Object.keys(sent.questions.model.criteria);
      const levels = sent.questions.effort.criteria;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: {
        model: { type: 'choice', choice: models[0], probabilities: Object.fromEntries(models.map((m, i) => [m, i === 0 ? 1 : 0])), confidence: 1 },
        effort: { type: 'score', score: 0, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === 0 ? 1 : 0])), confidence: 1 },
      } }));
    });
  }, async (url) => {
    const config = loadConfig({ env: { GEMINI_API_KEY: key }, overrides: {
      mode: 'gemini', gemini: { url }, ledger: { enabled: false }, route: { models: [
        { id: 'model-one', tier: 1, contextWindow: 10000, efforts: ['low'], strengths: `key ${key}` },
        { id: 'model-two', tier: 2, contextWindow: 10000, efforts: ['low'], strengths: 'hard tasks' },
      ] },
    } });
    const result = await createEngine({ config }).route({ task: 'Rename a local variable' });
    assert.equal(result.result.model, 'model-one');
    assert.equal(result.source, 'gemini');
  });
  assert.ok(!JSON.stringify(sent).includes(key));
  assert.ok(sent.questions.model.criteria['model-one'].includes('[redacted]'));
});

test('skill names are scrubbed from provider question instructions', async () => {
  const key = 'private-key-for-test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-skills-'));
  let sent;
  try {
    fs.mkdirSync(path.join(dir, 'rust-tests'));
    fs.writeFileSync(path.join(dir, 'rust-tests', 'SKILL.md'), `---\nname: ${key}\ndescription: Write Rust tests for the parser\n---\n`);
    await withServer((req, res) => {
      let data = '';
      req.on('data', (part) => { data += part; });
      req.on('end', () => {
        sent = JSON.parse(data);
        const answers = Object.fromEntries(Object.keys(sent.questions).map((name) => [name, { type: 'noul', noul: 0.95, confidence: 0.95 }]));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers }));
      });
    }, async (url) => {
      const config = loadConfig({ env: { GEMINI_API_KEY: key }, overrides: {
        mode: 'gemini', gemini: { url }, ledger: { enabled: false }, skills: { dirs: [dir] },
      } });
      const result = await createEngine({ config }).skills({ task: 'Write Rust tests for the parser' });
      assert.equal(result.source, 'gemini');
      assert.equal(result.result.selected[0].name, key);
    });
    assert.ok(!JSON.stringify(sent).includes(key));
    assert.ok(Object.values(sent.questions).some((q) => q.instructions.includes('[redacted]')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a secret used as a choice ID is rejected before transport', async () => {
  const key = 'private-key-for-test';
  let called = false;
  const question = { type: 'choice', name: 'model', instructions: 'Choose a model', choices: [
    { value: key, description: 'one' }, { value: 'other', description: 'two' },
  ] };
  await assert.rejects(askGemini({ apiKey: key }, {}, [question], async () => { called = true; }), { code: 'GEMINI_SENSITIVE_CHOICE' });
  assert.equal(called, false);
});
