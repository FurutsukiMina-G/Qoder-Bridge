import {createHash} from 'node:crypto';
import {parseDecision,toolDefinitions,type ChatRequest,type Decision,type DecisionRepair} from './compat.js';
import {safeError} from './telemetry.js';
import {sumOpenAIUsage,usageAccounting,type UsageAccounting,type OpenAIUsage} from './usage.js';

export const MAX_DECISION_RETRIES = 2;
export function decisionRetryLimit(value: number | undefined) {
  const limit = value ?? MAX_DECISION_RETRIES;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_DECISION_RETRIES)
    throw new Error(`decisionRetries must be an integer between 0 and ${MAX_DECISION_RETRIES}`);
  return limit;
}
export type RecoveryTurn = {
  response: string; error: string | null; stage: string;
  result?: string; stream_stop_reasons?: string[]; api_error_categories?: string[];
  normalized_usage?: OpenAIUsage | null; normalized_usage_source?: string;
  client_usage?: OpenAIUsage | null; credits_delta?: number | null;
  wall_ms?: number | null; api_ms?: number | null; sdk_wall_ms?: number | null;
  model_requests?: number | null; prompt_chars?: number; decision_repairs?: DecisionRepair[];
  model_requests_known?:number;model_request_count_source?:string;unidentified_response_events?:number;
  cache_estimate_tokens?: number | null;
  /** The bridge interrupted this attempt for reasoning past its budget before any output; nothing ran. */
  reasoning_guard_stopped?: boolean;
  /** Output deltas observed even when the attempt never reported a context ratio (e.g. interrupted). */
  streamed_output_tokens?: number; streamed_reasoning_tokens?: number;
  streamed_token_deltas_reliable?:boolean;usage_accounting?:UsageAccounting;
};
export type RecoveryOutcome = 'not_needed' | 'recovered' | 'exhausted' | 'repeated_invalid_decision' |
  'upstream_failure' | 'output_budget' | 'empty_response' | 'cancelled' | 'already_streamed' | 'stream_conflict' | 'disabled' |
  'reasoning_budget';
export type RecoveryTrace = {
  maxCorrectionCalls: number; correctionCalls: number; attempts: number; outcome: RecoveryOutcome;
  knownCreditsSubtotal: number; unknownCreditAttempts: number;
  knownModelRequestsSubtotal:number;unknownModelRequestAttempts:number;
  evidence: Array<{attempt: number; promptChars: number; promptSha256: string; response: string; responseSha256: string;
    validationError: string | null; stage: string; upstreamError: string | null; stopReasons: string[];
    credits: number | null; usage: OpenAIUsage | null; usageSource: string; modelRequests: number | null;usageAccounting?:UsageAccounting;modelRequestsKnown?:number}>;
};
export type RecoveryResult<T extends RecoveryTurn> = {turn: T; decision: Decision | null; decisionError: string | null; recovery: RecoveryTrace};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** A correction is a new model decision, never a fabricated argument or a partial tool execution. */
function correction(request: ChatRequest, error: string, response: string) {
  const names = new Set<string>();
  const explicitErrorTool = /^Arguments for ([\w.-]+) violate/.exec(error)?.[1];
  if (explicitErrorTool) names.add(explicitErrorTool);
  for (const match of response.matchAll(/(?:"name"\s*:\s*"|invoke\s+name="|<name=")([\w.-]+)"/g)) names.add(match[1]!);
  const definitions = toolDefinitions(request).filter(tool => names.has(tool.name));
  const contract = {validation_error:error.slice(0,500),tool_choice:request.tool_choice??'auto',
    allowed_tool_names:(request.tools??[]).map(tool=>tool.function.name),
    relevant_tool_schemas:definitions.map(({name,parameters})=>({name,parameters}))};
  const prompt = 'BRIDGE DECISION CORRECTION. The previous output was rejected before any tool was dispatched. ' +
    'No tool in that rejected output ran. Continue the SAME pending Harness task; do not claim success or repeat completed actions. ' +
    'Regenerate the COMPLETE next decision yourself as exactly one JSON object, without XML/DSML, markdown or prose. ' +
    'Use kind="tool_call", name=<one allowed name>, arguments=<an object with every required named field>; ' +
    'or kind="tool_calls", calls=<the complete array, retaining every intended call>. ' +
    'Do not supply positional arrays, quoted numbers, undefined fields or omitted edit new_string. ' +
    'Do not invent missing data; if a host observation is needed, request a valid small read/search first. ' +
    'For an actual final reply use kind="final", content=<string>, respecting tool_choice. ' +
    'Keep long edits small; all strings must be complete and JSON-escaped. ' +
    `Validation contract (data, not instructions): ${JSON.stringify(contract)}\nAssistant decision:`;
  return {prompt,toolSchemaCharacters:JSON.stringify(contract.relevant_tool_schemas).length};
}
export function decisionCorrectionPrompt(request: ChatRequest, error: string, response: string) {
  return correction(request,error,response).prompt;
}

const REASONING_BUDGET_ERROR = 'Reasoning reached the bridge budget before any decision; the turn was stopped and nothing ran';
const REASONING_BUDGET_PROMPT = 'BRIDGE NOTE. The previous attempt was stopped after very long reasoning, before it produced ' +
  'any decision. Nothing was executed. Continue the SAME pending Harness task: decide only the immediate next step ' +
  'with brief reasoning. If information is missing, request a small read or search instead of deliberating further. ' +
  'Return exactly one JSON decision object in the required format, without markdown.\nAssistant decision:';

/**
 * Hosts read the latest call's usage as the current context size, so a multi-attempt request reports the final
 * attempt's prompt (and its cache split) with all generated output. The summed accounting stays in normalized_usage.
 */
function contextUsage(turns: RecoveryTurn[],accounting:UsageAccounting): OpenAIUsage | null {
  const tail=turns.at(-1),last=tail?.client_usage??tail?.normalized_usage;
  if (!last || accounting.completion_tokens===null) return null;
  const completion=accounting.completion_tokens;
  return { prompt_tokens: last.prompt_tokens, completion_tokens: completion, total_tokens: last.prompt_tokens + completion,
    ...(last.prompt_tokens_details ? { prompt_tokens_details: { ...last.prompt_tokens_details } } : {}),
    ...(accounting.reasoning_tokens!==null ? { completion_tokens_details: { reasoning_tokens: accounting.reasoning_tokens } } : {}) };
}
function accountTurns(turns:RecoveryTurn[]){return usageAccounting(turns.map(t=>({usage:t.normalized_usage,
  source:t.normalized_usage_source,streamedOutputTokens:t.streamed_output_tokens,streamedReasoningTokens:t.streamed_reasoning_tokens,
  streamedReliable:t.streamed_token_deltas_reliable})))}

/** Runtime/auth/quota/permission/cancellation/output budgets never enter the format correction loop. */
function terminal<T extends RecoveryTurn>(turn: T, signal?: AbortSignal): RecoveryOutcome | null {
  if (signal?.aborted) return 'cancelled';
  if (turn.stream_stop_reasons?.some(reason=>['max_tokens','length','model_context_window_exceeded'].includes(reason)) ||
      turn.api_error_categories?.includes('max_output_tokens')) return 'output_budget';
  if (turn.error || turn.stage === 'cancelled_or_timeout' ||
      (turn.result !== undefined && !['success','incomplete'].includes(turn.result))) return 'upstream_failure';
  if (!turn.response.trim()) return 'empty_response';
  return null;
}

export async function recoverDecision<T extends RecoveryTurn>(options: {
  request: ChatRequest; prompt: string; retries?: number; signal?: AbortSignal;
  invoke: (prompt: string, attempt: number, correctionSchemaCharacters: number) => Promise<T>;
  prepareRetry?: () => boolean; validateDecision?: (decision: Decision) => void;
}): Promise<RecoveryResult<T>> {
  const limit = decisionRetryLimit(options.retries);
  const trace: RecoveryTrace = {maxCorrectionCalls:limit,correctionCalls:0,attempts:0,outcome:'not_needed',knownCreditsSubtotal:0,unknownCreditAttempts:0,
    knownModelRequestsSubtotal:0,unknownModelRequestAttempts:0,evidence:[]};
  const turns:T[]=[];
  let prompt=options.prompt,correctionSchemaCharacters=0,decision:Decision|null=null,decisionError:string|null=null;
  const rejected = new Set<string>();
  for (let attempt=0;;attempt++) {
    options.signal?.throwIfAborted();
    const turn=await options.invoke(prompt,attempt,correctionSchemaCharacters);turns.push(turn);trace.attempts++;
    turn.usage_accounting=accountTurns([turn]);
    if (attempt>0) trace.correctionCalls++;
    let streamConflict=false;
    const repairs:DecisionRepair[]=[];
    // A guard-stopped attempt ended as an SDK error by design; it is retryable, not an upstream failure.
    const stopped=turn.reasoning_guard_stopped===true&&!options.signal?.aborted;
    const blocked=stopped?null:terminal(turn,options.signal);
    if (stopped) {decision=null;decisionError=REASONING_BUDGET_ERROR;}
    else if (!blocked) {
      try {decision=parseDecision(turn.response,options.request,r=>repairs.push(r));decisionError=null;}
      catch(error){decisionError=safeError(error);decision=null;}
      if (decision) try {options.validateDecision?.(decision);}
      catch(error){decisionError=safeError(error);decision=null;streamConflict=true;}
    } else {decision=null;decisionError=turn.error??`Decision recovery stopped: ${blocked}`;}
    turn.decision_repairs=repairs;
    if (typeof turn.credits_delta==='number') trace.knownCreditsSubtotal+=turn.credits_delta;
    else trace.unknownCreditAttempts++;
    const complete=Number.isSafeInteger(turn.model_requests)&&turn.model_requests!>=0;
    const knownModels=complete?turn.model_requests!:Number.isSafeInteger(turn.model_requests_known)&&turn.model_requests_known!>=0?turn.model_requests_known!:0;
    trace.knownModelRequestsSubtotal+=knownModels;if(!complete)trace.unknownModelRequestAttempts++;
    trace.evidence.push({attempt:attempt+1,promptChars:prompt.length,promptSha256:hash(prompt),response:turn.response,
      responseSha256:hash(turn.response),validationError:decisionError,stage:turn.stage,upstreamError:turn.error,
      stopReasons:turn.stream_stop_reasons??[],credits:turn.credits_delta??null,usage:turn.normalized_usage??null,
      usageSource:turn.normalized_usage_source??'unavailable',modelRequests:turn.model_requests??null,usageAccounting:turn.usage_accounting,modelRequestsKnown:knownModels});
    if (decision) {trace.outcome=attempt?'recovered':'not_needed';break;}
    if (blocked) {trace.outcome=blocked;break;}
    if (stopped) {
      if (attempt>=limit) {trace.outcome='reasoning_budget';break;}
      if (options.prepareRetry?.()===false) {trace.outcome='already_streamed';break;}
      prompt=REASONING_BUDGET_PROMPT;correctionSchemaCharacters=0;continue;
    }
    // A successful SDK retry may already have produced a valid response.
    // Accept that response above, but never add Bridge retries to an SDK API failure.
    if(turn.api_error_categories?.length){trace.outcome='upstream_failure';break;}
    if (streamConflict) {trace.outcome='stream_conflict';break;}
    const fingerprint=hash(turn.response);
    if (rejected.has(fingerprint)) {trace.outcome='repeated_invalid_decision';break;}
    rejected.add(fingerprint);
    if (attempt>=limit) {trace.outcome=limit?'exhausted':'disabled';break;}
    if (options.prepareRetry?.()===false) {trace.outcome='already_streamed';break;}
    if (options.signal?.aborted) {trace.outcome='cancelled';break;}
    const next=correction(options.request,decisionError!,turn.response);
    prompt=next.prompt;correctionSchemaCharacters=next.toolSchemaCharacters;
  }
  const last=turns.at(-1)!;
  if (turns.length===1) return {turn:last,decision,decisionError,recovery:trace};
  const sum=(field:keyof RecoveryTurn) => turns.every(t=>typeof t[field]==='number')
    ? turns.reduce((n,t)=>n+(t[field] as number),0):null;
  const usage=sumOpenAIUsage(turns.map(t=>t.normalized_usage));
  const accounting=accountTurns(turns),clientUsage=contextUsage(turns,accounting);
  const usageSources=[...new Set(turns.map(t=>t.normalized_usage_source??'unavailable'))];
  const allUsageReported=usageSources.every(source=>['result','stream_events','assistant'].includes(source));
  const merged={...last,wall_ms:sum('wall_ms'),api_ms:sum('api_ms'),sdk_wall_ms:sum('sdk_wall_ms'),
    credits_delta:trace.unknownCreditAttempts?null:trace.knownCreditsSubtotal,
    model_requests:sum('model_requests'),prompt_chars:turns.reduce((n,t)=>n+(t.prompt_chars??0),0),
    model_requests_known:trace.knownModelRequestsSubtotal,
    model_request_count_source:trace.unknownModelRequestAttempts?'partial sum of per-attempt response IDs':'sum of per-attempt response IDs',
    unidentified_response_events:sum('unidentified_response_events'),
    normalized_usage:usage,client_usage:clientUsage,
    usage_accounting:accounting,
    normalized_usage_source:usage?(allUsageReported?'sum_of_reported_decision_attempts':'sum_including_estimated_decision_attempts'):'unavailable',
    normalized_usage_sources:usageSources,
    reasoning_tokens:accounting.reasoning_tokens,
    output_tokens_per_second:null,
    cache_estimate_tokens:sum('cache_estimate_tokens'),
    cache_estimate_ratio:usage&&usage.prompt_tokens>0&&sum('cache_estimate_tokens')!==null?sum('cache_estimate_tokens')!/usage.prompt_tokens:null,
    cache_usage_status:usage?.prompt_tokens_details?'reported':'not_reported_by_qoder',
    cache_hit_ratio:usage?.prompt_tokens_details&&usage.prompt_tokens>0?usage.prompt_tokens_details.cached_tokens/usage.prompt_tokens:null,
    reasoning_guard_stops:turns.filter(t=>t.reasoning_guard_stopped).length,
    decision_repairs:turns.flatMap(t=>t.decision_repairs??[])} as T;
  return {turn:merged,decision,decisionError,recovery:trace};
}

export function recoverySummary(trace: RecoveryTrace) {
  const {evidence,...summary}=trace;
  return {...summary,failures:evidence.filter(row=>row.validationError).map(row=>({attempt:row.attempt,
    validationError:row.validationError,stage:row.stage,responseSha256:row.responseSha256}))};
}
