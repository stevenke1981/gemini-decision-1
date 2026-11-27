// Path helpers shared by the kinds that accept a folder from a request (retrieve root, skills dirs).
import fs from 'node:fs';
import path from 'node:path';

// Windows file names ignore case, but NTFS folds with its own table, not Unicode lowercasing:
// `projK` and `proj\u212A` (Kelvin sign) are two folders that `toLowerCase()` makes equal. So the
// lexical check folds ASCII A-Z only, and `path.relative` (which lowercases on win32) is not used.
const FOLD_CASE = process.platform === 'win32';
const foldAscii = (p) => p.replace(/[A-Z]/g, (c) => c.toLowerCase());

// Errors that mean "this path does not exist": ENOTDIR is raised when an ancestor is a file.
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/**
 * True when `target` is `base` itself or starts with `base` followed by a separator. Both are
 * normalized absolute paths; the comparison is exact (no case folding).
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
function startsOnBoundary(base, target) {
  if (target === base) return true;
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return target.startsWith(prefix);
}

/**
 * True when `target` is `base` itself or lies below it. Both are absolute paths; the comparison
 * ignores ASCII case on Windows and is exact elsewhere. Pure: no file system access.
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
export function isWithin(base, target) {
  const fold = FOLD_CASE ? foldAscii : (p) => p;
  return startsOnBoundary(fold(path.resolve(base)), fold(path.resolve(target)));
}

/**
 * The real path of `p` (links resolved). A missing leaf is tolerated (also when an ancestor is a
 * file): its nearest existing ancestor is resolved and the missing names are appended. Other
 * errors propagate.
 * @param {string} p an absolute path
 * @returns {string}
 */
export function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    if (!MISSING.has(err.code)) throw err;
    // Resolve the existing ancestor as well: a missing child still carries its parent's
    // junction or Windows 8.3 alias, while an existing allowed base is already canonical.
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realOrSelf(parent), path.basename(p));
  }
}

/**
 * True when `target` lies in one of `bases` once links are resolved on both sides, so a symlink or
 * junction inside a base cannot lead outside it. Both real paths carry the on-disk case of every
 * existing name, so they are compared exactly, with no case folding.
 * @param {string[]} bases absolute paths
 * @param {string} target an absolute path
 * @returns {{ok: boolean, real: string}} the verdict and the resolved target
 */
export function realWithinAny(bases, target) {
  const real = realOrSelf(path.resolve(target));
  return { ok: bases.some((base) => startsOnBoundary(realOrSelf(path.resolve(base)), real)), real };
}
