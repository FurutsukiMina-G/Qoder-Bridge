import {usageAccounting,sumUsageAccounting,type OpenAIUsage,type UsageAccounting} from './usage.js';
export type RequestAccounting = {telemetry?: {credits_delta?:number|null;model_requests?:number|null;
  model_requests_known?:number|null;
  usage?:OpenAIUsage|null;usage_source?:string;usage_accounting?:UsageAccounting|null;
  local_response_replay?:boolean;decision_recovery?:{knownCreditsSubtotal?:number;correctionCalls?:number;outcome?:string;knownModelRequestsSubtotal?:number}|null}};
const callCount=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
export function knownRequestModelCalls(row:RequestAccounting){
  const t=row.telemetry;
  return callCount(t?.model_requests)?t.model_requests:callCount(t?.model_requests_known)?t.model_requests_known:
    callCount(t?.decision_recovery?.knownModelRequestsSubtotal)?t.decision_recovery.knownModelRequestsSubtotal:0;
}
/** A partial unknown aggregate still has a known subtotal; never count that subtotal twice. */
export function knownRequestCredits(row:RequestAccounting) {
  const value=row.telemetry?.credits_delta;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  const partial=row.telemetry?.decision_recovery?.knownCreditsSubtotal;
  return typeof partial==='number'&&Number.isFinite(partial)?partial:0;
}
export function requestAccounting(rows:RequestAccounting[]) {
  return {bridgeRequests:rows.length,
    upstreamModelRequestsKnown:rows.reduce((n,row)=>n+knownRequestModelCalls(row),0),
    upstreamModelRequestCountUnknown:rows.filter(row=>!row.telemetry?.local_response_replay&&!callCount(row.telemetry?.model_requests)).length,
    correctionCalls:rows.reduce((n,row)=>n+(row.telemetry?.decision_recovery?.correctionCalls??0),0),
    recoveredRequests:rows.filter(row=>row.telemetry?.decision_recovery?.outcome==='recovered').length,
    knownCredits:rows.reduce((n,row)=>n+knownRequestCredits(row),0),
    unknownCreditRequests:rows.filter(row=>typeof row.telemetry?.credits_delta!=='number').length};
}
export function requestTokenAccounting(rows:RequestAccounting[]){
  const parts=rows.filter(row=>!row.telemetry?.local_response_replay).map(row=>
    row.telemetry?.usage_accounting??usageAccounting([{usage:row.telemetry?.usage,source:row.telemetry?.usage_source}]));
  const sum=sumUsageAccounting(parts);
  return{promptTokens:sum.prompt_tokens,completionTokens:sum.completion_tokens,reasoningTokens:sum.reasoning_tokens,
    knownPromptTokens:sum.known_prompt_tokens,knownCompletionTokens:sum.known_completion_tokens,knownReasoningTokens:sum.known_reasoning_tokens,
    unknownPromptRequests:parts.filter(p=>p.prompt_tokens===null).length,unknownCompletionRequests:parts.filter(p=>p.completion_tokens===null).length,
    unknownReasoningRequests:parts.filter(p=>p.reasoning_tokens===null).length,sources:sum.sources};
}
