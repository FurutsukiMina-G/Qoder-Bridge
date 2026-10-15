import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ChatRequest, parseDecision, conversationPrompt, completion, assertTextRequest } from './compat.js';
import { runProbe, type Config } from './client.js';
import { appendReport, safeError } from './telemetry.js';
import { QoderPool } from './pool.js';
import { taskLogEntry } from './task-log.js';
import { RequestSlots } from './async.js';
import { FinalTextProjector } from './streaming.js';
import type { OpenAIUsage } from './usage.js';
import { BRIDGE_MODELS, DEFAULT_PUBLIC_MODEL, PRO_PUBLIC_MODEL, bridgeModel } from './model.js';

export const PUBLIC_MODEL = DEFAULT_PUBLIC_MODEL;
export const PUBLIC_PRO_MODEL = PRO_PUBLIC_MODEL;
const BODY_LIMIT = 12 * 1024 * 1024;
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > BODY_LIMIT) throw new Error('Request body exceeds 12 MiB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function bridgeKey(path = '.runtime/bridge-key') {
  await mkdir(resolve('.runtime'), { recursive: true });
  try { const key = (await readFile(path, 'utf8')).trim(); if (key) return key; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const value = `qoderbridge-${randomUUID()}-${randomUUID()}`;
  await writeFile(path, `${value}\n`, { flag: 'wx', mode: 0o600 });
  return value;
}
export async function createBridgeServer(config: Config, options: {
  port?: number; key?: string; infer?: typeof runProbe; reportDir?: string;
} = {}) {
  const bridgePort = options.port ?? 8646;
  const key = options.key ?? await bridgeKey();
  const infer = options.infer ?? runProbe;
  const reports = { bridge: join(options.reportDir ?? 'reports', 'bridge.ndjson'),
    tasks: join(options.reportDir ?? 'reports', 'tasks.ndjson') };
  if (config.model && config.model !== BRIDGE_MODELS[0].runtimeId)
    throw new Error('serve selects Flash/Pro through request.model; omit --model when serving both models');
  const pools = new Map<string, QoderPool>();
  const requestConfig = (model: string): Config => {
    const spec = bridgeModel(model);
    if (!spec) throw new Error(`Unknown model: ${model}`);
    return { ...config, model: spec.runtimeId };
  };
  const poolFor = (model: string) => {
    if (options.infer) return null;
    let selected = pools.get(model);
    if (!selected) { selected = new QoderPool(requestConfig(model)); pools.set(model, selected); }
    return selected;
  };
  // Independent pools prevent a model switch from carrying Qoder history or replay/cache state across models.
  const pool = poolFor(PUBLIC_MODEL);
  // Keep serving when the runtime is not reachable yet; the pool retries warm-up and opens sessions on demand.
  if (pool) await pool.prewarm().catch(() => {});
  const slots = new RequestSlots(3);
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const bridgeRequestId = randomUUID();
    let taskRequest: ChatRequest | undefined;
    let requestAccepted = false;
    let taskTurn: Parameters<typeof taskLogEntry>[0]['turn'];
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let firstClientTextMs: number | null = null;
    let firstClientThinkingMs: number | null = null;
    let streamChunks = 0;
    const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('Harness client disconnected')); };
    res.once('close', disconnect);
    const streamBase = { id: `chatcmpl-${bridgeRequestId}`, object: 'chat.completion.chunk',
      created: Math.floor(startedAt / 1000), model: PUBLIC_MODEL as string };
    const emit = (delta: Record<string, unknown>, finish: string | null = null) => {
      if (res.destroyed) throw new Error('Harness client disconnected');
      streamChunks++;
      res.write(`data: ${JSON.stringify({ ...streamBase, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    const projector = new FinalTextProjector(text => {
      firstClientTextMs ??= Date.now() - startedAt;
      emit({ content: text });
    });
    const writeTaskLog = async (decision?: ReturnType<typeof parseDecision>, error?: string) => {
      if (!taskRequest) return;
      try {
        await appendReport(reports.tasks, taskLogEntry({ request: taskRequest, turn: taskTurn,
          decision, bridgeRequestId, startedAt, error, bridgePort }));
      } catch (cause) { process.stderr.write(`[bridge] Task logging failed: ${safeError(cause)}\n`); }
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, {
        status: 'ok', pid: process.pid, model: PUBLIC_MODEL, port: bridgePort,
        models: BRIDGE_MODELS.map(model => model.id),
        activeRequests: slots.active, queuedRequests: slots.queued, pool: pool?.stats() ?? null,
        pools: Object.fromEntries([...pools].map(([model, value]) => [model, value.stats()])),
        capabilities: { finalTextStreaming: true, thinkingStreaming: true, validatedTools: true,
          usage: 'qoder-context-ratio+stream-token-deltas',
          cacheUsage: config.cacheUsage === 'estimate' ? 'session-prefix-estimate' : 'not-reported' },
      });
      if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
      if (req.method === 'GET' && url.pathname === '/v1/models') return send(res, 200, {
        object: 'list', data: BRIDGE_MODELS.map(model => ({ id: model.id, name: model.name,
          object: 'model', created: 0, owned_by: 'qoderbridge' })),
      });
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions')
        return send(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
      const raw = await body(req);
      const request = ChatRequest.parse(raw);
      taskRequest = request;
      if (!bridgeModel(request.model)) throw new Error(`Unknown model: ${request.model}`);
      streamBase.model = request.model;
      assertTextRequest(request);
      requestAccepted = true;
      deadline = setTimeout(() => controller.abort(new Error('QoderBridge request deadline exceeded')), config.timeout);
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
          'x-qoderbridge-stream-mode': 'final-text-and-thinking-tools-validated' });
        emit({ role: 'assistant' });
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': waiting for Qoder\n\n'); }, 15000);
        heartbeat.unref();
      }
      const release = await slots.take(controller.signal);
      try {
        controller.signal.throwIfAborted();
        const selectedPool = poolFor(request.model);
        const pooled = selectedPool ? await selectedPool.infer(request, { signal: controller.signal,
          onText: request.stream ? text => projector.push(text) : undefined,
          onThinking: request.stream ? text => {
            firstClientThinkingMs ??= Date.now() - startedAt;
            emit({ reasoning_content: text });
          } : undefined,
          validateDecision: request.stream ? decision => projector.validate(decision) : undefined,
        }) : null;
        const turn = pooled ? pooled.report : await infer(requestConfig(request.model), conversationPrompt(request), undefined,
          request.stream ? text => projector.push(text) : () => {});
        taskTurn = { ...turn, first_client_text_ms: firstClientTextMs,
          first_client_thinking_ms: firstClientThinkingMs, stream_chunks: streamChunks };
        await appendReport(reports.bridge, { ...turn, bridge_request_id: bridgeRequestId,
          bridge_port: bridgePort,
          harness_message_count: request.messages.length, harness_tool_count: request.tools?.length ?? 0 });
        if (turn.error) throw new Error(`Qoder inference failed at ${turn.stage}: ${turn.error}`);
        if (pooled?.decisionError) throw new Error(pooled.decisionError);
        const decision = pooled?.decision ?? parseDecision(turn.response, request);
        if (request.stream) projector.validate(decision);
        const answer = completion(request, decision);
        const usage = ('client_usage' in turn ? turn.client_usage as OpenAIUsage | null : null) ??
          ('normalized_usage' in turn ? turn.normalized_usage as OpenAIUsage | null : null);
        if (selectedPool && pooled && 'tool_calls' in answer.choices[0]!.message) {
          for (const call of answer.choices[0]!.message.tool_calls ?? []) selectedPool.bindTool(call.id, pooled.record);
        }
        if (!request.stream) send(res, 200, { ...answer, ...(usage ? { usage } : {}) });
        else {
          projector.finish(decision);
          if (decision.kind !== 'final') {
            const calls = answer.choices[0]!.message.tool_calls ?? [];
            calls.forEach((call, index) => emit({ tool_calls: [{ ...call, index }] }));
          }
          emit({}, decision.kind === 'final' ? 'stop' : 'tool_calls');
          if (usage && (request.stream_options as { include_usage?: boolean } | undefined)?.include_usage)
            res.write(`data: ${JSON.stringify({ ...streamBase, choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
        }
        taskTurn.first_client_text_ms = firstClientTextMs;
        taskTurn.first_client_thinking_ms = firstClientThinkingMs;
        taskTurn.stream_chunks = streamChunks;
        await writeTaskLog(decision);
      } finally { release(); }
    } catch (cause) {
      const message = safeError(cause);
      await writeTaskLog(undefined, message);
      process.stderr.write(`[bridge] ${message}\n`);
      const turnLimit = message.includes('Qoder result: error_max_turns');
      const invalidArguments = /^Arguments for [\w.-]+ violate its schema/.test(message);
      const error = { message: turnLimit ? 'Qoder SDK reached its per-request turn limit without a completed model decision.'
        : invalidArguments ? message.slice(0, 300) : 'QoderBridge could not complete the model request', type: 'upstream_error',
        code: controller.signal.aborted ? 'request_cancelled_or_timeout' : turnLimit ? 'qoder_turn_limit'
          : invalidArguments ? 'tool_arguments_invalid' : 'model_decision_error', request_id: bridgeRequestId };
      if (!res.headersSent) send(res, requestAccepted ? 502 : 400, { error });
      else if (!res.destroyed) { res.write(`data: ${JSON.stringify({ error })}\n\n`); res.end(); }
    } finally {
      if (deadline) clearTimeout(deadline);
      if (heartbeat) clearInterval(heartbeat);
      res.off('close', disconnect);
    }
  });
  await new Promise<void>((ok, reject) => {
    server.once('error', reject);
    server.listen(bridgePort, '127.0.0.1', () => { server.off('error', reject); ok(); });
  });
  server.on('close', () => { for (const value of pools.values()) value.closeAll(); });
  return server;
}
