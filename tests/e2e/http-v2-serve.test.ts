import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

const isE2EEnabled = process.env.NEXUS_E2E === '1';
const cliPath = join(process.cwd(), 'dist', 'bin', 'nexus.js');

const waitForStartup = (child: ChildProcessWithoutNullStreams): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = '';
    let diagnostics = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`nexus serve did not start in time: ${diagnostics}`));
    }, 30_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onStdout = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = /nexus serve listening on (127\.0\.0\.1|localhost):(\d+)/.exec(output);
      const host = match?.[1];
      const port = match?.[2];
      if (host !== undefined && port !== undefined) {
        cleanup();
        resolve(`http://${host}:${port}`);
      }
    };
    const onStderr = (chunk: Buffer): void => {
      diagnostics += chunk.toString('utf8');
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`nexus serve exited with ${String(code)}: ${diagnostics}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });

const startOllamaStub = async (): Promise<{ readonly server: Server; readonly baseUrl: string }> => {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/embed') {
      let body = '';
      for await (const chunk of request) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      const parsed: unknown = JSON.parse(body);
      const input =
        parsed !== null &&
        typeof parsed === 'object' &&
        'input' in parsed &&
        Array.isArray(parsed.input) &&
        parsed.input.every((value) => typeof value === 'string')
          ? parsed.input
          : undefined;
      if (input === undefined) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'input must be a string array' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ embeddings: input.map(() => Array.from({ length: 768 }, () => 0)) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    throw new Error('Ollama stub did not bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

describe.skipIf(!isE2EEnabled)('nexus serve E2E', () => {
  let projectRoot: string | undefined;
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: Client | undefined;
  let ollama: Server | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (server?.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
    server = undefined;
    if (ollama !== undefined) {
      await closeServer(ollama);
      ollama = undefined;
    }
    if (projectRoot !== undefined) {
      await rm(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('initializes, discovers, lists tools, and calls a tool through the MCP v2 SDK client', async () => {
    const ollamaStub = await startOllamaStub();
    ollama = ollamaStub.server;
    projectRoot = await mkdtemp(join(tmpdir(), 'nexus-serve-e2e-'));
    await writeFile(
      join(projectRoot, '.nexus.json'),
      JSON.stringify({
        embedding: {
          provider: 'ollama',
          model: 'nomic-embed-text',
          baseUrl: ollamaStub.baseUrl,
        },
      }),
    );
    await writeFile(join(projectRoot, 'e2e-fixture.ts'), 'export const e2eGrepNeedle = true;\n');
    const child = spawn(process.execPath, [cliPath, 'serve', '--project-root', projectRoot, '--port', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NEXUS_E2E: '1' },
    });
    server = child;

    const baseUrl = await waitForStartup(child);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    client = new Client(
      { name: 'nexus-serve-e2e-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getDiscoverResult()).toBeDefined();
    const discovery = await client.discover();
    expect(discovery._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'nexus' });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'semantic_search',
      'grep_search',
      'hybrid_search',
      'get_context',
      'index_status',
      'reindex',
      'get_file_outline',
      'get_symbol_source',
      'get_symbol_context',
    ]);

    const result = await client.callTool({ name: 'grep_search', arguments: { pattern: 'e2eGrepNeedle' } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      matches: [{ filePath: expect.stringMatching(/e2e-fixture\.ts$/) }],
    });
  });
});
