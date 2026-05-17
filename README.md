# SearXNG + Crawl4AI MCP Server

Self-hosted MCP server that combines SearXNG search with Crawl4AI's current Docker API.

This project now calls Crawl4AI directly. It does not use Firecrawl and does not require the old compatibility FastAPI wrapper.

## Architecture

- `src/index.ts` exposes MCP tools over stdio, Streamable HTTP, and an OpenAPI-compatible REST facade.
- `src/crawl4ai-client.ts` calls the official Crawl4AI Docker API on port `11235`.
- `src/searxng-client.ts` calls SearXNG for metasearch.
- `docker-compose.yml` can run:
  - SearXNG on `http://localhost:8081`
  - Crawl4AI official image on `http://localhost:11235`
  - this MCP server on Streamable HTTP at `http://localhost:3003/mcp`

## Quick Start

```bash
npm install
npm run build
docker compose up -d
```

That starts only the MCP server by default. If you want Compose to manage more of the stack, use profiles:

```bash
# MCP only, connect to existing SearXNG and Crawl4AI
docker compose up -d

# MCP + Crawl4AI + Redis, connect to existing SearXNG
docker compose --profile crawl4ai up -d

# MCP + SearXNG only, connect to existing Crawl4AI
docker compose --profile searxng up -d

# MCP + SearXNG + Crawl4AI + Redis
docker compose --profile full up -d
```

If you already run SearXNG and Crawl4AI elsewhere, point the MCP container at them:

```bash
SEARXNG_URL=http://host.docker.internal:8081 \
CRAWL4AI_URL=http://host.docker.internal:11235 \
docker compose up -d mcp-server
```

Use normal routable URLs when those services live on another host or Docker network.

Host ports are configurable:

```bash
MCP_HTTP_PORT=3303 \
SEARXNG_PORT=18081 \
CRAWL4AI_PORT=11236 \
REDIS_PORT=16380 \
docker compose --profile full up -d
```

Health checks:

```bash
curl "http://localhost:8081/search?q=test&format=json"
curl "http://localhost:11235/health"
curl "http://localhost:3003/health"
```

## MCP Transports

Stdio is the default:

```json
{
  "mcpServers": {
    "searxng-crawl4ai": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/searxng-crawl4ai-mcp",
      "env": {
        "MCP_TRANSPORT": "stdio",
        "SEARXNG_URL": "http://localhost:8081",
        "CRAWL4AI_URL": "http://localhost:11235"
      }
    }
  }
}
```

Streamable HTTP:

```bash
MCP_TRANSPORT=streamable-http MCP_HTTP_PORT=3003 npm start
```

The endpoint is `http://localhost:3003/mcp` by default. In Open WebUI, add it as Type `MCP (Streamable HTTP)`, not OpenAPI.

## OpenAPI

The same process also exposes an OpenAPI facade for clients that prefer ordinary HTTP tools:

- Spec: `http://localhost:3003/openapi.json`
- Plugin discovery: `http://localhost:3003/.well-known/ai-plugin.json`
- Tool endpoints: `POST http://localhost:3003/api/<tool_name>`

For Open WebUI, native Streamable HTTP MCP is the preferred path. Use the OpenAPI URL only if you deliberately want OpenAPI-style tool registration.

## Tools

By default, the server exposes only the conservative core tools:

- `search_web`: search via SearXNG.
- `search_and_crawl`: search via SearXNG, then crawl top results through Crawl4AI `/crawl`.
- `crawl4ai_crawl`: direct Crawl4AI `/crawl`.
- `crawl4ai_crawl_stream`: direct Crawl4AI `/crawl/stream`, collected into JSON.
- `crawl4ai_markdown`: direct Crawl4AI `/md`.

Additional tools exist but are disabled unless you opt in:

- `crawl4ai_html`: direct Crawl4AI `/html`.
- `crawl4ai_screenshot`: direct Crawl4AI `/screenshot`.
- `crawl4ai_pdf`: direct Crawl4AI `/pdf`.
- `crawl4ai_execute_js`: direct Crawl4AI `/execute_js`.
- `crawl4ai_ask`: direct Crawl4AI `/llm/{url}` Q&A.
- `crawl4ai_enqueue_crawl_job` / `crawl4ai_get_crawl_job`: background crawl jobs.
- `crawl4ai_enqueue_llm_job` / `crawl4ai_get_llm_job`: background LLM extraction jobs.
- `crawl4ai_schema`: current Crawl4AI BrowserConfig and CrawlerRunConfig schema defaults.
- `crawl4ai_health`: Crawl4AI health check.

Control the exposed surface with `ENABLED_TOOLS`:

```bash
# Default explicit set
ENABLED_TOOLS=search_web,search_and_crawl,crawl4ai_crawl,crawl4ai_crawl_stream,crawl4ai_markdown

# Add selected extra tools
ENABLED_TOOLS=search_web,search_and_crawl,crawl4ai_crawl,crawl4ai_markdown,crawl4ai_pdf,crawl4ai_health

# Expose every implemented tool
ENABLED_TOOLS=all
```

Disabled tools are hidden from MCP `tools/list`, `/tools`, and `/openapi.json`, and direct calls to them are rejected.

Most Crawl4AI tools accept native `browser_config` and `crawler_config` objects, so new Crawl4AI options can be passed through without another wrapper release.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | Use `stdio`, `streamable-http`, or `http`. |
| `MCP_HTTP_HOST` | `0.0.0.0` | Streamable HTTP host. |
| `MCP_HTTP_PORT` | `3003` | Streamable HTTP port. |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP endpoint. |
| `OPENAPI_BASE_PATH` | `/api` | Base path for OpenAPI REST tool endpoints. |
| `ENABLED_TOOLS` | core 5 tools | Comma-separated tool names, or `all`. |
| `SEARXNG_URL` | `http://localhost:8081` | SearXNG base URL. |
| `CRAWL4AI_URL` | `http://localhost:11235` | Crawl4AI Docker API base URL. |
| `CRAWL4AI_BEARER_TOKEN` | unset | Optional bearer token if Crawl4AI security is enabled. |
| `CRAWL4AI_TIMEOUT_MS` | `120000` | HTTP timeout for Crawl4AI calls. |
| `SEARXNG_PORT` | `8081` | Compose host port for bundled SearXNG. |
| `CRAWL4AI_PORT` | `11235` | Compose host port for bundled Crawl4AI. |
| `REDIS_PORT` | `6380` | Compose host port for bundled Redis. |

## Crawl4AI Version Notes

As of May 17, 2026, Crawl4AI `v0.8.x` ships an official Docker API with `/crawl`, `/crawl/stream`, `/md`, `/html`, `/screenshot`, `/pdf`, `/execute_js`, `/llm`, `/schema`, `/health`, and job endpoints. This MCP server targets those endpoints directly.
