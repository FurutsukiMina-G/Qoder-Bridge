import { readFile } from 'node:fs/promises';
const port = Number(process.argv[2] ?? '8646');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const origin = `http://127.0.0.1:${port}`;
const health = await fetch(`${origin}/health`);
const key = (await readFile('.runtime/bridge-key', 'utf8')).trim();
const models = await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
const data = models.ok ? await models.json() : null;
const model = data?.data?.some((entry: { id: string }) => entry.id === 'qoder-deepseek-flash') === true;
console.log(JSON.stringify({ port, healthy: health.ok, health: health.ok ? await health.json() : null,
  authenticatedModelListing: models.ok, expectedModelPresent: model }));
if (!health.ok || !models.ok || !model) process.exitCode = 1;
