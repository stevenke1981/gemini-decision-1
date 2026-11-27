// Repository chunk index for the retrieve decision (docs/design.md §4.3). A walk of one root
// keeps listed text files only, cuts them into line windows and ranks the windows with BM25 over
// `source + text`. Symlinks and junctions are never followed: a link can point outside the root,
// and chunk text may be sent to Gemini. Ignored folders, unlisted extensions, paths a .gitignore
// inside the root ignores (respectGitignore), oversized files and binary files (a NUL byte in the
// first 8 KB) are skipped. A folder or file the filesystem refuses (SKIPPABLE) is skipped and
// counted, and a walk stops once maxWalkMs has passed. The build is one generator of small steps:
// createRepoIndex runs it straight through, createRepoIndexAsync gives the event loop a turn
// after each YIELD_SLICE_MS of work, so both build the same index from the same folder.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULTS } from '../defaults.js';
import { createBm25 } from '../text.js';
import { chunkFile, assertChunkOptions } from './chunker.js';
import { isIgnored, readGitignore } from './gitignore.js';

const BINARY_PROBE_BYTES = 8192;
// Refusals that skip one folder or file and are counted; any other filesystem error propagates.
const SKIPPABLE = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ELOOP']);
const GITIGNORE = '.gitignore';
const NO_LEVELS = Object.freeze([]);
// The async build gives the event loop a turn after this much uninterrupted work.
const YIELD_SLICE_MS = 15;
const RESPECT_GITIGNORE_VALUES = new Set([true, false, undefined]);

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const monotonicMs = () => performance.now();

/**
 * The retrieve config with defaults for missing fields; throws TypeError on unusable values.
 * respectGitignore may be absent (undefined), which means true.
 */
function repoOptions(rcfg) {
  if (!isPlainObject(rcfg)) throw new TypeError('createRepoIndex: rcfg must be the retrieve config object');
  const o = { ...DEFAULTS.retrieve, ...rcfg };
  assertChunkOptions(o);
  for (const key of ['maxFileBytes', 'maxFiles', 'maxWalkMs']) {
    if (!Number.isInteger(o[key]) || o[key] < 1) throw new TypeError(`createRepoIndex: ${key} must be a positive integer`);
  }
  if (!Array.isArray(o.extensions) || !o.extensions.every((e) => typeof e === 'string' && e.startsWith('.'))) {
    throw new TypeError('createRepoIndex: extensions must be a list of strings starting with "."');
  }
  if (!Array.isArray(o.ignoreDirs) || !o.ignoreDirs.every((d) => typeof d === 'string')) {
    throw new TypeError('createRepoIndex: ignoreDirs must be a list of folder names');
  }
  if (!RESPECT_GITIGNORE_VALUES.has(o.respectGitignore)) {
    throw new TypeError('createRepoIndex: respectGitignore must be true or false');
  }
  return {
    ...o,
    extensions: new Set(o.extensions.map((e) => e.toLowerCase())),
    ignoreDirs: new Set(o.ignoreDirs),
    respectGitignore: o.respectGitignore !== false,
  };
}

/**
 * The walk's counters and deadline. `skipped` counts folders and files the filesystem refused;
 * `ignored` counts folders and files a .gitignore rule left out; `truncated` is set when the walk
 * stops with entries still to visit. `expired` is true once maxWalkMs has elapsed since the walk
 * began.
 */
function createWalk(maxWalkMs, now) {
  const started = now();
  return { skipped: 0, ignored: 0, truncated: false, expired: () => now() - started >= maxWalkMs };
}

/** Calls `read`; a refusal in SKIPPABLE is counted as skipped and gives `fallback`. */
function attempt(walk, read, fallback) {
  try {
    return read();
  } catch (err) {
    if (!SKIPPABLE.has(err?.code)) throw err;
    walk.skipped += 1;
    return fallback;
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Directory entries in name order, so the index is the same on every run. */
function readDirSorted(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
}

/**
 * The .gitignore levels that apply to the entries of `dir`: `levels` plus the folder's own
 * .gitignore when it is a regular file with rules. Off when respectGitignore is false. A
 * .gitignore that exists but cannot be used (a link, unreadable, too large) is counted in
 * walk.skipped: the files it would have hidden may be indexed, and the caller should see that.
 */
function levelsFor(dir, rel, entries, opts, levels, walk) {
  if (!opts.respectGitignore) return levels;
  const own = entries.find((e) => e.name === GITIGNORE);
  if (!own) return levels;
  const unusable = () => { walk.skipped += 1; };
  if (!own.isFile()) {
    unusable();
    return levels;
  }
  const rules = readGitignore(path.join(dir, GITIGNORE), opts.maxFileBytes, unusable);
  return rules.length ? Object.freeze([...levels, Object.freeze({ base: rel, rules })]) : levels;
}

/** Whether a .gitignore rule leaves the path out; counts it in walk.ignored when it does. */
function gitignored(levels, rel, isDir, walk) {
  if (!isIgnored(levels, rel, isDir)) return false;
  walk.ignored += 1;
  return true;
}

/**
 * Yields { full, rel } for every listed file under `dir`, depth first, in name order, and null
 * before each entry it looks at (a point where the build may pause). Symlinks and junctions are
 * skipped; ignored folder names and gitignored folders are not entered, so nothing below them can
 * be re-included; a refused folder is skipped. The walk ends, with walk.truncated set, once the
 * time limit passes while entries remain.
 */
function* walkFiles(dir, rel, opts, walk, levels) {
  const entries = attempt(walk, () => readDirSorted(dir), null);
  if (entries === null) return;
  const scope = levelsFor(dir, rel, entries, opts, levels, walk);
  for (const entry of entries) {
    yield null;
    if (walk.expired()) {
      walk.truncated = true;
      return;
    }
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (opts.ignoreDirs.has(entry.name) || gitignored(scope, childRel, true, walk)) continue;
      yield* walkFiles(full, childRel, opts, walk, scope);
    } else if (entry.isFile() && opts.extensions.has(path.extname(entry.name).toLowerCase())) {
      if (!gitignored(scope, childRel, false, walk)) yield { full, rel: childRel };
    }
  }
}

/**
 * The file's text, or null when it is too large or binary. A file the filesystem refuses, or
 * that vanished since the walk listed it, is skipped and counted; other read errors propagate.
 */
function readIndexable(full, maxBytes, walk) {
  return attempt(walk, () => {
    const st = fs.statSync(full);
    if (st.size > maxBytes) return null;
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
    return buf.toString('utf8');
  }, null);
}

/** BM25 search over the chunks; results are new objects carrying `score`. */
function searchChunks(bm25, byId, query, k) {
  if (typeof query !== 'string') throw new TypeError('search: query must be a string');
  if (!Number.isInteger(k) || k < 1) throw new TypeError('search: k must be a positive integer');
  return bm25.search(query, k).map(({ id, score }) => Object.freeze({ ...byId.get(id), score }));
}

/** The frozen index over the indexed files and their chunks. */
function finishIndex(files, perFile, walk) {
  const chunks = perFile.flat();
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const bm25 = createBm25(chunks.map((c) => ({ id: c.id, text: `${c.source}\n${c.text}` })));
  return Object.freeze({
    files: Object.freeze(files),
    chunks: Object.freeze(chunks),
    skipped: walk.skipped,
    truncated: walk.truncated,
    ignored: walk.ignored,
    search: (query, k = DEFAULTS.retrieve.shortlist) => searchChunks(bm25, byId, query, k),
  });
}

/**
 * The index build as a generator: it yields (undefined) between small steps of the walk and
 * returns the frozen index. Whoever drives it decides whether to pause at a yield.
 */
function* indexSteps(absRoot, opts, now) {
  const walk = createWalk(opts.maxWalkMs, now);
  const files = [];
  const perFile = [];
  for (const found of walkFiles(absRoot, '', opts, walk, NO_LEVELS)) {
    if (found === null) {
      yield;
      continue;
    }
    const text = readIndexable(found.full, opts.maxFileBytes, walk);
    if (text === null) continue;
    if (files.length >= opts.maxFiles) {
      walk.truncated = true;
      break;
    }
    files.push(found.rel);
    perFile.push(chunkFile(found.rel, text, opts));
  }
  return finishIndex(files, perFile, walk);
}

/** Runs a step generator to its end without pausing and gives its return value. */
function runToEnd(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Runs a step generator, giving the event loop a turn (setImmediate) whenever YIELD_SLICE_MS of
 * wall time has passed since the last turn, and resolves to its return value.
 */
async function runInSlices(steps) {
  let sliceStart = monotonicMs();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (monotonicMs() - sliceStart >= YIELD_SLICE_MS) {
      await nextTurn();
      sliceStart = monotonicMs();
    }
  }
}

/** Validates the arguments of both builds; throws TypeError on bad ones, Error when root is not a folder. */
function prepare(root, rcfg, now) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('createRepoIndex: root must be a non-empty string');
  const opts = repoOptions(rcfg);
  if (typeof now !== 'function') throw new TypeError('createRepoIndex: now must be a function');
  const absRoot = path.resolve(root);
  if (!fs.statSync(absRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`createRepoIndex: not a folder: ${absRoot}`);
  }
  return { absRoot, opts };
}

/**
 * Indexes the text files under `root`.
 * @param {string} root the folder to index (resolved to an absolute path)
 * @param {object} rcfg the `retrieve` config section; missing fields take the defaults
 * @param {{now?: () => number}} [options] `now`: a clock in milliseconds, injected by tests
 *   (default: a monotonic clock)
 * @returns {Readonly<{search:(query:string, k?:number) => object[], files:readonly string[],
 *   chunks:readonly object[], skipped:number, truncated:boolean, ignored:number}>}
 *   `files`: relative posix paths of the indexed files; `chunks`: every chunk; `search` returns
 *   the best `k` chunks (default: retrieve.shortlist) as new objects with a `score`; `skipped`:
 *   folders and files the filesystem refused; `truncated`: the walk stopped early, after maxWalkMs
 *   or maxFiles, with entries left unvisited; `ignored`: folders, and files with a listed
 *   extension, that a .gitignore rule left out (0 when respectGitignore is false).
 * @throws {TypeError} on bad arguments; {Error} when root is not a folder
 */
export function createRepoIndex(root, rcfg, { now = monotonicMs } = {}) {
  const { absRoot, opts } = prepare(root, rcfg, now);
  return runToEnd(indexSteps(absRoot, opts, now));
}

/**
 * createRepoIndex that gives the event loop a turn every YIELD_SLICE_MS while it walks and
 * reads, so a server keeps answering during a long build. Same arguments, same index.
 * @param {string} root
 * @param {object} rcfg
 * @param {{now?: () => number}} [options]
 * @returns {Promise<Readonly<object>>} the index createRepoIndex returns; rejects with a
 *   TypeError on bad arguments and an Error when root is not a folder
 */
export async function createRepoIndexAsync(root, rcfg, { now = monotonicMs } = {}) {
  const { absRoot, opts } = prepare(root, rcfg, now);
  return runInSlices(indexSteps(absRoot, opts, now));
}
