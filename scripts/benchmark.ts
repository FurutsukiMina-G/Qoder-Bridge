import { parseArgs } from 'node:util';
import { runProbe, type Config } from '../src/client.js';
import { appendReport } from '../src/telemetry.js';
const { values } = parseArgs({ options: {
  run: { type: 'boolean', default: false }, model: { type: 'string' },
  limit: { type: 'string', default: '35' }, log: { type: 'string', default: 'reports/benchmark.ndjson' },
} });
const cases = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `short-${i + 1}`, category: 'short', prompt: `Compute ${23 + i} * ${17 + i}. Return only the integer.` })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `reasoning-${i + 1}`, category: 'reasoning', prompt: `Count the integers from 1 to ${1000 + i * 137} divisible by 3 or 5 but not 7. Explain using inclusion-exclusion and give an exact answer.` })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `long-${i + 1}`, category: 'long', prompt: `Write a detailed 1500-word tutorial on ${['database transactions', 'event loops', 'distributed locks', 'HTTP caching', 'type systems'][i]}. Include examples and failure cases. Do not use tools.` })),
];
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 35) throw new Error('--limit must be 1..35');
if (!values.run) console.log(JSON.stringify({ note: 'Dry run. Add --run to consume Qoder Credits. Each case uses a fresh session; startup and inference are measured separately.', cases: cases.slice(0, limit) }, null, 2));
else {
  const config: Config = { auth: 'auto', model: values.model, timeout: 300000, strategy: 'permission', system: 'Answer the user directly. Do not use tools.' };
  for (const item of cases.slice(0, limit)) {
    const report = await runProbe(config, item.prompt);
    await appendReport(values.log!, { ...report, benchmark_case: item.id, category: item.category });
    console.log(JSON.stringify({ case: item.id, credits: report.credits, wall_ms: report.wall_ms, error: report.error }));
    if (report.error) { process.exitCode = 1; break; }
  }
}
