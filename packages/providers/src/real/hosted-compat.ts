/**
 * Free-tier hosts that speak the OpenAI Chat Completions shape, each as its
 * own provider so the router can rotate between them and fall back when one
 * hits its daily limit.
 *
 *   Cerebras    CEREBRAS_API_KEY        CEREBRAS_MODEL
 *   Mistral     MISTRAL_API_KEY         MISTRAL_MODEL
 *   NVIDIA NIM  NVIDIA_API_KEY          NVIDIA_MODEL
 *   Cloudflare  CLOUDFLARE_API_TOKEN    CLOUDFLARE_MODEL    CLOUDFLARE_ACCOUNT_ID
 *
 * Base URLs are the vendors' documented ones and are built in — unlike the
 * generic adapter, guessing is not a risk here because the host is the point.
 * Model ids are still never defaulted: they age, and free plans differ by
 * account. The operator names the model.
 */

import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai-compatible.ts';
import type { ProviderId } from '@acc/domain';

export interface HostPreset {
  id: ProviderId;
  label: string;
  keyVariable: string;
  modelVariable: string;
  baseUrlVariable: string;
  baseUrl: string | null;
}

export const CEREBRAS_PRESET: HostPreset = {
  id: 'cerebras',
  label: 'Cerebras',
  keyVariable: 'CEREBRAS_API_KEY',
  modelVariable: 'CEREBRAS_MODEL',
  baseUrlVariable: 'CEREBRAS_API_BASE_URL',
  baseUrl: 'https://api.cerebras.ai/v1',
};

export const MISTRAL_PRESET: HostPreset = {
  id: 'mistral',
  label: 'Mistral',
  keyVariable: 'MISTRAL_API_KEY',
  modelVariable: 'MISTRAL_MODEL',
  baseUrlVariable: 'MISTRAL_API_BASE_URL',
  baseUrl: 'https://api.mistral.ai/v1',
};

export const NVIDIA_PRESET: HostPreset = {
  id: 'nvidia',
  label: 'NVIDIA NIM',
  keyVariable: 'NVIDIA_API_KEY',
  modelVariable: 'NVIDIA_MODEL',
  baseUrlVariable: 'NVIDIA_API_BASE_URL',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
};

/** Cloudflare's URL contains the account id, so it is built from CLOUDFLARE_ACCOUNT_ID. */
export const CLOUDFLARE_PRESET: HostPreset = {
  id: 'cloudflare',
  label: 'Cloudflare Workers AI',
  keyVariable: 'CLOUDFLARE_API_TOKEN',
  modelVariable: 'CLOUDFLARE_MODEL',
  baseUrlVariable: 'CLOUDFLARE_ACCOUNT_ID',
  baseUrl: null,
};

export interface HostedCompatOptions extends OpenAICompatibleOptions {
  /** Cloudflare only. */
  accountId?: string | undefined;
}

export class HostedCompatProvider extends OpenAICompatibleProvider {
  override readonly id: ProviderId;
  override readonly keyVariable: string;
  override readonly modelVariable: string;
  protected override readonly baseUrlVariable: string;

  constructor(preset: HostPreset, options: HostedCompatOptions = {}) {
    const account = options.accountId?.trim() ?? '';
    const builtIn = preset.baseUrl ?? (account !== '' ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1` : '');
    const override = options.baseUrl?.trim() ?? '';
    super({ ...options, baseUrl: override !== '' ? override : builtIn, label: preset.label });
    this.id = preset.id;
    this.keyVariable = preset.keyVariable;
    this.modelVariable = preset.modelVariable;
    this.baseUrlVariable = preset.baseUrlVariable;
  }
}

export const createCerebras = (o?: HostedCompatOptions): HostedCompatProvider => new HostedCompatProvider(CEREBRAS_PRESET, o);
export const createMistral = (o?: HostedCompatOptions): HostedCompatProvider => new HostedCompatProvider(MISTRAL_PRESET, o);
export const createCloudflare = (o?: HostedCompatOptions): HostedCompatProvider => new HostedCompatProvider(CLOUDFLARE_PRESET, o);
export const createNvidia = (o?: HostedCompatOptions): HostedCompatProvider => new HostedCompatProvider(NVIDIA_PRESET, o);
