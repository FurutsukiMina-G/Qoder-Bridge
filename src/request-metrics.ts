export type RequestAccounting = {telemetry?: {credits_delta?:number|null;model_requests?:number|null;
  local_response_replay?:boolean;decision_recovery?:{knownCreditsSubtotal?:number;correctionCalls?:number;outcome?:string}|null}};
/** A partial unknown aggregate still has a known subtotal; never count that subtotal twice. */
export function knownRequestCredits(row:RequestAccounting) {
  const value=row.telemetry?.credits_delta;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  const partial=row.telemetry?.decision_recovery?.knownCreditsSubtotal;
  return typeof partial==='number'&&Number.isFinite(partial)?partial:0;
}
export function requestAccounting(rows:RequestAccounting[]) {
  const counted=rows.filter(row=>typeof row.telemetry?.model_requests==='number');
  return {bridgeRequests:rows.length,
    upstreamModelRequestsKnown:counted.reduce((n,row)=>n+row.telemetry!.model_requests!,0),
    upstreamModelRequestCountUnknown:rows.filter(row=>!row.telemetry?.local_response_replay&&typeof row.telemetry?.model_requests!=='number').length,
    correctionCalls:rows.reduce((n,row)=>n+(row.telemetry?.decision_recovery?.correctionCalls??0),0),
    recoveredRequests:rows.filter(row=>row.telemetry?.decision_recovery?.outcome==='recovered').length,
    knownCredits:rows.reduce((n,row)=>n+knownRequestCredits(row),0),
    unknownCreditRequests:rows.filter(row=>typeof row.telemetry?.credits_delta!=='number').length};
}
