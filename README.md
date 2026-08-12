# CQL Studio Server

Express ESM server for CQL Studio backend services and MCP (Model Context Protocol) tool orchestration.

## Features

- MCP protocol implementation for tool execution
- Ollama API proxy for browser CORS bypass (client-supplied base URL)
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

## Configuration

Variables are read from the process environment. Defaults apply when unset.

Core:

```bash
export CQL_STUDIO_SERVER_PORT=3003
export CQL_STUDIO_SERVER_NODE_ENV=development
export CQL_STUDIO_SERVER_CORS_ORIGIN=http://localhost:4200
export CQL_STUDIO_SERVER_LOG_LEVEL=info
```

- `CQL_STUDIO_SERVER_CORS_ORIGIN` — Allowed CORS origin. When SSO is enabled, used with credentials so the Studio UI (via `CQL_STUDIO_SERVER_BASE_URL` on the client) can send the HttpOnly session cookie.

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

