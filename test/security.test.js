import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { SECRET, REDACTED, redact } from '../src/contract.js';
import { loadConfig, geminiOptions } from '../src/config.js';
import { postDecision, resetGeminiState, scrubDetail, KEY_MARK } from '../src/gemini/client.js';

const KEY = 'sk-proj-SECRETKEYSECRETKEY1234';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-sec-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

const P = (name) => ({ type: 'predicate', name, instructions: `is ${name}?` });

// --- SECRET: every listed form is caught and its value removed; prose is left alone ----------

const SECRET_CASES = [
  ['DB_PASSWORD assignment', 'DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
  ['a key name longer than 40 characters', 'SOME_VERY_LONG_SERVICE_ACCOUNT_CLIENT_CREDENTIALS_FOR_PRODUCTION_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
  ['AWS secret access key', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['MY_API_KEY assignment', 'MY_API_KEY=abcdef1234567890', 'abcdef1234567890'],
  ['quoted JSON password', '{"password": "hunter2hunter2"}', 'hunter2hunter2'],
  ['quoted JSON apiKey', '{"apiKey":"abcdef1234567890abcd"}', 'abcdef1234567890abcd'],
  ['short password value (3 characters)', 'password: abc', 'abc'],
  ['token assignment', 'token=abc12', 'abc12'],
  ['Authorization Bearer JWT', `Authorization: Bearer ${JWT}`, 'dozjgNry'],
  ['bare JWT', JWT, 'dozjgNry'],
  ['Bearer token with digits', 'curl -H "Authorization: Bearer abc123def456ghi"', 'abc123def456ghi'],
  ['bare Bearer token with digits', 'send Bearer 4f8a9c2e7b1d3e6f0a9b to the api', '4f8a9c2e7b1d'],
  ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789', '11ABCDEFG0'],
  ['GitLab PAT', 'glpat-abcdefghij0123456789', 'abcdefghij0123'],
  ['client_secret assignment', 'client_secret = "s3cr3tvalue"', 's3cr3tvalue'],
  ['URL credentials', 'postgres://user:p4ssw0rdlong@db.example.com/x', 'p4ssw0rdlong'],
  ['NPM_TOKEN with a colon', 'NPM_TOKEN: abcdef12345', 'abcdef12345'],
  ['Django SECRET_KEY', 'SECRET_KEY = "django-insecure-x9q"', 'django-insecure'],
  ['OpenAI project key', KEY, 'SECRETKEYSECRETKEY'],
  ['env key with a sk- value', 'GOOGLE_API_KEY=sk-abcdefghijklmnopqrstu', 'abcdefghijklmnopqrstu'],
  ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA'],
];

for (const [name, text, leaked] of SECRET_CASES) {
  test(`SECRET catches ${name} and redact removes the value`, () => {
    assert.ok(SECRET.test(text), 'SECRET must match');
    const out = redact(text);
    assert.ok(out.includes(REDACTED), `redacted: ${out}`);
    assert.ok(!out.includes(leaked), `value "${leaked}" must not survive: ${out}`);
  });
}

const PROSE_CASES = [
  'the token budget is large',
  'password reset flow',
  'secret santa',
  'api key rotation docs',
  'always run the tests before committing',
  'tokenizer: bert',
  'max tokens: 4000',
  'passwordless: true',
  'author: Eda',
  'see https://example.com:8080/path for docs',
  'use bearer authentication for the API',
  'git@github.com:user/repo.git',
  'remember to prefer pnpm over npm',
];

for (const text of PROSE_CASES) {
  test(`SECRET leaves ordinary text alone: "${text}"`, () => {
    assert.equal(SECRET.test(text), false);
    assert.equal(redact(text), text);
  });
}

test('redact keeps the text around a secret', () => {
  assert.equal(redact('retry the deploy, token=abc12 then stop'), 'retry the deploy, [redacted] then stop');
  assert.equal(redact('const password: hunter2hunter2;'), 'const [redacted]');
});

// --- client: response bodies never carry the key into an error message ---------------------

test('scrubDetail replaces the literal key with [key] and redacts other secrets', () => {
  assert.equal(scrubDetail(`Incorrect API key provided: ${KEY}`, KEY), `Incorrect API key provided: ${KEY_MARK}`);
  assert.equal(scrubDetail('bad password: hunter2hunter2', KEY), 'bad [redacted]');
  assert.equal(scrubDetail(undefined, KEY), 'undefined');
});

test('postDecision error message never contains the key echoed by the server', async () => {
  resetGeminiState();
  const server = await serve((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const echoed = req.headers['x-goog-api-key'];
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${echoed}. Also password: hunter2hunter2` } }));
    });
  });
  try {
    const opts = { url: `http://127.0.0.1:${server.address().port}/v1beta/decisions`, apiKey: KEY, model: 'gemini-decision-1', timeoutMs: 2000 };
    const err = await postDecision(opts, { kind: 'route' }, [P('x')]).then(() => null, (e) => e);
    assert.ok(err instanceof Error, 'the call must fail');
    assert.match(err.message, /^Gemini HTTP 401: /);
    assert.ok(err.message.includes(KEY_MARK), err.message);
    assert.ok(!err.message.includes(KEY), err.message);
    assert.ok(!err.message.includes('hunter2'), err.message);
  } finally {
    server.close();
    resetGeminiState();
  }
});

test('postDecision without a usable body says so and still omits the key', async () => {
  resetGeminiState();
  const server = await serve((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`gateway trace for ${KEY}`);
    });
  });
  try {
    const opts = { url: `http://127.0.0.1:${server.address().port}/v1beta/decisions`, apiKey: KEY, model: 'gemini-decision-1', timeoutMs: 2000 };
    const err = await postDecision(opts, {}, [P('x')]).then(() => null, (e) => e);
    assert.equal(err.message, 'Gemini HTTP 500: no error body');
  } finally {
    server.close();
    resetGeminiState();
  }
});

// --- config: a working-folder file cannot redirect the key or move the stores ---------------

function writeJson(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
}

// [label, the key the error must name, the file body]
const WORKING_FOLDER_ONLY = [
  ['gemini.url', 'gemini.url', { gemini: { url: 'https://evil.example/v1/decisions' } }],
  ['gemini.url, even at the default value', 'gemini.url', { gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/decisions' } }],
  ['memory.path', 'memory.path', { memory: { path: 'steal.jsonl' } }],
  ['ledger.path', 'ledger.path', { ledger: { path: 'steal.jsonl' } }],
  ['skills.dirs', 'skills.dirs', { skills: { dirs: ['/somewhere'] } }],
  ['retrieve.allowedRoots', 'retrieve.allowedRoots', { retrieve: { allowedRoots: ['/'] } }],
  ['retrieve.respectGitignore', 'retrieve.respectGitignore', { retrieve: { respectGitignore: false } }],
  ['server.host', 'server.host', { server: { host: '0.0.0.0' } }],
  ['ledger.enabled', 'ledger.enabled', { ledger: { enabled: false } }],
];

for (const [label, key, body] of WORKING_FOLDER_ONLY) {
  test(`a working-folder gemini-core.config.json may not set ${label}`, () => withTmp(async (root) => {
    const cwd = path.join(root, 'repo');
    const home = path.join(root, 'home');
    writeJson(path.join(cwd, 'gemini-core.config.json'), body);
    assert.throws(
      () => loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd }),
      (err) => err instanceof Error && err.message.includes(`"${key}"`) && /working-folder config/.test(err.message),
    );
  }));
}

test('the trusted-only keys are accepted from an explicit file, GEMINI_CORE_CONFIG or the home config', () => withTmp(async (root) => {
  const cwd = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const explicit = path.join(root, 'explicit.json');
  const allowed = path.join(root, 'allowed');
  writeJson(explicit, { gemini: { url: 'https://proxy.example/v1/decisions' }, memory: { path: 'mem/m.jsonl' }, server: { host: '127.0.0.1' } });
  const viaFile = loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd, file: explicit });
  assert.equal(viaFile.gemini.url, 'https://proxy.example/v1/decisions');
  assert.equal(viaFile.memory.path, 'mem/m.jsonl');
  assert.equal(viaFile.server.host, '127.0.0.1');
  const viaEnv = loadConfig({ env: { GEMINI_CORE_HOME: home, GEMINI_CORE_CONFIG: explicit }, cwd });
  assert.equal(viaEnv.memory.path, 'mem/m.jsonl');
  writeJson(path.join(home, 'config.json'), { retrieve: { allowedRoots: [allowed] } });
  const viaHome = loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd });
  assert.deepEqual(viaHome.retrieve.allowedRoots, [allowed]);
}));

test('a working-folder config may still set the ordinary keys', () => withTmp(async (root) => {
  const cwd = path.join(root, 'repo');
  writeJson(path.join(cwd, 'gemini-core.config.json'), { mode: 'heuristic', skills: { maxSkills: 2 }, compress: { keepRecentTurns: 3 } });
  const c = loadConfig({ env: { GEMINI_CORE_HOME: path.join(root, 'home') }, cwd });
  assert.equal(c.mode, 'heuristic');
  assert.equal(c.skills.maxSkills, 2);
  assert.equal(c.compress.keepRecentTurns, 3);
}));

const URL_CASES = [
  ['https://api.example.com/v1/decisions', true],
  ['http://127.0.0.1:8080/v1/decisions', true],
  ['http://localhost:8080/v1/decisions', true],
  ['http://example.com/v1/decisions', false],
  ['http://10.0.0.5/v1/decisions', false],
  ['https://user:pw123@api.example.com/v1/decisions', false],
  ['ftp://api.example.com/v1/decisions', false],
  ['not a url', false],
];

for (const [url, allowed] of URL_CASES) {
  test(`gemini.url "${url}" is ${allowed ? 'accepted' : 'refused without echoing the URL'}`, () => withTmp(async (root) => {
    const env = { GEMINI_CORE_HOME: path.join(root, 'home') };
    if (allowed) {
      assert.equal(loadConfig({ env, cwd: root, overrides: { gemini: { url } } }).gemini.url, url);
      return;
    }
    assert.throws(
      () => loadConfig({ env, cwd: root, overrides: { gemini: { url } } }),
      (err) => err.message.includes('gemini.url must be an https URL') && !err.message.includes('pw123'),
    );
  }));
}

test('GEMINI_DECISION_URL is held to the same https rule', () => withTmp(async (root) => {
  const env = { GEMINI_CORE_HOME: path.join(root, 'home'), GEMINI_DECISION_URL: 'http://example.com/v1/decisions' };
  assert.throws(() => loadConfig({ env, cwd: root }), /gemini\.url must be an https URL/);
}));

test('the API key is readable on the config but never enumerable or serialised', () => withTmp(async (root) => {
  const c = loadConfig({ env: { GEMINI_CORE_HOME: root, GOOGLE_API_KEY: KEY }, cwd: root });
  assert.equal(c.apiKey, KEY);
  assert.equal(geminiOptions(c).apiKey, KEY);
  assert.equal(Object.getOwnPropertyDescriptor(c, 'apiKey').enumerable, false);
  assert.ok(!Object.keys(c).includes('apiKey'));
  assert.ok(!JSON.stringify(c).includes(KEY));
  assert.ok(!JSON.stringify({ ...c }).includes(KEY));
  assert.ok(!util.inspect(c).includes(KEY));
}));

test('route models get capabilities [], local false and strengths "" when they are omitted', () => withTmp(async (root) => {
  const cwd = path.join(root, 'repo');
  writeJson(path.join(cwd, 'gemini-core.config.json'), { route: { models: [{ id: 'm1', tier: 1, contextWindow: 1000, efforts: ['low', 'high'] }] } });
  const [m] = loadConfig({ env: { GEMINI_CORE_HOME: path.join(root, 'home') }, cwd }).route.models;
  assert.deepEqual(m.capabilities, []);
  assert.equal(m.local, false);
  assert.equal(m.strengths, '');
}));

const BAD_MODEL_FIELDS = [
  [{ capabilities: 'tools' }, /capabilities must be an array of strings/],
  [{ capabilities: ['tools', 3] }, /capabilities must be an array of strings/],
  [{ local: 'yes' }, /local must be true or false/],
  [{ strengths: 5 }, /strengths must be a string/],
  ['m1', /route\.models entries must be objects/],
];

for (const [entry, pattern] of BAD_MODEL_FIELDS) {
  test(`a route model with a malformed field is refused: ${JSON.stringify(entry)}`, () => withTmp(async (root) => {
    const base = { id: 'm1', tier: 1, contextWindow: 1000, efforts: ['low', 'high'] };
    const model = typeof entry === 'string' ? entry : { ...base, ...entry };
    const overrides = { route: { models: [model] } };
    assert.throws(() => loadConfig({ env: { GEMINI_CORE_HOME: root }, cwd: root, overrides }), pattern);
  }));
}

test('a config file with a prototype key is refused and pollutes nothing', () => withTmp(async (root) => {
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  const env = { GEMINI_CORE_HOME: path.join(root, 'home') };
  fs.writeFileSync(path.join(cwd, 'gemini-core.config.json'), '{"__proto__": {"polluted": 1}, "gemini": {}}');
  assert.throws(() => loadConfig({ env, cwd }), /"__proto__" is not allowed as a config key/);
  fs.writeFileSync(path.join(cwd, 'gemini-core.config.json'), '{"gemini": {"__proto__": {"polluted": 1}}}');
  assert.throws(() => loadConfig({ env, cwd }), /"__proto__" is not allowed/);
  assert.equal({}.polluted, undefined);
}));

test('redact leaves literals and type names as key values alone, but not credentials or quoted values', () => {
  for (const text of ['auth: true', 'const token: string = input', 'token=None', 'secret: undefined', 'password: NULL', 'apiKey: number', 'pwd = bool']) {
    assert.equal(redact(text), text, text);
    assert.equal(SECRET.test(text), false, text);
  }
  for (const text of ['password: truely-secret-9', 'password: "true"', "token: 'false'", 'password: nullable1', 'secret: string-value-9']) {
    assert.ok(redact(text).includes(REDACTED), text);
  }
});

test('redact stays fast on long inputs that could backtrack', () => {
  for (const text of ['a'.repeat(1e6), 'token'.repeat(2e5), 'x_token '.repeat(1e5), 'token: true '.repeat(1e5)]) {
    const t0 = performance.now();
    redact(text);
    assert.ok(performance.now() - t0 < 2000);
  }
});
