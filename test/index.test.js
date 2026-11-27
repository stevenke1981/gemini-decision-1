import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkFile, assertChunkOptions } from '../src/index/chunker.js';
import { createRepoIndex, createRepoIndexAsync } from '../src/index/repo.js';
import { loadConfig } from '../src/config.js';

const numbered = (n) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n');

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-index-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cfgFor(dir, retrieve = {}) {
  return loadConfig({ env: { GEMINI_CORE_HOME: dir }, cwd: dir, overrides: { retrieve } });
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test('chunkFile windows overlap by chunkOverlap lines and the last window ends at the final line', () => {
  const chunks = chunkFile('src/a.js', numbered(10), { chunkLines: 4, chunkOverlap: 1 });
  assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine]), [[1, 4], [4, 7], [7, 10]]);
  assert.deepEqual(chunks.map((c) => c.id), ['src/a.js#1', 'src/a.js#4', 'src/a.js#7']);
  assert.equal(chunks[1].text, 'line4\nline5\nline6\nline7');
  assert.equal(chunks[2].text, 'line7\nline8\nline9\nline10');
  assert.ok(chunks.every((c) => c.source === 'src/a.js' && Object.isFrozen(c)));
});

test('chunkFile numbers lines from 1, drops the final newline and never adds an empty last window', () => {
  assert.deepEqual(chunkFile('a.txt', 'one\ntwo\n', { chunkLines: 4, chunkOverlap: 0 }).map((c) => [c.id, c.text, c.endLine]), [['a.txt#1', 'one\ntwo', 2]]);
  const exact = chunkFile('b.txt', numbered(8), { chunkLines: 4, chunkOverlap: 0 });
  assert.deepEqual(exact.map((c) => [c.startLine, c.endLine]), [[1, 4], [5, 8]]);
  const single = chunkFile('c.txt', numbered(3), { chunkLines: 40, chunkOverlap: 10 });
  assert.equal(single.length, 1);
  assert.equal(single[0].endLine, 3);
  assert.equal(chunkFile('d.txt', numbered(3)).length, 1, 'the retrieve config values are the defaults');
});

test('chunkFile accepts CRLF and gives the same windows as LF with LF text', () => {
  const lf = 'a\nb\nc\nd\ne';
  const crlf = 'a\r\nb\r\nc\r\nd\r\ne\r\n';
  const opts = { chunkLines: 2, chunkOverlap: 0 };
  const fromCrlf = chunkFile('x.txt', crlf, opts);
  assert.deepEqual(fromCrlf.map((c) => [c.startLine, c.endLine]), [[1, 2], [3, 4], [5, 5]]);
  assert.deepEqual(fromCrlf, chunkFile('x.txt', lf, opts));
  assert.ok(fromCrlf.every((c) => !c.text.includes('\r')));
});

test('chunkFile returns no chunks for an empty file and writes ids with posix paths', () => {
  assert.deepEqual(chunkFile('a.js', '', { chunkLines: 4, chunkOverlap: 1 }), []);
  assert.deepEqual(chunkFile('a.js', ' \r\n\t\n', { chunkLines: 4, chunkOverlap: 1 }), []);
  assert.equal(chunkFile('src\\lib\\a.js', 'x')[0].id, 'src/lib/a.js#1');
  assert.equal(chunkFile('./top.js', 'x')[0].source, 'top.js');
  assert.equal(chunkFile(' spaced.js', 'x')[0].source, ' spaced.js', 'the name is kept as the index lists it');
});

test('chunkFile and assertChunkOptions reject bad paths, text and window options', () => {
  const type = (fn, re) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message));
  type(() => chunkFile('', 'x'), /relPath/);
  type(() => chunkFile('a.js', 5), /text must be a string/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 0 }), /chunkLines/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 2.5 }), /chunkLines/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 4, chunkOverlap: 4 }), /chunkOverlap/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 4, chunkOverlap: -1 }), /chunkOverlap/);
  assert.doesNotThrow(() => assertChunkOptions({ chunkLines: 4, chunkOverlap: 3 }));
});

test('createRepoIndex skips ignored folders, nested ignored folders and unlisted extensions', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    'src/a.js': 'const a = 1;\n',
    'src/UPPER.JS': 'const u = 2;\n',
    'src/logo.png': 'not listed\n',
    'src/deep/node_modules/x.js': 'nested ignored\n',
    'node_modules/pkg/index.js': 'ignored\n',
    '.git/hooks/pre.js': 'ignored\n',
    'dist/bundle.js': 'ignored\n',
    'docs/readme.md': '# Title\nbody\n',
    'docs/data.log': 'not listed\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['docs/readme.md', 'src/UPPER.JS', 'src/a.js']);
  assert.ok(index.chunks.every((c) => !c.source.includes('node_modules') && !c.source.endsWith('.png')));
}));

test('createRepoIndex skips files over maxFileBytes and files with a NUL byte in the first 8 KB only', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    'big.js': 'y'.repeat(25000),
    'bin.js': Buffer.from('ab\u0000cd'),
    'late-nul.js': `${'z'.repeat(9000)}\u0000tail\n`,
    'small.js': 'ok\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir, { maxFileBytes: 20000 }).retrieve);
  assert.deepEqual(index.files, ['late-nul.js', 'small.js']);
}));

test('createRepoIndex stops at maxFiles and visits folders depth first in name order', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'z.js': 'z\n', 'a/x.js': 'x\n', 'b.js': 'b\n' });
  const index = createRepoIndex(repo, cfgFor(dir, { maxFiles: 2 }).retrieve);
  assert.deepEqual(index.files, ['a/x.js', 'b.js']);
  assert.ok(index.chunks.every((c) => index.files.includes(c.source)));
}));

// A junction needs no privilege on Windows; on Linux and macOS it is an ordinary symlink.
test('createRepoIndex never follows a symlinked or junctioned folder', () => withDir(async (dir) => {
  const outside = path.join(dir, 'outside');
  const repo = path.join(dir, 'repo');
  writeFiles(outside, { 'secret.js': 'const LEAK_MARKER = 1;\n' });
  writeFiles(repo, { 'src/a.js': 'const ok = 1;\n' });
  fs.symlinkSync(outside, path.join(repo, 'linked'), 'junction');
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['src/a.js']);
  assert.ok(!index.chunks.some((c) => c.text.includes('LEAK_MARKER')));
}));

test('createRepoIndex never follows a symlinked file', (t) => withDir(async (dir) => {
  const outside = path.join(dir, 'outside');
  const repo = path.join(dir, 'repo');
  writeFiles(outside, { 'secret.js': 'const LEAK_MARKER = 1;\n' });
  writeFiles(repo, { 'src/a.js': 'const ok = 1;\n' });
  try {
    fs.symlinkSync(path.join(outside, 'secret.js'), path.join(repo, 'leak.js'), 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('creating a file symlink needs a privilege on this machine');
    throw err;
  }
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['src/a.js']);
  assert.ok(!index.chunks.some((c) => c.text.includes('LEAK_MARKER')));
}));

test('createRepoIndex windows each file with posix ids and freezes the index', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'src/a.js': `${numbered(10)}\n` });
  const index = createRepoIndex(repo, cfgFor(dir, { chunkLines: 4, chunkOverlap: 1 }).retrieve);
  assert.deepEqual(index.files, ['src/a.js']);
  assert.deepEqual(index.chunks.map((c) => c.id), ['src/a.js#1', 'src/a.js#4', 'src/a.js#7']);
  assert.ok(Object.isFrozen(index) && Object.isFrozen(index.files) && Object.isFrozen(index.chunks));
}));

test('search ranks the best chunk first, matches file names too, and returns new scored objects', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    'src/cache.js': 'function cacheGet(key) {\n  return store.get(key);\n}\n// cache lookup and cache fill\n',
    'src/parse.js': 'export function parse(text) {\n  return text.trim();\n}\n',
    'src/eviction.js': 'export const limit = 10;\n',
    'docs/notes.md': 'Weekly notes about the release.\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  const hits = index.search('cache lookup', 2);
  assert.equal(hits[0].id, 'src/cache.js#1');
  assert.ok(hits.length <= 2 && typeof hits[0].score === 'number' && hits[0].score > 0);
  assert.ok(Object.isFrozen(hits[0]) && !index.chunks.includes(hits[0]));
  assert.deepEqual(index.search('eviction').map((c) => c.id), ['src/eviction.js#1']);
  assert.deepEqual(index.search('zzzz'), []);
  assert.throws(() => index.search(5), TypeError);
  assert.throws(() => index.search('cache', 0), TypeError);
}));

test('createRepoIndex rejects a missing folder with an Error and bad arguments with a TypeError', () => withDir(async (dir) => {
  const type = (fn, re) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message));
  assert.throws(() => createRepoIndex(path.join(dir, 'nope'), cfgFor(dir).retrieve), (e) => e.constructor === Error && /not a folder/.test(e.message));
  type(() => createRepoIndex('', cfgFor(dir).retrieve), /root must be a non-empty string/);
  type(() => createRepoIndex(dir, undefined), /rcfg must be the retrieve config object/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, chunkOverlap: 40 }), /chunkOverlap/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, extensions: ['js'] }), /extensions/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, maxFiles: 0 }), /maxFiles/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, ignoreDirs: 'node_modules' }), /ignoreDirs/);
}));

// A filesystem refusal of the kinds the walk skips (see SKIPPABLE in repo.js).
const REFUSED_CODES = ['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ELOOP'];
const refused = (code) => Object.assign(new Error(`${code}: refused by the test`), { code });
const basename = (p) => path.basename(String(p));

for (const code of REFUSED_CODES) {
  test(`createRepoIndex skips a folder refused with ${code}, counts it and indexes the rest`, (t) => withDir(async (dir) => {
    const repo = path.join(dir, 'repo');
    writeFiles(repo, { 'open/a.js': 'const a = 1;\n', 'locked/b.js': 'const b = 2;\n' });
    const realReaddir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (p, o) => {
      if (basename(p) === 'locked') throw refused(code);
      return realReaddir(p, o);
    });
    const index = createRepoIndex(repo, cfgFor(dir).retrieve);
    t.mock.restoreAll();
    assert.deepEqual(index.files, ['open/a.js']);
    assert.equal(index.skipped, 1);
    assert.equal(index.truncated, false);
  }));

  test(`createRepoIndex skips a file refused with ${code} on read and counts it`, (t) => withDir(async (dir) => {
    const repo = path.join(dir, 'repo');
    writeFiles(repo, { 'a.js': 'a\n', 'b.js': 'b\n' });
    const realRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (p, o) => {
      if (basename(p) === 'b.js') throw refused(code);
      return realRead(p, o);
    });
    const index = createRepoIndex(repo, cfgFor(dir).retrieve);
    t.mock.restoreAll();
    assert.deepEqual(index.files, ['a.js']);
    assert.equal(index.skipped, 1);
  }));
}

test('createRepoIndex skips a file that vanished after the listing and counts it', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n', 'gone.js': 'g\n' });
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (p, o) => {
    if (basename(p) === 'gone.js') throw refused('ENOENT');
    return realStat(p, o);
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['a.js']);
  assert.equal(index.skipped, 1);
}));

test('createRepoIndex counts every skipped folder and file in one walk', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'ok.js': 'o\n', 'l1/x.js': 'x\n', 'l2/y.js': 'y\n', 'f.js': 'f\n' });
  const realReaddir = fs.readdirSync;
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (p, o) => {
    if (['l1', 'l2'].includes(basename(p))) throw refused('EACCES');
    return realReaddir(p, o);
  });
  t.mock.method(fs, 'readFileSync', (p, o) => {
    if (basename(p) === 'f.js') throw refused('EBUSY');
    return realRead(p, o);
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['ok.js']);
  assert.equal(index.skipped, 3);
}));

test('createRepoIndex rethrows a filesystem error that is not on the skip list', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n' });
  t.mock.method(fs, 'readdirSync', () => { throw refused('EIO'); });
  assert.throws(() => createRepoIndex(repo, cfgFor(dir).retrieve), (e) => e.code === 'EIO');
  t.mock.restoreAll();
}));

test('createRepoIndex stops once maxWalkMs has passed, keeps what it indexed and reports truncated', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' });
  let time = 0;
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, o) => {
    const text = realRead(p, o);
    time += 1000;
    return text;
  });
  const index = createRepoIndex(repo, cfgFor(dir, { maxWalkMs: 1500 }).retrieve, { now: () => time });
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['a.js', 'b.js']);
  assert.equal(index.truncated, true);
  assert.equal(index.skipped, 0);
}));

test('createRepoIndex stops exactly when maxWalkMs has elapsed, not one file later', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n', 'b.js': 'b\n' });
  let time = 0;
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, o) => {
    const text = realRead(p, o);
    time += 1000;
    return text;
  });
  const index = createRepoIndex(repo, cfgFor(dir, { maxWalkMs: 1000 }).retrieve, { now: () => time });
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['a.js']);
  assert.equal(index.truncated, true);
}));

test('createRepoIndex is not truncated when the time limit passes only after the last file', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n', 'b.js': 'b\n' });
  let time = 0;
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, o) => {
    const text = realRead(p, o);
    time += 1000;
    return text;
  });
  const index = createRepoIndex(repo, cfgFor(dir, { maxWalkMs: 1500 }).retrieve, { now: () => time });
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['a.js', 'b.js']);
  assert.equal(index.truncated, false);
}));

test('createRepoIndex reports truncated when maxFiles leaves an indexable file out, and not when it fits exactly', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' });
  const cut = createRepoIndex(repo, cfgFor(dir, { maxFiles: 2 }).retrieve);
  assert.deepEqual(cut.files, ['a.js', 'b.js']);
  assert.equal(cut.truncated, true);
  const exact = createRepoIndex(repo, cfgFor(dir, { maxFiles: 3 }).retrieve);
  assert.equal(exact.truncated, false);
}));

test('createRepoIndex rejects a non-positive maxWalkMs and a clock that is not a function', () => withDir(async (dir) => {
  const type = (fn, re) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message));
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, maxWalkMs: 0 }), /maxWalkMs/);
  type(() => createRepoIndex(dir, cfgFor(dir).retrieve, { now: 5 }), /now must be a function/);
}));

// --- .gitignore -------------------------------------------------------------------------------

// respectGitignore may be absent from the merged config until the default lists it; it means true.
const withGitignore = (dir, value, retrieve = {}) => ({ ...cfgFor(dir, retrieve).retrieve, respectGitignore: value });

const ROOT_GITIGNORE_TREE = {
  '.gitignore': '# local files\nsettings.local.json\nout/\n*.secret.md\n',
  'settings.local.json': '{"token": "LOCAL_MARKER"}\n',
  'src/settings.local.json': '{"token": "LOCAL_MARKER"}\n',
  'out/bundle.js': 'generated\n',
  'notes.secret.md': 'LOCAL_MARKER\n',
  'README.md': '# Read me\n',
  'src/a.js': 'const a = 1;\n',
};

test('createRepoIndex leaves out what the root .gitignore ignores and counts it', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, ROOT_GITIGNORE_TREE);
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['README.md', 'src/a.js']);
  assert.equal(index.ignored, 4, 'two settings files, the out/ folder and the secret note');
  assert.equal(index.skipped, 0);
  assert.ok(!index.chunks.some((c) => c.text.includes('LOCAL_MARKER')));
}));

test('createRepoIndex indexes gitignored files when respectGitignore is false and counts none', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, ROOT_GITIGNORE_TREE);
  const index = createRepoIndex(repo, withGitignore(dir, false));
  assert.deepEqual(index.files, ['README.md', 'notes.secret.md', 'out/bundle.js', 'settings.local.json', 'src/a.js', 'src/settings.local.json']);
  assert.equal(index.ignored, 0);
}));

test('createRepoIndex treats an absent respectGitignore as true and rejects values other than true or false', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, ROOT_GITIGNORE_TREE);
  const absent = createRepoIndex(repo, withGitignore(dir, undefined));
  assert.deepEqual(absent.files, ['README.md', 'src/a.js']);
  assert.deepEqual(createRepoIndex(repo, withGitignore(dir, true)).files, absent.files);
  for (const bad of ['yes', 1, null, 0]) {
    assert.throws(() => createRepoIndex(repo, withGitignore(dir, bad)), (e) => e instanceof TypeError && /respectGitignore/.test(e.message));
  }
}));

test('a nested .gitignore overrides the root one, and "!" re-includes', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    '.gitignore': '*.md\n!README.md\n',
    'README.md': 'readme\n',
    'a.md': 'a\n',
    'keep.md': 'root keep\n',
    'docs/.gitignore': '!keep.md\n/local.json\n',
    'docs/keep.md': 'keep\n',
    'docs/drop.md': 'drop\n',
    'docs/sub/keep.md': 'deeper keep\n',
    'docs/local.json': '{}\n',
    'docs/sub/local.json': '{}\n',
    'local.json': '{}\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['README.md', 'docs/keep.md', 'docs/sub/keep.md', 'docs/sub/local.json', 'local.json']);
  assert.equal(index.ignored, 4, 'a.md, keep.md at the root, docs/drop.md and docs/local.json');
}));

test('a folder-only rule leaves out folders but not files of the same name', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    '.gitignore': 'scratch*/\n',
    'scratch/a.js': 'a\n',
    'src/scratchpad/b.js': 'b\n',
    'scratch.js': 'kept\n',
    'src/c.js': 'c\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['scratch.js', 'src/c.js']);
  assert.equal(index.ignored, 2);
}));

test('an ignored folder is not entered, so nothing inside it can be re-included', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    '.gitignore': 'private/\n!private/keep.js\n',
    'private/.gitignore': '!*\n',
    'private/keep.js': 'keep\n',
    'private/sub/x.js': 'x\n',
    'pub.js': 'pub\n',
  });
  const realReaddir = fs.readdirSync;
  const listed = [];
  t.mock.method(fs, 'readdirSync', (p, o) => {
    listed.push(path.relative(repo, String(p)));
    return realReaddir(p, o);
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['pub.js']);
  assert.equal(index.ignored, 1, 'the folder counts once; what lies below it is never seen');
  assert.deepEqual(listed, ['']);
}));

test('a .gitignore outside the indexed root is not read', () => withDir(async (dir) => {
  writeFiles(dir, { '.gitignore': '*.js\n' });
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n' });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['a.js']);
  assert.equal(index.ignored, 0);
}));

test('an unreadable or oversized .gitignore gives no rules and never fails the index', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { '.gitignore': 'a.js\n', 'a.js': 'a\n', 'sub/.gitignore': `${'#'.repeat(60)}\nb.js\n`, 'sub/b.js': 'b\n' });
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, o) => {
    if (path.relative(repo, String(p)) === '.gitignore') throw refused('EACCES');
    return realRead(p, o);
  });
  const index = createRepoIndex(repo, cfgFor(dir, { maxFileBytes: 40 }).retrieve);
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['a.js', 'sub/b.js']);
  assert.equal(index.ignored, 0);
  assert.equal(index.skipped, 2, 'each .gitignore whose rules were lost is reported as skipped');
}));

// A junction needs no privilege on Windows; on Linux and macOS it is an ordinary symlink.
test('a .gitignore that is a junction is not followed and gives no rules', () => withDir(async (dir) => {
  const outside = path.join(dir, 'outside');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(outside);
  writeFiles(repo, { 'a.js': 'a\n' });
  fs.symlinkSync(outside, path.join(repo, '.gitignore'), 'junction');
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['a.js']);
  assert.equal(index.ignored, 0);
}));

test('a .gitignore that is a file symlink is not followed and gives no rules', (t) => withDir(async (dir) => {
  const outside = path.join(dir, 'outside');
  const repo = path.join(dir, 'repo');
  writeFiles(outside, { rules: '*.js\n' });
  writeFiles(repo, { 'a.js': 'a\n' });
  try {
    fs.symlinkSync(path.join(outside, 'rules'), path.join(repo, '.gitignore'), 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('creating a file symlink needs a privilege on this machine');
    throw err;
  }
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['a.js']);
  assert.equal(index.ignored, 0);
}));

// --- createRepoIndexAsync ---------------------------------------------------------------------

const MIXED_TREE = {
  ...ROOT_GITIGNORE_TREE,
  'docs/.gitignore': '!*.secret.md\n',
  'docs/plan.secret.md': 'plan about the cache\n',
  'src/cache.js': 'function cacheGet(key) {\n  return store.get(key);\n}\n',
  'src/deep/parse.js': `${numbered(30)}\n`,
  'node_modules/x/index.js': 'ignored\n',
  'bin.js': Buffer.from('ab\u0000cd'),
};

/** The fields of an index that deepEqual can compare, plus a few searches. */
function snapshot(index) {
  const { files, chunks, skipped, truncated, ignored } = index;
  const searches = ['cache', 'line12 line13', 'read me', 'zzzz'].map((q) => index.search(q, 5));
  return { files, chunks, skipped, truncated, ignored, searches };
}

test('createRepoIndexAsync builds the same index as createRepoIndex', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, MIXED_TREE);
  for (const retrieve of [{}, { maxFiles: 3 }, { chunkLines: 4, chunkOverlap: 1 }]) {
    const rcfg = cfgFor(dir, retrieve).retrieve;
    const sync = createRepoIndex(repo, rcfg);
    const pending = createRepoIndexAsync(repo, rcfg);
    assert.ok(pending instanceof Promise);
    const built = await pending;
    assert.deepEqual(snapshot(built), snapshot(sync));
    assert.ok(Object.isFrozen(built) && Object.isFrozen(built.files) && Object.isFrozen(built.chunks));
    assert.ok(built.ignored > 0);
  }
  const off = withGitignore(dir, false);
  assert.deepEqual(snapshot(await createRepoIndexAsync(repo, off)), snapshot(createRepoIndex(repo, off)));
}));

test('createRepoIndexAsync gives the event loop a turn while it builds', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  const count = 300;
  writeFiles(repo, Object.fromEntries(Array.from({ length: count }, (_, i) => [`f/${String(i).padStart(3, '0')}.js`, `const v${i} = ${i};\n`])));
  // Each read takes at least half a millisecond, so the build lasts well over one time slice
  // however fast the disk is.
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, o) => {
    const until = performance.now() + 0.5;
    while (performance.now() < until);
    return realRead(p, o);
  });
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const index = await createRepoIndexAsync(repo, cfgFor(dir).retrieve).then((built) => {
    assert.equal(timerFired, true, 'the timer ran before the build finished');
    return built;
  });
  t.mock.restoreAll();
  assert.equal(index.files.length, count);
}));

test('createRepoIndexAsync stops once maxWalkMs has passed on an injected clock', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' });
  const realRead = fs.readFileSync;
  const build = async (fn, maxWalkMs) => {
    let time = 0;
    t.mock.method(fs, 'readFileSync', (p, o) => {
      const text = realRead(p, o);
      time += 1000;
      return text;
    });
    const index = await fn(repo, cfgFor(dir, { maxWalkMs }).retrieve, { now: () => time });
    t.mock.restoreAll();
    return index;
  };
  const cut = await build(createRepoIndexAsync, 1500);
  assert.deepEqual(cut.files, ['a.js', 'b.js']);
  assert.equal(cut.truncated, true);
  assert.equal(cut.skipped, 0);
  assert.deepEqual(snapshot(cut), snapshot(await build(createRepoIndex, 1500)));
  const exact = await build(createRepoIndexAsync, 1000);
  assert.deepEqual(exact.files, ['a.js']);
  assert.equal(exact.truncated, true);
  const whole = await build(createRepoIndexAsync, 3500);
  assert.deepEqual(whole.files, ['a.js', 'b.js', 'c.js']);
  assert.equal(whole.truncated, false);
}));

test('createRepoIndexAsync rejects bad arguments with a TypeError and a missing folder with an Error', () => withDir(async (dir) => {
  const rcfg = cfgFor(dir).retrieve;
  const type = (promise, re) => assert.rejects(promise, (e) => e instanceof TypeError && re.test(e.message));
  await assert.rejects(createRepoIndexAsync(path.join(dir, 'nope'), rcfg), (e) => e.constructor === Error && /not a folder/.test(e.message));
  await type(createRepoIndexAsync('', rcfg), /root must be a non-empty string/);
  await type(createRepoIndexAsync(dir, undefined), /rcfg must be the retrieve config object/);
  await type(createRepoIndexAsync(dir, { ...rcfg, maxWalkMs: 0 }), /maxWalkMs/);
  await type(createRepoIndexAsync(dir, { ...rcfg, respectGitignore: 'no' }), /respectGitignore/);
  await type(createRepoIndexAsync(dir, rcfg, { now: 5 }), /now must be a function/);
}));

test('createRepoIndexAsync skips and counts refused folders like createRepoIndex', (t) => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'open/a.js': 'a\n', 'locked/b.js': 'b\n' });
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, o) => {
    if (basename(p) === 'locked') throw refused('EACCES');
    return realReaddir(p, o);
  });
  const index = await createRepoIndexAsync(repo, cfgFor(dir).retrieve);
  t.mock.restoreAll();
  assert.deepEqual(index.files, ['open/a.js']);
  assert.equal(index.skipped, 1);
}));

test('a .gitignore that exists but cannot be used is counted in skipped, and one that is fine is not', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'a.js': 'const a = 1;\n', 'sub/.gitignore': 'hidden.js\n', 'sub/hidden.js': 'const h = 1;\n', 'sub/shown.js': 'const s = 1;\n' });
  const fine = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(fine.files, ['a.js', 'sub/shown.js']);
  assert.equal(fine.skipped, 0);
  // Too large to read: its rules are lost, so the file it hid is indexed and the caller is told.
  writeFiles(repo, { 'sub/.gitignore': `hidden.js\n${'# padding\n'.repeat(40)}` });
  const lost = createRepoIndex(repo, cfgFor(dir, { maxFileBytes: 64 }).retrieve);
  assert.deepEqual(lost.files, ['a.js', 'sub/hidden.js', 'sub/shown.js']);
  assert.equal(lost.skipped, 1);
  // A folder named .gitignore is not a rules file either.
  fs.rmSync(path.join(repo, 'sub', '.gitignore'));
  fs.mkdirSync(path.join(repo, 'sub', '.gitignore'));
  assert.equal(createRepoIndex(repo, cfgFor(dir).retrieve).skipped, 1);
}));
