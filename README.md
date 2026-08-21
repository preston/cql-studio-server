# CQL Studio Server

Express ESM server for CQL Studio backend services and MCP (Model Context Protocol) tool orchestration.

## Features

- MCP protocol implementation for tool execution
- Ollama API proxy for browser CORS bypass (client-supplied base URL)
- OpenCode SDK gateway with isolated per-session CQL workspaces
- Read-only CQL Studio MCP tools for FHIR and VSAC context
- Web search via SearXNG (no API key; proxy to your own or public instance)
- Web content fetching and parsing
- CORS-enabled for webapp communication
- TypeScript with ES modules

## Setup

1. Install dependencies:

```bash
npm install
```

2. Export the environment variables you need (see [Configuration](#configuration)). The process reads `process.env` only — there is no `.env` file loader.

3. Build the project:

```bash
npm run build
```

4. Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run watch
```

## OpenCode runner

OpenCode does not run in the browser or in the public API process. CQL Studio Server owns the user session and delegates to a private runner container:

```text
Angular OpenCode tab -> CQL Studio Server :3003 -> OpenCode runner :4097
                                                    -> OpenCode serve :4096 (container-only)
                                                    -> Ollama /v1
                                                    -> per-session workspace volume
```

Build and start the runner from the adjacent `cql-studio` repository:

```bash
docker compose -f docker-compose.development.yml build opencode-runner
docker compose -f docker-compose.development.yml up -d opencode-runner
curl http://127.0.0.1:4097/health
```

Then run this server normally with `npm run watch` or `npm start`. The development defaults match the compose file. Production deployments must replace the shared token and keep port 4097 private.

```bash
export CQL_STUDIO_SERVER_OPENCODE_RUNNER_URL=http://localhost:4097
export CQL_STUDIO_SERVER_OPENCODE_RUNNER_TOKEN=replace-with-a-long-random-secret
# Address used from the runner container back to this API's tool bridge:
export CQL_STUDIO_SERVER_OPENCODE_TOOL_BRIDGE_URL=http://host.docker.internal:3003/api/opencode/tool-bridge
```

The runner accepts these environment variables:

- `OPENCODE_RUNNER_TOKEN` — must equal `CQL_STUDIO_SERVER_OPENCODE_RUNNER_TOKEN`.
- `OPENCODE_RUNNER_PORT` — public runner API inside the container; default `4097`.
- `OPENCODE_INTERNAL_PORT` — container-only `opencode serve` port; default `4096`.
- `OPENCODE_RUNNER_WORKSPACE_ROOT` — workspace volume root; default `/workspaces`.
- `OPENCODE_RUNNER_REWRITE_LOCALHOST` — rewrites a browser-configured localhost Ollama host to `host.docker.internal`; default enabled.

Each workspace configures OpenCode's documented `ollama` provider with
`@ai-sdk/openai-compatible`, an Ollama `/v1` base URL, and the model selected in
CQL Studio. The provider package is intentional: it is the adapter prescribed
by OpenCode for Ollama's OpenAI-compatible endpoint.

### Session filesystem

Each browser session gets an unguessable directory under `/workspaces`:

```text
<session-id>/
├── AGENTS.md
├── opencode.json
├── libraries/<active-library>.cql       # writable draft snapshot
├── dependencies/<included-library>.cql # mode 0400, directory mode 0500
├── .opencode/commands/*.md              # read-only CQL workflow commands
└── .cql-studio/manifest.json            # IDs, hashes, draft flags, mappings
```

Only the active CQL file is created with filesystem write bits and participates in the review diff. Open dependencies, the manifest, OpenCode config, instructions, and command definitions are mode `0400`; OpenCode may maintain its own internal files under `.opencode`. Unsaved editor text is deliberately used for the active snapshot, and the browser's original content is retained as diff metadata. FHIR endpoint credentials, headers, VSAC credentials, and SearXNG configuration are kept only in the gateway's in-memory session record and are never written to this filesystem. The runner receives a random MCP capability with no user credentials embedded in it.

OpenCode 1.18.x has an upstream inconsistency between documented granular edit-rule ordering and its tool-schema/call-time permission behavior. The generated config therefore enables the native edit category, while Unix file modes and manifest/path checks enforce the actual boundary. MCP has no write tool, dependency directories are locked, and files outside the manifest cannot be attached, validated, diffed, applied, or saved.

Ending a session deletes its workspace. A runner restart ends all in-memory sessions; the workspace volume is intended for ephemeral session data, not authoritative CQL storage. Accepted changes return to the Angular editor, which translates and saves the Library through the existing FHIR workflow.

### OpenCode MCP tools

The local stdio MCP bridge exposes all 22 server tools as read-only operations:

- CQL and context: `cql_studio_context`, `cql_validate`, `cql_library_search`, `cql_library_read`
- FHIR and terminology: `fhir_read`, `fhir_search` (maximum 20 entries), `valueset_expand` (maximum 100 concepts), `vsac_search`, `validate_vsac`
- Web discovery: `searxng_search`, `searxng_search_formatted`, `searxng_search_then_fetch`, `searxng_search_then_fetch_formatted`
- Bounded web reads: `fetch_content`, `fetch_url`, `batch_fetch`, `fetch_metadata`, `fetch_feed`, `fetch_content_as_markdown`, `extract_links`, `fetch_sitemap`, `get_rate_limit_status`

The server injects trusted FHIR, VSAC, and SearXNG origins from the session; the model cannot select an arbitrary service origin. Fetched URLs are DNS/IP checked, redirects are rechecked, response sizes are bounded, and loopback/private/link-local/metadata destinations are rejected. Shell and OpenCode's direct web fetch are denied. Every proposed CQL edit requires explicit diff review in the UI; `Apply & save` performs fresh server-side CQL validation followed by the existing browser translation and FHIR save gates. Two automatic repair prompts are allowed per explicit user request.

### Gateway endpoints

- `GET /api/opencode/health`
- `POST /api/opencode/sessions`
- `GET /api/opencode/sessions`
- `GET /api/opencode/sessions/:id/state`
- `POST /api/opencode/sessions/:id/prompt`
- `GET /api/opencode/sessions/:id/commands`
- `POST /api/opencode/sessions/:id/commands/:command`
- `GET /api/opencode/sessions/:id/files`
- `GET /api/opencode/sessions/:id/events` (SSE)
- `GET /api/opencode/sessions/:id/messages`
- `GET /api/opencode/sessions/:id/diff`
- `POST /api/opencode/sessions/:id/validate`
- `POST /api/opencode/sessions/:id/abort`
- `POST /api/opencode/sessions/:id/permissions/:permissionId`
- `POST|DELETE /api/opencode/sessions/:id/questions/:requestId`
- `DELETE /api/opencode/sessions/:id`

When SSO is configured, normal session endpoints require the existing HttpOnly login cookie and enforce per-user ownership. Tool-bridge endpoints use only the per-session capability and are not browser APIs.

Session and production settings:

- `CQL_STUDIO_SERVER_OPENCODE_SESSION_IDLE_MS` / `OPENCODE_SESSION_IDLE_MS` — idle TTL on gateway and runner; default 60 minutes.
- `CQL_STUDIO_SERVER_OPENCODE_CLEANUP_INTERVAL_MS` / `OPENCODE_CLEANUP_INTERVAL_MS` — orphan cleanup interval; default 60 seconds.
- `CQL_STUDIO_SERVER_OPENCODE_MAX_SESSIONS_PER_USER` — optional owner cap; `0` means unlimited.
- `CQL_STUDIO_SERVER_OPENCODE_MAX_SESSIONS_GLOBAL` — optional process cap; `0` means unlimited.
- `OPENCODE_PROVIDER_STALL_MS` — provider stall timeout; default 5 minutes.
- `CQL_STUDIO_SERVER_CQL_ASSETS_DIRECTORY` or `CQL_STUDIO_SERVER_CQL_ASSETS_URL` — System/FHIR/FHIRHelpers/UCUM sources used by real compiler validation.

Both processes emit structured OpenCode lifecycle, request, tool, duration, status, and error logs with credentials and capability tokens redacted. Production startup rejects the development runner token and tokens shorter than 32 bytes. Keep runner port 4097 private; only CQL Studio Server should reach it.

### Tests

```bash
npm run build
npm test

# Opt-in live probes. VSAC is skipped unless its password is supplied.
OPENCODE_LIVE_OLLAMA_URL=http://theperfect.crabdance.com:11434 \
OPENCODE_LIVE_OLLAMA_MODEL=qwen3.8:27b-mlx \
OPENCODE_LIVE_FHIR_URL=http://localhost:8080/fhir \
npm run test:opencode:live
```

Set `OPENCODE_LIVE_VSAC_URL`, `OPENCODE_LIVE_VSAC_USERNAME`, and `OPENCODE_LIVE_VSAC_PASSWORD` to include the authenticated VSAC probe. The adjacent frontend repository has the mocked, deterministic browser workflow under `npm run test:e2e`.

## Configuration

Variables are read from the process environment. Defaults apply when unset.

Core:

```bash
export CQL_STUDIO_SERVER_PORT=3003
export CQL_STUDIO_SERVER_NODE_ENV=development
export CQL_STUDIO_SERVER_CORS_ORIGIN=http://localhost:4200
export CQL_STUDIO_SERVER_LOG_LEVEL=info
```

- `CQL_STUDIO_SERVER_CORS_ORIGIN` — Allowed credentialed CORS origin. It must match the Studio UI origin even when SSO is disabled because the OpenCode fetch and EventSource clients use the same credential-capable transport in both modes.

### SSO and Team / Workspace features (optional)

Setting `CQL_STUDIO_SERVER_SSO_ISSUER_URL` enables OIDC login (BFF) and Team/Workspace APIs together. There is no separate feature flag. Startup fails if SSO is configured without `CQL_STUDIO_SERVER_DATABASE_URL`.

Example matching the checked-in Authentik IdP in the **cql-studio** repo (`docker-compose.development.yml` + `docker/authentik/blueprints/cql-studio-oidc.yaml`). Start that stack first (Authentik may take a minute to become ready on first boot):

```bash
# From the cql-studio repository
docker compose -f docker-compose.development.yml up -d
```

Then export these before `npm run watch` or `npm start` (Studio UI on `:4200`, this server on `:3003`, Authentik on `:9000`):

```bash
export CQL_STUDIO_SERVER_SSO_ISSUER_URL=http://localhost:9000/application/o/cql-studio/
export CQL_STUDIO_SERVER_SSO_CLIENT_ID=cql-studio-development
export CQL_STUDIO_SERVER_SSO_CLIENT_SECRET=cql-studio-development-secret
export CQL_STUDIO_SERVER_SSO_REDIRECT_URL=http://localhost:3003/api/auth/callback
export CQL_STUDIO_SERVER_SSO_SCOPES="openid profile email"
export CQL_STUDIO_SERVER_UI_BASE_URL=http://localhost:4200
export CQL_STUDIO_SERVER_CORS_ORIGIN=http://localhost:4200
export CQL_STUDIO_SERVER_SESSION_SECRET=cql-studio-development-session-secret
export CQL_STUDIO_SERVER_DATABASE_URL=postgresql://cql_studio:password@localhost:5432/cql_studio_development
```

`CQL_STUDIO_SERVER_DATABASE_URL` matches the `cql-studio-server-postgresql` service in `docker-compose.development.yml` (`cql_studio` / `password`, database `cql_studio_development` on port `5432`). OIDC test users from the blueprint include `alice`, `bob`, `charlie`, `daniel`, and `developer` (password `password` for the first four; `developer` uses password `developer`).

#### Docker networking (Authentik in compose, server on host)

The documented workflow runs **cql-studio-server on the host** (`npm run watch`) while Authentik runs in Docker with port `9000` published. In that setup, `CQL_STUDIO_SERVER_SSO_ISSUER_URL=http://localhost:9000/application/o/cql-studio/` is correct.

`fetch failed` on `/api/auth/login` means the **server process** could not open a TCP connection to the issuer — not that your browser cannot open Authentik. Verify from the same runtime as the server:

```bash
curl -s http://localhost:9000/application/o/cql-studio/.well-known/openid-configuration | head
```

If **cql-studio-server runs inside Docker**, `localhost` is the server container, not your Mac. From inside any container, `curl http://localhost:9000` fails while `curl http://host.docker.internal:9000` (Docker Desktop) or `curl http://authentik-server:9000` on the compose network succeeds. Prefer running the server on the host for local SSO development; containerized server + local Authentik requires split browser vs backchannel URL configuration in Authentik.

Optional rotation windows:

```bash
export CQL_STUDIO_SERVER_SESSION_SECRET_PREVIOUS=old-secret-1,old-secret-2
export CQL_STUDIO_SERVER_SSO_CLIENT_SECRET_PREVIOUS=old-client-secret
```

Notes:

- `CQL_STUDIO_SERVER_UI_BASE_URL` — Public Studio UI base URL (no trailing slash). Required when SSO is on. Used for post-login redirects (typically the same origin as `CQL_STUDIO_SERVER_CORS_ORIGIN`).
- `CQL_STUDIO_SERVER_SSO_REDIRECT_URL` — OIDC callback on **this server** (must match the IdP client redirect URI).
- `CQL_STUDIO_SERVER_DATABASE_URL` — PostgreSQL only. Also required in the environment for `npm run prisma:deploy` / `prisma:migrate`.
- Schema migrations run automatically on startup when SSO is configured (`prisma migrate deploy`). Table PKs are UUIDv4 via `gen_random_uuid()`.

Apply migrations manually if needed:

```bash
npm run prisma:deploy
# or during development:
npm run prisma:migrate
```

Team-related HTTP surface (only mounted when SSO is configured):

- `GET /api/auth/session` — `{ enabled, user }` (also answers `{ enabled: false }` when SSO is off)
- `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`
- `/api/teams`, `/api/workspaces`, `/api/activity`

## Ollama Proxy

The server proxies a fixed set of [Ollama native API](https://docs.ollama.com/api) endpoints so browser clients can reach a user-configured Ollama instance without CORS issues. The upstream base URL is supplied per request — no server-side Ollama configuration is required.

**Base URL:** `X-Ollama-Base-URL` header or `?ollamaBaseUrl=` query parameter (must be `http://` or `https://`).

| Method | Path | Upstream |
|--------|------|----------|
| GET | `/api/ollama/tags` | `/api/tags` |
| GET | `/api/ollama/version` | `/api/version` |
| GET | `/api/ollama/ps` | `/api/ps` |
| POST | `/api/ollama/show` | `/api/show` |
| POST | `/api/ollama/chat` | `/api/chat` |
| POST | `/api/ollama/generate` | `/api/generate` |
| POST | `/api/ollama/embed` | `/api/embed` |
| POST | `/api/ollama/embeddings` | `/api/embeddings` (legacy) |

Request bodies are forwarded unchanged. Streaming responses (`stream: true`) are piped through for chat and generate. Unknown endpoints return 404.

Example:

```bash
curl "http://localhost:3003/api/ollama/version?ollamaBaseUrl=http://localhost:11434"
```

## MCP Endpoints

### GET /tools
List all available MCP tools.

Response:
```json
[
  {
    "name": "searxng_search_formatted",
    "description": "...",
    "parameters": { ... }
  }
]
```

### POST /execute
Execute an MCP tool.

Request:
```json
{
  "method": "searxng_search_formatted",
  "params": {
    "query": "CQL programming",
    "searxng_base_url": "https://search.example.org"
  }
}
```

Response:
```json
{
  "result": "[1] Title\nURL: ...\nDescription: ...\n\n..."
}
```

## Available Tools

### fetch_content
Fetches and parses content from a webpage. Returns cleaned, formatted text for LLM consumption.

Parameters:
- `url` (required): The webpage URL to fetch

### fetch_url
Download and parse web content from a URL. Returns structured result (url, title, textContent, etc.).

Parameters:
- `url` (required): URL to fetch

### searxng_search
Perform an anonymous web search via a SearXNG instance (no API key). Returns structured results.

Parameters:
- `query` (required): Search query string
- `searxng_base_url` (required): SearXNG instance base URL (e.g. https://search.example.org).
- `max_results` (optional): Max results (default: 10, max: 50)
- Optional: `categories`, `language`, `pageno`, `time_range`, `safesearch`

### searxng_search_formatted
Same as `searxng_search` but returns a single formatted string for LLM consumption.

### searxng_search_then_fetch
Run a SearXNG search and fetch full page content for the top results in one call. Returns an array of `{ url, title, snippet, content }`. Parameters: `searxng_base_url`, `query`, optional `max_results_to_fetch` (default 3, max 5), plus optional SearXNG params.

### searxng_search_then_fetch_formatted
Same as above but returns a single formatted string for LLM context (all results concatenated).

### batch_fetch
Fetch multiple URLs in one call. Parameters: `urls` (array of URL strings, max 10). Returns an array of `{ url, title, contentLength, textContent, hasMoreContent }` per URL (or `{ url, error }` on failure).

### fetch_metadata
Lightweight fetch: final URL (after redirects), status code, content-type, and optional title/description/image from HTML meta tags (Open Graph, Twitter Card). Parameters: `url`.

### fetch_feed
Fetch and parse an RSS or Atom feed. Returns feed title, link, description, and list of entries (title, link, summary, date). Parameters: `url`.

### fetch_content_as_markdown
Fetch a webpage and return its main content as Markdown (headings, lists, links preserved). Parameters: `url`.

### extract_links
Fetch a page and return all outbound links. Returns array of `{ href, text }`. Parameters: `url`, optional `same_domain_only` (boolean, default false).

### fetch_sitemap
Fetch and parse a sitemap.xml (or sitemap index). Returns either `urlset` (list of page URLs with optional lastmod, changefreq, priority) or `sitemapindex` (list of child sitemap URLs). Parameters: `url`, optional `expand_index` (boolean; if true, follow index and aggregate URLs from up to 10 child sitemaps).

### get_rate_limit_status
Return remaining rate limit tokens for fetch and search. No parameters; does not consume tokens. Returns `{ fetch_remaining, searxng_remaining }`.

## Rate limits

- **Fetch** (fetch_content, fetch_url, fetch_metadata, fetch_feed, fetch_content_as_markdown, extract_links, fetch_sitemap, and each URL in batch_fetch): 20 requests per minute.
- **SearXNG** (search and search_then_fetch): 30 requests per minute.

## Further tool ideas

Possible additions for future versions:

- **DuckDuckGo (or other) search** – A second search backend so clients can search when no SearXNG instance is configured.
- **Resolve URL** – Given a URL, follow redirects and return only the final URL and status (no body).
- **Extract JSON-LD** – Fetch page and return structured data from JSON-LD blocks (Schema.org, etc.).

## Docker

Build and run with Docker:

```bash
# Build the image
docker build -t cql-studio-server .
# Alternatively, build images for multiple architectures if supported by your build environment
docker buildx build --platform linux/arm64/v8,linux/amd64 -t p3000/cql-studio-server:latest .

# Run the container
docker run -d \
  --name cql-studio-server \
  -p 3003:3003 \
  -e CQL_STUDIO_SERVER_NODE_ENV=production \
  -e CQL_STUDIO_SERVER_CORS_ORIGIN=http://localhost:4200 \
  cql-studio-server
```

Or use docker-compose:

```yaml
version: '3.8'
services:
  cql-studio-server:
    build: .
    ports:
      - "3003:3003"
    environment:
      - CQL_STUDIO_SERVER_NODE_ENV=production
      - CQL_STUDIO_SERVER_CORS_ORIGIN=http://localhost:4200
```

## Attribution

Copyright © 2025+ Preston Lee. All rights reserved.

## License

Released under the Apache 2.0 license.
