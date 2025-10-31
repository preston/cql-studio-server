# CQL Studio Server

Express ESM server for CQL Studio backend services and MCP (Model Context Protocol) tool orchestration.

## Features

- MCP protocol implementation for tool execution
- Web search via Brave Search API (requires API key)
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

**Note:** API keys (like `brave_api_key` for web search) are provided dynamically by the MCP client on each tool call, not through environment variables.

## MCP Endpoints

### GET /tools
List all available MCP tools.

Response:
```json
[
  {
    "name": "web_search",
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
  "method": "web_search",
  "params": {
    "query": "CQL programming",
    "brave_api_key": "your_brave_api_key_here",
    "maxResults": 10
  }
}
```

Response:
```json
{
  "result": {
    "query": "CQL programming",
    "resultsCount": 10,
    "results": [...]
  }
}
```

## Available Tools

### web_search
Perform web searches using Brave Search API. Requires `brave_api_key` parameter to be provided by the MCP client.

Parameters:
- `query` (required): Search query string
- `brave_api_key` (required): Brave Search API key (get your free API key at: https://brave.com/search/api)
- `maxResults` (optional): Maximum results (default: 10, max: 20)

### fetch_url
Download and parse web content from a URL.

Parameters:
- `url` (required): URL to fetch

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

