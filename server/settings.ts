/**
 * 仪表盘自身设置（额度/价格/供应商别名），存于项目 data/settings.json。
 * 与 ZCode 的配置完全隔离，只读对方、只写自己。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'data', 'settings.json');

export interface ModelPrice {
  in: number; // 元 / 百万输入 tokens
  out: number; // 元 / 百万输出 tokens
}

export interface PublishConfig {
  enabled: boolean; // 定时把快照推送到 GitCode Pages
  intervalMin: number; // 推送间隔（分钟）
}

export interface ScheduledQuota {
  value: number; // 元/日额度 tokens
  effectiveFrom: string; // 生效日期（本地时区），YYYY-MM-DD，当日 00:00 起生效
}

export interface Settings {
  /** 单模型额度（每日重置），键：`providerId|modelId` */
  quotas: Record<string, number>;
  /** 供应商级总额度（每日重置，全模型共享），键：`providerId` */
  providerQuotas: Record<string, number>;
  /** 未来生效的供应商总额度变更；到达 effectiveFrom 后由服务端自动应用 */
  providerQuotasScheduled?: Record<string, ScheduledQuota>;
  /** 单价，键：`providerId|modelId` */
  prices: Record<string, ModelPrice>;
  /** 供应商显示名覆盖 */
  providerAliases: Record<string, string>;  /** 供应商"连接方式"标签覆盖（用量侧发现的云端供应商拿不到协议类型） */
  connectionLabels: Record<string, string>;
  /** GitCode Pages 自动发布 */
  publish: PublishConfig;
}

const DEFAULTS: Settings = {
  quotas: {
    'builtin:zai-start-plan|GLM-5.3': 3000000,
    'builtin:zai-start-plan|GLM-5.3-Flash': 5000000,
  },
  providerQuotas: {
    // 火山方舟网关：每日额度 8000 万 tokens（全模型共享）
    'c528fecb-c921-43e8-bcb2-60732eba12cd': 80000000,
  },
  prices: {},
  providerAliases: {
    // 火山方舟网关的自定义供应商在 model_usage 里以 UUID 出现，这里给个可读名字
    'c528fecb-c921-43e8-bcb2-60732eba12cd': '火山方舟 Ark',
  },
  connectionLabels: {
    // 同上：该供应商协议未知，设置页"连接方式"处显示这个标签
    'c528fecb-c921-43e8-bcb2-60732eba12cd': '火山方舟网关',
  },
  publish: { enabled: true, intervalMin: 1 },
};

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      quotas: { ...DEFAULTS.quotas, ...(raw.quotas ?? {}) },
      providerQuotas: { ...DEFAULTS.providerQuotas, ...(raw.providerQuotas ?? {}) },
      providerQuotasScheduled: {
        ...DEFAULTS.providerQuotasScheduled,
        ...(raw.providerQuotasScheduled ?? {}),
      },
      prices: { ...DEFAULTS.prices, ...(raw.prices ?? {}) },
      providerAliases: { ...DEFAULTS.providerAliases, ...(raw.providerAliases ?? {}) },
      connectionLabels: { ...DEFAULTS.connectionLabels, ...(raw.connectionLabels ?? {}) },
      publish: { ...DEFAULTS.publish, ...(raw.publish ?? {}) },
    };
  } catch {
    const s = structuredClone(DEFAULTS);
    saveSettings(s);
    return s;
  }
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 应用已到生效日期的额度变更，返回解析后的供应商额度表（不改原始配置）。
 *  日期为本地时区，effectiveFrom 当日 00:00 起生效。 */
export function resolveProviderQuotas(s: Settings, todayStr: string): Record<string, number> {
  const resolved = { ...s.providerQuotas };
  for (const [pid, sched] of Object.entries(s.providerQuotasScheduled ?? {})) {
    if (todayStr >= sched.effectiveFrom) resolved[pid] = sched.value;
  }
  return resolved;
}

export function normalizeSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Settings>;
  const out: Settings = {
    quotas: {},
    providerQuotas: {},
    providerQuotasScheduled: {},
    prices: {},
    providerAliases: {},
    connectionLabels: {},
    publish: { enabled: true, intervalMin: 1 },
  };
  for (const [k, v] of Object.entries(raw.quotas ?? {})) {
    const n = Number(v);
    if (typeof k === 'string' && k.includes('|') && Number.isFinite(n) && n >= 0) {
      out.quotas[k] = Math.round(n);
    }
  }
  for (const [k, v] of Object.entries(raw.providerQuotas ?? {})) {
    const n = Number(v);
    if (typeof k === 'string' && Number.isFinite(n) && n >= 0) {
      out.providerQuotas[k] = Math.round(n);
    }
  }
  for (const [k, v] of Object.entries(raw.providerQuotasScheduled ?? {})) {
    const n = Number((v as Partial<ScheduledQuota>)?.value);
    const d = (v as Partial<ScheduledQuota>)?.effectiveFrom;
    if (
      typeof k === 'string' &&
      Number.isFinite(n) &&
      n >= 0 &&
      typeof d === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(d)
    ) {
      out.providerQuotasScheduled![k] = { value: Math.round(n), effectiveFrom: d };
    }
  }
  const pRaw = (raw.publish ?? {}) as Partial<PublishConfig>;
  out.publish = {
    enabled: typeof pRaw.enabled === 'boolean' ? pRaw.enabled : true,
    intervalMin: Math.min(60, Math.max(1, Math.round(Number(pRaw.intervalMin) || 5))),
  };
  for (const [k, v] of Object.entries(raw.prices ?? {})) {
    const p = v as Partial<ModelPrice>;
    const i = Number(p?.in);
    const o = Number(p?.out);
    if (typeof k === 'string' && k.includes('|') && Number.isFinite(i) && Number.isFinite(o)) {
      out.prices[k] = { in: Math.max(0, i), out: Math.max(0, o) };
    }
  }
  for (const [k, v] of Object.entries(raw.providerAliases ?? {})) {
    if (typeof k === 'string' && typeof v === 'string' && v.trim()) {
      out.providerAliases[k] = v.trim().slice(0, 50);
    }
  }
  for (const [k, v] of Object.entries(raw.connectionLabels ?? {})) {
    if (typeof k === 'string' && typeof v === 'string' && v.trim()) {
      out.connectionLabels[k] = v.trim().slice(0, 30);
    }
  }
  return out;
}
