import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGitignore, matchGitignore, isIgnored, readGitignore } from '../src/index/gitignore.js';

/** The verdict of a .gitignore text on one path: true ignored, false re-included, null no match. */
const verdict = (text, relPath, isDir = false) => matchGitignore(parseGitignore(text), relPath, isDir);
const ignored = (text, relPath, isDir = false) => verdict(text, relPath, isDir) === true;

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcore-gitignore-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('parseGitignore drops blank lines and comments and freezes the rules', () => {
  const rules = parseGitignore('\n# a comment\n   \n*.log\n\n#another\n');
  assert.deepEqual(rules.map((r) => r.pattern), ['*.log']);
  assert.ok(Object.isFrozen(rules) && Object.isFrozen(rules[0]) && Object.isFrozen(rules[0].segments));
  assert.equal(verdict('# x.js', '# x.js'), null, 'a comment is not a pattern');
  assert.throws(() => parseGitignore(5), TypeError);
});

test('a backslash escapes a leading "#" and "!" into literal characters', () => {
  assert.ok(ignored('\\#notes.md', '#notes.md'));
  assert.ok(ignored('\\!important.md', '!important.md'));
  assert.equal(verdict('\\!important.md', 'important.md'), null, 'the escaped "!" does not negate');
});

test('trailing spaces are trimmed unless a backslash escapes them', () => {
  assert.ok(ignored('a.txt   ', 'a.txt'));
  assert.equal(verdict('a.txt   ', 'a.txt '), null);
  assert.ok(ignored('a\\ ', 'a '));
  assert.equal(verdict('a\\ ', 'a'), null);
  assert.ok(ignored('a\\  ', 'a '), 'only the unescaped spaces after the escape are trimmed');
  assert.ok(ignored(' lead', ' lead'), 'leading spaces are kept');
});

test('CRLF line ends and a byte order mark are accepted', () => {
  const rules = parseGitignore('﻿a.js\r\nb.js\r\n');
  assert.deepEqual(rules.map((r) => r.pattern), ['a.js', 'b.js']);
  assert.ok(matchGitignore(rules, 'a.js', false) && matchGitignore(rules, 'b.js', false));
});

test('"!" re-includes and the last matching rule in a file wins', () => {
  assert.equal(verdict('*.log\n!keep.log', 'keep.log'), false);
  assert.equal(verdict('*.log\n!keep.log', 'drop.log'), true);
  assert.equal(verdict('!keep.log\n*.log', 'keep.log'), true, 'a later rule overrides an earlier negation');
  assert.equal(verdict('!', 'x'), null, 'a bare "!" is no rule');
});

test('a trailing "/" matches folders only', () => {
  assert.ok(ignored('cache/', 'cache', true));
  assert.equal(verdict('cache/', 'cache', false), null);
  assert.ok(ignored('cache/', 'deep/er/cache', true), 'without another "/" it matches at any depth');
  assert.equal(verdict('/', 'x', true), null, 'a bare "/" is no rule');
});

test('a leading or interior "/" anchors the pattern; without one it matches at any depth', () => {
  assert.ok(ignored('/top.js', 'top.js'));
  assert.equal(verdict('/top.js', 'sub/top.js'), null);
  assert.ok(ignored('doc/frotz', 'doc/frotz'));
  assert.equal(verdict('doc/frotz', 'a/doc/frotz'), null);
  assert.ok(ignored('doc/frotz/', 'doc/frotz', true));
  assert.ok(ignored('frotz', 'a/b/frotz'));
  assert.ok(ignored('frotz', 'frotz'));
  assert.ok(ignored('*.md', 'docs/deep/x.md'));
});

test('"*" and "?" never match "/"', () => {
  assert.ok(ignored('foo/*', 'foo/bar'));
  assert.equal(verdict('foo/*', 'foo/bar/baz'), null);
  assert.equal(verdict('a*z', 'a/z'), null);
  assert.ok(ignored('a*z', 'az') && ignored('a*z', 'abcz'));
  assert.ok(ignored('a?c', 'abc'));
  assert.equal(verdict('a?c', 'ac'), null);
  assert.equal(verdict('a/?c', 'a//c'), null);
  assert.equal(verdict('x?y', 'x/y'), null);
});

test('character classes take characters, ranges, "!" or "^" negation, a leading "]" and escapes', () => {
  assert.ok(ignored('[abc].js', 'b.js'));
  assert.equal(verdict('[abc].js', 'd.js'), null);
  assert.ok(ignored('file[0-9].txt', 'file7.txt'));
  assert.equal(verdict('file[0-9].txt', 'filex.txt'), null);
  assert.ok(ignored('[!a]x', 'bx'));
  assert.equal(verdict('[!a]x', 'ax'), null);
  assert.ok(ignored('[^a]x', 'bx'));
  assert.equal(verdict('[^a]x', 'ax'), null);
  assert.ok(ignored('[]]x', ']x'), 'a "]" first in the class is literal');
  assert.ok(ignored('[a-]x', '-x') && ignored('[a-]x', 'ax'), 'a "-" last in the class is literal');
  assert.ok(ignored('[\\]]x', ']x'), 'an escaped "]" is literal');
  assert.ok(ignored('[a\\-z]x', '-x') && !ignored('[a\\-z]x', 'mx'), 'an escaped "-" is not a range');
  assert.equal(verdict('a[/]b', 'a/b'), null, 'a class never matches "/"');
  assert.equal(verdict('[abc', '[abc'), null, 'an unclosed class never matches');
});

test('"**/x" matches x at any depth, including the top', () => {
  for (const p of ['foo', 'a/foo', 'a/b/foo']) assert.ok(ignored('**/foo', p), p);
  assert.ok(ignored('**/foo/bar', 'x/y/foo/bar'));
  assert.equal(verdict('**/foo/bar', 'foo/x/bar'), null);
});

test('"x/**" matches everything inside x but not x itself', () => {
  assert.ok(ignored('abc/**', 'abc/x'));
  assert.ok(ignored('abc/**', 'abc/x/y', true));
  assert.equal(verdict('abc/**', 'abc', true), null);
  assert.equal(verdict('abc/**', 'sub/abc/x'), null, 'it is anchored');
  assert.ok(ignored('**', 'any/path/at/all'));
});

test('"a/**/b" matches zero or more folders between a and b', () => {
  for (const p of ['a/b', 'a/x/b', 'a/x/y/b']) assert.ok(ignored('a/**/b', p), p);
  assert.equal(verdict('a/**/b', 'a/xb'), null);
  assert.equal(verdict('a/**/b', 'a/x/bc'), null);
  assert.ok(ignored('a/***/b', 'a/x/b'), 'a segment of three stars is a globstar too');
  assert.equal(verdict('a**b', 'a/x/b'), null, '"**" inside a segment is a plain star');
  assert.ok(ignored('a**b', 'axxb'));
});

test('matching is case-sensitive with ignoreCase off', () => {
  const exact = (pattern, p) => matchGitignore(parseGitignore(pattern, { ignoreCase: false }), p, false);
  assert.equal(exact('Secret.json', 'Secret.json'), true);
  assert.equal(exact('Secret.json', 'secret.json'), null);
  assert.equal(exact('[a-z].js', 'A.js'), null);
});

// Expectations were checked against `git check-ignore` with core.ignorecase=false and =true
// (git 2.55); the tests themselves do not need git. [pattern, path, isDir, off, on]
const FOLD_CASES = [
  ['Foo.txt', 'foo.txt', false, false, true],
  ['Foo.txt', 'FOO.TXT', false, false, true],
  ['Foo.txt', 'Foo.txt', false, true, true],
  ['Foo.txt', 'fo.txt', false, false, false],
  ['foo.txt', 'sub/FOO.txt', false, false, true],
  ['Secrets/', 'secrets', true, false, true],
  ['Secrets/', 'SECRETS', true, false, true],
  ['/Secrets/**', 'secrets/key', false, false, true],
  ['a*Z', 'abz', false, false, true],
  ['[A-C]x', 'bx', false, false, true],
  ['[A-C]x', 'Bx', false, true, true],
  ['[A-C]x', 'dx', false, false, false],
  ['[a-c]x', 'Bx', false, false, true],
  ['[a-c]x', 'Dx', false, false, false],
  ['[!a-c]x', 'Bx', false, true, false],
  ['[!a-c]x', 'dx', false, true, true],
  ['[^A-C]x', 'bx', false, true, false],
  ['é.txt', 'É.txt', false, false, false],
];

for (const [pattern, relPath, isDir, off, on] of FOLD_CASES) {
  test(`ignoreCase: ${pattern} vs ${relPath}`, () => {
    const check = (ignoreCase) => matchGitignore(parseGitignore(pattern, { ignoreCase }), relPath, isDir) === true;
    assert.equal(check(false), off, 'ignoreCase off');
    assert.equal(check(true), on, 'ignoreCase on');
  });
}

test('ignoreCase defaults to the platform: on for Windows and macOS, off elsewhere', () => {
  const expected = process.platform === 'win32' || process.platform === 'darwin';
  assert.equal(ignored('Foo.txt', 'foo.txt'), expected);
  assert.equal(parseGitignore('x')[0].ignoreCase, expected);
  assert.equal(parseGitignore('x', { ignoreCase: true })[0].ignoreCase, true);
  assert.equal(parseGitignore('x', { ignoreCase: false })[0].ignoreCase, false);
});

test('isIgnored folds case for rules read with ignoreCase on and not for those read with it off', () => {
  const on = [{ base: '', rules: parseGitignore('Secrets/', { ignoreCase: true }) }];
  const off = [{ base: '', rules: parseGitignore('Secrets/', { ignoreCase: false }) }];
  assert.equal(isIgnored(on, 'secrets', true), true);
  assert.equal(isIgnored(off, 'secrets', true), false);
});

// Checked against `git check-ignore` (both core.ignorecase values give the same answer here
// unless the case says otherwise). [pattern, [paths git ignores], [paths git leaves]]
const POSIX_CASES = [
  ['[[:alnum:]]x', ['1x', 'ax', 'Ax'], ['_x', '-x', ' x', 'éx']],
  ['[[:alpha:]]x', ['ax', 'Ax', 'fx'], ['1x', '_x', 'éx']],
  ['[[:blank:]]x', [' x', '\tx'], ['ax', '1x']],
  ['[[:cntrl:]]x', ['\x01x', '\tx'], ['ax', ' x']],
  ['[[:digit:]]x', ['1x', '5x'], ['ax', '_x', 'Ax']],
  ['[[:graph:]]x', ['1x', 'ax', '_x', '-x', '~x'], [' x', '\tx', 'éx']],
  ['[[:print:]]x', ['1x', 'ax', ' x', '~x'], ['\tx', '\x01x', 'éx']],
  ['[[:punct:]]x', ['_x', '-x', ':x', ']x', '~x'], ['ax', '1x', ' x']],
  ['[[:space:]]x', [' x', '\tx'], ['ax', '_x']],
  ['[[:xdigit:]]x', ['1x', 'fx', 'Fx'], ['gx', '_x']],
  ['[![:digit:]]x', ['ax', '_x'], ['1x']],
  ['[^[:digit:]]x', ['ax'], ['1x']],
  ['[a[:digit:]_]x', ['ax', '5x', '_x'], ['bx', 'Bx']],
  ['[[:digit:]a]x', ['ax', '5x'], ['bx']],
  ['[[:digit:][:upper:]]x', ['5x', 'Ax'], ['_x']],
  ['[[:digit:]-z]x', ['5x', '-x', 'zx'], ['mx']],
  ['[[:alpha:]-z]x', ['ax', '-x', 'zx'], ['5x']],
];

for (const [pattern, hit, miss] of POSIX_CASES) {
  test(`POSIX class ${pattern}`, () => {
    for (const ignoreCase of [false, true]) {
      const rules = parseGitignore(pattern, { ignoreCase });
      for (const p of hit) assert.equal(matchGitignore(rules, p, false), true, `${JSON.stringify(p)} ignoreCase=${ignoreCase}`);
      for (const p of miss) assert.equal(matchGitignore(rules, p, false), null, `${JSON.stringify(p)} ignoreCase=${ignoreCase}`);
    }
  });
}

test('POSIX [:upper:] and [:lower:] depend on ignoreCase, as in git', () => {
  const m = (pattern, p, ignoreCase) => matchGitignore(parseGitignore(pattern, { ignoreCase }), p, false) === true;
  assert.deepEqual([m('[[:upper:]]x', 'Ax', false), m('[[:upper:]]x', 'ax', false), m('[[:upper:]]x', 'ax', true)], [true, false, true]);
  assert.deepEqual([m('[[:lower:]]x', 'ax', false), m('[[:lower:]]x', 'Ax', false), m('[[:lower:]]x', 'Ax', true)], [true, false, true]);
  assert.deepEqual([m('[![:upper:]]x', 'ax', false), m('[![:upper:]]x', 'ax', true), m('[![:upper:]]x', '1x', true)], [true, false, true]);
  assert.deepEqual([m('[![:lower:]]x', 'Ax', false), m('[![:lower:]]x', 'Ax', true)], [true, false]);
});

test('a class name git does not know, or a "[:" git does not close, never matches (as in git)', () => {
  for (const pattern of ['[[:foo:]]x', '[![:foo:]]x', '[[:DIGIT:]]x', '[[::]]x', '[[:digit:', '[[:digit:]']) {
    for (const p of ['1x', 'ax', ':x', '[x', 'x', '1', 'a', 'fx']) assert.equal(verdict(pattern, p), null, `${pattern} ${p}`);
  }
  assert.ok(ignored('[[:digit]x', 'dx'), 'no ":]" before the "]": "[" is an ordinary member');
  assert.ok(ignored('[[:digit]x', '[x') && ignored('[[:digit]x', ':x'));
  assert.equal(verdict('[[:digit]x', '1x'), null);
  assert.ok(ignored('[[:]x', ':x') && ignored('[[:]x', '[x'), 'an empty name is no class either');
  assert.ok(ignored('[:alpha:]x', 'px'), 'a single bracket is an ordinary set of ":alph"');
  assert.equal(verdict('[:alpha:]x', 'bx'), null);
  assert.ok(ignored('[\\[:digit:]]x', '[x') === false, 'an escaped "[" does not open a class (set "[:digit" then literal "]")');
});

test('a dangling backslash makes a pattern that never matches', () => {
  assert.equal(parseGitignore('abc\\').length, 0);
});

test('matchGitignore rejects a path that is not a non-empty string', () => {
  assert.throws(() => matchGitignore([], ''), TypeError);
  assert.throws(() => matchGitignore([], 5), TypeError);
});

test('isIgnored lets a deeper .gitignore override a shallower one and scopes each to its folder', () => {
  const levels = [
    { base: '', rules: parseGitignore('*.md\n/top.js') },
    { base: 'docs', rules: parseGitignore('!keep.md\n/top.js') },
  ];
  assert.equal(isIgnored(levels, 'docs/keep.md', false), false);
  assert.equal(isIgnored(levels, 'docs/drop.md', false), true);
  assert.equal(isIgnored(levels, 'keep.md', false), true, 'the deeper rule does not reach the root');
  assert.equal(isIgnored(levels, 'top.js', false), true);
  assert.equal(isIgnored(levels, 'docs/top.js', false), true, 'anchored to docs/ by its own file');
  assert.equal(isIgnored(levels, 'other.js', false), false);
  assert.equal(isIgnored([], 'x.md', false), false);
});

// 30 × "*a" against a long name without enough "a"s: a backtracking regular expression takes
// exponential time here; the matcher takes at most pattern × name steps.
test('an adversarial pattern of many stars matches a long name quickly', () => {
  const started = performance.now();
  assert.equal(verdict('*a'.repeat(30), 'b'.repeat(20000)), null);
  assert.equal(verdict(`${'*a'.repeat(30)}b`, 'a'.repeat(5000)), null);
  assert.equal(verdict('**/'.repeat(30) + 'x', Array.from({ length: 300 }, () => 'd').join('/')), null);
  assert.equal(verdict('a/**/'.repeat(15) + 'z', Array.from({ length: 300 }, () => 'a').join('/')), null);
  assert.ok(ignored('*a'.repeat(30), 'a'.repeat(30)));
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
});

test('readGitignore reads the rules of a regular file and gives none for a missing one or a folder', () => withDir(async (dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
  assert.deepEqual(readGitignore(path.join(dir, '.gitignore'), 1000).map((r) => r.pattern), ['*.log']);
  assert.deepEqual(readGitignore(path.join(dir, 'missing'), 1000), []);
  fs.mkdirSync(path.join(dir, 'folder'));
  assert.deepEqual(readGitignore(path.join(dir, 'folder'), 1000), []);
}));

test('readGitignore gives no rules for a file larger than maxBytes', () => withDir(async (dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n'.repeat(10));
  assert.deepEqual(readGitignore(path.join(dir, '.gitignore'), 59), []);
  assert.equal(readGitignore(path.join(dir, '.gitignore'), 60).length, 10);
}));

// A junction needs no privilege on Windows; on Linux and macOS it is an ordinary symlink.
test('readGitignore gives no rules for a junction', () => withDir(async (dir) => {
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(dir, '.gitignore'), 'junction');
  assert.deepEqual(readGitignore(path.join(dir, '.gitignore'), 1000), []);
}));

test('readGitignore gives no rules for a file symlink and never follows it', (t) => withDir(async (dir) => {
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'rules'), '*.js\n');
  try {
    fs.symlinkSync(path.join(target, 'rules'), path.join(dir, '.gitignore'), 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('creating a file symlink needs a privilege on this machine');
    throw err;
  }
  assert.deepEqual(readGitignore(path.join(dir, '.gitignore'), 1000), []);
}));

test('readGitignore gives no rules when lstat reports a symlink', (t) => withDir(async (dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.js\n');
  t.mock.method(fs, 'lstatSync', () => ({ isFile: () => false, isSymbolicLink: () => true, size: 5 }));
  const rules = readGitignore(path.join(dir, '.gitignore'), 1000);
  t.mock.restoreAll();
  assert.deepEqual(rules, []);
}));

test('readGitignore gives no rules, and does not throw, when the file cannot be read', (t) => withDir(async (dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.js\n');
  for (const code of ['EACCES', 'EIO']) {
    t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error(code), { code }); });
    assert.deepEqual(readGitignore(path.join(dir, '.gitignore'), 1000), []);
    t.mock.restoreAll();
  }
}));
