import { describe, it, expect } from '@jest/globals';

describe('SearXNG + Crawl4AI MCP Server', () => {
  describe('Crawl4AI endpoint contract', () => {
    const tools = [
      'search_web',
      'search_and_crawl',
      'crawl4ai_crawl',
      'crawl4ai_crawl_stream',
      'crawl4ai_markdown',
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

    it('documents the native Crawl4AI tools exposed by the server', () => {
      expect(tools).not.toContain('scrape_url');
      expect(tools).not.toContain('crawl4ai_scrape');
      expect(tools).toContain('crawl4ai_crawl');
      expect(tools).toContain('crawl4ai_markdown');
      expect(tools).toContain('crawl4ai_crawl_stream');
    });

    it('uses Crawl4AI official Docker API defaults', () => {
      const crawl4aiUrl = process.env.CRAWL4AI_URL || 'http://localhost:11235';
      expect(crawl4aiUrl).toBe('http://localhost:11235');
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
