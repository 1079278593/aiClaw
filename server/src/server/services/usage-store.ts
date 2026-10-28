import { appendFile, readFile, truncate, writeFile } from "node:fs/promises";
import { getPaths } from "../../config/paths.js";
import type { UsageRecord } from "../../llm/types.js";
import type { UsageSummary } from "../protocol.js";

export type AggregatedUsage = UsageSummary;

export interface DailyStat {
  date: string;
  totalTokens: number;
  totalCost: number;
  byModel: Record<string, number>;
  byProvider: Record<string, number>;
  byModelCost: Record<string, number>;
  byProviderCost: Record<string, number>;
}

interface DailyUsage {
  date: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  billingOutputTokens: number;
  thinkingTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  cost: number;
  count: number;
}

const DAILY_RETENTION_DAYS = 30;

// 北京时间 = UTC + 8（无夏令时），统计口径按北京时间分天
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 将任意日期转成北京时间日期字符串（YYYY-MM-DD） */
function toBeijingDateStr(date: Date): string {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 当前北京时间往前推 days 天的日期字符串（YYYY-MM-DD） */
function beijingCutoff(days: number): string {
  const cutoff = new Date(Date.now() + BEIJING_OFFSET_MS);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().slice(0, 10);
}

export async function appendUsageRecord(record: UsageRecord): Promise<void> {
  await appendFile(getPaths().usageTempFile, `${JSON.stringify(record)}\n`, "utf-8");
}

function mergeAggregatedUsage(target: Map<string, AggregatedUsage>, record: UsageSummary): void {
  const key = `${record.provider}::${record.model}`;
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { ...record });
    return;
  }
  existing.inputTokens += record.inputTokens;
  existing.outputTokens += record.outputTokens;
  existing.billingOutputTokens += record.billingOutputTokens;
  existing.thinkingTokens = (existing.thinkingTokens ?? 0) + (record.thinkingTokens ?? 0) || undefined;
  existing.cachedReadTokens = (existing.cachedReadTokens ?? 0) + (record.cachedReadTokens ?? 0) || undefined;
  existing.cachedWriteTokens = (existing.cachedWriteTokens ?? 0) + (record.cachedWriteTokens ?? 0) || undefined;
  existing.cost = Number(((existing.cost ?? 0) + (record.cost ?? 0)).toFixed(6));
}

function addToBucket(map: Map<string, DailyUsage>, bucket: DailyUsage): void {
  const key = `${bucket.date}::${bucket.provider}::${bucket.model}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...bucket, cost: Number((bucket.cost ?? 0).toFixed(6)) });
    return;
  }
  existing.inputTokens += bucket.inputTokens;
  existing.outputTokens += bucket.outputTokens;
  existing.billingOutputTokens += bucket.billingOutputTokens;
  existing.thinkingTokens = (existing.thinkingTokens ?? 0) + (bucket.thinkingTokens ?? 0) || undefined;
  existing.cachedReadTokens = (existing.cachedReadTokens ?? 0) + (bucket.cachedReadTokens ?? 0) || undefined;
  existing.cachedWriteTokens = (existing.cachedWriteTokens ?? 0) + (bucket.cachedWriteTokens ?? 0) || undefined;
  existing.cost = Number((existing.cost + bucket.cost).toFixed(6));
  existing.count += bucket.count;
}

function recordToBucket(record: UsageRecord): DailyUsage {
  return {
    date: toBeijingDateStr(new Date(record.timestamp)),
    provider: record.provider || "unknown",
    model: record.model || "unknown",
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    billingOutputTokens: record.billingOutputTokens ?? record.outputTokens,
    thinkingTokens: record.thinkingTokens,
    cachedReadTokens: record.cachedReadTokens,
    cachedWriteTokens: record.cachedWriteTokens,
    cost: record.cost,
    count: 1,
  };
}

function recordToSummary(record: UsageRecord): UsageSummary {
  return {
    provider: record.provider,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    billingOutputTokens: record.billingOutputTokens ?? record.outputTokens,
    thinkingTokens: record.thinkingTokens,
    cachedReadTokens: record.cachedReadTokens,
    cachedWriteTokens: record.cachedWriteTokens,
    cost: record.cost,
  };
}

async function readTempRecords(): Promise<UsageRecord[]> {
  try {
    const content = await readFile(getPaths().usageTempFile, "utf-8");
    return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as UsageRecord);
  } catch {
    return [];
  }
}

async function readDailyStore(): Promise<Map<string, DailyUsage>> {
  const buckets = new Map<string, DailyUsage>();
  try {
    const stored = JSON.parse(await readFile(getPaths().usageDaily, "utf-8")) as DailyUsage[];
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        // Migrate old fields and ensure defaults for new fields
        const old = entry as unknown as Record<string, unknown>;
        if (typeof old.cachedReadTokens !== "number" && typeof old.cachedTokens === "number") {
          entry.cachedReadTokens = old.cachedTokens as number;
        }
        delete old.cachedTokens;
        entry.cachedReadTokens ??= 0;
        entry.cachedWriteTokens ??= 0;
        entry.cost ??= 0;
        addToBucket(buckets, entry);
      }
    }
  } catch {
    // Missing or malformed usage stores are treated as empty.
  }
  return buckets;
}

async function readDailyBuckets(): Promise<Map<string, DailyUsage>> {
  const buckets = await readDailyStore();
  for (const record of await readTempRecords()) addToBucket(buckets, recordToBucket(record));
  return buckets;
}

async function readTotalMap(): Promise<Map<string, AggregatedUsage>> {
  const map = new Map<string, AggregatedUsage>();
  try {
    const entries = JSON.parse(await readFile(getPaths().usageTotal, "utf-8")) as AggregatedUsage[];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const old = entry as unknown as Record<string, unknown>;
        if (typeof old.cachedReadTokens !== "number" && typeof old.cachedTokens === "number") {
          entry.cachedReadTokens = old.cachedTokens as number;
        }
        delete old.cachedTokens;
        entry.cachedReadTokens ??= 0;
        entry.cachedWriteTokens ??= 0;
        entry.cost ??= 0;
        map.set(`${entry.provider}::${entry.model}`, { ...entry });
      }
    }
  } catch {
    // Missing or malformed usage stores are treated as empty.
  }
  return map;
}

export async function flushUsage(): Promise<void> {
  const paths = getPaths();
  const tempRecords = await readTempRecords();
  if (tempRecords.length === 0) return;

  const totalMap = await readTotalMap();
  for (const record of tempRecords) mergeAggregatedUsage(totalMap, recordToSummary(record));

  const buckets = await readDailyStore();
  for (const record of tempRecords) addToBucket(buckets, recordToBucket(record));

  const cutoffStr = beijingCutoff(DAILY_RETENTION_DAYS);
  const daily = Array.from(buckets.values())
    .filter((bucket) => bucket.date >= cutoffStr)
    .sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  await writeFile(paths.usageTotal, JSON.stringify(Array.from(totalMap.values()), null, 2), "utf-8");
  await writeFile(paths.usageDaily, JSON.stringify(daily, null, 2), "utf-8");
  await truncate(paths.usageTempFile, 0);
}

export async function getUsageStats(): Promise<AggregatedUsage[]> {
  const totalMap = await readTotalMap();
  for (const record of await readTempRecords()) mergeAggregatedUsage(totalMap, recordToSummary(record));
  return Array.from(totalMap.values());
}

export async function getDailyStats(days: number): Promise<DailyStat[]> {
  const cutoffStr = beijingCutoff(days);
  const dateMap = new Map<string, {
    byModel: Map<string, number>;
    byProvider: Map<string, number>;
    total: number;
    byModelCost: Map<string, number>;
    byProviderCost: Map<string, number>;
    totalCost: number;
  }>();

  for (const bucket of (await readDailyBuckets()).values()) {
    if (bucket.date < cutoffStr) continue;
    let entry = dateMap.get(bucket.date);
    if (!entry) {
      entry = { byModel: new Map(), byProvider: new Map(), total: 0, byModelCost: new Map(), byProviderCost: new Map(), totalCost: 0 };
      dateMap.set(bucket.date, entry);
    }
    const tokens = bucket.inputTokens + bucket.billingOutputTokens;
    entry.total += tokens;
    entry.byModel.set(bucket.model, (entry.byModel.get(bucket.model) || 0) + tokens);
    entry.byProvider.set(bucket.provider, (entry.byProvider.get(bucket.provider) || 0) + tokens);
    const cost = bucket.cost ?? 0;
    entry.totalCost += cost;
    entry.byModelCost.set(bucket.model, (entry.byModelCost.get(bucket.model) || 0) + cost);
    entry.byProviderCost.set(bucket.provider, (entry.byProviderCost.get(bucket.provider) || 0) + cost);
  }

  const round6 = (v: number) => Number(v.toFixed(6));

  return Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      date,
      totalTokens: entry.total,
      totalCost: round6(entry.totalCost),
      byModel: Object.fromEntries(entry.byModel),
      byProvider: Object.fromEntries(entry.byProvider),
      byModelCost: Object.fromEntries(
        Array.from(entry.byModelCost.entries()).map(([k, v]) => [k, round6(v)])
      ),
      byProviderCost: Object.fromEntries(
        Array.from(entry.byProviderCost.entries()).map(([k, v]) => [k, round6(v)])
      ),
    }));
}
