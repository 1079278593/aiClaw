# Token 与费用统计设计

## 概述

每次 LLM 调用后会记录 `UsageRecord`（包含 token 详情和费用），通过 `usage_temp.json` → `usage_daily.json` / `usage_total.json` 两级归档，在前端 Token Stats 面板展示。

---

## 1. 类型体系

### 层次关系

```
ProviderRawUsage        ← provider 内部，描述 API 原始响应字段（不导出）
     ↓ mapUsage()
NormalizedUsage         ← 公共抽象层（src/llm/types.ts），provider 无关
     ↓ extends
UsageRecord             ← 持久化记录，加 model/provider/timestamp/sessionId/cost
UsageSummary            ← 发给前端，加 model/provider/cost（去掉 timestamp/sessionId）
```

### NormalizedUsage

```typescript
export interface NormalizedUsage {
  inputTokens: number;           // prompt_tokens 总数
  cachedReadTokens?: number;     // prompt 缓存命中
  cachedWriteTokens?: number;    // prompt 缓存写入
  billingOutputTokens: number;   // completion_tokens（计费用，含 thinking）
  thinkingTokens?: number;       // reasoning_tokens
  outputTokens: number;          // completion_tokens - thinkingTokens（纯输出）
}
```

- `cachedReadTokens` / `cachedWriteTokens` 是 `inputTokens` 的子集，统计时不额外相加
- `CompletionResponse.usage` 和 `StreamChunk.usage` 均引用此类型

### StreamChunk（流式）

```typescript
export type StreamChunk =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCallDelta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "usage"; usage: NormalizedUsage };
```

流式过程中可能多次 yield `usage` chunk（deepseek 等 provider 会返回增量 usage），`chat/index.ts` 中 `mergeUsage()` 负责累加。

### UsageRecord（持久化）

```typescript
export interface UsageRecord extends NormalizedUsage {
  model: string;
  provider: string;
  timestamp: string;
  sessionId: string;
  cost: number;
}
```

- 每次对话结束和 compaction 结束时各生成一条
- `contextUsage`（上下文占用的 token，在 `chatEnd` 事件中发送）**不落盘**，仅用于前端实时显示

---

## 2. Provider 实现

### 字段映射

| NormalizedUsage | DeepSeek | Zai | DashScope |
|---|---|---|---|
| `inputTokens` | `prompt_tokens` | `prompt_tokens` | `prompt_tokens` |
| `cachedReadTokens` | `prompt_cache_hit_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cached_tokens` |
| `cachedWriteTokens` | `prompt_tokens_details?.cache_write_tokens`（暂无） | 同 | 同 |
| `billingOutputTokens` | `completion_tokens` | `completion_tokens` | `completion_tokens` |
| `thinkingTokens` | `reasoning_tokens` | `reasoning_tokens` | `reasoning_tokens` |
| `outputTokens` | `completion_tokens - reasoning` | `completion_tokens - reasoning` | `text_tokens` |

### 新增供应商步骤

1. 定义 `XxxRawUsage`（内部类型，不导出），描述 API 原始 usage 字段
2. 实现 `mapUsage(raw: XxxRawUsage): NormalizedUsage`：
   - 不支持 thinking：`thinkingTokens` 省略（`undefined`），`outputTokens === billingOutputTokens`
   - 不支持 cache：`cachedReadTokens` / `cachedWriteTokens` 省略
3. `complete()` 返回时调用 `mapUsage`
4. `stream()` 在 `finish_reason` 非空时，若有 usage 则 yield `{ type: "usage", usage: mapUsage(raw) }`

### 示例：Zai（智谱）

```typescript
interface ZaiRawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(raw: ZaiRawUsage): NormalizedUsage {
  const thinkingTokens = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: raw.prompt_tokens,
    cachedReadTokens: raw.prompt_tokens_details?.cached_tokens,
    cachedWriteTokens: raw.prompt_tokens_details?.cache_write_tokens,
    billingOutputTokens: raw.completion_tokens,
    thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined,
    outputTokens: raw.completion_tokens - thinkingTokens,
  };
}
```

---

## 3. 费用计算

### 配置

`config.json` 每个 model 下可选 `cost` 字段，未配置则全为 0：

```jsonc
{
  "providers": {
    "deepseek": {
      "models": [
        {
          "id": "deepseek-v4-flash",
          "cost": {
            "input": 1,           // 每百万 tokens
            "output": 2,
            "cachedRead": 0.02,   // 缓存命中
            "cachedWrite": 0,     // 缓存写入（暂不触发）
            "schedules": [        // 可选：分时段价格，按数组顺序匹配第一个命中
              {
                "name": "peak-am",
                "weekdays": [1, 2, 3, 4, 5],  // 1=周一…7=周日，缺省=每天
                "start": "09:00",            // 含头（9:00 算高峰）
                "end": "12:00",              // 不含尾（12:00 算空闲）
                "input": 2, "output": 4, "cachedRead": 0.04, "cachedWrite": 0
              }
            ]
          }
        }
      ]
    }
  }
}
```

- 单位不管，用户配什么数值就按什么计算
- 未配置的字段默认 0；`schedules` 未配置时行为与旧版完全一致
- `schedules` 内价格为该时段的**完整价格**（非差值），顶层字段为未命中时段的兜底价
- 时段判定：按**北京时间**（UTC+8）的星期几 + 时分，窗口含头不含尾，`end <= start` 视为跨天（如 `22:00-06:00` 夜间价）；法定节假日无数据源，按工作日处理
- 判定时刻 = `UsageRecord.timestamp`（对话/compaction 结束时刻）

### 公式（`src/llm/cost.ts`）

`calcCost(usage, cost, now?)` 先用 `resolveCostConfig(now, cost)` 按北京时间解析出当前生效的价格（schedules 按序匹配，未命中取顶层默认），再计算：

```
未缓存输入 = inputTokens - (cachedReadTokens ?? 0) - (cachedWriteTokens ?? 0)

cost = ((未缓存输入) * input
      + billingOutputTokens * output
      + (cachedReadTokens ?? 0) * cachedRead
      + (cachedWriteTokens ?? 0) * cachedWrite) / 1_000_000
```

- 计算和持久化精度：**6 位小数**（`Number(v.toFixed(6))`）
- 前端显示精度：**2 位小数**（`Number(v).toFixed(2)`）
- 不显示货币符号，纯数字

### 调用点

- `src/chat/index.ts` 的 `buildUsageRecord()`：正常对话结束后计算
- `src/chat/compaction.ts`：上下文压缩的 LLM 调用也计算

---

## 4. 持久化与数据流

### 文件布局（`$AICLAW_DATA_DIR/files/`）

| 文件 | 内容 | 颗粒度 | 生命周期 |
|---|---|---|---|
| `usage_temp.json` | 实时流水，每次 LLM 调用追加一条 `UsageRecord` | 单次调用 | 归档时清空 |
| `usage_daily.json` | 日桶 `DailyUsage`，保留**最近 30 天** | 日 × 模型 × 供应商 | 归档时删除 30 天前 |
| `usage_total.json` | 按 模型 × 供应商 的**永久累计** | 模型 × 供应商 | 只增不减 |

> `usage_temp.json` 后缀虽是 `.json`，内部为 JSONL（每行一条），便于高频 append。

### 数据流

```
每次对话/compaction 结束
   └─ appendUsageRecord() → 追加 UsageRecord（含 cost）到 usage_temp.json

打开 Token Stats 面板 → POST /api/usage/flush → flushUsage()
   ① temp 流水累加进 usage_total.json（永久总量）
   ② temp 流水聚合进 usage_daily.json 日桶
   ③ 删除 usage_daily.json 中 30 天前的桶
   ④ 清空 usage_temp.json
   （temp 为空时直接返回，不写盘）
```

只有 `usage`（真实消耗）落盘；`contextUsage`（上下文占用）仅用于前端实时显示，不进统计。

> 旧数据兼容：读取旧 JSON 时自动迁移 `cachedTokens` → `cachedReadTokens`，并为缺失的 `cost`/`cachedReadTokens`/`cachedWriteTokens` 补 0。

### DailyUsage（日桶结构）

```typescript
interface DailyUsage {
  date: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  billingOutputTokens: number;
  thinkingTokens?: number;
  outputTokens: number;
  cost: number;
  count: number;
}
```

### 日期口径

- 按 `timestamp` 换算成**北京时间日期**（UTC+8，无夏令时）分桶，前后端一致
  - 后端：`toBeijingDateStr()`（`usage-store.ts`，时间戳 + 8h 后取 UTC 日期字段）
  - 前端：`padDateRange()` 补占位横轴日期时同样用 UTC+8 偏移
- 保留策略 / 最近 N 天 cutoff 同样按北京时间日期计算（`beijingCutoff(days)`）
- `DAILY_RETENTION_DAYS = 30`

---

## 5. 前端展示

### 「总量」tab

- 接口：`GET /api/usage/stats`
- 数据源：`usage_total.json` + 未归档 temp
- 表格列：模型、提供商、总缓存输入（`cachedReadTokens + cachedWriteTokens`）、总未缓存输入（`inputTokens` 减缓存，两者相加 = 总输入）、总输出（`billingOutputTokens`，含 thinking）、总费用
- 按模型 × 供应商展示累计

### 「按时间」tab

- 接口：`GET /api/usage/daily?days=N`
- 数据源：`usage_daily.json` + 未归档 temp
- `totalTokens = inputTokens + billingOutputTokens`（含 thinking），按 model / provider 分组
- 柱状图，Token / 费用 切换按钮（费用图用 `niceScale` 自适应 y 轴）

### 两个 tab 对比

| | 「总量」tab | 「按时间」tab |
|---|---|---|
| 接口 | `GET /api/usage/stats` | `GET /api/usage/daily?days=N` |
| 函数 | `getUsageStats` | `getDailyStats` |
| 数据源 | `usage_total.json` + 未归档 temp | `usage_daily.json` + 未归档 temp |
| 展示 | 表格，按 model × provider 分行 | 柱状图，按 model / provider 各一张 |
| 时间 | 全部历史 | 最近 N 天（前端 7/30，后端上限 90） |

### `niceScale` 算法

用于费用柱状图的 y 轴自适应刻度（token 图仍用 `Math.ceil(v/1000)*1000`）：

```
exp = floor(log10(max))
base = 10^exp
norm = max / base
nice = norm ≤ 1 ? 1 : norm ≤ 2 ? 2 : norm ≤ 5 ? 5 : 10
yMax = nice * base
```