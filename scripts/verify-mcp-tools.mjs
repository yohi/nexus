import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const EXPECTED_TOOL_NAMES = Object.freeze([
  'semantic_search', 'grep_search', 'hybrid_search', 'get_context', 'index_status',
  'reindex', 'get_file_outline', 'get_symbol_source', 'get_symbol_context',
]);

const asRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const textOf = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const hasMarker = (value, marker) => marker === undefined || textOf(value).includes(marker);

export const validateToolList = (actualNames) => {
  const missing = EXPECTED_TOOL_NAMES.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !EXPECTED_TOOL_NAMES.includes(name));
  if (missing.length === 0 && unexpected.length === 0 && actualNames.length === EXPECTED_TOOL_NAMES.length) return { ok: true };
  return { ok: false, reason: `tool list mismatch; missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}` };
};

export const validateToolResult = (toolName, result, marker) => {
  const data = asRecord(result);
  switch (toolName) {
    case 'grep_search':
      return Array.isArray(data.matches) && data.matches.length > 0 && hasMarker(data.matches, marker)
        ? { ok: true } : { ok: false, reason: 'grep_search returned no matching fixture marker' };
    case 'semantic_search':
    case 'hybrid_search':
      return Array.isArray(data.results) && data.results.length > 0 && hasMarker(data.results, marker)
        ? { ok: true } : { ok: false, reason: `${toolName} returned no matching fixture result` };
    case 'get_context':
      return typeof data.content === 'string' && hasMarker(data.content, marker)
        ? { ok: true } : { ok: false, reason: 'get_context did not return the fixture marker' };
    case 'index_status':
      return asRecord(data.pipelineProgress).status === 'idle' && asRecord(data.indexStats).lastIndexedAt !== null
        ? { ok: true } : { ok: false, reason: 'index_status did not reach an idle indexed state' };
    case 'reindex':
      return typeof data.startedAt === 'string' && typeof data.finishedAt === 'string' && typeof data.durationMs === 'number'
        ? { ok: true } : { ok: false, reason: 'reindex did not return a completed result' };
    case 'get_file_outline':
      return data.status === 'ok' && Array.isArray(data.symbols) && data.symbols.length > 0
        ? { ok: true } : { ok: false, reason: `get_file_outline status=${String(data.status ?? 'missing')}` };
    case 'get_symbol_source':
      return data.status === 'ok' && hasMarker(data.source, marker)
        ? { ok: true } : { ok: false, reason: 'get_symbol_source did not return marked source' };
    case 'get_symbol_context':
      return data.status === 'ok' && hasMarker(data.context, marker)
        ? { ok: true } : { ok: false, reason: 'get_symbol_context did not return marked context' };
    default:
      return { ok: false, reason: `unknown tool: ${toolName}` };
  }
};

export const summarizeToolResult = (phase, toolName, result) => {
  const data = asRecord(result.data);
  const validation = result.error === undefined ? validateToolResult(toolName, data, result.marker) : { ok: false, reason: result.error };
  return {
    phase,
    tool: toolName,
    ok: validation.ok,
    reason: validation.ok ? undefined : validation.reason,
    status: typeof data.status === 'string' ? data.status : undefined,
    reasonCode: typeof data.reasonCode === 'string' ? data.reasonCode : undefined,
  };
};

const parseToolData = (result) => {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (text === undefined) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
};

const createEnvironment = () => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('NEXUS_')));
  return {
    ...inherited,
    NEXUS_EMBEDDING_PROVIDER: 'ollama',
    NEXUS_EMBEDDING_MODEL: 'bge-m3',
    NEXUS_EMBEDDING_DIMENSIONS: '1024',
    NEXUS_EMBEDDING_BASE_URL: 'http://127.0.0.1:11434',
    NEXUS_EMBEDDING_RETRY_COUNT: '0',
    NEXUS_EMBEDDING_TIMEOUT_MS: '30000',
  };
};

const startClient = async (cliPath, projectRoot) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, '--project-root', projectRoot], env: createEnvironment() });
  const client = new Client({ name: 'nexus-mcp-tool-verifier', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return { client, transport };
};

const callTool = async (client, toolName, args, marker) => {
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return { data: parseToolData(result), marker, error: result.isError ? `MCP error response from ${toolName}` : undefined };
  } catch (error) {
    return { data: {}, marker, error: error instanceof Error ? error.message : String(error) };
  }
};

const waitForIndex = async (client) => {
  let last = {};
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await callTool(client, 'index_status', {});
    last = asRecord(result.data);
    if (asRecord(last.pipelineProgress).status === 'idle' && asRecord(last.indexStats).lastIndexedAt !== null) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
};

const closeClient = async ({ client, transport }, lockPath) => {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await access(lockPath); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Nexus process lock did not disappear during cleanup');
};

const createFixture = async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-mcp-tool-verification-'));
  const marker = `nexusVerificationNeedle${Date.now()}`;
  await writeFile(join(projectRoot, 'fixture.ts'), `export function verifyNexusToolNeedle(): string { return '${marker}'; }\n`);
  await writeFile(join(projectRoot, '.nexus.json'), JSON.stringify({ embedding: { provider: 'ollama', model: 'bge-m3', dimensions: 1024, baseUrl: 'http://127.0.0.1:11434', retryCount: 0, timeoutMs: 30_000 } }));
  return { projectRoot, marker, lockPath: join(projectRoot, '.nexus', '.nexus-lock') };
};

const record = async (records, phase, toolName, client, args, marker) => {
  const result = await callTool(client, toolName, args, marker);
  records.push(summarizeToolResult(phase, toolName, result));
  return result.data;
};

export const runVerification = async ({ cliPath, json = false } = {}) => {
  const resolvedCliPath = cliPath ?? join(process.cwd(), 'dist', 'bin', 'nexus.js');
  await access(resolvedCliPath);
  const fixture = await createFixture();
  const records = [];
  let first;
  let second;
  try {
    first = await startClient(resolvedCliPath, fixture.projectRoot);
    const firstStatus = await waitForIndex(first.client);
    records.push(summarizeToolResult('cold-start', 'index_status', { data: firstStatus, marker: fixture.marker }));
    const tools = await first.client.listTools();
    const listCheck = validateToolList(tools.tools.map((tool) => tool.name));
    records.push({ phase: 'cold-start', tool: 'tools/list', ok: listCheck.ok, reason: listCheck.ok ? undefined : listCheck.reason });
    await record(records, 'cold-start', 'grep_search', first.client, { pattern: fixture.marker }, fixture.marker);
    await record(records, 'cold-start', 'semantic_search', first.client, { query: 'function returning the verification marker', topK: 5 }, fixture.marker);
    await record(records, 'cold-start', 'hybrid_search', first.client, { query: 'function returning the verification marker', grepPattern: fixture.marker, topK: 5 }, fixture.marker);
    await record(records, 'cold-start', 'get_context', first.client, { filePath: 'fixture.ts', startLine: 1, endLine: 1, mode: 'eager' }, fixture.marker);
    await record(records, 'cold-start', 'get_file_outline', first.client, { filePath: 'fixture.ts' }, fixture.marker);
    await record(records, 'cold-start', 'reindex', first.client, { fullRebuild: true, reason: 'manual' }, fixture.marker);
    await closeClient(first, fixture.lockPath);
    first = undefined;

    second = await startClient(resolvedCliPath, fixture.projectRoot);
    await record(records, 'restart', 'index_status', second.client, {}, fixture.marker);
    const outline = await record(records, 'restart', 'get_file_outline', second.client, { filePath: 'fixture.ts' }, fixture.marker);
    const symbolId = asRecord(outline).symbols?.[0]?.symbolId ?? 'missing-symbol-for-verification';
    await record(records, 'restart', 'get_symbol_source', second.client, { symbolId }, fixture.marker);
    await record(records, 'restart', 'get_symbol_context', second.client, { symbolId, tokenBudget: 128 }, fixture.marker);
    await closeClient(second, fixture.lockPath);
    second = undefined;
  } finally {
    if (first !== undefined) await closeClient(first, fixture.lockPath).catch(() => {});
    if (second !== undefined) await closeClient(second, fixture.lockPath).catch(() => {});
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
  const passed = records.every((item) => item.ok);
  const summary = { ok: passed, toolCount: EXPECTED_TOOL_NAMES.length, records };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    for (const item of records) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.phase}/${item.tool}${item.reason ? `: ${item.reason}` : ''}`);
    console.log(`Summary: ${records.filter((item) => item.ok).length}/${records.length} checks passed`);
  }
  return summary;
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const json = process.argv.includes('--json');
  try {
    const summary = await runVerification({ json });
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
