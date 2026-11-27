// The decision ledger (docs/design.md §5): one JSON line per decision in a JSONL file. Only the
// fields in LEDGER_FIELDS are written, so a decision's `result`, `reasons`, and the task, query,
// observation or segments never reach the file. `summary` is the kind's one-line digest of its
// result; a kind must keep input text out of it. A write is a synchronous append. A failure is
// reported to stderr once and then ignored, so a full disk never fails a decision. With `maxBytes`,
// a file that would grow past it is first renamed to `<file>.1` (replacing the old one), so the
// ledger keeps at most two files. The file is created with mode 0o600 (not enforced on Windows).
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const PRIVATE_MODE = 0o600;
const ROTATED_SUFFIX = '.1';

export const LEDGER_FIELDS = Object.freeze(['kind', 'source', 'confidence', 'cost', 'tokens', 'calls', 'latencyMs', 'error', 'errorCode', 'summary']);

/**
 * The record written for a decision: a timestamp and the whitelisted fields, absent ones null.
 * @param {object} decision
 * @param {Date} [now]
 * @returns {object}
 */
export function ledgerRecord(decision, now = new Date()) {
  const record = { ts: now.toISOString() };
  for (const field of LEDGER_FIELDS) record[field] = decision[field] ?? null;
  return record;
}

/** The file's size in bytes; 0 when it does not exist. */
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

/** Puts a moved-aside ledger back as `file` without overwriting anything: link when `file` is absent, else append. */
function restore(aside, file) {
  try {
    fs.linkSync(aside, file); // fails with EEXIST rather than replacing a file another process created
  } catch {
    fs.appendFileSync(file, fs.readFileSync(aside), { mode: PRIVATE_MODE });
  }
  fs.rmSync(aside, { force: true });
}

/**
 * Moves a full ledger to `<file>.1` when appending `line` would take it past `maxBytes`.
 *
 * Several processes (HTTP, MCP, CLI) may rotate the same file, so the size read first may be stale:
 * another process may have rotated and started a fresh file since. The file is therefore renamed to a
 * private name first, and only replaces `.1` if what was actually moved is still over the limit. If
 * it is a fresh file, its lines are put back (never overwritten, never dropped). Renaming a file
 * to a name nobody else uses never replaces anything, which keeps this safe on Windows too, where a
 * rename over an existing file or one another process holds open can fail or race; only the final
 * step replaces `.1`, and then the source is a file this process alone owns. The rename itself is
 * atomic, so at most one process moves a given file; the others see ENOENT and skip.
 */
function rotateIfFull(file, line, maxBytes) {
  const need = Buffer.byteLength(line, 'utf8');
  const size = sizeOf(file);
  if (size === 0 || size + need <= maxBytes) return;
  const aside = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.rotating`;
  try {
    fs.renameSync(file, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return; // another process rotated it first
    throw err;
  }
  try {
    const moved = sizeOf(aside);
    if (moved + need <= maxBytes) restore(aside, file); // not the file that was measured
    else fs.renameSync(aside, `${file}${ROTATED_SUFFIX}`);
  } catch (err) {
    try {
      if (fs.existsSync(aside)) restore(aside, file);
    } catch { /* the lines stay in the .rotating file rather than being lost */ }
    throw err;
  }
}

/**
 * @param {{path: string, enabled?: boolean, maxBytes?: number}} options `path` is required when
 *   enabled; `maxBytes` (a positive integer) turns on rotation to `<path>.1`, absent: never rotate
 * @returns {Readonly<{append: (decision: object) => void}>}
 */
export function createLedger({ path: file, enabled = true, maxBytes }) {
  if (enabled && typeof file !== 'string') throw new TypeError('createLedger: path must be a string when the ledger is enabled');
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) throw new TypeError('createLedger: maxBytes must be a positive integer');
  let warned = false;
  const warn = (err) => {
    if (warned) return;
    warned = true;
    process.stderr.write(`gemini-core: decision ledger not written to ${file}: ${err.message}\n`);
  };
  return Object.freeze({
    append(decision) {
      if (!enabled) return;
      const line = `${JSON.stringify(ledgerRecord(decision))}\n`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // A failed rotation must not lose the record: it is appended to the current file regardless.
        if (maxBytes !== undefined) {
          try {
            rotateIfFull(file, line, maxBytes);
          } catch (err) {
            warn(err);
          }
        }
        fs.appendFileSync(file, line, { encoding: 'utf8', mode: PRIVATE_MODE });
      } catch (err) {
        warn(err);
      }
    },
  });
}
