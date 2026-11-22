/**
 * 阶段 4：原文落盘后自动整理（plan_people_reply §4）。
 *
 * 为什么是服务端后台队列，而不是跟着这一轮聊天跑：
 * - 自动整理要**再调一次模型**，不能压在用户等回复的那条 WebSocket 上；
 * - 同一个人只允许一个整理在跑，否则两轮会把 `digest.md` 写乱、`organizedAt` 回退。
 *
 * 串行单位是 `personId`，不是会话：简报与当前判断属于人，不属于某条分析会话。
 * 同一人已经有一份在跑时，新到的请求不排队等它，而是记一个「跑完再补一轮」：
 * 连续发十条也只会多跑一轮，且那轮读到的是当时最新的原文，不会漏掉后面几条。
 */

import type { Config } from "../config/index.js";
import { getProviderCredential, resolveModelThinking } from "../config/index.js";
import { createProvider } from "../llm/index.js";
import { calcCost } from "../llm/cost.js";
import type { LLMProvider } from "../llm/index.js";
import type { UsageRecord } from "../llm/types.js";
import type { getLogger } from "../logger/index.js";
import { appendUsageRecord } from "../server/services/usage-store.js";
import { loadAppState, resolveAutoOrganize } from "../app-state/index.js";
import { applyAutoOrganizeResult, buildAutoOrganizeMaterials } from "./organize.js";
import {
  entriesAfter,
  getPersonRecord,
  markOrganizeDay,
  readEntries,
  recordOrganizeOutcome,
} from "./store.js";

export type AutoOrganizeLogger = Pick<ReturnType<typeof getLogger>, "info" | "warn">;

/** 北京时间 = UTC + 8（无夏令时）。与 `usage-store` 的分天口径保持一致。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 今天（北京时间）的日期字符串，YYYY-MM-DD。 */
export function beijingDay(now: Date = new Date()): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 后台整理的总时长上限。
 *
 * 它不是「单次请求的 timeout」：provider 那层是「每次尝试一个 timeout + 三轮重试」，
 * 遇到慢速失败（比如每次 50 秒才回 5xx）最坏能拖到四分多钟。这里按整轮一刀切，
 * 到点直接 abort，`fetchWithRetry` 见外部信号已中止会立刻停掉后续重试。
 */
export const ORGANIZE_TIMEOUT_MS = 60_000;

/**
 * 单次请求的 timeout，必须**短于**上面的总上限。
 * 相等的话两个计时器同一刻触发，谁先到全凭运气；短一点，先由它给一句清楚的超时错误。
 */
const ORGANIZE_REQUEST_TIMEOUT_MS = 45_000;

/**
 * 取消信号用默认的 `AbortError`，不用自定义 reason。
 *
 * `fetchWithRetry` 只在 `name === "AbortError"` 且外部信号已中止时立即抛出，
 * 别的 reason 会被当成普通网络错误继续重试三轮——后台整理白跑四份。
 * 于是「是不是我们踩掉的」改由调用处的 `signal.aborted` 判断。
 */

export type AutoOrganizeResult =
  | {
      status: "skipped";
      reason:
        | "disabled"
        | "busy"
        | "no-fresh-entries"
        | "too-little-fresh"
        | "already-today"
        | "debounced"
        | "empty-brief"
        | "cancelled"
        | "error";
    }
  | { status: "applied"; currentWritten: boolean; currentLength: number };

/** 正在跑自动整理的人。 */
const inFlight = new Set<string>();

/** 在跑那一份的取消开关。手动整理开始时用它停掉这次模型调用。 */
const inFlightAbort = new Map<string, AbortController>();

/** 手动「整理」按钮正在跑的人：自动整理这一轮直接让路。 */
const manualBusy = new Set<string>();

/**
 * 跑着的时候又来了新消息：
 * 不排队等这一份，而是记一个「跑完再来一轮」，让最后一轮读到最新原文。
 * 连续发十条也只会多跑一轮，不会堆十份。
 */
const rerunRequested = new Map<string, { config: Config; logger: AutoOrganizeLogger }>();

/** 只用于测试：断言队列跑空。 */
const pending = new Map<string, Promise<AutoOrganizeResult>>();

/**
 * 防抖计时器与这一轮防抖的起点。
 *
 * 连发几条时只该跑一轮：新消息进来就重置计时器，静默够久才真正开跑。
 * `debounceSince` 兜住「用户一直在打字」的情况，超过一个上限就强制跑。
 */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const debounceSince = new Map<string, number>();

/** 防抖最长等待：连续输入超过这么久还没停手，也得跑一轮，不让人饿着。 */
export const DEBOUNCE_MAX_WAIT_MS = 45_000;

/**
 * 这一轮防抖该等多久。
 *
 * 平时是「静默 `waitMs` 就开跑」；但如果从第一条消息算起已经超过
 * `DEBOUNCE_MAX_WAIT_MS`，就不再多等——用户一直打字时也得定期落一次，
 * 否则聊一整个下午，简报都是空的。
 */
export function computeDebounceDelay(waitMs: number, startedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.min(waitMs, startedAt + DEBOUNCE_MAX_WAIT_MS - now));
}

const RE_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;
const RE_LATIN_OR_DIGIT = /[A-Za-z0-9]/;

/**
 * 按语言折算的「信息单位」，用来判断这次新增原文值不值得烧一次模型。
 *
 * 裸字符数不可比：一句 40 个汉字的「她周五搬家，别提前问，也别告诉别人」是完整信息，
 * 而 40 个英文字母大约只有一半信息量。所以中日韩文字每字算 1，拉丁字母和数字每 2 个算 1，
 * 空白、标点、emoji 不计——它们不承载内容。
 *
 * 不追求精确的分词器，「大致可比」就够：这是省钱的粗筛，不是语言学工具。
 */
export function contentUnits(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const char of text) {
    if (RE_CJK.test(char)) cjk += 1;
    else if (RE_LATIN_OR_DIGIT.test(char)) latin += 1;
  }
  return cjk + latin / 2;
}

export function markManualOrganize(personId: string, running: boolean): void {
  if (running) {
    manualBusy.add(personId);
    // 手动是人的明确意图：把在跑的自动整理停掉，省掉一次没人要的模型调用，
    // 也避免两份结果抢着写 `digest.md`。已经写进去的那一段留着，不回滚。
    inFlightAbort.get(personId)?.abort();
    // 还挂在防抖里的那一轮也取消：手动整理会把游标推到最新，它已经没内容可整理了。
    clearTimeout(debounceTimers.get(personId));
    debounceTimers.delete(personId);
    debounceSince.delete(personId);
  } else {
    manualBusy.delete(personId);
  }
}

export function isAutoOrganizeRunning(personId: string): boolean {
  return inFlight.has(personId);
}

/** 手动整理是否正在跑这个人。 */
export function isManualOrganizeRunning(personId: string): boolean {
  return manualBusy.has(personId);
}

/**
 * 等人身上的自动整理跑完（测试与发版前检查用）。
 * 生产路径不该 `await` 它：那会拖住用户这一轮的回复。
 *
 * 也等掉还在防抖里的那一轮：测试断言「跑空」时，光看 `pending` 会漏掉计时器。
 */
export async function waitForAutoOrganize(personId: string): Promise<void> {
  while (debounceTimers.has(personId)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await pending.get(personId)?.catch(() => undefined);
}

/**
 * 让模型写这一次的简报与当前判断。
 *
 * 走 `config.compaction` 的服务与模型：它的定位就是「后台、便宜的整理任务」，
 * 与手动整理（用用户当前选的模型）分开，不会因为用户切模型而改变后台开销。
 */
/** 测试注入点：默认走真实模型，测试里塞假模型，避免联网。 */
export type OrganizeCompleter = (
  materials: string,
  config: Config,
  signal?: AbortSignal,
) => Promise<{ raw: string; usage?: UsageRecord }>;

let completerOverride: OrganizeCompleter | undefined;

export function setOrganizeCompleter(completer: OrganizeCompleter | undefined): void {
  completerOverride = completer;
}

async function completeOrganizePrompt(materials: string, config: Config, logger: AutoOrganizeLogger, signal?: AbortSignal): Promise<{
  raw: string;
  usage?: UsageRecord;
}> {
  if (completerOverride) return completerOverride(materials, config, signal);
  const providerName = config.compaction.provider;
  const model = config.compaction.model;
  if (!providerName || !model) throw new Error("整理用的模型没有配置");
  const credential = getProviderCredential(config, providerName);
  const provider: LLMProvider = createProvider(providerName);
  const thinking = resolveModelThinking(config, providerName, model, config.compaction.thinkingEffort);
  const response = await provider.complete(credential.apiKey, [
    {
      id: "system",
      role: "system",
      content: materials,
      timestamp: new Date().toISOString(),
    },
    {
      id: "user",
      role: "user",
      // 材料全在 system 里，这里只做触发，避免重复计费体积。
      content: "请按上述规则输出。",
      timestamp: new Date().toISOString(),
    },
  ], {
    model,
    baseUrl: credential.baseUrl,
    maxTokens: 2048,
    thinkingEffort: thinking.level,
    thinkingParams: thinking.params,
    timeout: ORGANIZE_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const usage = response.usage
    ? {
        ...response.usage,
        model,
        provider: providerName,
        timestamp: new Date().toISOString(),
        sessionId: "",
        cost: calcCost(
          response.usage,
          config.providers[providerName]?.models.find((item) => item.id === model)?.cost,
          new Date(),
        ),
      } satisfies UsageRecord
    : undefined;
  logger.info(`auto organize completed (${providerName}/${model})`);
  return { raw: response.content ?? "", usage };
}

async function runAutoOrganize(
  personId: string,
  config: Config,
  logger: AutoOrganizeLogger,
  signal?: AbortSignal,
): Promise<AutoOrganizeResult> {
  const record = await getPersonRecord(personId);
  const fresh = entriesAfter(await readEntries(personId), record.person.organizedAt);
  if (fresh.length === 0) {
    return { status: "skipped", reason: "no-fresh-entries" };
  }
  // 内容门槛默认关闭（见 `config.autoOrganizeMinUnits`）：`daily` 节奏下最多省一次调用，
  // 却会拦掉 40 字说完的真事。打开时按语言折算单位而不是裸字符数。
  if (config.autoOrganizeMinUnits > 0) {
    const units = fresh.reduce((total, entry) => total + contentUnits(entry.text), 0);
    if (units < config.autoOrganizeMinUnits) {
      return { status: "skipped", reason: "too-little-fresh" };
    }
  }
  // 每天一轮：今天已经跑过就不跑，哪怕后来又说了几句。
  // 剩下的留到明天那一轮一起整理，游标没前进，不会漏。
  if (config.autoOrganizeCadence === "daily" && record.person.organizeWindow?.day === beijingDay()) {
    return { status: "skipped", reason: "already-today" };
  }
  if (manualBusy.has(personId)) return { status: "skipped", reason: "busy" };
  if (signal?.aborted) return { status: "skipped", reason: "cancelled" };

  const materials = buildAutoOrganizeMaterials(record.digest, record.current, fresh);
  const { raw, usage } = await completeOrganizePrompt(materials, config, logger, signal);
  if (usage) await appendUsageRecord(usage).catch(() => undefined);
  // 模型跑完，人可能已经在这段时间里点了手动「整理」：结果不要了，
  // 否则两份内容会叠进同一份简报，用户还会看到「刚才手动整理的东西没了」。
  if (signal?.aborted || manualBusy.has(personId)) {
    return { status: "skipped", reason: "cancelled" };
  }

  const lastAt = fresh.at(-1)?.at;
  const outcome = await applyAutoOrganizeResult(personId, raw, lastAt);
  if (!outcome.applied) return { status: "skipped", reason: "empty-brief" };
  return {
    status: "applied",
    currentWritten: outcome.currentWritten,
    currentLength: outcome.currentLength,
  };
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // 用户看的是人物页，不是日志：常见的几类给一句人话，其余保留原文。
  if (/没有配置/.test(message)) return "整理用的模型没有配置";
  if (/401|403|api key|鉴权|unauthorized/i.test(message)) return "整理用的模型鉴权失败";
  if (/abort|timeout|超时/i.test(message)) return "整理超时，没有写入";
  return message.slice(0, 200) || "整理失败";
}

/**
 * 真正跑一轮：占位、超时、失败留痕、补跑都在这里。
 *
 * `inFlight` 必须在这里同步占上，而不是在 `scheduleAutoOrganize` 里——
 * 后者只排计时器，占在那里会让界面一直显示「整理中」。
 */
async function runOnce(
  personId: string,
  config: Config,
  logger: AutoOrganizeLogger,
): Promise<AutoOrganizeResult> {
  if (inFlight.has(personId)) {
    rerunRequested.set(personId, { config, logger });
    return { status: "skipped", reason: "busy" };
  }
  inFlight.add(personId);
  const controller = new AbortController();
  inFlightAbort.set(personId, controller);
  /**
   * 总时长上限，比单次请求的 timeout 更硬。
   *
   * provider 那层是「每次尝试 timeout + 三轮重试」，只设 timeout 的话最坏能拖四分多钟。
   * 这里一刀切：到点就 abort，`fetchWithRetry` 见外部信号已中止会立刻停掉重试。
   */
  let timedOut = false;
  /** 这一轮是不是失败了（超时或异常）。失败时不补跑：游标没前进，下一条消息会重新触发。 */
  let failed = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ORGANIZE_TIMEOUT_MS);
  const task = (async (): Promise<AutoOrganizeResult> => {
    try {
      const state = await loadAppState();
      if (!resolveAutoOrganize(state, config.autoOrganize)) return { status: "skipped", reason: "disabled" };
      if (manualBusy.has(personId)) return { status: "skipped", reason: "busy" };
      const result = await runAutoOrganize(personId, config, logger, controller.signal);
      // 成功才写「今天跑过」；跳过（内容太少 / 无新原文）不写，
      // 否则当天后来补了一段有实质内容的原文，就被这一条挡到明天了。
      if (result.status === "applied") {
        await markOrganizeDay(personId, beijingDay()).catch(() => undefined);
      }
      // 到点被我们踩掉时，`runAutoOrganize` 可能在自己的前置检查里就返回 cancelled；
      // 那种情况仍然是「超时」，要留痕，不能当成手动让路悄悄咽掉。
      // 但若这一轮刚好在到点前写完了，以成功为准，不要把成功记成失败。
      if (timedOut && result.status !== "applied") {
        failed = true;
        await recordOrganizeOutcome(
          personId,
          { at: new Date().toISOString(), status: "failed", message: "整理超时，没有写入" },
        ).catch(() => undefined);
        await markOrganizeDay(personId, beijingDay()).catch(() => undefined);
        return { status: "skipped", reason: "error" };
      }
      return result;
    } catch (error) {
      // 被手动整理踩掉的那一轮不算失败：不记 `failed`，免得人物页挂一条假错误。
      // 超时是另一回事，要让人看见，否则他只会觉得「简报怎么一直不变」。
      if (controller.signal.aborted && !timedOut) return { status: "skipped", reason: "cancelled" };
      failed = true;
      const message = timedOut ? "整理超时，没有写入" : describeFailure(error);
      logger.warn(`auto organize failed for ${personId}: ${(error as Error).message}`);
      await recordOrganizeOutcome(personId, { at: new Date().toISOString(), status: "failed", message }).catch(() => undefined);
      // 失败也占掉今天的名额：否则模型挂了的那个下午，每条消息都会重试一次同样的错误。
      await markOrganizeDay(personId, beijingDay()).catch(() => undefined);
      return { status: "skipped", reason: "error" };
    } finally {
      clearTimeout(deadline);
      inFlight.delete(personId);
      inFlightAbort.delete(personId);
      pending.delete(personId);
      const again = rerunRequested.get(personId);
      rerunRequested.delete(personId);
      // 补跑那一轮不再登记 `pending`：它读的是最新原文，调用方等第一轮就够了。
      // 被手动整理踩掉、或这一轮已经失败时不补：游标没前进，下一条消息会重新触发，
      // 现在补只会立刻再撞一次同样的错误、再烧一次模型。
      // `daily` 节奏下补跑也会被「今天已经跑过」挡住，所以这里不必再判断。
      if (again && !failed && !manualBusy.has(personId)) {
        void scheduleAutoOrganize(personId, again.config, again.logger);
      }
    }
  })();
  pending.set(personId, task);
  return task;
}

/**
 * 排一次自动整理。**调用方不要 `await`**——它在 `chatEnd` 之后跑，
 * 绝不能变成用户这条消息的错误。
 *
 * 三层节流（`plan_people_reply §4 成本`）：
 * 1. **每天一轮**（`config.autoOrganizeCadence`，默认）：同一个人每个自然日最多整理一次。
 * 2. **防抖**（`config.autoOrganizeDebounceMs`）：等这么久没新消息才开跑，连发几条算一轮。
 * 3. **最小内容**（`config.autoOrganizeMinUnits`，默认关）：新增原文折算单位太少就不跑，
 *    在 `runAutoOrganize` 里判。默认关是因为 `daily` 下最多省一次调用，却会拦掉 40 字说成的实事；
 *    切到 `message` 时才建议打开。
 *
 * 失败不是只进日志：结局写进 `meta.json` 的 `lastOrganize`，
 * 人物页据此显示「上次整理失败：原因」。否则界面上和「还没整理过」长得一样。
 *
 * 开关两道：`config.autoOrganize`（装机默认）与 `app_state.autoOrganize`（用户在这台设备的改动）。
 * 后者的存在是为了让人能在对话页随手关掉，不必改配置文件。
 */
export function scheduleAutoOrganize(
  personId: string,
  config: Config | undefined,
  logger: AutoOrganizeLogger,
): Promise<AutoOrganizeResult> {
  if (!config?.autoOrganize) return Promise.resolve({ status: "skipped", reason: "disabled" });
  if (manualBusy.has(personId)) return Promise.resolve({ status: "skipped", reason: "busy" });
  // 已经有一份在跑：记下来，让它跑完再补一轮，别把这段原文漏掉。
  if (inFlight.has(personId)) {
    rerunRequested.set(personId, { config, logger });
    return Promise.resolve({ status: "skipped", reason: "busy" });
  }

  const wait = config.autoOrganizeDebounceMs;
  if (wait <= 0) return runOnce(personId, config, logger);

  // 连发：重置计时器，只留最后一次。起点不动，用来兜住「一直在打字」。
  const since = debounceSince.get(personId) ?? Date.now();
  debounceSince.set(personId, since);
  clearTimeout(debounceTimers.get(personId));
  debounceTimers.set(personId, setTimeout(() => {
    debounceTimers.delete(personId);
    debounceSince.delete(personId);
    void runOnce(personId, config, logger);
  }, computeDebounceDelay(wait, since)));

  return Promise.resolve({ status: "skipped", reason: "debounced" });
}
