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
import {recoverDecision,decisionRetryLimit,decisionCorrectionPrompt,type RecoveryTrace} from './decision-recovery.js';
import { cacheFromCredits, sharedTierCalendar } from './billing.js';

export type InferHooks = { signal?: AbortSignal; onText?: (text: string) => void;
  onThinking?: (text: string) => void; validateDecision?: (decision: Decision) => void;
  prepareDecisionRetry?: () => boolean;
  /** Bridge status during upstream silence (SDK API retries); not model output. */
  onStatus?: (text: string) => void;
  /** Client-picked effort the model offers; overrides the configured default for this request. */
  reasoningEffort?: string };

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
  lastFailedDecision: {hash:string;response:string;error:string;recovery:RecoveryTrace} | null;
  lastCompletionId: string | null;
  /** Read by resolveModel before each upstream call; set only for a single bridge-initiated retry. */
  policy: { reasoning: string | null };
};
/** Bridge-initiated retries (format corrections, reasoning-guard retries) step down from max effort. */
const RETRY_REASONING = 'high';
export const DEFAULT_REASONING_GUARD_TOKENS = 24_000;
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
  private recoveredRequests = 0;
  private exhaustedRequests = 0;
  private reasoningGuardTrips = 0;
  // Idle SDK runtimes are otherwise released only when another session is opened.
  private sweeper = setInterval(() => this.sweepIdle(), SWEEP_MS);
  constructor(readonly config: Config) {
    this.sweeper.unref();
    try { decisionRetryLimit(config.decisionRetries); }
    catch(error) { clearInterval(this.sweeper); throw error; }
    if (config.sessionIdleMs !== undefined && (!Number.isSafeInteger(config.sessionIdleMs) || config.sessionIdleMs < 60_000)) {
      clearInterval(this.sweeper);
      throw new Error('sessionIdleMs must be an integer >=60000');
    }
    const guard = config.reasoningGuardTokens;
    if (guard !== undefined && (!Number.isSafeInteger(guard) || (guard !== 0 && guard < 1024))) {
      clearInterval(this.sweeper);
      throw new Error('reasoningGuardTokens must be 0 (disabled) or an integer >=1024');
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
    const policy: RecordSession['policy'] = { reasoning: null };
    try {
      const options = baseOptions(this.config, controller);
      options.resolveModel = context => {
        const selected = selectModel(context.availableModels,
          policy.reasoning ? { ...this.config, reasoning: policy.reasoning } : this.config);
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
        closed: false, lastSuccessHash: null, lastDecision: null, sdkSessionId: null, lastPromptTokens: null,
        lastFailedDecision:null,lastCompletionId:null, policy };
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
    opening: this.openingByClient.size, prewarmed: this.nextWarm !== null, prewarm_error: this.prewarmError,
    decision_recovery:{max_correction_calls:decisionRetryLimit(this.config.decisionRetries),
      recovered_requests:this.recoveredRequests,exhausted_requests:this.exhaustedRequests},
    reasoning_guard:{max_reasoning_tokens:this.guardTokens(),trips:this.reasoningGuardTrips},
    billing_calendar_overrides:sharedTierCalendar.learnedDates() }; }
  private guardTokens() { return this.config.reasoningGuardTokens ?? DEFAULT_REASONING_GUARD_TOKENS; }
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
        max_completion_tokens: request.max_completion_tokens, reasoning: hooks.reasoningEffort ?? null })).digest('hex');
      // An exhausted identical request must not restart another paid retry loop
      // just because an HTTP client retries the same body. A changed request
      // (including an explicit new user message) can start a new decision.
      if(record.lastFailedDecision?.hash===requestHash){
        const failed=record.lastFailedDecision;
        const localRecovery={...failed.recovery,correctionCalls:0,attempts:0,evidence:[],knownCreditsSubtotal:0,unknownCreditAttempts:0};
        return {record,decision:null,decisionError:failed.error,response:failed.response,completionId:undefined,
          recovery:localRecovery,report:{...new Telemetry().snapshot(),response:failed.response,
            error:null as string|null,stage:'local_rejected_replay',model:record.model,
            session_id:record.sdkSessionId,reused_session:true,startup_ms:0,prompt_chars:0,
            available_tool_definition_chars:0,sent_tool_definition_chars:0,tool_definitions_reused:true,
            tool_detail_mode:'reused',history_mode:'delta',sent_message_count:0,model_policy_calls:[],
            client_session_key_present:Boolean(request.prompt_cache_key),client_session_key_hash:request.prompt_cache_key?createHash('sha256').update(request.prompt_cache_key).digest('hex').slice(0,12):null,
            credits_delta:0,total_session_credits:record.lastCredits,model_requests:0,
            local_response_replay:true,normalized_usage_source:'local_replay',client_usage:{...ZERO_USAGE} as OpenAIUsage|null,
            client_cache_usage:'omitted',cache_estimate_tokens:null as number|null,cache_estimate_ratio:null as number|null,
            decision_recovery:localRecovery,
          }};
      }
      record.lastFailedDecision=null;
      if (record.lastSuccessHash === requestHash && record.lastDecision && Date.now() - record.touched < 120_000) {
        hooks.validateDecision?.(record.lastDecision);
        return { record, decision: record.lastDecision, decisionError: null, response: JSON.stringify(record.lastDecision),
          completionId:record.lastCompletionId??undefined,
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
      signal.addEventListener('abort', abort, { once: true });
      const attemptReports:Array<Record<string,unknown>>=[];
      const recovered=await recoverDecision({request,prompt,retries:this.config.decisionRetries,signal,
        prepareRetry:hooks.prepareDecisionRetry,validateDecision:hooks.validateDecision,
        invoke:async(attemptPrompt,attempt,correctionSchemaCharacters)=>{
          const telemetry = new Telemetry();
          const policyStart = record.policyCalls.length;
          const attemptAt = new Date();
          let inferenceError: string | null = null;
          const guard = this.guardTokens();
          let guardTripped = false;
          // Corrections and guard retries need a valid next step, not another maximal deliberation.
          const chosen = hooks.reasoningEffort ?? this.config.reasoning;
          const reasoning = attempt > 0 && chosen === 'max' ? RETRY_REASONING : hooks.reasoningEffort ?? null;
          const policy = record.policy ??= { reasoning: null };
          policy.reasoning = reasoning;
          const onThinking = (text: string) => {
            hooks.onThinking?.(text);
            // Long reasoning with no output is the max_tokens/error_max_turns failure mode; stop it early.
            if (guard && !guardTripped && telemetry.textDeltaCount === 0 && telemetry.thinkingDeltaCount >= guard) {
              guardTripped = true; this.reasoningGuardTrips++;
              void record.q.interrupt().catch(() => {});
            }
          };
          try {
            signal.throwIfAborted();
            record.queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: attemptPrompt } });
            while (true) {
              const step = await abortable(record.q.next(), signal);
              if (step.done) throw new Error('Qoder stream closed');
              telemetry.observe(step.value, hooks.onText, onThinking, hooks.onStatus);
              if (step.value.type === 'result') break;
            }
            const failed = telemetry.result?.subtype !== 'success' || telemetry.result.is_error;
            // An interrupted runaway turn leaves the SDK session usable; the recovery loop owns the retry.
            if (failed && !guardTripped) throw new Error(`Qoder result: ${telemetry.result?.subtype ?? 'missing'}`);
          } catch (error) {
            inferenceError = safeError(error);
            this.close(record);
          } finally { policy.reasoning = null; }
          const reasoningGuardStopped = guardTripped && !inferenceError &&
            (telemetry.result?.subtype !== 'success' || telemetry.result.is_error);
          record.touched = Date.now();
          const turnPolicies = record.policyCalls.slice(policyStart);
          const windows = new Set(turnPolicies.map(call => call.context_window));
          const report = telemetry.snapshot(windows.size === 1 ? [...windows][0]! : null);
          const measured = report.normalized_usage_source === 'qoder_context_ratio+stream_token_deltas' ? report.normalized_usage : null;
          const previousPrompt = record.lastPromptTokens;
          const cacheEstimate = measured ? prefixCacheEstimate(measured.prompt_tokens, previousPrompt) : null;
          record.sdkSessionId = report.session_id ?? record.sdkSessionId;
          // A cumulative total below the last one (seen after interrupted turns) cannot be differenced.
          const total = report.total_session_credits;
          const regressed = total !== null && record.lastCredits !== null && total < record.lastCredits;
          const deltaCredits = regressed ? null : total === null ? report.credits : total - (record.lastCredits ?? 0);
          if (total !== null && !regressed) record.lastCredits = total;
          else if (total === null && report.credits !== null) record.lastCredits = (record.lastCredits ?? 0) + report.credits;
          const billedCredits = report.stream_original_credits ?? deltaCredits;
          const billing = measured && typeof billedCredits === 'number' && report.stream_billable !== false
            ? cacheFromCredits({ model: record.model, promptTokens: measured.prompt_tokens,
              outputTokens: measured.completion_tokens, credits: billedCredits, at: attemptAt, prefixHint: previousPrompt }) : null;
          const cacheMode = this.config.cacheUsage ?? 'none';
          const clientCached = cacheMode === 'billing' ? billing?.cachedTokens ?? cacheEstimate
            : cacheMode === 'estimate' ? cacheEstimate : null;
          const clientUsage = measured && clientCached !== null ? withCachedTokens(measured, clientCached) : report.normalized_usage;
          // The Qoder session appends every completed request, including one whose decision is later rejected.
          if (!inferenceError && measured) record.lastPromptTokens = measured.prompt_tokens;
          else if (!inferenceError && !reasoningGuardStopped) record.lastPromptTokens = report.normalized_usage?.prompt_tokens ?? null;
          const attemptReport={...report,response:telemetry.text,error:inferenceError,
            stage:signal.aborted?'cancelled_or_timeout':reasoningGuardStopped?'reasoning_guard':'inference',
            requested_reasoning:reasoning??this.config.reasoning??null,
            reasoning_guard:guardTripped?{limit:guard,reasoning_tokens:telemetry.thinkingDeltaCount,stopped:reasoningGuardStopped}:null,
            reasoning_guard_stopped:reasoningGuardStopped,
            streamed_output_tokens:telemetry.textDeltaCount+telemetry.thinkingDeltaCount,
            streamed_reasoning_tokens:telemetry.thinkingDeltaCount,
            cache_billing:billing,billing_tier:billing?.tier??null,
            model:record.model,reused_session:attempt>0||reused,
            startup_ms:attempt>0||reused?0:performance.now()-start-report.wall_ms,
            prompt_chars:attemptPrompt.length,available_tool_definition_chars:toolSignature.length,
            sent_tool_definition_chars:attempt>0?correctionSchemaCharacters:omitUnchangedTools?0:JSON.stringify(toolDefinitions(request)).length,
            tool_detail_mode:attempt>0?'correction_subset':omitUnchangedTools?'reused':'compact',tool_definitions_reused:omitUnchangedTools,
            client_session_key_present:Boolean(request.prompt_cache_key),
            client_session_key_hash:request.prompt_cache_key?createHash('sha256').update(request.prompt_cache_key).digest('hex').slice(0,12):null,
            model_policy_calls:turnPolicies,decision_repairs:[] as DecisionRepair[],
            history_mode:prefix?'delta':'full',sent_message_count:attempt>0?0:delta.length,
            credits_delta:deltaCredits,credits_delta_source:report.total_session_credits!==null?'cumulative_delta':report.request_credits_source,
            local_response_replay:false,client_usage:clientUsage,cache_estimate_tokens:cacheEstimate,
            cache_estimate_ratio:cacheEstimate!==null&&measured&&measured.prompt_tokens>0?cacheEstimate/measured.prompt_tokens:null,
            client_cache_usage:!clientUsage?.prompt_tokens_details?'omitted':!measured?'reported'
              :cacheMode==='billing'&&billing?'credits_inverse':'session_prefix_estimate'};
          attemptReports.push(attemptReport);
          return attemptReport;
      }});
      const {decision,decisionError,recovery}=recovered;
      const turn=recovered.turn;
      if(recovery.outcome==='recovered')this.recoveredRequests++;
      // An identical HTTP retry of these outcomes would repeat the same paid loop; a changed request may continue.
      if(['exhausted','repeated_invalid_decision','reasoning_budget'].includes(recovery.outcome)){
        this.exhaustedRequests++;
        record.lastFailedDecision={hash:requestHash,response:turn.response,error:decisionError!,recovery};
      }
      if (decision) {
        record.messages = request.messages;
        record.toolSignature = toolSignature;
        record.retryHint = null;
        record.retryMessageHash = null;
        record.lastSuccessHash = requestHash;
        record.lastDecision = decision;
        record.lastCompletionId=randomUUID();
      } else if (!turn.error) {
        record.retryHint = `The preceding model decision was rejected. ${decisionCorrectionPrompt(request,decisionError!,turn.response)}`;
        record.retryMessageHash = requestHash;
      }
      return {record,decision,decisionError,response:turn.response,recovery,completionId:record.lastCompletionId??undefined,report:{...turn,reused_session:reused,
        history_mode:prefix?'delta':'full',sent_message_count:delta.length,
        wall_ms:performance.now()-start,
        credits_delta_source:recovery.attempts>1?'sum_of_decision_attempts':turn.credits_delta_source,
        sent_tool_definition_chars:attemptReports.reduce((n,r)=>n+(r.sent_tool_definition_chars as number),0),
        model_policy_calls:attemptReports.flatMap(r=>r.model_policy_calls as unknown[]),
        requests:attemptReports.flatMap(r=>r.requests as unknown[]),
        api_retries:attemptReports.reduce((n,r)=>n+(r.api_retries as number),0),
        api_retry_details:attemptReports.flatMap(r=>r.api_retry_details as unknown[]),
        api_error_categories:attemptReports.flatMap(r=>r.api_error_categories as string[]),
        stream_stop_reasons:[...new Set(attemptReports.flatMap(r=>r.stream_stop_reasons as string[]))],
        sdk_errors:attemptReports.flatMap(r=>r.sdk_errors as string[]),
        model_queue_statuses:attemptReports.flatMap(r=>r.model_queue_statuses as unknown[]),
        stream_usage_snapshots:attemptReports.flatMap(r=>r.stream_usage_snapshots as unknown[]),
        stream_token_counts:attemptReports.flatMap(r=>r.stream_token_counts as unknown[]),
        text_delta_count:attemptReports.reduce((n,r)=>n+(r.text_delta_count as number),0),
        thinking_delta_count:attemptReports.reduce((n,r)=>n+(r.thinking_delta_count as number),0),
        thinking_chars:attemptReports.reduce((n,r)=>n+(r.thinking_chars as number),0),
        ttft_ms:attemptReports[0]!.ttft_ms as number|null,
        first_event_ms:attemptReports[0]!.first_event_ms as number|null,
        decision_recovery:recovery}};
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
