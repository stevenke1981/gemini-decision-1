// .gitignore matching for the repository index (docs/design.md §4.3). A file's lines become
// rules; a rule is cut at "/" into segment patterns, and `**` as a whole segment matches any run
// of folders. Matching walks the pattern with the classic wildcard algorithm (one backtrack
// point, to the latest star) at both the segment and the character level, so it takes at most
// pattern × path steps whatever the pattern holds: no regular expressions, no exponential
// backtracking. Matching folds ASCII letters when ignoreCase is on (the default on Windows and
// macOS, as git's core.ignorecase). A .gitignore that is not a regular file (a symlink
// or junction), is too large or cannot be read gives no rules; reading one never throws.
import fs from 'node:fs';

const LINE_BREAK = /\r?\n/;
const BOM = /^﻿/;
const SEPARATOR = '/';
const ESCAPE = '\\';
const COMMENT = '#';
const NEGATE = '!';
const SPACE = ' ';
const STAR_CHAR = '*';
const ANY_CHAR = '?';
const CLASS_OPEN = '[';
const CLASS_CLOSE = ']';
const CLASS_NEGATE = new Set(['!', '^']);
const CLASS_RANGE = '-';
const POSIX_OPEN = ':';

/**
 * Whether matching folds case when the caller does not say: git's core.ignorecase defaults to
 * true on Windows and macOS (case-insensitive file systems) and to false elsewhere.
 */
const DEFAULT_IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * POSIX bracket classes, in C-locale ASCII like git's wildmatch: "[[:digit:]]" and the rest.
 * A character code at or past 128 is in none of them.
 */
const POSIX_CLASSES = Object.freeze({
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: (c) => isAlpha(c),
  blank: (c) => c === 32 || c === 9,
  cntrl: (c) => c < 32 || c === 127,
  digit: (c) => isDigit(c),
  graph: (c) => c > 32 && c < 127,
  lower: (c) => c >= 97 && c <= 122,
  print: (c) => c >= 32 && c < 127,
  punct: (c) => c > 32 && c < 127 && !isAlpha(c) && !isDigit(c),
  space: (c) => c === 32 || (c >= 9 && c <= 13),
  upper: (c) => c >= 65 && c <= 90,
  xdigit: (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
});

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * The other-case ASCII twin of a character code, or the code itself. Only A-Z and a-z fold:
 * git's own wildmatch folds ASCII only, so a non-ASCII letter never gains a match here that
 * git would deny, and every pair git folds (the ASCII letters) is folded here, so the fold
 * cannot hide a file that git ignores.
 */
function twinCode(code) {
  if (code >= 65 && code <= 90) return code + 32;
  if (code >= 97 && code <= 122) return code - 32;
  return code;
}

/** The character with ASCII letters lower-cased (see twinCode), for literal comparison. */
function foldChar(ch) {
  const code = ch.codePointAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
}

// Token kinds of one pattern segment.
const LITERAL = 'literal';
const ANY = 'any';
const STAR = 'star';
const CLASS = 'class';
const SEP = 'separator';

const ANY_TOKEN = Object.freeze({ kind: ANY });
const SEP_TOKEN = Object.freeze({ kind: SEP });
/** A whole segment of two or more stars: zero or more folders. */
const GLOBSTAR = Object.freeze({ kind: 'globstar' });
/** A segment pattern that matches any one path segment. */
const ONE_SEGMENT = Object.freeze([Object.freeze({ kind: STAR, run: 1 })]);
const NO_RULES = Object.freeze([]);

/**
 * The line with trailing spaces removed, unless a backslash escapes them (git's
 * trim_trailing_spaces): "a  " gives "a", "a\ " keeps "a\ ".
 */
function trimTrailingSpaces(line) {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === SPACE) {
      if (lastSpace < 0) lastSpace = i;
    } else {
      if (ch === ESCAPE) i += 1;
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace);
}

/**
 * Parses a character class whose "[" is at chars[open - 1]: an optional "!" or "^", then
 * characters, "a-z" ranges and backslash escapes up to "]" ("]" first is literal).
 * @returns {{token:object, next:number}|null} null when the class is never closed
 */
function parseClass(chars, open) {
  let i = open;
  const negate = CLASS_NEGATE.has(chars[i]);
  if (negate) i += 1;
  const ranges = [];
  const names = [];
  let prev = null;
  for (let first = true; first || chars[i] !== CLASS_CLOSE; first = false, i += 1) {
    if (i >= chars.length) return null;
    let ch = chars[i];
    if (ch === CLASS_OPEN && chars[i + 1] === POSIX_OPEN) {
      const posix = parsePosix(chars, i + 2);
      if (posix === null) return null;
      if (posix.name !== null) {
        names.push(posix.name);
        prev = null;
        i = posix.end;
        continue;
      }
    }
    if (ch === ESCAPE) {
      i += 1;
      if (i >= chars.length) return null;
      ch = chars[i];
    } else if (ch === CLASS_RANGE && prev !== null && i + 1 < chars.length && chars[i + 1] !== CLASS_CLOSE) {
      i += 1;
      let hi = chars[i];
      if (hi === ESCAPE) {
        i += 1;
        if (i >= chars.length) return null;
        hi = chars[i];
      }
      ranges.push(Object.freeze([prev.codePointAt(0), hi.codePointAt(0)]));
      prev = null;
      continue;
    }
    ranges.push(Object.freeze([ch.codePointAt(0), ch.codePointAt(0)]));
    prev = ch;
  }
  const token = Object.freeze({ kind: CLASS, negate, ranges: Object.freeze(ranges), names: Object.freeze(names) });
  return { token, next: i + 1 };
}

/**
 * The "[:name:]" at chars[start - 2] (as git's wildmatch reads it): the text up to the next "]"
 * must end in ":" to be a class name; otherwise the "[" is an ordinary member of the set.
 * @returns {{name:string|null, end:number}|null} name: the class (null: not a class, "[" is
 *   literal); end: the index of the closing "]"; null when the pattern can never match: no "]"
 *   at all, or an unknown class name (git aborts the whole match there)
 */
function parsePosix(chars, start) {
  let end = start;
  while (end < chars.length && chars[end] !== CLASS_CLOSE) end += 1;
  if (end >= chars.length) return null;
  if (end === start || chars[end - 1] !== POSIX_OPEN) return { name: null, end };
  const name = chars.slice(start, end - 1).join('');
  return Object.hasOwn(POSIX_CLASSES, name) ? { name, end } : null;
}

/**
 * The pattern's tokens: literals, "?", runs of "*", classes and "/" separators (an escaped "/"
 * is a separator too, as in git). Null when the pattern can never match: a dangling backslash
 * or an unclosed "[".
 */
function tokenize(pattern) {
  const chars = Array.from(pattern);
  const tokens = [];
  for (let i = 0; i < chars.length;) {
    const ch = chars[i];
    if (ch === ESCAPE) {
      if (i + 1 >= chars.length) return null;
      const next = chars[i + 1];
      tokens.push(next === SEPARATOR ? SEP_TOKEN : Object.freeze({ kind: LITERAL, ch: next }));
      i += 2;
    } else if (ch === STAR_CHAR) {
      let run = 0;
      while (chars[i] === STAR_CHAR) { run += 1; i += 1; }
      tokens.push(Object.freeze({ kind: STAR, run }));
    } else if (ch === CLASS_OPEN) {
      const parsed = parseClass(chars, i + 1);
      if (parsed === null) return null;
      tokens.push(parsed.token);
      i = parsed.next;
    } else {
      tokens.push(ch === SEPARATOR ? SEP_TOKEN : ch === ANY_CHAR ? ANY_TOKEN : Object.freeze({ kind: LITERAL, ch }));
      i += 1;
    }
  }
  return tokens;
}

/**
 * Splits tokens at separators into segment patterns. A segment of only stars (two or more)
 * becomes GLOBSTAR; a trailing GLOBSTAR needs at least one segment ("a/**" does not match "a").
 */
function toSegments(tokens) {
  const segments = [[]];
  for (const token of tokens) {
    if (token.kind === SEP) segments.push([]);
    else segments.at(-1).push(token);
  }
  const out = segments.map((seg) => (seg.length === 1 && seg[0].kind === STAR && seg[0].run > 1 ? GLOBSTAR : Object.freeze(seg)));
  if (out.at(-1) === GLOBSTAR) out.splice(-1, 1, ONE_SEGMENT, GLOBSTAR);
  return Object.freeze(out);
}

/**
 * One rule from one .gitignore line, or null for a blank line, a comment or a pattern that can
 * never match. `anchored`: the pattern held a "/" before its trailing one, so it is matched
 * against the path below the .gitignore's folder; otherwise against the last segment only.
 */
function parseLine(line, ignoreCase) {
  if (!line || line.startsWith(COMMENT)) return null;
  let body = trimTrailingSpaces(line);
  const negate = body.startsWith(NEGATE);
  if (negate) body = body.slice(1);
  const dirOnly = body.endsWith(SEPARATOR);
  if (dirOnly) body = body.slice(0, -1);
  const anchored = body.includes(SEPARATOR);
  if (body.startsWith(SEPARATOR)) body = body.slice(1);
  if (!body) return null;
  const tokens = tokenize(body);
  if (tokens === null) return null;
  return Object.freeze({ pattern: line, negate, dirOnly, anchored, ignoreCase, segments: toSegments(tokens) });
}

/**
 * Parses the text of a .gitignore file. Blank lines and "#" comments are dropped ("\#" and "\!"
 * start a literal "#" or "!"), trailing spaces are trimmed unless escaped, "!" negates, a
 * trailing "/" matches folders only, and a leading or interior "/" anchors the pattern to the
 * .gitignore's folder. CRLF line ends and a UTF-8 byte order mark are accepted.
 * @param {string} text
 * @param {{ignoreCase?:boolean}} [options] ignoreCase: fold ASCII letters, as git's
 *   core.ignorecase; defaults to true on Windows and macOS, false elsewhere
 * @returns {ReadonlyArray<{pattern:string, negate:boolean, dirOnly:boolean, anchored:boolean,
 *   ignoreCase:boolean, segments:readonly object[]}>} the rules in file order
 * @throws {TypeError} when text is not a string
 */
export function parseGitignore(text, { ignoreCase = DEFAULT_IGNORE_CASE } = {}) {
  if (typeof text !== 'string') throw new TypeError('gitignore: text must be a string');
  const fold = Boolean(ignoreCase);
  return Object.freeze(text.replace(BOM, '').split(LINE_BREAK).map((line) => parseLine(line, fold)).filter(Boolean));
}

/**
 * Whether `items` match `pattern`, where an element for which isStar() holds matches any run of
 * items (none included) and any other element matches one item when matchOne(element, item).
 * On a mismatch it backtracks only to the latest star, which is enough because a star matches
 * any run; so it takes at most pattern.length × items.length steps.
 */
function wildcardMatch(pattern, items, isStar, matchOne) {
  let p = 0;
  let i = 0;
  let starP = -1;
  let starI = 0;
  while (i < items.length) {
    if (p < pattern.length && isStar(pattern[p])) {
      starP = p;
      starI = i;
      p += 1;
    } else if (p < pattern.length && matchOne(pattern[p], items[i])) {
      p += 1;
      i += 1;
    } else if (starP >= 0) {
      p = starP + 1;
      starI += 1;
      i = starI;
    } else {
      return false;
    }
  }
  while (p < pattern.length && isStar(pattern[p])) p += 1;
  return p === pattern.length;
}

/** Whether the code is in one of the token's ranges or POSIX classes. */
function classHolds(token, code) {
  return token.ranges.some(([lo, hi]) => code >= lo && code <= hi)
    || token.names.some((name) => POSIX_CLASSES[name](code));
}

/**
 * Whether one character class token matches the character `ch`. When folding, the class holds
 * if it holds for the character or its other-case twin (as in git's wildmatch), so "[A-C]"
 * takes "b" and "[[:upper:]]" takes "b"; negation applies after that.
 */
function classMatches(token, ch, fold) {
  const code = ch.codePointAt(0);
  const inside = classHolds(token, code) || (fold && classHolds(token, twinCode(code)));
  return inside !== token.negate;
}

const isStarToken = (token) => token.kind === STAR;

/** Whether one non-star token matches one character (a segment never holds "/"). */
function tokenMatches(token, ch, fold) {
  if (token.kind === LITERAL) return token.ch === ch || (fold && foldChar(token.ch) === foldChar(ch));
  if (token.kind === ANY) return true;
  return classMatches(token, ch, fold);
}

const isGlobstar = (segment) => segment === GLOBSTAR;
const exactMatches = (segment, chars) => wildcardMatch(segment, chars, isStarToken, (t, ch) => tokenMatches(t, ch, false));
const foldedMatches = (segment, chars) => wildcardMatch(segment, chars, isStarToken, (t, ch) => tokenMatches(t, ch, true));

/** Whether the rule matches the path, given as segments that are each a list of characters. */
function ruleMatches(rule, parts, isDir) {
  if (rule.dirOnly && !isDir) return false;
  const target = rule.anchored ? parts : parts.slice(-1);
  return wildcardMatch(rule.segments, target, isGlobstar, rule.ignoreCase ? foldedMatches : exactMatches);
}

/**
 * The verdict of one .gitignore's rules on a path; the last matching rule wins.
 * @param {ReadonlyArray<object>} rules from parseGitignore
 * @param {string} relPath posix path relative to the .gitignore's folder
 * @param {boolean} isDir whether the path names a folder
 * @returns {boolean|null} true: ignored; false: re-included by a "!" rule; null: no rule matched
 * @throws {TypeError} when relPath is not a non-empty string
 */
export function matchGitignore(rules, relPath, isDir) {
  if (typeof relPath !== 'string' || !relPath) throw new TypeError('gitignore: relPath must be a non-empty string');
  const parts = relPath.split(SEPARATOR).map((part) => Array.from(part));
  for (let r = rules.length - 1; r >= 0; r -= 1) {
    if (ruleMatches(rules[r], parts, Boolean(isDir))) return !rules[r].negate;
  }
  return null;
}

/**
 * Whether a path is ignored by a stack of .gitignore files. Levels are ordered shallow to deep;
 * the deepest level whose rules match decides, so a deeper file overrides a shallower one.
 * @param {ReadonlyArray<{base:string, rules:ReadonlyArray<object>}>} levels `base`: the posix
 *   path of the .gitignore's folder relative to the walk root ('' for the root); every level
 *   must be an ancestor folder of relPath
 * @param {string} relPath posix path relative to the walk root
 * @param {boolean} isDir whether the path names a folder
 * @returns {boolean}
 */
export function isIgnored(levels, relPath, isDir) {
  for (let l = levels.length - 1; l >= 0; l -= 1) {
    const { base, rules } = levels[l];
    const verdict = matchGitignore(rules, base ? relPath.slice(base.length + 1) : relPath, isDir);
    if (verdict !== null) return verdict;
  }
  return false;
}

/**
 * The rules of one .gitignore file. A path that is not a regular file (a symlink, a junction, a
 * folder), is larger than maxBytes, is missing or cannot be read gives no rules; never throws.
 * @param {string} file absolute path of the .gitignore
 * @param {number} maxBytes the largest file read
 * @param {() => void} [onUnusable] called when the path exists but its rules could not be used,
 *   so the caller can report that files it would have hidden may be included
 * @param {{ignoreCase?:boolean}} [options] as for parseGitignore
 * @returns {ReadonlyArray<object>} the rules, as parseGitignore returns them
 */
export function readGitignore(file, maxBytes, onUnusable = () => {}, options = {}) {
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size <= maxBytes) {
      const buf = fs.readFileSync(file);
      if (buf.length <= maxBytes) return parseGitignore(buf.toString('utf8'), options);
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return NO_RULES;
  }
  onUnusable();
  return NO_RULES;
}
