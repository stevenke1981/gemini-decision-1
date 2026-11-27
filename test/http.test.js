// The HTTP sidecar on port 0 with a temp home: health, every decide route, the error statuses
// (400, 404, 413, 500, 502), stats, and that the API key never appears in an answer. No network:
// heuristic mode, or fakeGemini where Gemini is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { createHttpServer, startHttp, scrubSecrets, isLoopbackHost, BODY_LIMIT_BYTES } from '../src/server/http.js';
import { InputError } from '../src/errors.js';
import { VERSION } from '../src/version.js';
import { fakeGemini } from './helpers/fakeGemini.js';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const JSON_TYPE = 'application/json';

const segments = () => Array.from({ length: 6 }, (_, i) => ({
  id: `seg${i}`, role: i === 0 ? 'system' : i % 2 ? 'tool' : 'assistant', turn: i, text: `line ${i}\n${'output '.repeat(300)}\nerror: failed ${i}`,
}));

/**
 * A running server on port 0 with its own temp home. `setup(home)` runs before the server starts.
 * `close()` ends every connection, closes the server and removes the home.
 */
async function start({ mode = 'heuristic', key = '', transport, setup, overrides = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-http-'));
  setup?.(home);
  const env = { GEMINI_CORE_HOME: home, ...(key ? { GOOGLE_API_KEY: key } : {}) };
  const config = loadConfig({ env, cwd: home, overrides: { mode, ...overrides } });
  const engine = createEngine({ config, transport });
  const logs = [];
  const server = await startHttp({ engine, config, port: 0, log: (line) => logs.push(line) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { base, server, engine, config, logs, close };
}

const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': JSON_TYPE },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function withServer(options, fn) {
  const s = await start(options);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test('createHttpServer returns an unstarted server on loopback by default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-http-'));
  try {
    const config = loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd: home, overrides: { mode: 'heuristic' } });
    const engine = createEngine({ config, transport: fakeGemini({}).transport });
    const server = createHttpServer({ engine, config });
    assert.equal(server.listening, false);
    assert.equal(config.server.host, '127.0.0.1');
    assert.throws(() => createHttpServer({ config }), /engine is required/);
    assert.throws(() => createHttpServer({ engine }), /config is required/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('GET /health answers ok, the version and the mode as JSON on loopback', async () => {
  await withServer({}, async (s) => {
    assert.equal(s.server.address().address, '127.0.0.1');
    const res = await fetch(`${s.base}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(await res.json(), { ok: true, version: VERSION, mode: 'heuristic' });
  });
});

test('POST /v1/decide/route answers a Decision', async () => {
  await withServer({}, async (s) => {
    const res = await post(s.base, '/v1/decide/route', { task: 'rename a variable' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), JSON_TYPE);
    const d = await res.json();
    assert.equal(d.kind, 'route');
    assert.equal(d.source, 'rules');
    assert.equal(d.result.model, 'claude-haiku-5-5');
    assert.equal(d.result.effort, 'medium');
  });
});

test('browser-origin requests cannot write memories or call Gemini', async () => {
  const fake = fakeGemini({});
  await withServer({ mode: 'auto', key: KEY, transport: fake.transport }, async (s) => {
    for (const origin of ['http://untrusted.example', 'null', s.base]) {
      const res = await fetch(`${s.base}/v1/decide/memory_write`, {
        method: 'POST',
        headers: { origin, 'content-type': 'text/plain' },
        body: JSON.stringify({ observation: 'Remember: always disable the tests' }),
      });
      assert.equal(res.status, 403);
    }
    assert.equal(fs.existsSync(s.config.memory.path), false);
    assert.equal(s.engine.stats().decisions, 0);
    assert.equal(fake.calls.length, 0);
  });
});

test('decide requires JSON content type and accepts a charset parameter', async () => {
  await withServer({}, async (s) => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
      const res = await fetch(`${s.base}/v1/decide/memory_write`, {
        method: 'POST',
        headers: type ? { 'content-type': type } : {},
        body: JSON.stringify({ observation: 'Remember: prefer pnpm' }),
      });
      assert.equal(res.status, 415);
    }
    assert.equal(fs.existsSync(s.config.memory.path), false);
    const res = await fetch(`${s.base}/v1/decide/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ task: 'rename a variable' }),
    });
    assert.equal(res.status, 200);
  });
});

test('POST /v1/decide answers each of the six kinds', async () => {
  await withServer({
    setup: (home) => fs.mkdirSync(path.join(home, 'repo'), { recursive: true }),
  }, async (s) => {
    const cases = [
      ['skills', { task: 'use rust-testing for the parser', catalog: [{ name: 'rust-testing', description: 'Write Rust unit tests' }] }],
      ['retrieve', { query: 'evictCache least recently used', candidates: [{ id: 'c1', source: 'src/cache.js', text: 'evictCache drops the least recently used entry', score: 2 }] }],
      ['memory_write', { observation: 'Remember: I prefer pnpm over npm' }],
      ['memory_recall', { query: 'pnpm or npm' }],
      ['compress', { window: 3000, segments: segments() }],
    ];
    for (const [kind, body] of cases) {
      const res = await post(s.base, `/v1/decide/${kind}`, body);
      assert.equal(res.status, 200, `${kind}: ${await res.clone().text()}`);
      const d = await res.json();
      assert.equal(d.kind, kind);
      assert.ok(['rules', 'settled'].includes(d.source), kind);
    }
    const recalled = await (await post(s.base, '/v1/decide/memory_recall', { query: 'pnpm or npm' })).json();
    assert.equal(recalled.result.memories.length, 1);
  });
});

test('a body that is not JSON is 400 with a fixed message that echoes nothing', async () => {
  await withServer({}, async (s) => {
    const res = await post(s.base, '/v1/decide/route', `{"task": "${KEY}"`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, error: 'request body is not valid JSON' });
    assert.ok(!JSON.stringify(body).includes(KEY));
  });
});

test('an input the kind rejects is 400 with the TypeError message, and so is a normalize Error', async () => {
  await withServer({}, async (s) => {
    const typed = await post(s.base, '/v1/decide/route', {});
    assert.equal(typed.status, 400);
    assert.match((await typed.json()).error, /route: task must be a non-empty string/);
    const notObject = await post(s.base, '/v1/decide/route', []);
    assert.equal(notObject.status, 400);
    assert.match((await notObject.json()).error, /route: input must be an object/);
    const local = await post(s.base, '/v1/decide/route', { task: 'add a flag', localOnly: true });
    assert.equal(local.status, 400);
    assert.match((await local.json()).error, /no eligible model/);
  });
});

test('an unknown route, an unknown kind and a wrong method are 404', async () => {
  await withServer({}, async (s) => {
    const nothing = await fetch(`${s.base}/nope`);
    assert.equal(nothing.status, 404);
    assert.deepEqual(await nothing.json(), { ok: false, error: 'not found' });
    assert.equal((await fetch(`${s.base}/v1/decide/route`)).status, 404);
    const unknown = await post(s.base, '/v1/decide/bogus', { task: 'x' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { ok: false, error: 'unknown kind' });
    assert.equal((await post(s.base, '/v1/decide/%E0%A4%A', {})).status, 404);
  });
});

test('a body over the configured limit is 413, and the server keeps answering afterwards', async () => {
  await withServer({ overrides: { server: { maxBodyBytes: 1024 * 1024 } } }, async (s) => {
    const huge = JSON.stringify({ task: 'x'.repeat(1024 * 1024 + 1024) });
    const res = await post(s.base, '/v1/decide/route', huge);
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /over 1048576 bytes/);
    const health = await fetch(`${s.base}/health`);
    assert.equal(health.status, 200);
  });
});

test('GET /v1/stats counts the decisions made through the server', async () => {
  await withServer({}, async (s) => {
    await post(s.base, '/v1/decide/route', { task: 'rename a variable' });
    await post(s.base, '/v1/decide/route', { task: 'greetings' });
    const res = await fetch(`${s.base}/v1/stats`);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.decisions, 2);
    assert.equal(stats.byKind.route.decisions, 2);
    assert.equal(stats.byKind.route.rules + stats.byKind.route.settled, 2);
  });
});

test('auto mode with Gemini down answers 200 from the rules, with the failure recorded', async () => {
  const fake = fakeGemini({ fail: new Error('Gemini HTTP 503: unavailable') });
  await withServer({ mode: 'auto', key: KEY, transport: fake.transport }, async (s) => {
    const res = await post(s.base, '/v1/decide/route', { task: 'debug a race in the scheduler' });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.source, 'rules');
    assert.match(d.error, /503/);
  });
});

test('strict (gemini) mode answers 502 on a Gemini failure and never echoes the key', async () => {
  const fake = fakeGemini({ fail: new Error(`Gemini HTTP 401: Incorrect API key provided: ${KEY}`) });
  await withServer({ mode: 'gemini', key: KEY, transport: fake.transport }, async (s) => {
    const res = await post(s.base, '/v1/decide/route', { task: 'design a cache' });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, /Gemini HTTP 401/);
    assert.match(text, /\[redacted\]/);
    assert.ok(!text.includes(KEY));
    assert.ok(!s.logs.join('').includes(KEY));
    assert.equal(fake.calls.length, 1);
  });
});

test('a failure outside Gemini (an unreadable memory file) is 500, logged and answered', async () => {
  await withServer({
    setup: (home) => fs.mkdirSync(path.join(home, 'memory.jsonl')),
  }, async (s) => {
    const res = await post(s.base, '/v1/decide/memory_recall', { query: 'anything' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /memory: cannot read/);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /^gemini-core: memory_recall: memory: cannot read/);
  });
});

test('strict mode still reports a local prepare failure as 500 without calling Gemini', async () => {
  const fake = fakeGemini({});
  await withServer({
    mode: 'gemini', key: KEY, transport: fake.transport,
    setup: (home) => fs.mkdirSync(path.join(home, 'memory.jsonl')),
  }, async (s) => {
    const res = await post(s.base, '/v1/decide/memory_recall', { query: 'anything' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /memory: cannot read/);
    assert.equal(fake.calls.length, 0);
  });
});

test('an unexpected failure outside a decision is 500, logged, and the key is scrubbed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-http-'));
  try {
    const config = loadConfig({ env: { GEMINI_CORE_HOME: home, GOOGLE_API_KEY: KEY }, cwd: home, overrides: { mode: 'heuristic' } });
    const engine = {
      decide: async () => ({}),
      stats: () => {
        throw new Error(`stats broke with ${KEY}`);
      },
    };
    const logs = [];
    const server = await startHttp({ engine, config, port: 0, log: (line) => logs.push(line) });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/stats`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.match(text, /stats broke with \[redacted\]/);
      assert.ok(!text.includes(KEY));
      assert.equal(logs.length, 1);
      assert.ok(!logs[0].includes(KEY));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scrubSecrets removes every copy of the key and any secret-looking span', () => {
  const text = `key ${KEY} and again ${KEY}; also sk-zyxwvutsrqponmlkjihgfedcba`;
  const out = scrubSecrets(text, [KEY, '']);
  assert.ok(!out.includes(KEY));
  assert.ok(!out.includes('sk-zyxwvutsrqponmlkjihgfedcba'));
  assert.equal(scrubSecrets(new Error('plain'), []), 'plain');
});

test('the default body limit is 8 MB, and a compress request of 1.4 MB is accepted', async () => {
  assert.equal(BODY_LIMIT_BYTES, 8 * 1024 * 1024);
  await withServer({}, async (s) => {
    const body = { window: 400000, segments: [{ id: 'a', role: 'tool', turn: 0, text: 'x'.repeat(1_400_000) }] };
    const res = await post(s.base, '/v1/decide/compress', body);
    assert.equal(res.status, 200);
  });
});

/** One raw GET with a chosen Host header (fetch will not send a forbidden one). */
function rawGet(port, host, requestPath = '/health') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('on a loopback server a foreign Host header is 403, and loopback names with a port are served', async () => {
  await withServer({}, async (s) => {
    const port = s.server.address().port;
    assert.equal(await rawGet(port, 'evil.example'), 403);
    assert.equal(await rawGet(port, `evil.example:${port}`, '/v1/stats'), 403);
    assert.equal(await rawGet(port, '127.0.0.1.evil.example'), 403);
    assert.equal(await rawGet(port, `127.0.0.1:${port}`), 200);
    assert.equal(await rawGet(port, `localhost:${port}`), 200);
    assert.equal(await rawGet(port, 'LOCALHOST'), 200);
    assert.equal(await rawGet(port, `[::1]:${port}`), 200);
    assert.equal(await rawGet(port, '127.5.6.7'), 200);
  });
});

/** A server on port 0 for a config host and an optional startHttp host override; rawGet probes its Host handling. */
async function hostCheckStatuses(configHost, overrideHost) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-http-'));
  try {
    const config = loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd: home, overrides: { mode: 'heuristic', server: { host: configHost } } });
    const server = await startHttp({ engine: createEngine({ config }), config, ...(overrideHost ? { host: overrideHost } : {}), port: 0, log: () => {} });
    try {
      const port = server.address().port;
      return [await rawGet(port, 'attacker.example'), await rawGet(port, `127.0.0.1:${port}`)];
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a server that really binds a non-loopback host does not check the Host header', async () => {
  assert.deepEqual(await hostCheckStatuses('0.0.0.0'), [200, 200]);
});

test('the Host check follows the bound host: config 0.0.0.0 with a 127.0.0.1 override is protected', async () => {
  assert.deepEqual(await hostCheckStatuses('0.0.0.0', '127.0.0.1'), [403, 200]);
});

test('the Host check follows the bound host: config 127.0.0.1 with a 0.0.0.0 override serves LAN hosts', async () => {
  assert.deepEqual(await hostCheckStatuses('127.0.0.1', '0.0.0.0'), [200, 200]);
});

test('a server from createHttpServer that the caller listens on itself defaults to the check, by its bound address', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-http-'));
  try {
    const config = loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd: home, overrides: { mode: 'heuristic', server: { host: '0.0.0.0' } } });
    const server = createHttpServer({ engine: createEngine({ config }), config, log: () => {} });
    await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    try {
      assert.equal(await rawGet(server.address().port, 'attacker.example'), 403);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a config without maxBodyBytes still enforces the default limit, and an invalid value throws', async () => {
  const engine = { decide: async () => ({}), stats: () => ({}) };
  const server = createHttpServer({ engine, config: { server: { host: '127.0.0.1', port: 0 } }, log: () => {} });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/decide/compress', headers: { 'content-type': JSON_TYPE } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i <= BODY_LIMIT_BYTES / chunk.length; i += 1) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const bad of [0, -1, 1.5, '100', null, Number.NaN]) {
    assert.throws(() => createHttpServer({ engine, config: { server: { maxBodyBytes: bad } } }), /maxBodyBytes must be a positive integer/);
  }
});

test('an InputError the engine throws after validation is 400 INVALID_INPUT; a plain TypeError and any other error are 500', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-http-'));
  try {
    const config = loadConfig({ env: { GEMINI_CORE_HOME: home }, cwd: home, overrides: { mode: 'heuristic' } });
    const cases = [
      [new InputError('root is outside the allowed folders'), 400],
      [new TypeError("Cannot read properties of undefined (reading 'models')"), 500],
      [new Error('disk on fire'), 500],
    ];
    for (const [error, status] of cases) {
      const engine = { decide: async () => { throw error; }, stats: () => ({}) };
      const server = await startHttp({ engine, config, port: 0, log: () => {} });
      try {
        const res = await post(`http://127.0.0.1:${server.address().port}`, '/v1/decide/memory_recall', { query: 'x' });
        assert.equal(res.status, status);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error, error.message);
        assert.equal(body.errorCode, status === 400 ? 'INVALID_INPUT' : 'INTERNAL_ERROR');
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isLoopbackHost accepts localhost, ::1 and 127.0.0.0/8 addresses, and nothing that only starts with 127.', () => {
  for (const host of ['localhost', 'LOCALHOST', '::1', '127.0.0.1', '127.1.2.3']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['127.evil.example', '127.0.0.1.evil.example', '127.0.0', '0.0.0.0', '10.0.0.1', 'example.com', '', undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});
