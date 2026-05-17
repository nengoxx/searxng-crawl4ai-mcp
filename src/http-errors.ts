import axios, { AxiosError } from 'axios';

const MAX_DETAIL_LENGTH = Number(process.env.ERROR_DETAIL_MAX_CHARS || 1200);

export class UpstreamHttpError extends Error {
  readonly status?: number;
  readonly method?: string;
  readonly url?: string;
  readonly detail?: unknown;

  constructor(message: string, options: { status?: number; method?: string; url?: string; detail?: unknown } = {}) {
    super(message);
    this.name = 'UpstreamHttpError';
    this.status = options.status;
    this.method = options.method;
    this.url = options.url;
    this.detail = options.detail;
  }
}

export function normalizeHttpError(error: unknown, service: string): UpstreamHttpError {
  if (!axios.isAxiosError(error)) {
    return error instanceof UpstreamHttpError
      ? error
      : new UpstreamHttpError(error instanceof Error ? error.message : String(error));
  }

  const axiosError = error as AxiosError;
  const method = axiosError.config?.method?.toUpperCase();
  const url = buildUrl(axiosError);
  const status = axiosError.response?.status;
  const detail = trimDetail(extractDetail(axiosError));
  const statusText = status ? `HTTP ${status}` : axiosError.code || 'request failed';
  const target = [method, url].filter(Boolean).join(' ');
  const message = `${service} ${statusText}${target ? ` for ${target}` : ''}${detail ? `: ${detail}` : ''}`;

  return new UpstreamHttpError(message, {
    status,
    method,
    url,
    detail,
  });
}

export function shouldRetryHttpError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  if (status && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code || '');
}

export function loggableError(error: unknown, service: string) {
  const normalized = normalizeHttpError(error, service);
  return {
    message: normalized.message,
    status: normalized.status,
    method: normalized.method,
    url: normalized.url,
    detail: normalized.detail,
    stack: normalized.stack,
  };
}

function buildUrl(error: AxiosError): string | undefined {
  const config = error.config;
  if (!config?.url) {
    return undefined;
  }

  if (/^https?:\/\//i.test(config.url)) {
    return config.url;
  }

  return `${String(config.baseURL || '').replace(/\/$/, '')}/${config.url.replace(/^\//, '')}`;
}

function extractDetail(error: AxiosError): string {
  const data = error.response?.data;
  if (!data) {
    return error.message;
  }

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'object' && 'detail' in data) {
    const detail = (data as { detail?: unknown }).detail;
    return typeof detail === 'string' ? detail : JSON.stringify(detail);
  }

  return JSON.stringify(data);
}

function trimDetail(detail: string): string {
  const compact = detail.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_DETAIL_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, MAX_DETAIL_LENGTH)}...`;
}
