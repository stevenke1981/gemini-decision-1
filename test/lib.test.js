import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../src/lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the library entry exports the public functions and the error class', () => {
  for (const name of ['loadConfig', 'createEngine', 'createHttpServer', 'startHttp', 'createMcpServer', 'createMemoryStore']) {
    assert.equal(typeof lib[name], 'function', `${name} should be a function`);
  }
  assert.equal(typeof lib.DecisionError, 'function');
  assert.ok(lib.DecisionError.prototype instanceof Error);
  assert.ok(lib.InputError.prototype instanceof TypeError);
  assert.equal(new lib.InputError('x').code, 'INVALID_INPUT');
});

test('the library entry exports VERSION as the package.json version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(typeof lib.VERSION, 'string');
  assert.ok(lib.VERSION.length > 0);
  assert.equal(lib.VERSION, pkg.version);
});
