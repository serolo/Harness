import { appendFile, readFile } from 'node:fs/promises';

import { ProjectKnowledgeGateway, type KnowledgeRetrievalTraceEntry } from './knowledge/gateway';

interface Config {
  projectId: string; root: string; provider: 'qmd' | 'basic' | 'none'; maxResults: number;
  maxContextTokens: number; rerank: boolean; qmdStateRoot: string; traceFile: string;
}
interface Request { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }

function validConfig(value: unknown): value is Config {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.projectId === 'string' && typeof row.root === 'string' &&
    ['qmd', 'basic', 'none'].includes(String(row.provider)) &&
    typeof row.maxResults === 'number' && typeof row.maxContextTokens === 'number' &&
    typeof row.rerank === 'boolean' && typeof row.qmdStateRoot === 'string' && typeof row.traceFile === 'string';
}
async function main(): Promise<void> {
  const path = process.env.HARNESS_KNOWLEDGE_CONFIG;
  if (!path) throw new Error('Missing private knowledge gateway configuration.');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!validConfig(raw)) throw new Error('Invalid private knowledge gateway configuration.');
  const gateway = new ProjectKnowledgeGateway(raw);
  let traced = 0;
  const recordTrace = async (): Promise<void> => {
    const fresh = gateway.trace().slice(traced);
    traced += fresh.length;
    for (const entry of fresh) await appendFile(raw.traceFile, `${JSON.stringify(toEvent(entry))}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) void respond(JSON.parse(line) as Request, gateway, recordTrace);
  });
}
function toEvent(entry: KnowledgeRetrievalTraceEntry): Record<string, unknown> {
  return { kind: 'knowledge_retrieval', ...entry };
}
async function respond(request: Request, gateway: ProjectKnowledgeGateway, recordTrace: () => Promise<void>): Promise<void> {
  if (request.id === undefined) return;
  let result: unknown;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'harness-project-knowledge', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [
    { name: 'search_project_knowledge', description: 'Search canonical project knowledge. Call before reading.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'read_project_knowledge', description: 'Read a path returned by search. Optional one-based line range is capped.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  ] };
  else if (request.method === 'tools/call') {
    const params = request.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
    const args = params?.arguments ?? {};
    if (params?.name === 'search_project_knowledge' && typeof args.query === 'string') result = await gateway.searchProjectKnowledge(args.query);
    else if (params?.name === 'read_project_knowledge' && typeof args.path === 'string') result = await gateway.readProjectKnowledge(args.path, typeof args.startLine === 'number' ? args.startLine : undefined, typeof args.endLine === 'number' ? args.endLine : undefined);
    else result = { content: [{ type: 'text', text: 'Invalid knowledge tool call.' }], isError: true };
    await recordTrace();
  } else result = {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}

void main().catch((error) => { process.stderr.write(`Knowledge server failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
