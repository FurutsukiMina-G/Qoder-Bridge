#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { discover, runProbe, type Config } from './client.js';
import { appendReport, safeError } from './telemetry.js';
import { actionPrompt, parseAction, type Action } from './action.js';
import { createBridgeServer } from './server.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    model: { type: 'string' }, reasoning: { type: 'string' }, context: { type: 'string' },
    auth: { type: 'string', default: 'auto' }, timeout: { type: 'string', default: '120000' },
    'cli-path': { type: 'string' }, proxy: { type: 'string' }, 'system-file': { type: 'string' },
    'session-settings': { type: 'string' },
    strategy: { type: 'string', default: 'permission' }, path: { type: 'string', default: 'src/main.ts' },
    json: { type: 'boolean', default: false }, log: { type: 'string', default: 'reports/telemetry.ndjson' },
    help: { type: 'boolean', short: 'h' },
    port: { type: 'string', default: '8646' },
    'cache-usage': { type: 'string', default: process.env.QODERBRIDGE_CACHE_USAGE ?? 'billing' },
    'decision-retries': { type: 'string', default: '2' },
    'reasoning-guard-tokens': { type: 'string', default: process.env.QODERBRIDGE_REASONING_GUARD_TOKENS ?? '24000' },
  } });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(`QoderBridge CN — Phase 0 / Phase 1 experiments
  npm run dev -- models
  npm run probe -- "Reply with OK" [--model ID] [--json]
  npm run action -- "Read src/main.ts" [--json]
  npm run serve -- --port 8646
  npm run gate -- [--path src/main.ts] [--strategy permission|hook|defer]
Options: --auth auto|cli|pat --timeout MS --cli-path PATH --proxy URL
         --reasoning LEVEL --context TOKENS --system-file FILE --log FILE
         --session-settings FILE (explicit session-only settings JSON)
         --decision-retries 0|1|2 (serve; bounded model correction before tools are dispatched)
         --cache-usage billing|estimate|none (serve; env QODERBRIDGE_CACHE_USAGE; default billing).
           Qoder reports no cache counts; billing derives cached_tokens from each request's billed
           Credits (prefix estimate as fallback), estimate always sends the session-prefix estimate
         --reasoning-guard-tokens N (serve; default 24000, 0 disables). Stop a turn whose reasoning
           reaches N tokens before any output and retry it once at lower effort
Uses QODERCN_PERSONAL_ACCESS_TOKEN when set, otherwise official CLI login.
Gate tools are inert sentinels; no user file is read or command executed.
Exit codes: 0 success; 1 runtime/auth/config failure; 2 interception gate failed.
Native tool-result replay runs after interception passes; history auditing remains required.`);
    return;
  }
  if (!['models', 'probe', 'gate', 'action', 'serve'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!['auto', 'cli', 'pat'].includes(values.auth!)) throw new Error('Invalid --auth');
  if (!['permission', 'hook', 'defer'].includes(values.strategy!)) throw new Error('Invalid --strategy');
  if (!['none', 'estimate', 'billing'].includes(values['cache-usage']!)) throw new Error('Invalid --cache-usage');
  const reasoningGuardTokens = Number(values['reasoning-guard-tokens']);
  const timeout = Number(values.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('--timeout must be an integer >=1000 ms');
  const context = values.context === undefined ? undefined : Number(values.context);
  if (context !== undefined && (!Number.isSafeInteger(context) || context < 1)) throw new Error('Invalid --context');
  const config: Config = {
    model: values.model, reasoning: values.reasoning, context,
    auth: values.auth as Config['auth'], timeout, cliPath: values['cli-path'] ?? process.env.QODERCNCLI_PATH,
    proxy: values.proxy, strategy: values.strategy as Config['strategy'],
    sessionSettings: values['session-settings'] ? JSON.stringify(JSON.parse(await readFile(values['session-settings'], 'utf8'))) : undefined,
    cacheUsage: values['cache-usage'] as Config['cacheUsage'],
    decisionRetries:Number(values['decision-retries']),
    reasoningGuardTokens,
    system: values['system-file'] ? await readFile(values['system-file'], 'utf8') :
      'Follow the user request directly. The host owns planning and tool execution. Be concise.',
  };
  if (command === 'serve') {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
    config.context ??= 1_000_000;
    config.reasoning ??= 'max';
    await createBridgeServer(config, { port });
    console.log(`QoderBridge listening on http://127.0.0.1:${port}/v1`);
    return;
  }
  if (command === 'models') {
    const report = await discover(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.models.length) process.exitCode = 1;
    return;
  }
  const prompt = command === 'gate' ?
    `Call the read_file tool exactly once with path ${JSON.stringify(values.path)}. Do not answer in text or use another tool.` : args.join(' ');
  if (!prompt.trim()) throw new Error('probe requires a prompt');
  const base = await runProbe(config, command === 'action' ? actionPrompt(prompt) : prompt, command === 'gate' ? values.path : undefined,
    values.json ? () => {} : text => process.stderr.write(text));
  let action: Action | undefined;
  if (command === 'action' && !base.error) {
    try { action = parseAction(base.response); }
    catch (error) { base.error = `Invalid action output: ${safeError(error)}`; }
  }
  const report = { ...base, ...(command === 'action' ? { mode: 'action', protocol: 'minimal-action-v1', action: action ?? null } : {}) };
  await appendReport(values.log!, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.error) process.exitCode = 1;
  else if (report.gate && !report.gate.interception_passed) process.exitCode = 2;
}
main().catch(error => { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; });
