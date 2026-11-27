import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, ledgerRecord, LEDGER_FIELDS } from '../src/ledger.js';

/** A temp folder, removed afterwards. */
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-ledger-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DECISION = {
  kind: 'route',
  source: 'gemini',
  result: { model: 'claude-sonnet-5-5', task: 'PRIVATE TASK TEXT' },
  confidence: 0.9,
  reasons: ['quoted the task: PRIVATE TASK TEXT'],
  cost: 0.0001,
  tokens: { input: 1000 },
  calls: 1,
  latencyMs: 12,
  summary: 'route: claude-sonnet-5-5 / medium',
};

test('ledgerRecord keeps only the whitelisted fields, with a timestamp and nulls for absent ones', () => {
  const rec = ledgerRecord(DECISION, new Date('2026-11-04T00:00:00.000Z'));
  assert.equal(rec.ts, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(Object.keys(rec).sort(), ['ts', ...LEDGER_FIELDS].sort());
  assert.equal(rec.error, null);
  assert.equal(rec.summary, 'route: claude-sonnet-5-5 / medium');
  assert.equal(JSON.stringify(rec).includes('PRIVATE'), false);

  const failed = ledgerRecord({ kind: 'skills', source: null, error: 'Gemini HTTP 500: x' });
  assert.equal(failed.source, null);
  assert.equal(failed.calls, null);
  assert.equal(failed.error, 'Gemini HTTP 500: x');
});

test('append writes one JSON line per decision, in order, creating missing folders', () => withDir((dir) => {
  const file = path.join(dir, 'nested', 'deeper', 'decisions.jsonl');
  const ledger = createLedger({ path: file, enabled: true });
  ledger.append({ ...DECISION, kind: 'route' });
  ledger.append({ ...DECISION, kind: 'compress', source: 'settled', calls: 0, cost: null });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ['route', 'compress']);
  assert.equal(lines[1].source, 'settled');
  assert.equal(lines[1].cost, null);
  assert.deepEqual(lines[0].tokens, { input: 1000 });
}));

test('a disabled ledger is a no-op, even with a path that cannot be written', () => withDir((dir) => {
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const ledger = createLedger({ path: path.join(blocker, 'decisions.jsonl'), enabled: false });
  assert.doesNotThrow(() => ledger.append(DECISION));
  const plain = createLedger({ path: path.join(dir, 'off.jsonl'), enabled: false });
  plain.append(DECISION);
  assert.equal(fs.existsSync(path.join(dir, 'off.jsonl')), false);
}));

test('a write failure is reported to stderr once and never throws', () => withDir((dir) => {
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const ledger = createLedger({ path: path.join(blocker, 'decisions.jsonl'), enabled: true });
  const original = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    assert.doesNotThrow(() => ledger.append(DECISION));
    assert.doesNotThrow(() => ledger.append(DECISION));
    assert.doesNotThrow(() => ledger.append(DECISION));
  } finally {
    process.stderr.write = original;
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0], /decision ledger not written/);
}));

test('an enabled ledger needs a path', () => {
  assert.throws(() => createLedger({ enabled: true }), (err) => err instanceof TypeError && /path must be a string/.test(err.message));
  assert.doesNotThrow(() => createLedger({ enabled: false }));
});

test('a failed decision is written with a null source and null summary', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  createLedger({ path: file, enabled: true }).append({
    kind: 'memory_write', source: null, result: null, reasons: [], cost: null, tokens: null, calls: 0,
    latencyMs: 3, error: 'Gemini abstained', summary: null,
  });
  const [line] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(line.source, null);
  assert.equal(line.error, 'Gemini abstained');
  assert.equal(line.summary, null);
  assert.equal(line.calls, 0);
}));

const POSIX_ONLY = { skip: process.platform === 'win32' && 'file modes are not enforced on Windows' };

/** The size in bytes of one ledger line for DECISION. */
function lineBytes() {
  return Buffer.byteLength(`${JSON.stringify(ledgerRecord(DECISION))}\n`, 'utf8');
}

test('the ledger file is created private (0o600)', POSIX_ONLY, () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  createLedger({ path: file }).append(DECISION);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}));

test('without maxBytes the ledger never rotates', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  const ledger = createLedger({ path: file, maxBytes: undefined });
  for (let i = 0; i < 20; i += 1) ledger.append(DECISION);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 20);
  assert.equal(fs.existsSync(`${file}.1`), false);
}));

test('with maxBytes a full ledger moves to <file>.1, replacing the old one, and a new file starts', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  const ledger = createLedger({ path: file, maxBytes: lineBytes() * 2 + 10 });
  for (const kind of ['a', 'b', 'c', 'd', 'e']) ledger.append({ ...DECISION, kind });
  const kindsIn = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
  assert.deepEqual(kindsIn(file), ['e']);
  assert.deepEqual(kindsIn(`${file}.1`), ['c', 'd']);
}));

test('a single line larger than maxBytes is still written, to a fresh file', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  const ledger = createLedger({ path: file, maxBytes: 1 });
  ledger.append(DECISION);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.1`), false);
  ledger.append(DECISION);
  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
}));

test('a rotation failure is reported once and never throws', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(file, `${'x'.repeat(100)}\n`);
  fs.mkdirSync(`${file}.1`); // a non-empty folder cannot be replaced by the rename
  fs.writeFileSync(path.join(`${file}.1`, 'keep'), 'x');
  const ledger = createLedger({ path: file, maxBytes: 50 });
  const original = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    assert.doesNotThrow(() => ledger.append(DECISION));
    assert.doesNotThrow(() => ledger.append(DECISION));
  } finally {
    process.stderr.write = original;
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0], /decision ledger not written/);
  // the records are still appended after the failed rotation, and nothing is left aside
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1 + 2);
  assert.equal(lines[0], 'x'.repeat(100));
  assert.equal(JSON.parse(lines[2]).kind, 'route');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.rotating')), []);
}));

test('a rotator that measured a stale size does not clobber <file>.1 with a fresh file', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  const max = lineBytes() * 3 + 10;
  const a = createLedger({ path: file, maxBytes: max });
  const b = createLedger({ path: file, maxBytes: max });
  for (const kind of ['o1', 'o2', 'o3']) a.append({ ...DECISION, kind });
  const kindsIn = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
  // B measures the full file; before it renames, A rotates it and appends to the fresh one.
  const realStat = fs.statSync;
  let fired = false;
  fs.statSync = (...args) => {
    const st = realStat(...args);
    if (!fired && args[0] === file) {
      fired = true;
      a.append({ ...DECISION, kind: 'A' });
    }
    return st;
  };
  try {
    b.append({ ...DECISION, kind: 'B' });
  } finally {
    fs.statSync = realStat;
  }
  assert.deepEqual(kindsIn(`${file}.1`), ['o1', 'o2', 'o3']);
  assert.deepEqual(kindsIn(file), ['A', 'B']);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.rotating')), []);
}));

test('maxBytes must be a positive integer when given', () => {
  for (const bad of [0, -1, 1.5, '10', null, NaN]) {
    assert.throws(() => createLedger({ path: 'x.jsonl', maxBytes: bad }), TypeError, String(bad));
  }
});
