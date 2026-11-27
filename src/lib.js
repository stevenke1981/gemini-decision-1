// The library entry point: re-exports the public API so the package can be imported by name
// (`import { createEngine } from 'gemini-decision-1'`). It adds no behaviour of its own.
export { loadConfig } from './config.js';
export { createEngine } from './engine.js';
export { DecisionError } from './errors.js';
export { createHttpServer, startHttp } from './server/http.js';
export { createMcpServer } from './server/mcp.js';
export { createMemoryStore } from './memory/store.js';
export { VERSION } from './version.js';
