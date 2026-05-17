import { afterEach, describe, it, expect } from '@jest/globals';
import { SearXNGCrawl4AIMCPServer } from '../src/index';

describe('SearXNG + Crawl4AI MCP Server', () => {
  const originalEnabledTools = process.env.ENABLED_TOOLS;

  afterEach(async () => {
    if (originalEnabledTools === undefined) {
      delete process.env.ENABLED_TOOLS;
    } else {
      process.env.ENABLED_TOOLS = originalEnabledTools;
    }
  });

  describe('Crawl4AI endpoint contract', () => {
    const defaultTools = [
      'search_web',
      'search_and_crawl',
      'crawl4ai_crawl',
      'crawl4ai_crawl_stream',
      'crawl4ai_markdown',
    ];

    const optionalTools = [
      'crawl4ai_html',
      'crawl4ai_screenshot',
      'crawl4ai_pdf',
      'crawl4ai_execute_js',
      'crawl4ai_ask',
      'crawl4ai_enqueue_crawl_job',
      'crawl4ai_get_crawl_job',
      'crawl4ai_enqueue_llm_job',
      'crawl4ai_get_llm_job',
      'crawl4ai_schema',
      'crawl4ai_health',
    ];

    it('documents the conservative default tool surface', () => {
      expect(defaultTools).toEqual([
        'search_web',
        'search_and_crawl',
        'crawl4ai_crawl',
        'crawl4ai_crawl_stream',
        'crawl4ai_markdown',
      ]);
      expect(defaultTools).not.toContain('crawl4ai_screenshot');
      expect(defaultTools).not.toContain('crawl4ai_execute_js');
    });

    it('documents optional tools that require ENABLED_TOOLS opt-in', () => {
      expect(optionalTools).toContain('crawl4ai_pdf');
      expect(optionalTools).toContain('crawl4ai_health');
      expect(optionalTools).not.toContain('scrape_url');
      expect(optionalTools).not.toContain('crawl4ai_scrape');
    });

    it('uses Crawl4AI official Docker API defaults', () => {
      const crawl4aiUrl = process.env.CRAWL4AI_URL || 'http://localhost:11235';
      expect(crawl4aiUrl).toBe('http://localhost:11235');
    });

    it('filters actual MCP tools to the default allowlist', () => {
      delete process.env.ENABLED_TOOLS;
      const server = new SearXNGCrawl4AIMCPServer();
      const names = server.listTools().map(tool => tool.name);

      expect(names).toEqual(defaultTools);
      expect(names).not.toContain('crawl4ai_health');
    });

    it('rejects disabled tools even when called directly', async () => {
      delete process.env.ENABLED_TOOLS;
      const server = new SearXNGCrawl4AIMCPServer();

      await expect(server.callTool('crawl4ai_health')).rejects.toThrow('Tool is disabled: crawl4ai_health');
    });

    it('can expose all implemented tools by configuration', () => {
      process.env.ENABLED_TOOLS = 'all';
      const server = new SearXNGCrawl4AIMCPServer();
      const names = server.listTools().map(tool => tool.name);

      expect(names).toHaveLength(16);
      expect(names).toContain('crawl4ai_health');
    });
  });

  describe('MCP transport configuration', () => {
    it('defaults to stdio and supports Streamable HTTP', () => {
      const defaultTransport = process.env.MCP_TRANSPORT || 'stdio';
      const supported = ['stdio', 'streamable-http', 'http'];

      expect(defaultTransport).toBe('stdio');
      expect(supported).toContain('streamable-http');
    });

    it('documents the OpenAPI defaults for Open WebUI fallback mode', () => {
      const openApiBasePath = process.env.OPENAPI_BASE_PATH || '/api';
      expect(openApiBasePath).toBe('/api');
    });
  });
});
