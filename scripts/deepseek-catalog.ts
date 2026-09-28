import { readFile, writeFile } from 'node:fs/promises';
import { discover } from '../src/client.js';
const catalog = await discover({ auth: 'auto', timeout: 90000, strategy: 'permission', system: 'Model discovery only.',
  sessionSettings: await readFile('config/thin-cn.json', 'utf8') });
const models = catalog.models.filter(model => /deepseek/i.test(`${model.value} ${model.displayName}`)).map(model => ({
  id: model.value, name: model.displayName, enabled: model.isEnabled !== false,
  contextWindows: Object.values(model.context_config ?? {}).map(value => value.token_count),
  reasoningEfforts: Object.keys(model.thinking_config?.enabled?.efforts ?? {}),
  maxOutputTokens: model.maxOutputTokens ?? null,
}));
await writeFile('reports/deepseek-catalog.json', JSON.stringify({ checkedAt: new Date().toISOString(), models }, null, 2));
console.log(JSON.stringify(models, null, 2));
