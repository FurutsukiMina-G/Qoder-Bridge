import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { startup, type Query, type SDKUserMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { baseOptions, isolateSession, type Config } from './client.js';
import { InputQueue } from './queue.js';
import { selectModel } from './model.js';
import { Telemetry, safeError } from './telemetry.js';
import { type ChatRequest, type Decision, type DecisionRepair, conversationPrompt, parseDecision, toolDefinitions } from './compat.js';
import { hasConversationPrefix, routeConversation } from './routing.js';
import { abortable } from './async.js';
import { prefixCacheEstimate, withCachedTokens, ZERO_USAGE, type OpenAIUsage } from './usage.js';

export type InferHooks = { signal?: AbortSignal; onText?: (text: string) => void;
  onThinking?: (text: string) => void; validateDecision?: (decision: Decision) => void };

type Warm = Awaited<ReturnType<typeof startup>>;
type RecordSession = {
  id: string; warm: Warm; q: Query; queue: InputQueue<SDKUserMessage>; controller: AbortController;
  messages: ChatRequest['messages']; touched: number; locked: Promise<void>;
  lastCredits: number | null; model: string; busy: number; toolSignature: string | null;
  retryHint: string | null; retryMessageHash: string | null;
  closed: boolean; lastSuccessHash: string | null; lastDecision: Decision | null; sdkSessionId: string | null;
  policyCalls: Array<{ purpose: string; model: string; context_window: number | null; reasoning_effort: string | null }>;
  /** Prompt tokens of this Qoder session's latest completed model request: the next request's exact prefix. */
  lastPromptTokens: number | null;
};
const MAX_SESSIONS = 8;
const IDLE_MS = 60 * 60_000;
const SWEEP_MS = 60_000;
export class QoderPool {
  private sessions = new Map<string, RecordSession>();
  private byToolId = new Map<string, string>();
  private byClientSession = new Map<string, string>();
  private nextWarm: Promise<RecordSession> | null = null;
  private openingByClient = new Map<string, Promise<RecordSession>>();
  private prewarmError: string | null = null;
  // Idle SDK runtimes are otherwise released only when another session is opened.
  private sweeper = setInterval(() => this.sweepIdle(), SWEEP_MS);
  constructor(readonly config: Config) {
    this.sweeper.unref();
    if (config.sessionIdleMs !== undefined && (!Number.isSafeInteger(config.sessionIdleMs) || config.sessionIdleMs < 60_000)) {
      clearInterval(this.sweeper);
      throw new Error('sessionIdleMs must be an integer >=60000');
    }
  }
  private primeNext(): Promise<RecordSession> {
    if (this.nextWarm) return this.nextWarm;
    const pending = this.open();
    this.nextWarm = pending;
    void pending.then(() => { this.prewarmError = null; }, error => {
      if (this.nextWarm === pending) this.nextWarm = null;
      this.prewarmError = safeError(error);
      process.stderr.write(`[bridge] Prewarm failed: ${this.prewarmError}\n`);
    });
    return pending;
  }
  prewarm() { return this.primeNext().then(() => {}); }
  private async open(): Promise<RecordSession> {
    await mkdir('.runtime', { recursive: true });
    const controller = new AbortController();
    const queue = new InputQueue<SDKUserMessage>();
    let warm: Warm | undefined;
    const policyCalls: RecordSession['policyCalls'] = [];
    try {
      const options = baseOptions(this.config, controller);
      options.resolveModel = context => {
        const selected = selectModel(context.availableModels, this.config);
        policyCalls.push({ purpose: context.purpose, model: selected.model,
          context_window: selected.parameters?.contextWindow ?? null,
          reasoning_effort: selected.parameters?.reasoningEffort ?? null });
        return selected;
      };
      warm = await startup({ options, initializeTimeoutMs: this.config.timeout });
      const q = warm.query(queue);
      const isolation = await isolateSession(q);
      if (isolation.error || isolation.remaining_plugins.length || isolation.context_skills.count)
        throw new Error(`Thin session isolation failed: ${isolation.error ?? 'plugin or skill remained active'}`);
      const selected = selectModel(await q.getAvailableModels(), this.config);
      return { id: randomUUID(), warm, q, queue, controller, messages: [],
        touched: Date.now(), locked: Promise.resolve(), lastCredits: null, model: selected.model, busy: 0,
        toolSignature: null, retryHint: null, retryMessageHash: null, policyCalls,
        closed: false, lastSuccessHash: null, lastDecision: null, sdkSessionId: null, lastPromptTokens: null };
    } catch (error) { queue.close(); warm?.close(); controller.abort(); throw error; }
  }
  private close(record: RecordSession) {
    if (record.closed) return;
    record.closed = true;
    this.sessions.delete(record.id);
    for (const [id, owner] of this.byToolId) if (owner === record.id) this.byToolId.delete(id);
    for (const [id, owner] of this.byClientSession) if (owner === record.id) this.byClientSession.delete(id);
    record.queue.close(); record.warm.close(); record.controller.abort();
  }
  private sweepIdle() {
    for (const record of this.sessions.values()) if (!record.busy && Date.now() - record.touched > (this.config.sessionIdleMs ?? IDLE_MS)) this.close(record);
    // A failed startup prewarm (e.g. network not ready at logon) retries until the runtime is reachable.
    if (this.prewarmError && !this.nextWarm) void this.primeNext();
  }
  private sweep() {
    this.sweepIdle();
    if (this.sessions.size < MAX_SESSIONS) return;
    const oldest = [...this.sessions.values()].filter(r => !r.busy).sort((a, b) => a.touched - b.touched)[0];
    if (oldest) this.close(oldest);
    else throw new Error('All QoderBridge conversation slots are active');
  }
  private matching(request: ChatRequest): RecordSession | undefined {
    const id = routeConversation(request, this.sessions, this.byClientSession, this.byToolId);
    return id ? this.sessions.get(id) : undefined;
  }
  private async acquire(request: ChatRequest) {
    const existing = this.matching(request);
    if (existing) return { record: existing, reused: true };
    const key = request.prompt_cache_key;
    const opening = key ? this.openingByClient.get(key) : undefined;
    if (opening) return { record: await opening, reused: true };
    const created = this.acquireNew(request);
    if (key) this.openingByClient.set(key, created);
    try { return { record: await created, reused: false }; }
    finally { if (key && this.openingByClient.get(key) === created) this.openingByClient.delete(key); }
  }
  private async acquireNew(request: ChatRequest) {
    this.sweep();
    const pending = this.nextWarm;
    this.nextWarm = null;
    const record = pending ? await pending : await this.open();
    this.sessions.set(record.id, record);
    const key = request.prompt_cache_key;
    if (key) {
      const superseded = this.sessions.get(this.byClientSession.get(key) ?? '');
      this.byClientSession.set(key, record.id);
      // A client key routes only to its newest session, so a replaced branch (rollback, compaction) is unreachable.
      if (superseded && superseded !== record && !superseded.busy) this.close(superseded);
    }
    void this.primeNext();
    return record;
  }
  bindTool(id: string, record: RecordSession) { this.byToolId.set(id, record.id); }
  stats() { return { sessions: this.sessions.size, busy: [...this.sessions.values()].filter(row => row.busy > 0).length,
    opening: this.openingByClient.size, prewarmed: this.nextWarm !== null, prewarm_error: this.prewarmError }; }
  async infer(request: ChatRequest, hooks: InferHooks = {}) {
    const start = performance.now();
    const signal = AbortSignal.any([AbortSignal.timeout(this.config.timeout), ...(hooks.signal ? [hooks.signal] : [])]);
    const { record, reused } = await abortable(this.acquire(request), signal);
    record.busy++;
    let unlock!: () => void;
    const previous = record.locked;
    record.locked = new Promise<void>(resolve => { unlock = resolve; });
    let ownsTurn = false;
    const abort = () => this.close(record);
    try {
      await abortable(previous, signal);
      ownsTurn = true;
      signal.throwIfAborted();
      if (record.closed) throw new Error('Qoder session closed before this queued request');
      const requestHash = createHash('sha256').update(JSON.stringify({ model: request.model,
        messages: request.messages, tools: request.tools, choice: request.tool_choice,
        temperature: request.temperature, max_tokens: request.max_tokens,
        max_completion_tokens: request.max_completion_tokens })).digest('hex');
      if (record.lastSuccessHash === requestHash && record.lastDecision && Date.now() - record.touched < 120_000) {
        hooks.validateDecision?.(record.lastDecision);
        return { record, decision: record.lastDecision, decisionError: null, response: JSON.stringify(record.lastDecision),
          report: { ...new Telemetry().snapshot(), session_id: record.sdkSessionId, model: record.model,
            response: JSON.stringify(record.lastDecision), error: null as string | null, stage: 'local_replay',
            reused_session: true, startup_ms: 0, prompt_chars: 0, available_tool_definition_chars: 0,
            sent_tool_definition_chars: 0, tool_definitions_reused: true, tool_detail_mode: 'reused',
            client_session_key_present: Boolean(request.prompt_cache_key),
            client_session_key_hash: request.prompt_cache_key ? createHash('sha256').update(request.prompt_cache_key).digest('hex').slice(0, 12) : null,
            model_policy_calls: [], history_mode: 'delta', sent_message_count: 0,
            credits_delta: 0, total_session_credits: record.lastCredits, model_requests: 0, local_response_replay: true,
            // No model call ran, so zero is the exact usage of this replay.
            normalized_usage_source: 'local_replay', client_usage: { ...ZERO_USAGE } as OpenAIUsage | null,
            client_cache_usage: 'omitted', cache_estimate_tokens: null as number | null,
            cache_estimate_ratio: null as number | null } };
      }
      const prefix = reused && hasConversationPrefix(record.messages, request.messages);
      const delta = prefix ? request.messages.slice(record.messages.length) : request.messages;
      const toolSignature = JSON.stringify(request.tools ?? []);
      const omitUnchangedTools = reused && record.toolSignature === toolSignature;
      if (record.retryMessageHash !== requestHash) { record.retryHint = null; record.retryMessageHash = null; }
      const prompt = `${record.retryHint ? `${record.retryHint}\n` : ''}${conversationPrompt({ ...request, messages: delta }, {
        omitUnchangedTools, historyMode: prefix ? 'delta' : 'full',
      })}`;
      const telemetry = new Telemetry();
      const policyStart = record.policyCalls.length;
      let inferenceError: string | null = null;
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        record.queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
        while (true) {
          const step = await abortable(record.q.next(), signal);
          if (step.done) throw new Error('Qoder stream closed');
          telemetry.observe(step.value, hooks.onText, hooks.onThinking);
          if (step.value.type === 'result') break;
        }
        if (telemetry.result?.subtype !== 'success' || telemetry.result.is_error)
          throw new Error(`Qoder result: ${telemetry.result?.subtype ?? 'missing'}`);
      } catch (error) {
        inferenceError = safeError(error);
        this.close(record);
      }
      record.touched = Date.now();
      const turnPolicies = record.policyCalls.slice(policyStart);
      const windows = new Set(turnPolicies.map(call => call.context_window));
      const report = telemetry.snapshot(windows.size === 1 ? [...windows][0]! : null);
      const measured = report.normalized_usage_source === 'qoder_context_ratio+stream_token_deltas' ? report.normalized_usage : null;
      const cacheEstimate = measured ? prefixCacheEstimate(measured.prompt_tokens, record.lastPromptTokens) : null;
      const clientUsage = measured && cacheEstimate !== null && this.config.cacheUsage === 'estimate'
        ? withCachedTokens(measured, cacheEstimate) : report.normalized_usage;
      // The Qoder session appends every completed request, including one whose decision is later rejected.
      if (!inferenceError) record.lastPromptTokens = report.normalized_usage?.prompt_tokens ?? null;
      record.sdkSessionId = report.session_id ?? record.sdkSessionId;
      const deltaCredits = report.total_session_credits === null ? report.credits :
        report.total_session_credits - (record.lastCredits ?? 0);
      if (report.total_session_credits !== null) record.lastCredits = report.total_session_credits;
      else if (report.credits !== null) record.lastCredits = (record.lastCredits ?? 0) + report.credits;
      let decision: ReturnType<typeof parseDecision> | null = null;
      let decisionError: string | null = null;
      const decisionRepairs: DecisionRepair[] = [];
      if (!inferenceError) try {
        decision = parseDecision(telemetry.text, request, repair => decisionRepairs.push(repair));
        hooks.validateDecision?.(decision);
      } catch (error) { decisionError = safeError(error); decision = null; }
      if (decision) {
        record.messages = request.messages;
        record.toolSignature = toolSignature;
        record.retryHint = null;
        record.retryMessageHash = null;
        record.lastSuccessHash = requestHash;
        record.lastDecision = decision;
      } else if (!inferenceError) {
        record.retryHint = `The preceding model decision was rejected: ${decisionError?.slice(0, 180)}. ` +
          'Retry the same Harness request with a valid final answer or tool call. Every call needs a name and arguments; do not assume any tool ran.' +
          (/(?:^|\.)name:|Unknown or unselected tool name/.test(decisionError ?? '')
            ? ` Allowed tool names: ${(request.tools ?? []).map(tool => tool.function.name).join(', ').slice(0, 350)}.` : '');
        record.retryMessageHash = requestHash;
      }
      return { record, decision, decisionError, response: telemetry.text, report: { ...report, response: telemetry.text,
        error: inferenceError, stage: signal.aborted ? 'cancelled_or_timeout' : 'inference', model: record.model, reused_session: reused,
        startup_ms: reused ? 0 : performance.now() - start - report.wall_ms,
        prompt_chars: prompt.length, available_tool_definition_chars: toolSignature.length,
        sent_tool_definition_chars: omitUnchangedTools ? 0 : JSON.stringify(toolDefinitions(request)).length,
        tool_detail_mode: omitUnchangedTools ? 'reused' : 'compact',
        tool_definitions_reused: omitUnchangedTools,
        client_session_key_present: Boolean(request.prompt_cache_key),
        client_session_key_hash: request.prompt_cache_key ?
          createHash('sha256').update(request.prompt_cache_key).digest('hex').slice(0, 12) : null,
        model_policy_calls: turnPolicies, decision_repairs: decisionRepairs,
        history_mode: prefix ? 'delta' : 'full', sent_message_count: delta.length,
        credits_delta: deltaCredits, credits_delta_source: report.total_session_credits !== null ? 'cumulative_delta' : report.request_credits_source,
        local_response_replay: false, client_usage: clientUsage, cache_estimate_tokens: cacheEstimate,
        cache_estimate_ratio: cacheEstimate !== null && measured && measured.prompt_tokens > 0
          ? cacheEstimate / measured.prompt_tokens : null,
        client_cache_usage: clientUsage?.prompt_tokens_details ? (measured ? 'session_prefix_estimate' : 'reported') : 'omitted' } };
    } finally {
      signal.removeEventListener('abort', abort);
      record.busy--;
      if (ownsTurn) unlock(); else void previous.then(unlock, unlock);
    }
  }
  closeAll() {
    clearInterval(this.sweeper);
    for (const record of this.sessions.values()) this.close(record);
    this.nextWarm?.then(record => this.close(record)).catch(() => {});
    this.nextWarm = null;
  }
}
