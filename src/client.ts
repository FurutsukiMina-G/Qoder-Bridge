import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { accessTokenFromEnv, qodercliAuth, startup, getSessionMessages, type Options, type SDKUserMessage, type Query } from '@qodercn-ai/qodercn-agent-sdk';
import { selectModel, type Selection } from './model.js';
import { InputQueue } from './queue.js';
import { Interceptor, evaluateGate, type Strategy } from './interceptor.js';
import { Telemetry, safeError } from './telemetry.js';
import { auditHistory } from './history.js';

export interface Config extends Selection {
  auth: 'auto' | 'cli' | 'pat'; timeout: number; cliPath?: string; proxy?: string;
  system: string; strategy: Strategy;
  sessionSettings?: string;
  /**
   * Qoder reports no cache counts. 'billing' (serve default) derives cached_tokens from each request's billed
   * Credits, falling back to the session-prefix estimate; 'estimate' always sends that estimate; 'none' omits it.
   */
  cacheUsage?: 'none' | 'estimate' | 'billing';
  /** Interrupt a turn whose reasoning reaches this many tokens before any output, then retry at lower effort. 0 disables. */
  reasoningGuardTokens?: number;
  /** Retain idle conversation context through human approval waits; bounded by pool capacity. */
  sessionIdleMs?: number;
  /** Regenerate rejected decisions inside one request; never retry runtime/permission/budget failures. */
  decisionRetries?: number;
}
export function baseOptions(config: Config, controller: AbortController): Options {
  return {
    auth: config.auth === 'pat' || (config.auth === 'auto' && process.env.QODERCN_PERSONAL_ACCESS_TOKEN) ? accessTokenFromEnv() : qodercliAuth(),
    cwd: resolve('.runtime'), abortController: controller,
    tools: [], skills: [], settingSources: [], plugins: [], mcpServers: {},
    systemPrompt: config.system, maxTurns: 1, includePartialMessages: true,
    permissionMode: 'default', persistSession: false, promptSuggestions: false,
    strictMcpConfig: true,
    settings: config.sessionSettings,
    stderr: text => process.stderr.write(safeError(text)),
    controlRequestTimeoutMs: Math.min(config.timeout, 30000),
    ...(config.cliPath ? { pathToQoderCLIExecutable: config.cliPath } : {}),
    ...(config.proxy ? { proxy: config.proxy } : {}),
    // SDK env replaces the environment rather than merging it.
    env: { ...process.env, QODERCN_EXPOSE_REQUEST_ID: 'true' },
  };
}

export async function isolateSession(q: Query) {
  const init = await q.initializationResult();
  const plugins = await q.listPlugins();
  const skills = init.skills ?? [];
  let isolationError: string | null = null;
  if (plugins.length || skills.length) {
    try {
    await q.applyFlagSettings({
      enabledPlugins: Object.fromEntries(plugins.map(p => [p.id, false])),
      skillOverrides: Object.fromEntries(skills.map(s => [s.name, 'off' as const])),
    });
    const reloaded = await q.reloadPlugins();
    if (reloaded.error_count) throw new Error(`Plugin isolation reload failed (${reloaded.error_count})`);
    } catch (cause) { isolationError = safeError(cause); }
  }
  const remaining = await q.listPlugins();
  const context = await q.getContextUsage();
  return { initial_plugins: plugins.map(p => p.id), remaining_plugins: remaining.map(p => p.id),
    context_skills: context.skills, error: isolationError, scope: 'session-only applyFlagSettings' };
}

export async function discover(config: Config) {
  await mkdir('.runtime', { recursive: true });
  const controller = new AbortController();
  const queue = new InputQueue<SDKUserMessage>();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  let warm: Awaited<ReturnType<typeof startup>> | undefined;
  try {
    warm = await startup({ options: baseOptions(config, controller), initializeTimeoutMs: config.timeout });
    const q = warm.query(queue);
    const init = await q.initializationResult();
    const models = await q.getAvailableModels();
    return { authenticated: Boolean(init.account?.userId), models, account_present: Object.keys(init.account ?? {}).length > 0 };
  } finally { clearTimeout(timer); queue.close(); warm?.close(); controller.abort(); }
}

export async function runProbe(config: Config, prompt: string, gatePath?: string, onText: (text: string) => void = () => {}) {
  await mkdir('.runtime', { recursive: true });
  const coldStart = performance.now();
  const controller = new AbortController();
  const queue = new InputQueue<SDKUserMessage>();
  const interceptor = gatePath === undefined ? undefined : new Interceptor(config.strategy);
  let telemetry: Telemetry | undefined;
  let selected: ReturnType<typeof selectModel> | undefined;
  let warm: Awaited<ReturnType<typeof startup>> | undefined;
  let q: Query | undefined;
  let error: string | undefined;
  let timedOut = false;
  let startupMs: number | null = null;
  let continuation: Record<string, unknown> | undefined;
  let stage = 'startup';
  let isolation: Awaited<ReturnType<typeof isolateSession>> | null = null;
  let selectedMetadata: unknown = null;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); queue.close(); warm?.close(); }, config.timeout);
  try {
    const options = baseOptions(config, controller);
    options.resolveModel = context => {
      if (!selected || !telemetry) throw new Error('Model request before host submitted a prompt');
      telemetry.policyCalls.push({ purpose: context.purpose, turn_index: context.turnIndex, model: selected.model });
      // Allow one unintended retry to be observed; bound runaway experiments.
      if (telemetry.policyCalls.length > (interceptor ? 2 : 1)) throw new Error('Probe model request limit exceeded');
      return selectModel(context.availableModels, { ...config, model: selected.model });
    };
    if (interceptor) {
      // maxTurns=1 would conceal a failed interrupt. Permit a retry and measure it.
      options.maxTurns = 3;
      options.persistSession = true; // Public transcript reader audits only this experimental session.
      options.mcpServers = { bridge: interceptor.server() };
      options.canUseTool = interceptor.canUseTool;
      options.hooks = { PreToolUse: [{ hooks: [interceptor.beforeTool] }] };
    }
    warm = await startup({ options, initializeTimeoutMs: config.timeout });
    q = warm.query(queue);
    stage = 'session_isolation';
    isolation = await isolateSession(q);
    stage = 'model_discovery';
    const catalog = await q.getAvailableModels();
    selected = selectModel(catalog, config);
    selectedMetadata = catalog.find(m => m.value === selected!.model) ?? null;
    startupMs = performance.now() - coldStart;
    telemetry = new Telemetry();
    stage = 'inference';
    queue.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
    for await (const message of q) {
      telemetry.observe(message, onText);
      if (message.type === 'result') {
        if (interceptor && !continuation) {
          const before = telemetry.snapshot();
          const initial = evaluateGate(interceptor, {
            expectedPath: gatePath!, requests: before.model_requests, policyCalls: before.policy_calls.length,
            retries: before.api_retries, completed: true, credits: before.credits, timedOut,
            error: message.subtype !== 'success' || message.is_error ? message.subtype : undefined,
          });
          if (initial.behavior_passed) {
            const firstTelemetry = telemetry;
            const followup = new Telemetry();
            const nonce = `HOST_RESULT_${randomUUID()}`;
            const call = interceptor.calls[0]!;
            const callsBefore = interceptor.calls.length;
            telemetry = followup;
            stage = 'continuation';
            queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
              { type: 'tool_result', tool_use_id: call.tool_use_id, content: nonce },
              { type: 'text', text: 'Return the exact HOST_RESULT value from the host tool result. Do not call any tools.' },
            ] } });
            // Continue consuming the SAME iterator and process, preserving role/tool IDs.
            try {
              while (true) {
                const next = await q.next();
                if (next.done) break;
                followup.observe(next.value);
                if (next.value.type === 'result') break;
              }
              continuation = {
                response: followup.text,
                status: followup.result?.subtype === 'success' && !followup.result.is_error &&
                  followup.text.trim() === nonce && followup.policyCalls.length === 1 &&
                  followup.session_id === firstTelemetry.session_id &&
                  interceptor.calls.length === callsBefore && interceptor.handlerInvocations === 0 ? 'passed' : 'failed',
                same_session: followup.session_id === firstTelemetry.session_id,
                telemetry: followup.snapshot(),
              };
            } catch (cause) { continuation = { status: 'failed', error: safeError(cause) }; }
            finally { telemetry = firstTelemetry; }
          }
        }
        break;
      }
    }
    if (!telemetry.result) error = 'Stream ended without terminal result';
    else if (telemetry.result.subtype !== 'success') error = telemetry.result.subtype;
    else if (telemetry.result.is_error) error = 'SDK returned is_error';
  } catch (cause) { error = safeError(cause); }
  finally { clearTimeout(timer); queue.close(); warm?.close(); controller.abort(); }
  // Without an explicit policy window the ratio's denominator is unknown, so tokens stay unmeasured.
  const data = (telemetry ?? new Telemetry()).snapshot(selected?.parameters?.contextWindow ?? null);
  let history: ReturnType<typeof auditHistory> | { error: string } | null = null;
  if (interceptor && data.session_id) {
    try {
      history = auditHistory(await getSessionMessages(data.session_id, { dir: resolve('.runtime'), view: 'runtime' }),
        interceptor.calls.map(c => c.tool_use_id));
    } catch (cause) { history = { error: safeError(cause) }; }
  }
  const gate = interceptor ? evaluateGate(interceptor, {
    expectedPath: gatePath!, requests: data.model_requests, policyCalls: data.policy_calls.length,
    retries: data.api_retries, completed: Boolean(telemetry?.result), credits: data.credits, timedOut, error,
  }) : undefined;
  return { ...data, wall_ms: telemetry ? data.wall_ms : null,
    mode: interceptor ? 'gate' : 'thin', timestamp: new Date().toISOString(),
    startup_ms: startupMs, total_wall_ms: performance.now() - coldStart,
    reasoning_effort: selected?.parameters?.reasoningEffort ?? null, context_window: selected?.parameters?.contextWindow ?? null,
    stage, timed_out: timedOut, error: error ?? null, response: telemetry?.text ?? '',
    isolation, model_metadata: selectedMetadata,
    ...(interceptor ? { strategy: config.strategy, captured_calls: interceptor.calls,
      handler_invocations: interceptor.handlerInvocations, pre_tool_calls: interceptor.preToolCalls,
      continuation: continuation ?? null,
      history_audit: history,
      gate: { ...gate!, session_continuation: continuation?.status ?? 'not_tested',
        session_history_clean: history && 'session_history_clean' in history ? history.session_history_clean : 'not_verified' } } : {}),
  };
}
