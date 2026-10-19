import test from 'node:test';
import assert from 'node:assert/strict';
import {requestAccounting} from '../src/request-metrics.js';
test('request accounting distinguishes HTTP requests, correction calls and partial unknown billing',()=>{
  const report=requestAccounting([
    {telemetry:{credits_delta:0.3,model_requests:2,decision_recovery:{knownCreditsSubtotal:0.3,correctionCalls:1,outcome:'recovered'}}},
    {telemetry:{credits_delta:null,model_requests:null,decision_recovery:{knownCreditsSubtotal:0.1,correctionCalls:1,outcome:'upstream_failure'}}},
    {telemetry:{credits_delta:0,model_requests:0,local_response_replay:true}},
    {telemetry:{credits_delta:0.2}},
  ]);
  assert.equal(report.bridgeRequests,4);assert.equal(report.upstreamModelRequestsKnown,2);
  assert.equal(report.upstreamModelRequestCountUnknown,2);assert.equal(report.knownCredits,0.6000000000000001);
  assert.equal(report.unknownCreditRequests,1);assert.equal(report.correctionCalls,2);assert.equal(report.recoveredRequests,1);
});
