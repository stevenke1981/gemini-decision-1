# Gemini Decision Core

A decision layer for coding-agent harnesses, adapted from [luna-decision-core](https://github.com/stevenke1981/luna-decision-core) and powered by Google's **Gemini Decision 1**. It advises on model and effort routing, skills, retrieval, memory and context compression. The decision model selects among bounded options; it does not generate prose or switch another agent's model for you.

這是以 Google Gemini Decision 1 為核心的 agent 決策層，提供 CLI、Node.js 函式庫、HTTP sidecar 與 MCP server。可先使用完全離線的規則模式，再自行設定 Google API 金鑰啟用 Gemini。

## Requirements and quick start

Node.js **22.15 or newer** is required. There are no runtime dependencies.

~~~bash
git clone https://github.com/stevenke1981/gemini-decision-1.git
cd gemini-decision-1
node bin/gemini-core.js --help
node bin/gemini-core.js route --task "Fix a failing test" --mode heuristic
npm test
~~~

The routing model list in src/defaults.js is an example list of *generation* models; change route.models to match the models and capabilities actually available to your harness. Gemini Decision 1 evaluates the choice and does not execute it. The [example configuration](gemini-core.config.example.json) shows a customized list.

## Connect Google Gemini

Set GEMINI_API_KEY or GOOGLE_API_KEY in the environment; GEMINI_API_KEY takes precedence. Alternatively copy [.env.example](.env.example) to .env.local in the package directory and fill in a key. The file is ignored by Git. The tool also reads .env.local and .env from GEMINI_CORE_HOME (default ~/.gemini-decision-1). Existing nonempty environment variables take precedence. Never put keys in JSON configuration or committed files.

~~~powershell
# Set the key in your own shell or .env.local first.
node bin/gemini-core.js config
node bin/gemini-core.js probe
node bin/gemini-core.js route --task "Investigate a failing test" --mode gemini
~~~

The config command displays only whether the key is set. The probe sends one real request to Google and can incur charges. This repository's automated tests use local fake servers and never require a real key.

Modes:

- auto (default): ask Gemini; fall back to local rules when it fails or abstains. The result includes the error if a fallback occurred.
- gemini: strict Gemini mode; a provider failure is returned as an error.
- heuristic: local rules only, with no model request or key required.

All modes may settle some decisions locally without contacting the model. Set GEMINI_CORE_MODE or pass --mode after a command.

## Commands

~~~text
route --task TEXT                  select generation model and effort
route --input-json FILE            use the full routing input
skills --task TEXT --dir DIRECTORY recommend skills
retrieve --query TEXT --root DIR   select relevant repository chunks
recall --query TEXT                select stored memories
remember --text TEXT --dry-run     evaluate a memory without writing
memories                           list every stored memory
forget --id ID                     remove one stored memory (--purge also erases its earlier versions)
purge-history                      erase the earlier versions kept in memory.jsonl.history (--id ID: one memory's)
compress --file INPUT.json         choose which transcript segments to keep, summarize or drop
serve                              start the local HTTP sidecar
mcp                                start the stdio MCP server
config | probe | --help | --version
~~~

Run node bin/gemini-core.js --help for flags. To install the command into the local Node environment, run npm install -g . from this directory; the executable is gemini-core.

The six decision kinds are route, skills, retrieve, memory_recall, memory_write, and compress. Memory is stored in memory.jsonl and the decision ledger in decisions.jsonl under the configured home by default. The remember command writes unless --dry-run is supplied. The ledger keeps a decision summary rather than the full task text. A deterministic local summarizer is used for compression; Gemini Decision 1 does not generate summaries.

## MCP and HTTP

The stdio server exposes gemini_route, gemini_skills, gemini_retrieve, gemini_recall, gemini_remember, and gemini_compress. Example Codex-style configuration, with an absolute path substituted:

~~~toml
[mcp_servers.gemini_core]
command = "node"
args = ["/absolute/path/to/gemini-decision-1/bin/gemini-core.js", "mcp"]

[mcp_servers.gemini_core.env]
GEMINI_CORE_MODE = "heuristic"
~~~

Use the package or home .env.local, or the host's secret mechanism, for a key. Adding this configuration is a user action; this repository does not install itself into a host. See [integration examples](docs/integration.md) and the [Traditional Chinese guide](docs/usage.zh-TW.md).

For HTTP use node bin/gemini-core.js serve --mode heuristic, then GET /health, GET /v1/stats, or POST /v1/decide/:kind with a JSON body. The default address is 127.0.0.1:8792. The server has **no authentication**; keep it on loopback and do not expose it to untrusted clients. Requests with an Origin header are rejected, and so are requests whose Host header is not a loopback host while the server is bound to loopback. The request body limit is `server.maxBodyBytes` (default 8 MB).

The repository index honours `.gitignore` files inside the indexed root (`retrieve.respectGitignore`, default true), so files git ignores are neither indexed nor sent to Gemini. It reads only `.gitignore` files, not `.git/info/exclude` or global excludes, and never runs `git`. Matching ignores ASCII letter case on Windows and macOS, as git does by default. A `.gitignore` that cannot be used (a link, unreadable, too large) is counted in the result's `skipped`. Long-running servers build the index without blocking other requests.

Replaced and removed memories are appended to `memory.jsonl.history`, so `forget` alone leaves the text there; `forget --id ID --purge` or `purge-history [--id ID]` erases it (the file's lines are removed, not overwritten on the disk). The decision ledger rotates to `decisions.jsonl.1` once it passes `ledger.maxBytes` (default 10 MB).

Request input is trusted less than configuration: a skills `dirs` entry sent over MCP or HTTP must lie inside the configured `skills.dirs` or the working folder. In rules mode only observations with `source: "user"` are stored as memories; with Gemini, a tool's or the agent's observation may be kept as a new memory but never rewrites one the user wrote. Configuration is strict: an unknown key is an error.

## Node.js library

~~~js
import { loadConfig, createEngine } from './src/lib.js';

const config = loadConfig({ overrides: { mode: 'heuristic' } });
const engine = createEngine({ config });
const decision = await engine.route({ task: 'Fix a failing unit test' });
console.log(decision.result, decision.source);
~~~

Each decision includes its source, result, confidence when available, reasons, call count, latency, and token/cost estimates when returned by the provider. Set GEMINI_CORE_HOME to choose the storage directory. A gemini-core.config.json in the working directory is supported with restrictions on sensitive settings; use an explicitly selected config or the home config for paths and the provider URL. GEMINI_CORE_CONFIG or --config selects a file. See [design](docs/design.md) and [integration](docs/integration.md) for details.

## API, privacy and cost

The provider adapter sends a shared text rubric and serialized decision state to Google's POST https://generativelanguage.googleapis.com/v1beta/decisions using x-goog-api-key. It maps internal predicate, choice and score questions to Google's noul, choice and score types and interprets their probabilities. Independent questions share state and are batched at gemini.maxQuestionsPerCall (default 16; maximum 1000); each batch resends the input. This application currently sends **text**, even though Google's API also accepts other modalities.

The app redacts recognizable secrets and the configured key from decision state and questions before sending them, but redaction is not a guarantee that all sensitive data is removed. Task text and selected skill descriptions, repository excerpts, memories or transcript excerpts can be sent to Google depending on the operation. Review what you provide and Google's applicable data terms. The configurable provider URL receives both the key and decision data; use only a trusted endpoint.

For gemini-decision-1, cost is an estimate at USD $0.10 per million input tokens using Google's published price on 2026-11-12. It is not a billing receipt and does not account for free-tier eligibility or later pricing changes. No estimate is provided for a different configured model. Check [Google's pricing](https://aistudio.google.com/docs/pricing) and [Decisions API documentation](https://aistudio.google.com/docs/decisions-api) before live use.

## Attribution and license

Adapted from [stevenke1981/luna-decision-core](https://github.com/stevenke1981/luna-decision-core), upstream commit df2a1f187606f4238893dd2059ac7bc49b629e8c. The original MIT copyright and license are preserved in [LICENSE](LICENSE).
