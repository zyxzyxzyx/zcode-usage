/**
 * ZCode 本地数据库只读访问层。
 * 数据源：~/.zcode/cli/db/db.sqlite（WAL 模式，ZCode 运行时并发读安全）。
 * 本服务对业务表只做 SELECT，绝不写入。
 */
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function resolveDbPath(): string {
  return (
    process.env.ZCODE_DB ||
    path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  );
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const p = resolveDbPath();
  if (!fs.existsSync(p)) {
    throw new Error(`未找到 ZCode 数据库：${p}（可通过环境变量 ZCODE_DB 指定路径）`);
  }
  try {
    db = new DatabaseSync(p, { readOnly: true });
  } catch {
    // WAL 需要恢复时只读打开会失败，退回普通打开；本服务自身不写任何业务表
    db = new DatabaseSync(p);
  }
  try {
    db.exec('PRAGMA busy_timeout = 3000');
  } catch {
    /* 忽略 */
  }
  return db;
}

export interface DailyRow {
  d: string; // 本地日期 YYYY-MM-DD
  tok: number; // input + output
  req: number;
}

export interface ModelUsageRow {
  provider: string;
  model: string;
  tok: number;
  req: number;
}

export interface TrendRow extends ModelUsageRow {
  d: string;
}

export interface DetailRow extends TrendRow {
  si: number; // 输入
  so: number; // 输出
  cr: number; // 缓存读
  cw: number; // 缓存写
}

function q<T>(sql: string, ...params: (string | number)[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[];
}

/** 全部已完成请求的逐日汇总（口径：input + output，与 ZCode computed_total 一致） */
export function getDaily(): DailyRow[] {
  return q<DailyRow>(`
    SELECT date(started_at/1000,'unixepoch','localtime') AS d,
           SUM(input_tokens + output_tokens) AS tok,
           COUNT(*) AS req
    FROM model_usage
    WHERE status = 'completed'
    GROUP BY d ORDER BY d
  `);
}

/** 最近 days 天的 逐日 × 供应商 × 模型 汇总 */
export function getTrend(days: number): TrendRow[] {
  const first = new Date(Date.now() - (days - 1) * 86400000);
  const since = localMidnightEpoch(first);
  return q<TrendRow>(
    `
    SELECT date(started_at/1000,'unixepoch','localtime') AS d,
           provider_id AS provider,
           model_id AS model,
           SUM(input_tokens + output_tokens) AS tok,
           COUNT(*) AS req
    FROM model_usage
    WHERE status = 'completed' AND started_at >= ?
    GROUP BY d, provider_id, model_id ORDER BY d
  `,
    since
  );
}

/** 全历史按 供应商 × 模型 汇总（环图） */
export function getModelTotals(): ModelUsageRow[] {
  return q<ModelUsageRow>(`
    SELECT provider_id AS provider,
           model_id AS model,
           SUM(input_tokens + output_tokens) AS tok,
           COUNT(*) AS req
    FROM model_usage
    WHERE status = 'completed'
    GROUP BY provider_id, model_id
    ORDER BY tok DESC
  `);
}

/** 今日按 供应商 × 模型 汇总（模型设置页的"今日余额"） */
export function getTodayByModel(): ModelUsageRow[] {
  return q<ModelUsageRow>(`
    SELECT provider_id AS provider,
           model_id AS model,
           SUM(input_tokens + output_tokens) AS tok,
           COUNT(*) AS req
    FROM model_usage
    WHERE status = 'completed'
      AND date(started_at/1000,'unixepoch','localtime') = date('now','localtime')
    GROUP BY provider_id, model_id
    ORDER BY tok DESC
  `);
}

/** 导出用：逐日 × 供应商 × 模型 的输入/输出/缓存明细 */
export function getDetailSince(days: number): DetailRow[] {
  const since = localMidnightEpoch(new Date(Date.now() - (days - 1) * 86400000));
  return q<DetailRow>(
    `
    SELECT date(started_at/1000,'unixepoch','localtime') AS d,
           provider_id AS provider,
           model_id AS model,
           COUNT(*) AS req,
           SUM(input_tokens) AS si,
           SUM(output_tokens) AS so,
           SUM(cache_read_input_tokens) AS cr,
           SUM(cache_creation_input_tokens) AS cw
    FROM model_usage
    WHERE status = 'completed' AND started_at >= ?
    GROUP BY d, provider_id, model_id ORDER BY d
  `,
    since
  );
}

export interface Overview {
  totalTokens: number;
  totalRequests: number;
  errorRequests: number;
  peakDayTokens: number;
  peakDayDate: string | null;
  maxTurnMs: number;
  currentStreak: number;
  longestStreak: number;
  todayTokens: number;
  firstDay: string | null;
}

export function getOverview(daily: DailyRow[]): Overview {
  const total = q<{ tok: number | null; req: number }>(
    `SELECT SUM(input_tokens + output_tokens) AS tok, COUNT(*) AS req FROM model_usage WHERE status = 'completed'`
  )[0];
  const err = q<{ n: number }>(
    `SELECT COUNT(*) AS n FROM model_usage WHERE status = 'error'`
  )[0];
  const turn = q<{ m: number | null }>(
    `SELECT MAX(duration_ms) AS m FROM turn_usage WHERE completed_at IS NOT NULL`
  )[0];
  const today = q<{ tok: number | null }>(
    `SELECT SUM(input_tokens + output_tokens) AS tok FROM model_usage
     WHERE status = 'completed'
       AND date(started_at/1000,'unixepoch','localtime') = date('now','localtime')`
  )[0];

  const dates = daily.map((r) => r.d);
  const peak = daily.reduce<DailyRow | null>((a, b) => (!a || b.tok > a.tok ? b : a), null);
  const streaks = computeStreaks(dates);

  return {
    totalTokens: total?.tok ?? 0,
    totalRequests: total?.req ?? 0,
    errorRequests: err?.n ?? 0,
    peakDayTokens: peak?.tok ?? 0,
    peakDayDate: peak?.d ?? null,
    maxTurnMs: turn?.m ?? 0,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    todayTokens: today?.tok ?? 0,
    firstDay: dates[0] ?? null,
  };
}

function localMidnightEpoch(d: Date): number {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return new Date(`${y}-${m}-${day}T00:00:00`).getTime();
}

export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 连续活跃天数：当天无用量则从昨天起算 */
function computeStreaks(dates: string[]): { current: number; longest: number } {
  const set = new Set(dates);
  let longest = 0;
  let run = 0;
  let prev = 0;
  for (const d of [...set].sort()) {
    const t = Date.parse(`${d}T00:00:00`);
    run = prev && t - prev === 86400000 ? run + 1 : 1;
    prev = t;
    if (run > longest) longest = run;
  }
  let cursor = new Date();
  if (!set.has(localDateStr(cursor))) cursor = new Date(Date.now() - 86400000);
  let current = 0;
  while (set.has(localDateStr(cursor))) {
    current++;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return { current, longest };
}
