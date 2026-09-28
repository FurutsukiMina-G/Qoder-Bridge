import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const runtime = join(dirname(require.resolve('@qodercn-ai/qodercn-agent-sdk')), '_worker', 'qoder-worker-runtime.obf.mjs');
const child = spawn(process.execPath, [runtime, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
