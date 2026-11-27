// The HTTP JSON sidecar (docs/design.md §6): `GET /health`, `POST /v1/decide/:kind` and
// `GET /v1/stats`, bound to loopback by default. Status codes: 200 ok; 400 a body that is not JSON
// or an input the kind's normalize or the engine's prepare rejects (a TypeError); 404 an unknown
// route or kind; 413 a body over server.maxBodyBytes; 403 a browser Origin or, on a loopback server, a
// foreign Host header (DNS rebinding); 415 a non-JSON content type; 502 a strict Gemini failure;
// 500 anything else. Every message
// goes through scrubSecrets, so the API key never reaches a response or the log.
import http from 'node:http';
import { scrub } from '../contract.js';
import { decisionErrorCode, isGeminiFailure } from '../engine.js';
import { DEFAULTS, KINDS } from '../defaults.js';
import { KIND_MODULES } from '../registry.js';
import { VERSION } from '../version.js';

/** The default largest request body accepted, in bytes (8 MB); config.server.maxBodyBytes overrides it. */
export const BODY_LIMIT_BYTES = DEFAULTS.server.maxBodyBytes;
const LOOPBACK_NAMES = new Set(['localhost', '::1']);
const JSON_TYPE = 'application/json';
const DECIDE_PATH = /^\/v1\/decide\/([^/]+)$/;
const STATUS = Object.freeze({ OK: 200, BAD_INPUT: 400, FORBIDDEN: 403, NOT_FOUND: 404, TOO_LARGE: 413, MEDIA_TYPE: 415, UNPROCESSABLE: 422, UPSTREAM: 502, SERVER: 500 });

const writeStderr = (line) => process.stderr.write(line);

/**
 * A message with every copy of the given secrets, and every secret-looking span, replaced.
 * @param {unknown} text an Error (its message is used), or anything printable
 * @param {string[]} secrets literal values to remove (the API key)
 * @returns {string}
 */
export function scrubSecrets(text, secrets = []) {
  return scrub(text, secrets);
}

function send(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendError(res, ctx, status, message, extra, code) {
  send(res, status, { ok: false, error: scrubSecrets(message, ctx.secrets), ...(code ? { errorCode: code } : {}) }, extra);
}

/**
 * The body as text, or `null` when it is over the limit. An over-limit body is drained and not
 * kept, so the client finishes sending and can read the 413 answer.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        // Answering now would close the socket under a client that is still sending (a reset
        // on Windows, and the 413 is lost), so the answer waits for 'end'.
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** True for 127.0.0.0/8 (four numeric parts), localhost and ::1; the one loopback rule of the server and the CLI. */
export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase();
  return LOOPBACK_NAMES.has(h) || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The hostname of a Host header (no port, no IPv6 brackets), lowercased; '' when absent or malformed. */
function hostnameOf(header) {
  const text = String(header ?? '').trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d*)?$/.exec(text);
  if (bracketed) return bracketed[1];
  return text.includes(':') ? text.slice(0, text.indexOf(':')) : text;
}

/** The body limit to enforce: the default when unset, else the configured positive integer (a TypeError otherwise). */
function resolveBodyLimit(value) {
  if (value === undefined) return BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('createHttpServer: config.server.maxBodyBytes must be a positive integer');
  return value;
}

function decodeKind(raw) {
  try {
    const kind = decodeURIComponent(raw);
    return KINDS.includes(kind) ? kind : null;
  } catch {
    return null;
  }
}

/** The status of a failed decision: a TypeError that is not a Gemini failure is bad input (400). */
function failureStatus(err, code) {
  if (isGeminiFailure(err)) return STATUS.UPSTREAM;
  if (code === 'ESCALATION_EXHAUSTED') return STATUS.UNPROCESSABLE;
  return err instanceof TypeError ? STATUS.BAD_INPUT : STATUS.SERVER;
}

/** A failed decision: 502 in strict mode (a Gemini failure), 500 otherwise. Logged, then answered. */
function failDecision(res, ctx, kind, err) {
  const code = decisionErrorCode(err);
  const status = failureStatus(err, code);
  ctx.log(`gemini-core: ${kind}: ${scrubSecrets(err?.message ?? err, ctx.secrets)}\n`);
  sendError(res, ctx, status, err?.message ?? err, undefined, status === STATUS.BAD_INPUT ? decisionErrorCode(err, 'INVALID_INPUT') : code);
}

/** The body of a decide request, validated by the kind's normalize before any work is done. */
async function parseDecideBody(req, res, ctx, kind) {
  const text = await readBody(req, ctx.bodyLimit);
  if (text === null) {
    sendError(res, ctx, STATUS.TOO_LARGE, `request body is over ${ctx.bodyLimit} bytes`, { connection: 'close' });
    return undefined;
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    sendError(res, ctx, STATUS.BAD_INPUT, 'request body is not valid JSON');
    return undefined;
  }
  try {
    KIND_MODULES[kind].normalize(input, ctx.config);
  } catch (err) {
    sendError(res, ctx, STATUS.BAD_INPUT, err?.message ?? err, undefined, decisionErrorCode(err, 'INVALID_INPUT'));
    return undefined;
  }
  return { input };
}

async function decide(req, res, ctx, rawKind) {
  const kind = decodeKind(rawKind);
  if (kind === null) return sendError(res, ctx, STATUS.NOT_FOUND, 'unknown kind');
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== JSON_TYPE) {
    req.resume();
    return sendError(res, ctx, STATUS.MEDIA_TYPE, 'content-type must be application/json');
  }
  const parsed = await parseDecideBody(req, res, ctx, kind);
  if (!parsed) return undefined;
  try {
    return send(res, STATUS.OK, await ctx.engine.decide(kind, parsed.input));
  } catch (err) {
    return failDecision(res, ctx, kind, err);
  }
}

async function handle(req, res, ctx) {
  // This sidecar serves nonbrowser clients. Browser writes must be blocked before any work,
  // since missing CORS headers alone do not prevent a simple request from changing memory.
  if (req.headers.origin !== undefined) {
    req.resume();
    return sendError(res, ctx, STATUS.FORBIDDEN, 'browser-origin requests are not supported');
  }
  if (ctx.guard.checkHost &&!isLoopbackHost(hostnameOf(req.headers.host))) {
    req.resume();
    return sendError(res, ctx, STATUS.FORBIDDEN, 'host header is not a loopback host');
  }
  const pathname = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && pathname === '/health') {
    return send(res, STATUS.OK, { ok: true, version: VERSION, mode: ctx.config.mode });
  }
  if (req.method === 'GET' && pathname === '/v1/stats') return send(res, STATUS.OK, ctx.engine.stats());
  const match = DECIDE_PATH.exec(pathname);
  if (req.method === 'POST' && match) return decide(req, res, ctx, match[1]);
  return sendError(res, ctx, STATUS.NOT_FOUND, 'not found');
}

function failUnexpected(res, ctx, err) {
  const message = scrubSecrets(err?.message ?? err, ctx.secrets);
  ctx.log(`gemini-core: server: ${message}\n`);
  if (res.headersSent) res.end();
  else send(res, STATUS.SERVER, { ok: false, error: message });
}

/**
 * The HTTP server, not yet listening.
 * @param {{engine: object, config: object, log?: (line: string) => void}} options `log` receives
 *   one line per failed request (stderr by default)
 * @returns {import('node:http').Server}
 */
export function createHttpServer({ engine, config, log = writeStderr } = {}) {
  if (!engine) throw new TypeError('createHttpServer: engine is required');
  if (!config) throw new TypeError('createHttpServer: config is required');
  const bodyLimit = resolveBodyLimit(config.server?.maxBodyBytes);
  // The Host check follows the address the socket really binds, not config.server.host (startHttp
  // can override the host). Until the server is listening the check is on, the safe default: a
  // caller that listens on its own gets it too, and it is dropped only for a known non-loopback bind.
  const guard = { checkHost: true };
  const ctx = Object.freeze({ engine, config, log, bodyLimit, guard, secrets: Object.freeze([config.apiKey].filter(Boolean)) });
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => failUnexpected(res, ctx, err));
  });
  server.on('listening', () => {
    const address = server.address();
    guard.checkHost = typeof address === 'string' || isLoopbackHost(address?.address);
  });
  return server;
}

/**
 * Creates the server and starts listening. Host and port default to the config's `server` block.
 * @returns {Promise<import('node:http').Server>} resolves once listening; `server.address()` has the port
 */
export function startHttp({ engine, config, host = config?.server?.host, port = config?.server?.port, log } = {}) {
  const server = createHttpServer({ engine, config, log });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
