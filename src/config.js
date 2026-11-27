// Configuration: DEFAULTS, then a JSON config file, then environment variables, validated and
// deep-frozen. The API key comes only from the environment (or env files), never from the
// JSON config, so a shared config file cannot leak it. On the loaded config it is readable as
// `config.apiKey` but not enumerable, so JSON.stringify and object spreads never carry it.
//
// A config file in the working folder is read by every run of the tool from that folder, so it
// is trusted less than an explicit file (--config, GEMINI_CORE_CONFIG) or the home config: it may
// not set the keys in TRUSTED_ONLY_KEYS, which would send the key elsewhere or move where memory,
// the ledger and the indexed folders are.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, EFFORTS, MODES } from './defaults.js';
import { homeDir } from './envfile.js';

export const CONFIG_FILE = 'gemini-core.config.json';
// Below this a summary is mostly its `[summarized N→M tokens]` marker.
const MIN_SUMMARY_CHARS = 64;
const TRUSTED_ONLY_KEYS = [['gemini', 'url'], ['memory', 'path'], ['ledger', 'path'], ['ledger', 'enabled'], ['skills', 'dirs'], ['retrieve', 'allowedRoots'], ['retrieve', 'respectGitignore'], ['server', 'host']];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// route.models entries and route.start are validated by their own rules, so their keys are listed here.
const MODEL_KEYS = Object.freeze(['id', 'tier', 'contextWindow', 'capabilities', 'local', 'efforts', 'strengths']);
const START_KEYS = Object.freeze(['model', 'effort']);
// The longest model id: route ids are choice keys of the model question (see validateQuestions).
const MAX_CHOICE_KEY_CHARS = 128;
const MAX_CHOICE_KEY_BYTES = 512;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

const orDefault = (v, fallback) => (v === undefined ? fallback : v);

/** A new object: `over` merged into `base`; arrays and scalars in `over` replace. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** The config file used: explicit, GEMINI_CORE_CONFIG, ./gemini-core.config.json, <home>/config.json. */
export function configFileCandidates({ env = process.env, cwd = process.cwd(), file } = {}) {
  if (file) return [path.resolve(cwd, file)];
  if (env.GEMINI_CORE_CONFIG) return [path.resolve(cwd, env.GEMINI_CORE_CONFIG)];
  return [path.join(cwd, CONFIG_FILE), path.join(homeDir(env), 'config.json')];
}

/** "section.key" of the first trusted-only key the config sets, or null. */
function untrustedKey(json) {
  const hit = TRUSTED_ONLY_KEYS.find(([section, key]) => isPlainObject(json[section]) && json[section][key] !== undefined);
  return hit ? hit.join('.') : null;
}

/** The first prototype key (__proto__, constructor, prototype) found anywhere in `value`, or null. */
function unsafeKey(value) {
  if (value == null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) return k;
    const inner = unsafeKey(v);
    if (inner) return inner;
  }
  return null;
}

/** "section.key" (or a top-level key) of the first key `json` sets that DEFAULTS does not have, or null. */
function unknownKey(json) {
  for (const [key, value] of Object.entries(json)) {
    if (!Object.hasOwn(DEFAULTS, key)) return key;
    if (!isPlainObject(DEFAULTS[key])) continue;
    if (!isPlainObject(value)) continue;
    const inner = Object.keys(value).find((k) => !Object.hasOwn(DEFAULTS[key], k));
    if (inner !== undefined) return `${key}.${inner}`;
  }
  return null;
}

/** The first section (a key of DEFAULTS whose default is an object) that `json` sets to something else, or null. */
function wrongTypeSection(json) {
  const hit = Object.entries(json).find(([key, value]) => value !== undefined
    && Object.hasOwn(DEFAULTS, key) && isPlainObject(DEFAULTS[key]) && !isPlainObject(value));
  return hit ? hit[0] : null;
}

/** "route.models[i].key" or "route.start.key" of the first unknown key in the route's own lists, or null. */
function unknownRouteKey(json) {
  const route = json.route;
  if (!isPlainObject(route)) return null;
  if (isPlainObject(route.start)) {
    const k = Object.keys(route.start).find((x) => !START_KEYS.includes(x));
    if (k !== undefined) return `route.start.${k}`;
  }
  if (!Array.isArray(route.models)) return null;
  for (const [i, m] of route.models.entries()) {
    const k = isPlainObject(m) ? Object.keys(m).find((x) => !MODEL_KEYS.includes(x)) : undefined;
    if (k !== undefined) return `route.models[${i}].${k}`;
  }
  return null;
}

/** The first unknown key anywhere in a config object, or null. */
function firstUnknownKey(json) {
  return unknownKey(json) ?? unknownRouteKey(json);
}

/** Parses and checks one config file's text; `trusted` is false for a working-folder file. */
function parseConfigFile(file, text, trusted) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`config ${file} is not valid JSON: ${err.message}`);
  }
  if (!isPlainObject(json)) throw new Error(`config ${file} must be a JSON object`);
  if ('apiKey' in json || (isPlainObject(json.gemini) && 'apiKey' in json.gemini)) {
    throw new Error(`config ${file}: put the API key in GEMINI_API_KEY or GOOGLE_API_KEY, not in the config file`);
  }
  const unsafe = unsafeKey(json);
  if (unsafe) throw new Error(`config ${file}: "${unsafe}" is not allowed as a config key`);
  const unknown = firstUnknownKey(json);
  if (unknown) throw new Error(`config ${file}: unknown key "${unknown}"`);
  const wrongType = wrongTypeSection(json);
  if (wrongType) throw new Error(`config ${file}: "${wrongType}" must be an object`);
  const restricted = trusted ? null : untrustedKey(json);
  if (restricted) {
    throw new Error(`config ${file}: "${restricted}" can be set only in the home config or an explicit config file (--config or GEMINI_CORE_CONFIG), not in a working-folder config`);
  }
  return json;
}

/** The first config file that exists, parsed. `explicit` files must exist; `cwdFile` is untrusted. */
function readConfigFile(candidates, { explicit, cwdFile }) {
  for (const f of candidates) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    } catch (err) {
      if (err.code === 'ENOENT' && !explicit) continue;
      throw new Error(`cannot read config ${f}: ${err.message}`);
    }
    return { file: f, json: parseConfigFile(f, text, explicit || f !== cwdFile) };
  }
  return { file: null, json: {} };
}

function envOverrides(env) {
  const o = { gemini: {} };
  if (env.GEMINI_CORE_MODE) o.mode = env.GEMINI_CORE_MODE.trim().toLowerCase();
  if (env.GEMINI_DECISION_URL) o.gemini.url = env.GEMINI_DECISION_URL;
  if (env.GEMINI_DECISION_MODEL) o.gemini.model = env.GEMINI_DECISION_MODEL;
  if (env.GEMINI_DECISION_TIMEOUT_MS) o.gemini.timeoutMs = Number(env.GEMINI_DECISION_TIMEOUT_MS);
  if (env.GEMINI_MIN_CONFIDENCE) o.minConfidence = Number(env.GEMINI_MIN_CONFIDENCE);
  return o;
}

/** A model entry with the optional fields filled in; non-objects pass through to validation. */
function withModelDefaults(m) {
  if (!isPlainObject(m)) return m;
  return {
    ...m,
    capabilities: orDefault(m.capabilities, []),
    local: orDefault(m.local, false),
    strengths: orDefault(m.strengths, ''),
  };
}

function check(cond, msg) {
  if (!cond) throw new Error(`config: ${msg}`);
}

/** An https URL without credentials, or http to 127.0.0.1 or localhost (tests, local proxies). */
function isAllowedGeminiUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

/** True when `id` can be a choice key of the model question: the rule of validateQuestions. */
function isChoiceKey(id) {
  return typeof id === 'string' && id.trim() !== '' && id === id.trim()
    && id.length <= MAX_CHOICE_KEY_CHARS && Buffer.byteLength(id, 'utf8') <= MAX_CHOICE_KEY_BYTES
    && !/[\x00-\x1f\x7f-\x9f\s]/u.test(id.replaceAll(' ', ''));
}

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const prob = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const posInt = (v) => Number.isInteger(v) && v > 0;

/** Checks every route.models entry: unique ids, positive numbers, known efforts, typed optional fields. */
function checkModels(models) {
  check(Array.isArray(models) && models.length > 0, 'route.models must list at least one model');
  const ids = new Set();
  for (const m of models) {
    check(isPlainObject(m), 'route.models entries must be objects');
    check(typeof m.id === 'string' && m.id && !ids.has(m.id), `route.models: missing or duplicate id "${m.id}"`);
    check(isChoiceKey(m.id), `route.models: id "${m.id}" must have no surrounding whitespace, no control characters or line breaks, and at most ${MAX_CHOICE_KEY_CHARS} characters`);
    ids.add(m.id);
    check(posInt(m.tier), `route.models ${m.id}: tier must be a positive integer`);
    check(posInt(m.contextWindow), `route.models ${m.id}: contextWindow must be a positive integer`);
    check(Array.isArray(m.efforts) && m.efforts.length > 0 && m.efforts.every((e) => EFFORTS.includes(e)), `route.models ${m.id}: efforts must list known efforts`);
    check(Array.isArray(m.capabilities) && m.capabilities.every((x) => typeof x === 'string'), `route.models ${m.id}: capabilities must be an array of strings`);
    check(typeof m.local === 'boolean', `route.models ${m.id}: local must be true or false`);
    check(typeof m.strengths === 'string', `route.models ${m.id}: strengths must be a string`);
  }
}

/** Throws a clear error for the first invalid field. */
export function validateConfig(c) {
  check(MODES.includes(c.mode), `mode must be ${MODES.join('|')}; got "${c.mode}"`);
  check(isAllowedGeminiUrl(c.gemini.url), 'gemini.url must be an https URL without credentials (http only for 127.0.0.1 or localhost)');
  check(nonEmptyString(c.gemini.model), 'gemini.model must be a non-empty string');
  check(posInt(c.gemini.timeoutMs), 'gemini.timeoutMs must be a positive integer');
  check(posInt(c.gemini.maxQuestionsPerCall) && c.gemini.maxQuestionsPerCall <= 1000, 'gemini.maxQuestionsPerCall must be 1 to 1000');
  check(prob(c.minConfidence), 'minConfidence must be 0..1');
  check(Array.isArray(c.ladder) && c.ladder.length >= 2 && c.ladder.length <= 10, 'ladder needs 2 to 10 efforts');
  for (let i = 0; i < c.ladder.length; i++) {
    check(EFFORTS.includes(c.ladder[i]), `ladder: unknown effort "${c.ladder[i]}"`);
    if (i > 0) check(EFFORTS.indexOf(c.ladder[i]) > EFFORTS.indexOf(c.ladder[i - 1]), 'ladder must run from least to most effort without repeats');
  }
  check(prob(c.route.effortQuantile) && prob(c.route.modelQuantile), 'route quantiles must be 0..1');
  check(Number.isFinite(c.route.contextHeadroom) && c.route.contextHeadroom >= 1, 'route.contextHeadroom must be a number of at least 1');
  checkModels(c.route.models);
  if (c.route.start !== null) {
    const start = c.route.start;
    check(isPlainObject(start) && c.route.models.some((m) => m.id === start.model) && EFFORTS.includes(start.effort),
      'route.start must name a configured model and a known effort');
  }
  check(Array.isArray(c.skills.dirs) && c.skills.dirs.every(nonEmptyString), 'skills.dirs must be an array of non-empty strings');
  check(posInt(c.skills.shortlist) && posInt(c.skills.maxSkills) && prob(c.skills.threshold), 'skills: shortlist/maxSkills positive, threshold 0..1');
  check(posInt(c.retrieve.shortlist) && posInt(c.retrieve.budgetTokens) && prob(c.retrieve.threshold), 'retrieve: shortlist/budgetTokens positive, threshold 0..1');
  check(Array.isArray(c.retrieve.allowedRoots) && c.retrieve.allowedRoots.every((r) => typeof r === 'string' && path.isAbsolute(r)), 'retrieve.allowedRoots must list absolute paths');
  check(posInt(c.retrieve.maxFileBytes) && posInt(c.retrieve.maxFiles) && posInt(c.retrieve.excerptChars), 'retrieve: maxFileBytes, maxFiles and excerptChars must be positive integers');
  check(Array.isArray(c.retrieve.extensions) && c.retrieve.extensions.every((e) => typeof e === 'string' && e.startsWith('.')), 'retrieve.extensions must be an array of strings starting with "."');
  check(Array.isArray(c.retrieve.ignoreDirs) && c.retrieve.ignoreDirs.every((d) => typeof d === 'string'), 'retrieve.ignoreDirs must be an array of strings');
  check(posInt(c.retrieve.maxWalkMs), 'retrieve.maxWalkMs must be a positive integer');
  check(typeof c.retrieve.respectGitignore === 'boolean', 'retrieve.respectGitignore must be true or false');
  check(Number.isInteger(c.cacheTtlMs) && c.cacheTtlMs >= 0, 'cacheTtlMs must be a non-negative integer');
  check(posInt(c.retrieve.chunkLines) && c.retrieve.chunkOverlap >= 0 && c.retrieve.chunkOverlap < c.retrieve.chunkLines, 'retrieve: chunkOverlap must be below chunkLines');
  check(prob(c.memory.recallThreshold) && prob(c.memory.durableThreshold) && prob(c.memory.duplicateSimilarity), 'memory thresholds must be 0..1');
  check(posInt(c.memory.shortlist) && posInt(c.memory.maxRecall), 'memory: shortlist and maxRecall must be positive integers');
  check(typeof c.ledger.enabled === 'boolean', 'ledger.enabled must be true or false');
  check(posInt(c.ledger.maxBytes), 'ledger.maxBytes must be a positive integer');
  check(nonEmptyString(c.server.host), 'server.host must be a non-empty string');
  check(posInt(c.server.maxBodyBytes), 'server.maxBodyBytes must be a positive integer');
  const k = c.compress;
  check(prob(k.softRatio) && prob(k.hardRatio) && prob(k.targetRatio) && k.targetRatio <= k.softRatio && k.softRatio <= k.hardRatio, 'compress: need targetRatio <= softRatio <= hardRatio, all 0..1');
  check(Number.isInteger(k.keepRecentTurns) && k.keepRecentTurns >= 0, 'compress.keepRecentTurns must be >= 0');
  check(posInt(k.maxSegmentsAsked) && posInt(k.excerptChars) && posInt(k.summaryChars), 'compress: maxSegmentsAsked, excerptChars and summaryChars must be positive integers');
  check(k.summaryChars >= MIN_SUMMARY_CHARS, `compress.summaryChars must be at least ${MIN_SUMMARY_CHARS}, room for the summary marker and some text`);
  check(Number.isInteger(c.server.port) && c.server.port >= 0 && c.server.port < 65536, 'server.port must be 0..65535');
}

/** The merged config completed with the values that depend on the home folder and the file read. */
function completeConfig(merged, { home, used, env, cwd }) {
  const models = Array.isArray(merged.route.models) ? merged.route.models.map(withModelDefaults) : merged.route.models;
  return deepMerge(merged, {
    home,
    // The working folder the config was loaded for; the default scope of retrieve roots.
    cwd: path.resolve(cwd),
    configFile: used,
    memory: { path: merged.memory.path || path.join(home, 'memory.jsonl') },
    ledger: { path: merged.ledger.path || path.join(home, 'decisions.jsonl') },
    route: { models },
  });
}

/**
 * The effective configuration (deep-frozen) plus where it came from.
 * @param {{env?:object, cwd?:string, file?:string, overrides?:object}} [o]
 * @returns {object} config with `home` and `configFile` filled in; `apiKey` readable but not enumerable
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), file, overrides } = {}) {
  const explicit = Boolean(file || env.GEMINI_CORE_CONFIG);
  const { file: used, json } = readConfigFile(configFileCandidates({ env, cwd, file }), { explicit, cwdFile: path.join(cwd, CONFIG_FILE) });
  const home = homeDir(env);
  const unknown = firstUnknownKey(overrides ?? {});
  if (unknown) throw new Error(`config: unknown key "${unknown}" in overrides`);
  const wrongType = wrongTypeSection(overrides ?? {});
  if (wrongType) throw new Error(`config: "${wrongType}" must be an object in overrides`);
  const merged = deepMerge(deepMerge(deepMerge(DEFAULTS, json), envOverrides(env)), overrides ?? {});
  const c = completeConfig(merged, { home, used, env, cwd });
  Object.defineProperty(c, 'apiKey', { value: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '', enumerable: false });
  validateConfig(c);
  return deepFreeze(c);
}

/** The GeminiOptions for the client, from a loaded config. */
export function geminiOptions(c) {
  return {
    url: c.gemini.url, apiKey: c.apiKey, model: c.gemini.model, timeoutMs: c.gemini.timeoutMs,
    maxQuestionsPerCall: c.gemini.maxQuestionsPerCall,
  };
}
