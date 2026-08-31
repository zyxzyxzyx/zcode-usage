/**
 * 供应商元数据：
 * 1) 读取 ZCode 的 ~/.zcode/v2/config.json（只取名称/启用/模型元数据，绝不读取 apiKey）
 * 2) 合并 model_usage 中出现但配置里没有的供应商（如火山方舟网关的 UUID 供应商）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelUsageRow } from './db.ts';
import type { Settings } from './settings.ts';

export interface ModelMeta {
  id: string;
  name?: string;
  context?: number; // 上下文长度
  output?: number; // 最大输出
  vision: boolean; // 支持图像/视频输入
}

export interface ProviderMeta {
  id: string;
  name: string;
  enabled: boolean;
  kind?: string;
  baseURL?: string;
  builtin: boolean;
  models: ModelMeta[];
}

export function readConfigProviders(): ProviderMeta[] {
  const p = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
  const out: ProviderMeta[] = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [id, v] of Object.entries<Record<string, any>>(cfg.provider ?? {})) {
      out.push({
        id,
        name: v.name ?? id,
        enabled: Boolean(v.enabled),
        kind: v.kind,
        baseURL: v.options?.baseURL,
        builtin: id.startsWith('builtin:'),
        models: Object.entries<Record<string, any>>(v.models ?? {}).map(([mid, m]) => ({
          id: mid,
          name: m.name,
          context: m.limit?.context,
          output: m.limit?.output,
          vision:
            Array.isArray(m.modalities?.input) &&
            (m.modalities.input.includes('image') || m.modalities.input.includes('video')),
        })),
      });
    }
  } catch {
    // 读取失败时不阻塞，仅展示用量侧发现的供应商
  }
  return out;
}

export function buildProviderList(settings: Settings, totals: ModelUsageRow[]): ProviderMeta[] {
  const byId = new Map<string, ProviderMeta>();
  for (const p of readConfigProviders()) byId.set(p.id, p);

  // 用量侧出现但配置缺失的供应商（例如云端下发的网关供应商）
  for (const row of totals) {
    if (!byId.has(row.provider)) {
      byId.set(row.provider, {
        id: row.provider,
        name: settings.providerAliases[row.provider] ?? `自定义供应商 ${row.provider.slice(0, 8)}`,
        enabled: true,
        builtin: false,
        models: [],
      });
    }
  }

  const list = [...byId.values()];
  for (const p of list) {
    // 模型列表：优先配置元数据；没有配置的（用量侧供应商）从用量记录补
    if (p.models.length === 0) {
      p.models = totals
        .filter((r) => r.provider === p.id)
        .map((r) => ({ id: r.model, vision: false }));
    }
    if (settings.providerAliases[p.id]) p.name = settings.providerAliases[p.id];
  }
  // 内置供应商在前，其余按名称
  list.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  return list;
}
