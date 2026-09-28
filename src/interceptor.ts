import { createSdkMcpServer, tool, type CanUseTool, type HookCallback } from '@qodercn-ai/qodercn-agent-sdk';
import { z } from 'zod';

export type Strategy = 'permission' | 'hook' | 'defer';
export class Interceptor {
  calls: Array<{ name: string; arguments: unknown; tool_use_id: string; source: string }> = [];
  handlerInvocations = 0;
  preToolCalls = 0;
  interruptErrors: string[] = [];
  constructor(readonly strategy: Strategy) {}
  capture(name: string, args: unknown, id: string, source: string) {
    if (!this.calls.some(c => c.tool_use_id === id)) this.calls.push({ name, arguments: args, tool_use_id: id, source });
  }
  readonly canUseTool: CanUseTool = async (name, input, ctx) => {
    this.capture(name, input, ctx.toolUseID, 'canUseTool');
    return { behavior: 'deny', message: 'Tool execution delegated to host harness.', toolUseID: ctx.toolUseID, interrupt: true };
  };
  readonly beforeTool: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    this.preToolCalls++;
    if (this.strategy === 'permission') return {};
    this.capture(input.tool_name, input.tool_input, input.tool_use_id, 'PreToolUse');
    if (this.strategy === 'defer') return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' },
    };
    return { continue: false, stopReason: 'Tool execution delegated to host harness.',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Host owns tools.' } };
  };
  server() {
    return createSdkMcpServer({ name: 'bridge', tools: [tool('read_file',
      'Request file contents from the external host harness.', { path: z.string() }, async () => {
        // Sentinel only: NEVER touch the filesystem. Reaching this handler fails the gate.
        this.handlerInvocations++;
        return { isError: true, content: [{ type: 'text', text: 'INTERCEPTION_FAILED: sentinel handler reached; no file was read.' }] };
      })] });
  }
}

export function evaluateGate(interceptor: Interceptor, data: {
  expectedPath: string; requests: number | null; policyCalls: number; retries: number;
  completed: boolean; credits: number | null; timedOut: boolean; error?: string;
}) {
  const call = interceptor.calls[0];
  const args = call?.arguments as { path?: unknown } | undefined;
  const checks = {
    captured: interceptor.calls.length === 1 && call?.name === 'mcp__bridge__read_file',
    arguments_complete: args?.path === data.expectedPath,
    handler_not_executed: interceptor.handlerInvocations === 0,
    one_model_request: data.requests === 1 && data.policyCalls === 1 && data.retries === 0,
    terminal_observed: data.completed && !data.timedOut && !data.error,
    request_credits_available: data.credits !== null,
  };
  const { request_credits_available: _metering, ...behavior } = checks;
  return { checks, behavior_passed: Object.values(behavior).every(Boolean), interception_passed: Object.values(checks).every(Boolean),
    extra_model_request: data.requests === null ? null : data.requests > 1 || data.policyCalls > 1 || data.retries > 0,
    // A stopped turn alone cannot prove native tool-result replay or clean history.
    session_continuation: 'not_tested', session_history_clean: 'not_verified', phase2_ready: false };
}
