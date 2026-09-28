import { mkdir, readFile } from 'node:fs/promises';
import { startup, type SDKUserMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { baseOptions, type Config } from '../src/client.js';
import { InputQueue } from '../src/queue.js';
import { safeError } from '../src/telemetry.js';

async function main() {
  await mkdir('.runtime', { recursive: true });
  const controller = new AbortController();
  const queue = new InputQueue<SDKUserMessage>();
  const config: Config = { auth: 'auto', timeout: 90000, strategy: 'permission', system: 'Usage inspection only.',
    sessionSettings: await readFile('config/thin-cn.json', 'utf8') };
  let warm: Awaited<ReturnType<typeof startup>> | undefined;
  try {
    warm = await startup({ options: baseOptions(config, controller), initializeTimeoutMs: 90000 });
    const q = warm.query(queue);
    await q.initializationResult();
    const usage = await q.getUsageInfo();
    if (!usage) {
      console.log(JSON.stringify({ available: false,
        reason: 'Qoder SDK did not return an account quota snapshot; remaining Credits are unknown',
        desktopRequired: false,
        fallback: 'Run npm.cmd run qoder:tui, then enter /usage in the official Qoder CN CLI' }, null, 2));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ available: true, userType: usage.userType ?? null,
      userQuota: usage.userQuota ?? null, addOnQuota: usage.addOnQuota ?? null,
      orgResourcePackage: usage.orgResourcePackage ?? null,
      totalUsagePercentage: usage.totalUsagePercentage ?? null,
      isQuotaExceeded: usage.isQuotaExceeded ?? null,
      note: 'session Credits are intentionally omitted: a fresh inspection session is not account balance' }, null, 2));
  } finally { queue.close(); warm?.close(); controller.abort(); }
}
main().catch(error => { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; });
