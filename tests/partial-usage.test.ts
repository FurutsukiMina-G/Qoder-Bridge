import test from 'node:test';
import assert from 'node:assert/strict';
import {usageAccounting} from '../src/usage.js';
import {requestTokenAccounting} from '../src/request-metrics.js';
import {recoverDecision,type RecoveryTurn} from '../src/decision-recovery.js';
import {ChatRequest} from '../src/compat.js';
const completed={prompt_tokens:500,completion_tokens:100,total_tokens:600,completion_tokens_details:{reasoning_tokens:80}};
test('a missing guard prompt preserves reliable observed output without fabricating input or counting the retry twice',()=>{
  const ledger=usageAccounting([{usage:null,streamedOutputTokens:24000,streamedReasoningTokens:24000,streamedReliable:true},
    {usage:completed,source:'qoder_context_ratio+stream_token_deltas',streamedOutputTokens:100,streamedReasoningTokens:80,streamedReliable:true}]);
  assert.equal(ledger.prompt_tokens,null);assert.equal(ledger.known_prompt_tokens,500);assert.equal(ledger.unknown_prompt_attempts,1);
  assert.equal(ledger.completion_tokens,24100);assert.equal(ledger.reasoning_tokens,24080);assert.equal(ledger.attempts,2);
  assert.ok(ledger.sources.includes('stream_token_deltas_partial'));
});
test('batched, invalid or unverified stream deltas remain unknown, and no missing reasoning is treated as zero',()=>{
  for(const row of [{streamedOutputTokens:24000,streamedReasoningTokens:24000},
    {streamedOutputTokens:24000,streamedReasoningTokens:24000,streamedReliable:false},
    {streamedOutputTokens:NaN,streamedReasoningTokens:0,streamedReliable:true}]){
    const ledger=usageAccounting([row]);assert.equal(ledger.completion_tokens,null);assert.equal(ledger.reasoning_tokens,null);
  }
  const missing=usageAccounting([{usage:{prompt_tokens:500,completion_tokens:20,total_tokens:520},source:'result'}]);
  assert.equal(missing.reasoning_tokens,null);assert.equal(missing.unknown_reasoning_attempts,1);
  const inconsistent=usageAccounting([{usage:{prompt_tokens:50,completion_tokens:5,total_tokens:55},source:'result',streamedOutputTokens:20,streamedReasoningTokens:10,streamedReliable:true}]);
  assert.equal(inconsistent.completion_tokens,5);assert.equal(inconsistent.reasoning_tokens,null);
  const reasonOnly=usageAccounting([{usage:{prompt_tokens:50,completion_tokens:20,total_tokens:70},source:'result',streamedOutputTokens:20,streamedReasoningTokens:10,streamedReliable:true}]);
  assert.equal(reasonOnly.reasoning_tokens,10);assert.ok(reasonOnly.sources.includes('stream_token_deltas_partial'));
});
test('token reports keep complete totals null and expose subtotals across new partial ledgers and legacy records',()=>{
  const partial=usageAccounting([{streamedOutputTokens:24000,streamedReasoningTokens:24000,streamedReliable:true}]);
  const summary=requestTokenAccounting([{telemetry:{usage_accounting:partial}},{telemetry:{usage:completed,usage_source:'fixture'}},
    {telemetry:{local_response_replay:true,usage:completed}}]);
  assert.equal(summary.promptTokens,null);assert.equal(summary.knownPromptTokens,500);
  assert.equal(summary.completionTokens,24100);assert.equal(summary.reasoningTokens,24080);assert.equal(summary.unknownPromptRequests,1);
});
test('a final attempt with no input measurement must not borrow a previous attempt context',async()=>{
  const request=ChatRequest.parse({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}]});let call=0;
  const result=await recoverDecision({request,prompt:'fixture',invoke:async():Promise<RecoveryTurn>=>++call===1?
    {response:'{',error:null,stage:'inference',normalized_usage:completed,normalized_usage_source:'result'}:
    {response:'',error:null,stage:'reasoning_guard',reasoning_guard_stopped:true,streamed_output_tokens:24000,streamed_reasoning_tokens:24000,streamed_token_deltas_reliable:true},retries:1});
  assert.equal(result.recovery.outcome,'reasoning_budget');assert.equal(result.turn.client_usage,null);
  assert.equal(result.turn.normalized_usage,null);assert.equal(result.turn.usage_accounting?.completion_tokens,24100);
});
