import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const distIndex = path.join(process.cwd(), 'dist', 'index.js');
const maybeIt = existsSync(distIndex) ? it : it.skip;
let child: ChildProcessWithoutNullStreams | undefined;

jest.setTimeout(20000);

afterEach(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
  child = undefined;
});

describe('Streamable HTTP integration', () => {
  maybeIt('handles an empty tools/list result and session termination without crashing', async () => {
    const port = await getFreePort();
    child = await startServer(port, { ENABLED_TOOLS: 'not_a_real_tool' });

    const client = new Client({ name: 'empty-tools-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    const tools = await client.listTools();
    await transport.terminateSession();
    await client.close();

    expect(tools.tools).toEqual([]);
    await sleep(200);
    expect(child.exitCode).toBeNull();
  });

  maybeIt('lists default tools and rejects disabled direct calls without crashing', async () => {
    const port = await getFreePort();
    child = await startServer(port, { ENABLED_TOOLS: '' });

    const client = new Client({ name: 'default-tools-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    const tools = await client.listTools();
    let disabledRejected = false;
    try {
      await client.callTool({ name: 'crawl4ai_health', arguments: {} });
    } catch (error) {
      disabledRejected = String(error).includes('Tool is disabled');
    }
    await transport.terminateSession();
    await client.close();

    expect(tools.tools.map(tool => tool.name)).toEqual([
      'search_web',
      'search_and_crawl',
      'crawl4ai_crawl',
      'crawl4ai_crawl_stream',
      'crawl4ai_markdown',
    ]);
    expect(disabledRejected).toBe(true);
    await sleep(200);
    expect(child.exitCode).toBeNull();
  });
});

async function startServer(port: number, env: Record<string, string>): Promise<ChildProcessWithoutNullStreams> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    MCP_TRANSPORT: 'streamable-http',
    MCP_HTTP_PORT: String(port),
    PORT: String(port),
    LOG_LEVEL: 'error',
  };
  delete childEnv.JEST_WORKER_ID;

  const proc = spawn(process.execPath, [distIndex], {
    cwd: process.cwd(),
    env: childEnv,
  });

  const errors: string[] = [];
  proc.stderr.on('data', chunk => errors.push(String(chunk)));
  proc.stdout.on('data', chunk => errors.push(String(chunk)));

  await waitForHttp(`http://127.0.0.1:${port}/health`, errors);
  return proc;
}

async function waitForHttp(url: string, errors: string[]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server is ready or the timeout expires.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}. Server output: ${errors.join('\n')}`);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolve(address.port);
        } else {
          reject(new Error('Unable to allocate a free port'));
        }
      });
    });
    server.on('error', reject);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
