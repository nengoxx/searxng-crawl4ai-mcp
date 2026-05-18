import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { logger } from './logger.js';
import { SearXNGClient } from './searxng-client.js';
import { Crawl4AIClient } from './crawl4ai-client.js';

config();

type JsonRecord = Record<string, unknown>;

const DEFAULT_ENABLED_TOOLS = [
  'search_web',
  'search_and_crawl',
  'crawl4ai_crawl',
  'crawl4ai_crawl_stream',
  'crawl4ai_markdown',
];

export const textResult = (value: unknown) => ({
  content: [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2),
    },
  ],
});

export const parseMcpText = (value: unknown): unknown => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray((value as { content?: unknown }).content)
  ) {
    const first = (value as { content: Array<{ text?: unknown }> }).content[0];
    if (typeof first?.text === 'string') {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return value;
};

const asStringArray = (value: unknown, field: string): string[] => {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value;
  }
  throw new Error(`${field} must be an array of strings`);
};

const singleUrlList = (args: JsonRecord): string[] => {
  if (typeof args.url !== 'string') {
    throw new Error('url is required');
  }
  return [args.url];
};

export class SearXNGCrawl4AIMCPServer {
  private readonly server: Server;
  private readonly searxng: SearXNGClient;
  private readonly crawl4ai: Crawl4AIClient;
  private readonly enabledTools: Set<string> | 'all';
  private isClosing = false;

  constructor(dependencies: { searxng?: SearXNGClient; crawl4ai?: Crawl4AIClient } = {}) {
    this.server = new Server(
      {
        name: 'searxng-crawl4ai-mcp',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.searxng = dependencies.searxng || new SearXNGClient(process.env.SEARXNG_URL || 'http://localhost:8081');
    this.crawl4ai = dependencies.crawl4ai || new Crawl4AIClient(
      process.env.CRAWL4AI_URL || 'http://localhost:11235',
      process.env.CRAWL4AI_BEARER_TOKEN
    );
    this.enabledTools = this.parseEnabledTools();

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return textResult(await this.callTool(request.params.name, (request.params.arguments || {}) as JsonRecord));
      } catch (error) {
        logger.error(`Error executing tool ${request.params.name}:`, {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    });
  }

  async callTool(name: string, input: JsonRecord = {}): Promise<unknown> {
    if (!this.isToolEnabled(name)) {
      throw new Error(`Tool is disabled: ${name}`);
    }

    switch (name) {
      case 'search_web':
        return await this.handleSearchWeb(input);
      case 'search_and_crawl':
        return await this.handleSearchAndCrawl(input);
      case 'crawl4ai_crawl':
        return await this.crawl4ai.crawl(
          input.urls ? asStringArray(input.urls, 'urls') : singleUrlList(input),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_crawl_stream':
        return await this.crawl4ai.crawlStream(
          input.urls ? asStringArray(input.urls, 'urls') : singleUrlList(input),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_markdown':
        return await this.crawl4ai.markdown(
          this.requiredString(input, 'url'),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_html':
        return await this.crawl4ai.html(this.requiredString(input, 'url'));
      case 'crawl4ai_screenshot':
        return await this.crawl4ai.screenshot(
          this.requiredString(input, 'url'),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_pdf':
        return await this.crawl4ai.pdf(
          this.requiredString(input, 'url'),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_execute_js':
        return await this.crawl4ai.executeJs(
          this.requiredString(input, 'url'),
          asStringArray(input.scripts, 'scripts')
        );
      case 'crawl4ai_ask':
        return await this.crawl4ai.ask(
          this.requiredString(input, 'url'),
          this.requiredString(input, 'question'),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_enqueue_crawl_job':
        return await this.crawl4ai.enqueueCrawlJob(
          input.urls ? asStringArray(input.urls, 'urls') : singleUrlList(input),
          input.options as JsonRecord | undefined
        );
      case 'crawl4ai_get_crawl_job':
        return await this.crawl4ai.getCrawlJob(this.requiredString(input, 'task_id'));
      case 'crawl4ai_enqueue_llm_job':
        return await this.crawl4ai.enqueueLlmJob({
          url: this.requiredString(input, 'url'),
          q: this.requiredString(input, 'question'),
          ...(input.schema ? { schema: JSON.stringify(input.schema) } : {}),
          ...(input.options as JsonRecord | undefined),
        } as any);
      case 'crawl4ai_get_llm_job':
        return await this.crawl4ai.getLlmJob(this.requiredString(input, 'task_id'));
      case 'crawl4ai_schema':
        return await this.crawl4ai.getSchema();
      case 'crawl4ai_health':
        return { healthy: await this.crawl4ai.healthCheck() };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private parseEnabledTools(): Set<string> | 'all' {
    const configured = process.env.ENABLED_TOOLS || process.env.MCP_ENABLED_TOOLS;
    if (!configured || configured.trim().length === 0) {
      return new Set(DEFAULT_ENABLED_TOOLS);
    }

    const tokens = configured
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    if (tokens.includes('*') || tokens.includes('all')) {
      return 'all';
    }

    const knownTools = new Set(this.allTools().map(tool => tool.name));
    const enabled = tokens.filter(token => knownTools.has(token));
    const unknown = tokens.filter(token => !knownTools.has(token));
    if (unknown.length > 0) {
      logger.warn(`Ignoring unknown ENABLED_TOOLS entries: ${unknown.join(', ')}`);
    }

    return new Set(enabled);
  }

  private isToolEnabled(name: string): boolean {
    return this.enabledTools === 'all' || this.enabledTools.has(name);
  }

  private requiredString(input: JsonRecord, field: string): string {
    const value = input[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${field} is required`);
    }
    return value;
  }

  private async handleSearchWeb(args: JsonRecord) {
    const query = this.requiredString(args, 'query');
    const options = (args.options || {}) as JsonRecord;

    const result = await this.searxng.search(query, {
      engines: options.engines as string | undefined,
      categories: options.categories as string | undefined,
      language: (options.language as string | undefined) || 'en',
      pageno: (options.pageno || options.page) as number | undefined,
      time_range: options.time_range as string | undefined,
      safesearch: options.safesearch as 0 | 1 | 2 | undefined,
      format: 'json',
    });

    const limit = Number(options.limit || 10);
    return {
      query: result.query,
      total_results: result.number_of_results,
      results: result.results.slice(0, limit).map(item => ({
        title: item.title,
        url: item.url,
        content: item.content,
        publishedDate: item.publishedDate,
        score: item.score,
      })),
      suggestions: result.suggestions,
      unresponsive_engines: result.unresponsive_engines,
    };
  }

  private async handleSearchAndCrawl(args: JsonRecord) {
    const query = this.requiredString(args, 'query');
    const options = (args.options || {}) as JsonRecord;
    const maxResults = Math.min(Number(options.max_results || 3), 10);

    const searchResults = await this.searxng.search(query, {
      engines: options.engines as string | undefined,
      categories: options.categories as string | undefined,
      language: (options.language as string | undefined) || 'en',
      format: 'json',
    });

    const selected = searchResults.results.slice(0, maxResults);
    if (selected.length === 0) {
      return { query, search_results: 0, crawled_results: [] };
    }

    const crawlResult = await this.crawl4ai.crawl(
      selected.map(result => result.url),
      {
        browser_config: (options.browser_config || {}) as JsonRecord,
        crawler_config: {
          ...(options.crawler_config as JsonRecord | undefined),
          ...(options.cache_mode ? { cache_mode: options.cache_mode } : {}),
        },
      }
    );

    return {
      query,
      search_results: searchResults.number_of_results,
      selected_results: selected.map(result => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
      })),
      crawl: crawlResult,
    };
  }

  listTools(): Tool[] {
    return this.allTools().filter(tool => this.isToolEnabled(tool.name));
  }

  private allTools(): Tool[] {
    return [
      {
        name: 'search_web',
        description: 'Search the web using SearXNG and return structured results.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            options: {
              type: 'object',
              properties: {
                engines: { type: 'string' },
                categories: { type: 'string' },
                language: { type: 'string', default: 'en' },
                limit: { type: 'number', default: 10 },
                page: { type: 'number', default: 1 },
                time_range: { type: 'string' },
                safesearch: { type: 'number', enum: [0, 1, 2] },
              },
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_and_crawl',
        description: 'Search with SearXNG, then crawl the top results through Crawl4AI /crawl.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            options: {
              type: 'object',
              properties: {
                max_results: { type: 'number', default: 3 },
                engines: { type: 'string' },
                categories: { type: 'string' },
                language: { type: 'string', default: 'en' },
                browser_config: { type: 'object' },
                crawler_config: { type: 'object' },
              },
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'crawl4ai_crawl',
        description: 'Call Crawl4AI /crawl directly for one or more URLs. Pass native browser_config and crawler_config objects.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            urls: { type: 'array', items: { type: 'string' } },
            options: {
              type: 'object',
              properties: {
                browser_config: { type: 'object' },
                crawler_config: { type: 'object' },
                hooks: { type: 'object' },
              },
            },
          },
        },
      },
      {
        name: 'crawl4ai_crawl_stream',
        description: 'Call Crawl4AI /crawl/stream directly and collect the NDJSON stream into a JSON array.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            urls: { type: 'array', items: { type: 'string' } },
            options: {
              type: 'object',
              properties: {
                browser_config: { type: 'object' },
                crawler_config: { type: 'object' },
                hooks: { type: 'object' },
              },
            },
          },
        },
      },
      {
        name: 'crawl4ai_markdown',
        description: 'Call Crawl4AI /md for clean markdown. Filters: fit, raw, bm25, llm.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            options: {
              type: 'object',
              properties: {
                f: { type: 'string', enum: ['fit', 'raw', 'bm25', 'llm'], default: 'fit' },
                q: { type: 'string' },
                c: { type: 'string', default: '0' },
                provider: { type: 'string' },
                temperature: { type: 'number' },
                base_url: { type: 'string' },
              },
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'crawl4ai_html',
        description: 'Call Crawl4AI /html for preprocessed HTML suitable for schema building.',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      {
        name: 'crawl4ai_screenshot',
        description: 'Call Crawl4AI /screenshot for a full-page PNG screenshot as base64 or saved server-side path.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            options: {
              type: 'object',
              properties: {
                screenshot_wait_for: { type: 'number', default: 2 },
                wait_for_images: { type: 'boolean', default: false },
                output_path: { type: 'string' },
              },
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'crawl4ai_pdf',
        description: 'Call Crawl4AI /pdf for a page PDF as base64 or saved server-side path.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            options: { type: 'object', properties: { output_path: { type: 'string' } } },
          },
          required: ['url'],
        },
      },
      {
        name: 'crawl4ai_execute_js',
        description: 'Call Crawl4AI /execute_js with ordered JavaScript snippets and return the CrawlResult JSON.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            scripts: { type: 'array', items: { type: 'string' } },
          },
          required: ['url', 'scripts'],
        },
      },
      {
        name: 'crawl4ai_ask',
        description: 'Call Crawl4AI /llm/{url}?q=... for LLM Q&A over crawled page content.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            question: { type: 'string' },
            options: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                temperature: { type: 'number' },
                base_url: { type: 'string' },
              },
            },
          },
          required: ['url', 'question'],
        },
      },
      {
        name: 'crawl4ai_enqueue_crawl_job',
        description: 'Enqueue a Crawl4AI /crawl/job background crawl for long-running jobs.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            urls: { type: 'array', items: { type: 'string' } },
            options: {
              type: 'object',
              properties: {
                browser_config: { type: 'object' },
                crawler_config: { type: 'object' },
                webhook_config: { type: 'object' },
              },
            },
          },
        },
      },
      {
        name: 'crawl4ai_get_crawl_job',
        description: 'Poll Crawl4AI /crawl/job/{task_id}.',
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
      {
        name: 'crawl4ai_enqueue_llm_job',
        description: 'Enqueue a Crawl4AI /llm/job extraction job.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            question: { type: 'string' },
            schema: { type: 'object' },
            options: { type: 'object' },
          },
          required: ['url', 'question'],
        },
      },
      {
        name: 'crawl4ai_get_llm_job',
        description: 'Poll Crawl4AI /llm/job/{task_id}.',
        inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
      {
        name: 'crawl4ai_schema',
        description: 'Fetch Crawl4AI /schema with current BrowserConfig and CrawlerRunConfig defaults.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'crawl4ai_health',
        description: 'Check Crawl4AI /health.',
        inputSchema: { type: 'object', properties: {} },
      },
    ] as Tool[];
  }

  async connect(transport: StdioServerTransport | StreamableHTTPServerTransport) {
    await this.server.connect(transport);
  }

  async close() {
    if (this.isClosing) {
      return;
    }
    this.isClosing = true;
    await this.server.close();
  }
}

type McpRequestHandler = (req: express.Request, res: express.Response) => Promise<void>;

async function runStdio() {
  process.env.MCP_MODE = 'true';
  const server = new SearXNGCrawl4AIMCPServer();
  await server.connect(new StdioServerTransport());
  logger.info('SearXNG + Crawl4AI MCP server started on stdio');
}

async function runStreamableHttp() {
  const app = express();
  app.use(express.json({ limit: process.env.MCP_HTTP_BODY_LIMIT || '10mb' }));

  const endpoint = process.env.MCP_HTTP_PATH || '/mcp';
  const openApiBasePath = process.env.OPENAPI_BASE_PATH || '/api';
  const port = Number(process.env.PORT || process.env.MCP_HTTP_PORT || 3003);
  const host = process.env.HOST || process.env.MCP_HTTP_HOST || '0.0.0.0';
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; server: SearXNGCrawl4AIMCPServer }>();
  const httpToolServer = new SearXNGCrawl4AIMCPServer();

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, mcp-session-id');
    next();
  });

  app.options('*path', (_req, res) => {
    res.status(204).end();
  });

  app.post(endpoint, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let entry = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (!entry) {
      const server = new SearXNGCrawl4AIMCPServer();
      const sessionEntry: { transport?: StreamableHTTPServerTransport; server: SearXNGCrawl4AIMCPServer } = { server };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string): void => {
          transports.set(id, { transport: sessionEntry.transport!, server });
        },
      });
      sessionEntry.transport = transport;
      entry = { transport, server };
      transport.onclose = async () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
    }

    await handleMcpHttpRequest(req, res, async () => {
      await entry.transport.handleRequest(req, res, req.body);
    });
  });

  app.get(endpoint, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing or invalid session id' }, id: null });
      return;
    }
    await handleMcpHttpRequest(req, res, async () => {
      await entry.transport.handleRequest(req, res);
    });
  });

  app.delete(endpoint, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing or invalid session id' }, id: null });
      return;
    }
    await handleMcpHttpRequest(req, res, async () => {
      await entry.transport.handleRequest(req, res);
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      endpoint,
      openapi: '/openapi.json',
      services: {
        searxng_url: process.env.SEARXNG_URL || 'http://localhost:8081',
        crawl4ai_url: process.env.CRAWL4AI_URL || 'http://localhost:11235',
      },
    });
  });

  app.get('/openapi.json', (req, res) => {
    res.json(buildOpenApiDocument(httpToolServer.listTools(), `${req.protocol}://${req.get('host')}`));
  });

  app.get('/.well-known/ai-plugin.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      schema_version: 'v1',
      name_for_human: 'SearXNG Crawl4AI',
      name_for_model: 'searxng_crawl4ai',
      description_for_human: 'Search with SearXNG and crawl pages with Crawl4AI.',
      description_for_model: 'Use these tools to search the web and extract markdown, HTML, screenshots, PDFs, or Crawl4AI crawl results.',
      auth: { type: 'none' },
      api: { type: 'openapi', url: `${baseUrl}/openapi.json` },
    });
  });

  app.get('/tools', (_req, res) => {
    res.json({ tools: httpToolServer.listTools() });
  });

  for (const tool of httpToolServer.listTools()) {
    app.post(`${openApiBasePath}/${tool.name}`, async (req, res) => {
      try {
        res.json(parseMcpText(await httpToolServer.callTool(tool.name, req.body || {})));
      } catch (error) {
        logger.error(`OpenAPI tool ${tool.name} failed:`, {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  app.listen(port, host, () => {
    logger.info(`SearXNG + Crawl4AI MCP Streamable HTTP server listening on http://${host}:${port}${endpoint}`);
  });
}

async function handleMcpHttpRequest(req: express.Request, res: express.Response, handler: McpRequestHandler) {
  try {
    await handler(req, res);
  } catch (error) {
    logger.error('MCP Streamable HTTP request failed:', {
      method: req.method,
      path: req.path,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
}

function buildOpenApiDocument(tools: Tool[], baseUrl: string) {
  const openApiBasePath = process.env.OPENAPI_BASE_PATH || '/api';
  const paths = Object.fromEntries(tools.map(tool => [
    `${openApiBasePath}/${tool.name}`,
    {
      post: {
        summary: tool.name,
        description: tool.description,
        operationId: `tool_${tool.name}_post`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: tool.inputSchema,
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
          '500': {
            description: 'Tool execution error',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  ]));

  return {
    openapi: '3.1.0',
    info: {
      title: 'SearXNG Crawl4AI MCP Tools',
      version: '2.0.0',
      description: 'OpenAPI facade over the same tools exposed by the Streamable HTTP MCP server.',
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}

export async function run() {
  const transport = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

  if (transport === 'http' || transport === 'streamable-http') {
    await runStreamableHttp();
  } else {
    await runStdio();
  }
}

if (!process.env.JEST_WORKER_ID && process.argv[1] && /(?:src|dist)[\\/]+index\.(?:ts|js)$/.test(process.argv[1])) {
  run().catch(error => {
    logger.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
