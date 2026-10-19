import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ChatRequest, parseDecision, conversationPrompt, completion, assertTextRequest } from './compat.js';
import { runProbe, type Config } from './client.js';
import { appendReport, safeError } from './telemetry.js';
import { QoderPool, DEFAULT_REASONING_GUARD_TOKENS } from './pool.js';
import { taskLogEntry } from './task-log.js';
import { RequestSlots } from './async.js';
import { FinalTextProjector } from './streaming.js';
import type { OpenAIUsage } from './usage.js';
import { BRIDGE_MODELS, DEFAULT_PUBLIC_MODEL, PRO_PUBLIC_MODEL, bridgeModel, requestedEffort } from './model.js';
import {recoverDecision,recoverySummary,decisionRetryLimit,type RecoveryTrace} from './decision-recovery.js';
import {assertToolContract} from './tool-contract.js';
import {publicUpstreamFailure} from './diagnostics.js';
import {bridgeFailure,type FailurePhase,type FailureInput} from './failures.js';

export const PUBLIC_MODEL = DEFAULT_PUBLIC_MODEL;
export const PUBLIC_PRO_MODEL = PRO_PUBLIC_MODEL;
const BODY_LIMIT = 12 * 1024 * 1024;
/** Report upstream silence well inside a 300 s client stream-idle watchdog. */
const SILENCE_STATUS_MS = 60_000;
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
  decisionRetryLimit(config.decisionRetries);
  const key = options.key ?? await bridgeKey();
  const infer = options.infer ?? runProbe;
  const reports = { bridge: join(options.reportDir ?? 'reports', 'bridge.ndjson'),
    tasks: join(options.reportDir ?? 'reports', 'tasks.ndjson'),
    errors: join(options.reportDir ?? 'reports', 'errors.ndjson') };
  if (config.model && config.model !== BRIDGE_MODELS[0].runtimeId)
    throw new Error('serve selects Flash/Pro through request.model; omit --model when serving both models');
  const pools = new Map<string, QoderPool>();
  const requestConfig = (model: string): Config => {
    const spec = bridgeModel(model);
    if (!spec) throw new Error(`Unknown model: ${model}`);
    // Each public variant pins its Qoder context window; the Harness entry declares the same window.
    return { ...config, model: spec.runtimeId, context: spec.contextWindow };
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
    res.setHeader('x-qoderbridge-request-id', bridgeRequestId);
    // The Bridge owns bounded corrections. Do not add SDK HTTP status retries around the whole operation.
    res.setHeader('x-should-retry', 'false');
    let taskRequest: ChatRequest | undefined;
    let requestAccepted = false;
    let taskTurn: Parameters<typeof taskLogEntry>[0]['turn'];
    let decisionRecovery: RecoveryTrace | undefined;
    let upstreamFailure:ReturnType<typeof publicUpstreamFailure> = null;
    let failurePhase: FailurePhase = 'request';
    let failureTurn: FailureInput['turn'];
    let abortKind: FailureInput['abort'];
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let firstClientTextMs: number | null = null;
    let firstClientThinkingMs: number | null = null;
    let streamChunks = 0;
    const disconnect = () => { if (!res.writableEnded && !controller.signal.aborted) {
      abortKind = 'client_disconnect'; controller.abort(new Error('Harness client disconnected'));
    } };
    res.once('close', disconnect);
    const streamBase = { id: `chatcmpl-${bridgeRequestId}`, object: 'chat.completion.chunk',
      created: Math.floor(startedAt / 1000), model: PUBLIC_MODEL as string };
    let lastEmitAt = Date.now();
    const emit = (delta: Record<string, unknown>, finish: string | null = null) => {
      if (res.destroyed) throw new Error('Harness client disconnected');
      streamChunks++; lastEmitAt = Date.now();
      res.write(`data: ${JSON.stringify({ ...streamBase, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    // Client idle watchdogs count parsed deltas, not SSE comments. Before any answer text, report upstream
    // waits in the reasoning channel; this is bridge status, never model output.
    const status = (text: string) => {
      if (firstClientTextMs !== null || res.destroyed) return;
      try { emit({ reasoning_content: `\n${text}\n` }); } catch { /* the close handler aborts the request */ }
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
    const recordFailure = async (error: ReturnType<typeof bridgeFailure>) => {
      try { await appendReport(reports.errors, { schema: 'qoderbridge-error-v1', time: new Date().toISOString(),
        bridge_request_id: bridgeRequestId, bridge_port: bridgePort, error }); }
      catch (cause) { process.stderr.write(`[bridge] Error logging failed: ${safeError(cause)}\n`); }
    };
    const earlyFailure = async (kind: 'authentication' | 'route', status: number) => {
      const error = bridgeFailure({ requestId: bridgeRequestId, phase: 'request', accepted: false, early: kind });
      if (kind === 'authentication') error.type = 'authentication_error';
      await recordFailure(error); send(res, status, { error });
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, {
        status: 'ok', pid: process.pid, model: PUBLIC_MODEL, port: bridgePort,
        models: BRIDGE_MODELS.map(model => model.id),
        modelOptions: BRIDGE_MODELS.map(({ id, contextWindow, efforts }) => ({ id, contextWindow, reasoningEfforts: efforts })),
        activeRequests: slots.active, queuedRequests: slots.queued, pool: pool?.stats() ?? null,
        pools: Object.fromEntries([...pools].map(([model, value]) => [model, value.stats()])),
        capabilities: { finalTextStreaming: true, thinkingStreaming: true, validatedTools: true,
          errorDiagnostics: { version: 1, origins: ['account','bridge','model_output','upstream','dsh_request','connection','unknown'],
            visibleMessage: true, sdkErrorCode: true, requestId: true },
          decisionRecovery: {maxCorrectionCalls:decisionRetryLimit(config.decisionRetries),
            beforeToolDispatch:true,retriesRuntimeFailures:false},
          usage: 'qoder-context-ratio+stream-token-deltas',
          cacheUsage: config.cacheUsage === 'billing' ? 'qoder-credits-inverse+session-prefix-fallback'
            : config.cacheUsage === 'estimate' ? 'session-prefix-estimate' : 'not-reported',
          reasoningGuard: { maxReasoningTokensBeforeOutput: config.reasoningGuardTokens ?? DEFAULT_REASONING_GUARD_TOKENS,
            retryReasoningEffort: config.reasoning === 'max' ? 'high' : config.reasoning ?? null } },
      });
      if (req.headers.authorization !== `Bearer ${key}`) return await earlyFailure('authentication', 401);
      if (req.method === 'GET' && url.pathname === '/v1/models') return send(res, 200, {
        object: 'list', data: BRIDGE_MODELS.map(model => ({ id: model.id, name: model.name,
          object: 'model', created: 0, owned_by: 'qoderbridge', context_window: model.contextWindow,
          reasoning_efforts: model.efforts })),
      });
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions')
        return await earlyFailure('route', 404);
      const raw = await body(req);
      const request = ChatRequest.parse(raw);
      taskRequest = request;
      const spec = bridgeModel(request.model);
      if (!spec) throw new Error(`Unknown model: ${request.model}`);
      const reasoningEffort = requestedEffort(spec, request.reasoning_effort);
      streamBase.model = request.model;
      assertTextRequest(request);
      assertToolContract(request);
      requestAccepted = true;
      deadline = setTimeout(() => { if (!controller.signal.aborted) {
        abortKind = 'deadline'; controller.abort(new Error('QoderBridge request deadline exceeded'));
      } }, config.timeout);
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
          'x-qoderbridge-stream-mode': 'final-text-and-thinking-tools-validated' });
        emit({ role: 'assistant' });
        heartbeat = setInterval(() => {
          if (res.destroyed) return;
          res.write(': waiting for Qoder\n\n');
          const silent = Date.now() - lastEmitAt;
          if (silent >= SILENCE_STATUS_MS) status(`[QoderBridge] Still waiting for Qoder (${Math.round(silent / 1000)}s without upstream output).`);
        }, 15000);
        heartbeat.unref();
      }
      failurePhase = 'queue';
      const release = await slots.take(controller.signal);
      try {
        controller.signal.throwIfAborted();
        failurePhase = 'upstream';
        const selectedPool = poolFor(request.model);
        const pooled = selectedPool ? await selectedPool.infer(request, { signal: controller.signal, reasoningEffort,
          onText: request.stream ? text => projector.push(text) : undefined,
          onThinking: request.stream ? text => {
            firstClientThinkingMs ??= Date.now() - startedAt;
            emit({ reasoning_content: text });
          } : undefined,
          validateDecision: request.stream ? decision => projector.validate(decision) : undefined,
          prepareDecisionRetry:request.stream?()=>projector.resetUncommitted():undefined,
          onStatus: request.stream ? status : undefined,
        }) : null;
        const direct=pooled?null:await recoverDecision({request,prompt:conversationPrompt(request),
          retries:config.decisionRetries,signal:controller.signal,
          prepareRetry:request.stream?()=>projector.resetUncommitted():undefined,
          validateDecision:request.stream?decision=>projector.validate(decision):undefined,
          invoke:async prompt=>infer({...requestConfig(request.model),...(reasoningEffort?{reasoning:reasoningEffort}:{})},prompt,undefined,
            request.stream?text=>projector.push(text):()=>{})});
        decisionRecovery=pooled?.recovery??direct?.recovery;
        const turn=pooled?pooled.report:{...direct!.turn,decision_recovery:direct!.recovery};
        failureTurn = turn;
        const decisionError=pooled?.decisionError??direct?.decisionError;
        upstreamFailure=turn.error?publicUpstreamFailure(turn.sdk_errors,turn.api_error_categories,turn.sdk_error_code):null;
        failurePhase = turn.error ? 'upstream' : 'decision';
        const failure = turn.error || decisionError ? bridgeFailure({ requestId: bridgeRequestId,
          phase: failurePhase, accepted: true, turn, recovery: decisionRecovery, abort: abortKind }) : null;
        taskTurn = { ...turn, first_client_text_ms: firstClientTextMs,
          first_client_thinking_ms: firstClientThinkingMs, stream_chunks: streamChunks,upstream_failure:upstreamFailure, failure };
        const turnPhase = failurePhase;
        failurePhase = 'reporting';
        await appendReport(reports.bridge, { ...turn, bridge_request_id: bridgeRequestId,
          upstream_failure:upstreamFailure, failure,
          bridge_port: bridgePort,
          harness_message_count: request.messages.length, harness_tool_count: request.tools?.length ?? 0 });
        failurePhase = turnPhase;
        if (turn.error) throw new Error(`Qoder inference failed at ${turn.stage}: ${turn.error}`);
        if (decisionError) throw new Error(decisionError);
        const decision = pooled?.decision ?? direct?.decision ?? parseDecision(turn.response, request);
        if (request.stream) projector.validate(decision);
        failurePhase = 'delivery';
        const answer = completion(request, decision,pooled?.completionId);
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
      const failure = bridgeFailure({ requestId: bridgeRequestId, phase: failurePhase, accepted: requestAccepted,
        cause, abort: abortKind, turn: failureTurn, recovery: decisionRecovery });
      taskTurn = { ...taskTurn, failure };
      await recordFailure(failure);
      await writeTaskLog(undefined, failure.message);
      process.stderr.write(`[bridge] ${failure.code} request=${bridgeRequestId}: ${message}\n`);
      const error = { ...failure,
        ...(decisionRecovery?{decision_recovery:{...recoverySummary(decisionRecovery),
          // Validation errors can contain arbitrary rejected names/arguments or upstream payloads.
          // Full evidence remains local; the client needs only counts, outcome and correlation hashes.
          failures:decisionRecovery.evidence.filter(row=>row.validationError).map(row=>({
            attempt:row.attempt,stage:row.stage,responseSha256:row.responseSha256}))}}:{}) };
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
