import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from './logger.js';
import { loggableError, normalizeHttpError, shouldRetryHttpError } from './http-errors.js';

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
  private readonly retries: number;

  constructor(baseUrl: string = 'http://localhost:11235', bearerToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.retries = Number(process.env.CRAWL4AI_RETRIES || 1);
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
    const response = await this.requestWithRetry({ method: 'GET', url: '/schema' });
    return response.data;
  }

  async crawl(urls: string[], options: Crawl4AICrawlOptions = {}): Promise<unknown> {
    logger.info(`Crawl4AI crawl: ${urls.length} URL(s)`);
    const response = await this.requestWithRetry({
      method: 'POST',
      url: '/crawl',
      data: {
      urls,
      browser_config: options.browser_config || {},
      crawler_config: options.crawler_config || {},
      ...(options.hooks ? { hooks: options.hooks } : {}),
      },
    });
    return response.data;
  }

  async crawlStream(urls: string[], options: Crawl4AICrawlOptions = {}): Promise<unknown[]> {
    logger.info(`Crawl4AI stream crawl: ${urls.length} URL(s)`);
    const response = await this.requestWithRetry({
      method: 'POST',
      url: '/crawl/stream',
      data: {
        urls,
        browser_config: options.browser_config || {},
        crawler_config: { ...(options.crawler_config || {}), stream: true },
        ...(options.hooks ? { hooks: options.hooks } : {}),
      },
      responseType: 'text',
      headers: { Accept: 'application/x-ndjson' },
      transformResponse: value => value,
    });

    return this.parseNdjson(response.data);
  }

  async markdown(url: string, options: Crawl4AIMarkdownOptions = {}): Promise<unknown> {
    const response = await this.requestWithRetry({
      method: 'POST',
      url: '/md',
      data: {
        url,
        f: options.f || 'fit',
        ...(options.q ? { q: options.q } : {}),
        c: options.c || '0',
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.base_url ? { base_url: options.base_url } : {}),
      },
    });
    return response.data;
  }

  async html(url: string): Promise<unknown> {
    const response = await this.requestWithRetry({ method: 'POST', url: '/html', data: { url } });
    return response.data;
  }

  async screenshot(url: string, options: Crawl4AIScreenshotOptions = {}): Promise<unknown> {
    const response = await this.requestWithRetry({
      method: 'POST',
      url: '/screenshot',
      data: { url, ...options },
    });
    return response.data;
  }

  async pdf(url: string, options: Crawl4AIPdfOptions = {}): Promise<unknown> {
    const response = await this.requestWithRetry({
      method: 'POST',
      url: '/pdf',
      data: { url, ...options },
    });
    return response.data;
  }

  async executeJs(url: string, scripts: string[]): Promise<unknown> {
    const response = await this.requestWithRetry({ method: 'POST', url: '/execute_js', data: { url, scripts } });
    return response.data;
  }

  async ask(url: string, q: string, options: Crawl4AILlmOptions = {}): Promise<unknown> {
    const response = await this.requestWithRetry({
      method: 'GET',
      url: `/llm/${encodeURIComponent(url)}`,
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
    const response = await this.requestWithRetry({
      method: 'POST',
      url: '/crawl/job',
      data: {
        urls,
        browser_config: options.browser_config || {},
        crawler_config: options.crawler_config || {},
        ...(options.webhook_config ? { webhook_config: options.webhook_config } : {}),
      },
    });
    return response.data;
  }

  async getCrawlJob(taskId: string): Promise<unknown> {
    const response = await this.requestWithRetry({ method: 'GET', url: `/crawl/job/${encodeURIComponent(taskId)}` });
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
    const response = await this.requestWithRetry({ method: 'POST', url: '/llm/job', data: payload });
    return response.data;
  }

  async getLlmJob(taskId: string): Promise<unknown> {
    const response = await this.requestWithRetry({ method: 'GET', url: `/llm/job/${encodeURIComponent(taskId)}` });
    return response.data;
  }

  async request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
    const response = await this.requestWithRetry<T>(config);
    return response.data;
  }

  private async requestWithRetry<T = unknown>(config: AxiosRequestConfig): Promise<{ data: T }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.http.request<T>(config);
      } catch (error) {
        lastError = error;
        if (attempt >= this.retries || !shouldRetryHttpError(error)) {
          const normalized = normalizeHttpError(error, 'Crawl4AI');
          logger.error('Crawl4AI request failed:', loggableError(error, 'Crawl4AI'));
          throw normalized;
        }

        logger.warn(`Retrying Crawl4AI request after transient failure (${attempt + 1}/${this.retries})`, loggableError(error, 'Crawl4AI'));
        await this.sleep(250 * 2 ** attempt);
      }
    }

    throw normalizeHttpError(lastError, 'Crawl4AI');
  }

  private parseNdjson(data: unknown): unknown[] {
    const lines = String(data)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid Crawl4AI NDJSON on line ${index + 1}: ${line.slice(0, 200)}`);
      }
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
