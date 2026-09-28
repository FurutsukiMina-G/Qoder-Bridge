import type { ModelInfo, ModelPolicyResult } from '@qodercn-ai/qodercn-agent-sdk';

/** Runtime IDs verified against the authenticated Qoder CN catalog. Missing IDs fail closed. */
export const BRIDGE_MODELS = [
  { id: 'qoder-deepseek-flash', runtimeId: 'dfmodel', name: 'Qoder DeepSeek Flash', contextWindow: 1_000_000, maxTokens: 32000 },
  { id: 'qoder-deepseek-pro', runtimeId: 'dmodel', name: 'Qoder DeepSeek V4 Pro', contextWindow: 1_000_000, maxTokens: 32000 },
] as const;
export const DEFAULT_PUBLIC_MODEL = BRIDGE_MODELS[0].id;
export const PRO_PUBLIC_MODEL = BRIDGE_MODELS[1].id;
export function bridgeModel(id: string) { return BRIDGE_MODELS.find(model => model.id === id); }

export interface Selection { model?: string; reasoning?: string; context?: number }
export function selectModel(models: ModelInfo[], config: Selection): ModelPolicyResult & { model: string } {
  const enabled = models.filter(m => m.isEnabled !== false);
  const matches = enabled.filter(m => config.model ? m.value === config.model :
    /deepseek/i.test(`${m.value} ${m.displayName}`) && /flash/i.test(`${m.value} ${m.displayName}`));
  if (matches.length !== 1) throw new Error(`Expected one available model, found ${matches.length}. Run models, then use --model <exact ID>. Available: ${enabled.map(m => m.value).join(', ')}`);
  const model = matches[0]!;
  const contexts = Object.values(model.context_config ?? {}).map(c => c.token_count);
  const efforts = Object.keys(model.thinking_config?.enabled?.efforts ?? {});
  if (config.context !== undefined && !contexts.includes(config.context)) throw new Error(`Unsupported context window: ${config.context}`);
  if (config.reasoning && !efforts.includes(config.reasoning) && !(config.reasoning === 'none' && model.thinking_config?.disabled)) throw new Error(`Unsupported reasoning effort: ${config.reasoning}`);
  return { model: model.value, parameters: {
    ...(config.context !== undefined ? { contextWindow: config.context } : {}),
    ...(config.reasoning ? { reasoningEffort: config.reasoning } : {}),
  } };
}
