import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from './logger.js';

export type MarkdownFilter = 'fit' | 'raw' | 'bm25' | 'llm';

export interface Crawl4AICrawlOptions {
  browser_config?: Record<string, unknown>;
  crawler_config?: Record<string, unknown>;
  hooks?: {
    code?: Record<string, string>;
    timeout?: number;
  };
}

export interface Crawl4AIMarkdownOptions {
  f?: MarkdownFilter;
  q?: string;
  c?: string;
  provider?: string;
  temperature?: number;
  base_url?: string;
}

export interface Crawl4AIScreenshotOptions {
  screenshot_wait_for?: number;
  wait_for_images?: boolean;
  output_path?: string;
}

export interface Crawl4AIPdfOptions {
  output_path?: string;
}

export interface Crawl4AILlmOptions {
  provider?: string;
  temperature?: number;
  base_url?: string;
}

export interface Crawl4AIJobOptions extends Crawl4AICrawlOptions {
  webhook_config?: Record<string, unknown>;
}

export class Crawl4AIClient {
  private readonly baseUrl: string;
  private readonly http: AxiosInstance;

  constructor(baseUrl: string = 'http://localhost:11235', bearerToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: Number(process.env.CRAWL4AI_TIMEOUT_MS || 120000),
      headers: {
        Accept: 'application/json',
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.http.get('/health', { timeout: 5000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async getSchema(): Promise<unknown> {
    const response = await this.http.get('/schema');
    return response.data;
  }

  async crawl(urls: string[], options: Crawl4AICrawlOptions = {}): Promise<unknown> {
    logger.info(`Crawl4AI crawl: ${urls.length} URL(s)`);
    const response = await this.http.post('/crawl', {
      urls,
      browser_config: options.browser_config || {},
      crawler_config: options.crawler_config || {},
      ...(options.hooks ? { hooks: options.hooks } : {}),
    });
    return response.data;
  }

  async crawlStream(urls: string[], options: Crawl4AICrawlOptions = {}): Promise<unknown[]> {
    logger.info(`Crawl4AI stream crawl: ${urls.length} URL(s)`);
    const response = await this.http.post('/crawl/stream', {
      urls,
      browser_config: options.browser_config || {},
      crawler_config: { ...(options.crawler_config || {}), stream: true },
      ...(options.hooks ? { hooks: options.hooks } : {}),
    }, {
      responseType: 'text',
      headers: { Accept: 'application/x-ndjson' },
      transformResponse: value => value,
    });

    return String(response.data)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  async markdown(url: string, options: Crawl4AIMarkdownOptions = {}): Promise<unknown> {
    const response = await this.http.post('/md', {
      url,
      f: options.f || 'fit',
      ...(options.q ? { q: options.q } : {}),
      c: options.c || '0',
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.base_url ? { base_url: options.base_url } : {}),
    });
    return response.data;
  }

  async html(url: string): Promise<unknown> {
    const response = await this.http.post('/html', { url });
    return response.data;
  }

  async screenshot(url: string, options: Crawl4AIScreenshotOptions = {}): Promise<unknown> {
    const response = await this.http.post('/screenshot', {
      url,
      ...options,
    });
    return response.data;
  }

  async pdf(url: string, options: Crawl4AIPdfOptions = {}): Promise<unknown> {
    const response = await this.http.post('/pdf', {
      url,
      ...options,
    });
    return response.data;
  }

  async executeJs(url: string, scripts: string[]): Promise<unknown> {
    const response = await this.http.post('/execute_js', { url, scripts });
    return response.data;
  }

  async ask(url: string, q: string, options: Crawl4AILlmOptions = {}): Promise<unknown> {
    const response = await this.http.get(`/llm/${encodeURIComponent(url)}`, {
      params: {
        q,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.base_url ? { base_url: options.base_url } : {}),
      },
    });
    return response.data;
  }

  async enqueueCrawlJob(urls: string[], options: Crawl4AIJobOptions = {}): Promise<unknown> {
    const response = await this.http.post('/crawl/job', {
      urls,
      browser_config: options.browser_config || {},
      crawler_config: options.crawler_config || {},
      ...(options.webhook_config ? { webhook_config: options.webhook_config } : {}),
    });
    return response.data;
  }

  async getCrawlJob(taskId: string): Promise<unknown> {
    const response = await this.http.get(`/crawl/job/${encodeURIComponent(taskId)}`);
    return response.data;
  }

  async enqueueLlmJob(payload: {
    url: string;
    q: string;
    schema?: string;
    cache?: boolean;
    provider?: string;
    webhook_config?: Record<string, unknown>;
    temperature?: number;
    base_url?: string;
  }): Promise<unknown> {
    const response = await this.http.post('/llm/job', payload);
    return response.data;
  }

  async getLlmJob(taskId: string): Promise<unknown> {
    const response = await this.http.get(`/llm/job/${encodeURIComponent(taskId)}`);
    return response.data;
  }

  async request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
    const response = await this.http.request<T>(config);
    return response.data;
  }
}
