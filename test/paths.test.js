import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWithin, realOrSelf, realWithinAny } from '../src/paths.js';

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-paths-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('isWithin accepts the base itself and children, and rejects parents, siblings with a shared prefix and other drives', () => withDir((dir) => {
  assert.equal(isWithin(dir, dir), true);
  assert.equal(isWithin(dir, path.join(dir, 'a', 'b')), true);
  assert.equal(isWithin(dir, path.dirname(dir)), false);
  assert.equal(isWithin(dir, `${dir}-sibling`), false);
  assert.equal(isWithin(dir, path.join(dir, '..', 'x')), false);
  assert.equal(isWithin(dir, path.parse(dir).root), false);
}));

test('isWithin ignores case on win32 only', () => withDir((dir) => {
  assert.equal(isWithin(dir, path.join(dir.toUpperCase(), 'x')), process.platform === 'win32');
}));

test('realOrSelf resolves an existing folder, keeps a missing leaf and resolves a link in the existing parent', () => withDir((dir) => {
  const real = fs.realpathSync.native(dir);
  assert.equal(realOrSelf(dir), real);
  assert.equal(realOrSelf(path.join(dir, 'missing', 'deeper')), path.join(real, 'missing', 'deeper'));
  const target = path.join(dir, 'target');
  const link = path.join(dir, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'junction');
  assert.equal(realOrSelf(path.join(link, 'missing')), path.join(fs.realpathSync.native(target), 'missing'));
}));

test('realOrSelf treats a path below a regular file as missing instead of throwing ENOTDIR', () => withDir((dir) => {
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'x');
  const below = path.join(file, 'child', 'deeper');
  assert.equal(realOrSelf(below), path.join(fs.realpathSync.native(file), 'child', 'deeper'));
  assert.equal(realWithinAny([dir], below).ok, true);
  assert.equal(realWithinAny([path.join(dir, 'other')], below).ok, false);
}));

test('isWithin and realWithinAny refuse a sibling whose name only Unicode case folding makes equal', (t) => withDir((dir) => {
  const allowed = path.join(dir, 'projK'); // ASCII K
  const sibling = path.join(dir, 'proj\u212A'); // KELVIN SIGN, lowercases to ASCII k
  fs.mkdirSync(allowed);
  try {
    fs.mkdirSync(sibling);
  } catch (err) {
    t.skip(`file system refused to create "proj\\u212A" next to "projK" (${err.code})`);
    return;
  }
  if (fs.readdirSync(dir).length !== 2) {
    t.skip('file system stores "projK" and "proj\\u212A" as one folder');
    return;
  }
  assert.equal(isWithin(allowed, sibling), false);
  assert.equal(isWithin(allowed, path.join(sibling, 'secret.txt')), false);
  assert.equal(realWithinAny([allowed], sibling).ok, false);
  assert.equal(realWithinAny([allowed], path.join(sibling, 'secret.txt')).ok, false);
  assert.equal(realWithinAny([allowed], path.join(allowed, 'inside.txt')).ok, true);
}));

test('realWithinAny accepts an ASCII-case-different spelling of an allowed folder on win32', { skip: process.platform !== 'win32' && 'case-insensitive names are a win32 behaviour' }, () => withDir((dir) => {
  const allowed = path.join(dir, 'Allowed');
  fs.mkdirSync(path.join(allowed, 'Sub'), { recursive: true });
  const respelled = path.join(dir.toUpperCase(), 'aLLOWED', 'sub', 'missing');
  const res = realWithinAny([allowed], respelled);
  assert.equal(res.ok, true);
  assert.equal(res.real, path.join(fs.realpathSync.native(allowed), 'Sub', 'missing'));
  assert.equal(realWithinAny([path.join(dir.toLowerCase(), 'allowed')], path.join(allowed, 'Sub')).ok, true);
}));

test('isWithin compares ASCII case only and keeps the separator boundary', () => {
  const root = path.parse(process.cwd()).root;
  const base = path.join(root, 'a', 'b');
  assert.equal(isWithin(base, path.join(root, 'a', 'bc')), false);
  assert.equal(isWithin(base, path.join(base, '..', 'bc')), false);
  assert.equal(isWithin(base, `${base}${path.sep}`), true);
  assert.equal(isWithin(root, path.join(root, 'x')), true);
  assert.equal(isWithin(path.join(root, 'caf\u00e9'), path.join(root, 'CAF\u00c9', 'x')), false);
});

test('realWithinAny refuses a junction that leads outside every base', () => withDir((dir) => {
  const inside = path.join(dir, 'inside');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  const link = path.join(inside, 'link');
  fs.symlinkSync(outside, link, 'junction');
  assert.equal(realWithinAny([inside], path.join(inside, 'plain')).ok, true);
  const bad = realWithinAny([inside], link);
  assert.equal(bad.ok, false);
  assert.equal(bad.real, fs.realpathSync.native(outside));
  assert.equal(realWithinAny([inside, outside], link).ok, true);
}));
