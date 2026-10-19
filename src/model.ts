import type { ModelInfo, ModelPolicyResult } from '@qodercn-ai/qodercn-agent-sdk';

/** Reasoning efforts the Qoder CN catalog offers per runtime model (Harness levels use the same spelling). */
const FLASH_EFFORTS = ['low', 'high', 'max'] as const;
const PRO_EFFORTS = ['high', 'max'] as const;
export type BridgeModel = { id: string; runtimeId: string; name: string; contextWindow: number; maxTokens: number;
  efforts: readonly string[] };
/**
 * Runtime IDs verified against the authenticated Qoder CN catalog. Missing IDs fail closed. Each context
 * window is its own public model so a Harness model picker can switch it (and its compaction threshold);
 * the original 1M IDs stay first and unchanged for existing sessions.
 */
export const BRIDGE_MODELS: readonly [BridgeModel, BridgeModel, ...BridgeModel[]] = [
  { id: 'qoder-deepseek-flash', runtimeId: 'dfmodel', name: 'Qoder DeepSeek Flash (1M)', contextWindow: 1_000_000, maxTokens: 32000, efforts: FLASH_EFFORTS },
  { id: 'qoder-deepseek-pro', runtimeId: 'dmodel', name: 'Qoder DeepSeek V4 Pro (1M)', contextWindow: 1_000_000, maxTokens: 32000, efforts: PRO_EFFORTS },
  { id: 'qoder-deepseek-flash-400k', runtimeId: 'dfmodel', name: 'Qoder DeepSeek Flash (400K)', contextWindow: 400_000, maxTokens: 32000, efforts: FLASH_EFFORTS },
  { id: 'qoder-deepseek-flash-200k', runtimeId: 'dfmodel', name: 'Qoder DeepSeek Flash (200K)', contextWindow: 200_000, maxTokens: 32000, efforts: FLASH_EFFORTS },
  { id: 'qoder-deepseek-pro-400k', runtimeId: 'dmodel', name: 'Qoder DeepSeek V4 Pro (400K)', contextWindow: 400_000, maxTokens: 32000, efforts: PRO_EFFORTS },
  { id: 'qoder-deepseek-pro-200k', runtimeId: 'dmodel', name: 'Qoder DeepSeek V4 Pro (200K)', contextWindow: 200_000, maxTokens: 32000, efforts: PRO_EFFORTS },
];
export const DEFAULT_PUBLIC_MODEL = BRIDGE_MODELS[0].id;
export const PRO_PUBLIC_MODEL = BRIDGE_MODELS[1].id;
export function bridgeModel(id: string) { return BRIDGE_MODELS.find(model => model.id === id); }
/** A client-selected effort the model offers; anything else falls back to the configured default. */
export function requestedEffort(model: BridgeModel, value: unknown) {
  return typeof value === 'string' && model.efforts.includes(value) ? value : undefined;
}

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
