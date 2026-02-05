# CQL Studio Server

Express ESM server for CQL Studio backend services and MCP (Model Context Protocol) tool orchestration.

## Features

- MCP protocol implementation for tool execution
- Web search via SearXNG (no API key; proxy to your own or public instance)
- Web content fetching and parsing
- CORS-enabled for webapp communication
- TypeScript with ES modules

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

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
npm run dev
```

## Configuration

Environment variables (in `.env`):

- `CQL_STUDIO_SERVER_PORT` - Server port (default: 3003)
- `CQL_STUDIO_SERVER_NODE_ENV` - Environment mode (development/production)
- `CQL_STUDIO_SERVER_CORS_ORIGIN` - Allowed CORS origin (default: http://localhost:4200)
- `CQL_STUDIO_SERVER_LOG_LEVEL` - Logging level (default: info)

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

## License

Apache-2.0

