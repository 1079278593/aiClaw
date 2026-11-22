import { describe, expect, it, afterEach, vi } from "vitest";
import {
  AUTO_ORGANIZE_INSTRUCTIONS_MARKER,
  applyAutoOrganizeResult,
  buildAutoOrganizeMaterials,
  splitAutoOrganizeReply,
  visibleBeforeMarker,
} from "./organize.js";
import {
  DEBOUNCE_MAX_WAIT_MS,
  ORGANIZE_TIMEOUT_MS,
  beijingDay,
  computeDebounceDelay,
  contentUnits,
  isAutoOrganizeRunning,
  markManualOrganize,
  scheduleAutoOrganize,
  setOrganizeCompleter,
  waitForAutoOrganize,
} from "./auto-organize.js";
import {
  appendEntry,
  createPerson,
  getPersonRecord,
  markOrganizeDay,
  readEntries,
  replaceCurrent,
} from "./store.js";
import { CURRENT_CHAR_LIMIT } from "./profile.js";
import { recordPersonInput } from "./input.js";
import { setupTestDir } from "../test-utils.js";
import type { Config } from "../config/index.js";

const logger = { info: () => undefined, warn: () => undefined };

/** 只填自动整理真正读到的字段，其余用最小占位。 */
function configWith(autoOrganize: boolean, overrides: Partial<Config> = {}): Config {
  return {
    autoOrganize,
    // 旧测试按「每条消息整理一次」写的；默认的 daily + 防抖另有专门的用例。
    autoOrganizeCadence: "message",
    autoOrganizeDebounceMs: 0,
    autoOrganizeMinUnits: 0,
    compaction: {
      provider: "zai",
      model: "glm-4.5-air",
      thinkingEffort: "off",
      keepRecentRounds: 0,
    },
    ...overrides,
  } as unknown as Config;
}

afterEach(() => {
  setOrganizeCompleter(undefined);
  markManualOrganize("", false);
});
describe("auto organize after raw input", () => {
  it("appends the digest and replaces current.md, leaving profile.md byte-identical", async () => {
    const dir = await setupTestDir("auto-organize-basic");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "她说周五要搬家，让我别提前问", dir);
    const before = await getPersonRecord(person.id, dir);

    setOrganizeCompleter(async () => ({
      raw: "她周五搬家。「不要提前问」是她的明确要求。\n<<<当前>>>\n先别追问搬家的事，等她自己说。",
    }));
    const result = await scheduleAutoOrganize(person.id, configWith(true), logger);
    expect(result).toEqual({ status: "applied", currentWritten: true, currentLength: expect.any(Number) });

    const after = await getPersonRecord(person.id, dir);
    // 简报只追加，旧的版本头与旧段都还在。
    expect(after.digest.startsWith(before.digest.trimEnd())).toBe(true);
    expect(after.digest).toContain("她周五搬家");
    // 当前判断整篇替换。
    expect(after.current).toContain("先别追问搬家的事");
    // 档案一个字节都不能动。
    expect(after.profile).toBe(before.profile);
    // 游标推进到最后一条原文。
    const entries = await readEntries(person.id, dir);
    expect(after.person.organizedAt).toBe(entries.at(-1)?.at);
  });

  it("never rewrites old digest paragraphs across two rounds", async () => {
    const dir = await setupTestDir("auto-organize-append");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "第一件事", dir);

    setOrganizeCompleter(async () => ({ raw: "第一段。\n<<<当前>>>\n第一版判断。" }));
    await scheduleAutoOrganize(person.id, configWith(true), logger);
    const first = await getPersonRecord(person.id, dir);

    await recordPersonInput(person.id, "第二件事", dir);
    setOrganizeCompleter(async () => ({ raw: "第二段。\n<<<当前>>>\n第二版判断。" }));
    await scheduleAutoOrganize(person.id, configWith(true), logger);
    const second = await getPersonRecord(person.id, dir);

    expect(second.digest).toContain("第一段。");
    expect(second.digest).toContain("第二段。");
    // 当前判断是替换而不是追加。
    expect(second.current).toContain("第二版判断。");
    expect(second.current).not.toContain("第一版判断。");
  });

  it("skips everything when the model finds nothing substantial", async () => {
    const dir = await setupTestDir("auto-organize-empty");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "在吗", dir);
    const before = await getPersonRecord(person.id, dir);

    setOrganizeCompleter(async () => ({ raw: "无" }));
    const result = await scheduleAutoOrganize(person.id, configWith(true), logger);

    expect(result.status).toBe("skipped");
    const after = await getPersonRecord(person.id, dir);
    expect(after.digest).toBe(before.digest);
    expect(after.current).toBe(before.current);
    // 不推进游标，下一轮还会读到这条原文。
    expect(after.person.organizedAt).toBe(before.person.organizedAt);
  });

  it("keeps the old current.md when the new one exceeds the limit", async () => {
    const dir = await setupTestDir("auto-organize-too-long");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有实质内容的一段", dir);
    await replaceCurrent(person.id, "旧判断。", dir);
    const before = await getPersonRecord(person.id, dir);

    setOrganizeCompleter(async () => ({
      raw: `新的一段简报。\n<<<当前>>>\n${"长".repeat(CURRENT_CHAR_LIMIT + 10)}`,
    }));
    const result = await scheduleAutoOrganize(person.id, configWith(true), logger);

    expect(result).toEqual({ status: "applied", currentWritten: false, currentLength: CURRENT_CHAR_LIMIT + 10 });
    const after = await getPersonRecord(person.id, dir);
    // 简报照常追加、游标照常推进。
    expect(after.digest).toContain("新的一段简报。");
    expect(after.person.organizedAt).toBe((await readEntries(person.id, dir)).at(-1)?.at);
    // 当前判断保持旧版。
    expect(after.current).toContain("旧判断。");
  });

  it("drops an archive section the model emitted on the auto path", async () => {
    const dir = await setupTestDir("auto-organize-no-profile");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "改称呼的事先别提", dir);
    const before = await getPersonRecord(person.id, dir);

    setOrganizeCompleter(async () => ({
      raw: "她不想现在改称呼。\n<<<档案>>>\n## 基本信息\n- 称呼：应该是别人",
    }));
    await scheduleAutoOrganize(person.id, configWith(true), logger);

    const after = await getPersonRecord(person.id, dir);
    expect(after.profile).toBe(before.profile);
  });

  it("does nothing when the switch is off", async () => {
    const dir = await setupTestDir("auto-organize-disabled");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有内容", dir);

    let called = 0;
    setOrganizeCompleter(async () => {
      called += 1;
      return { raw: "简报。" };
    });
    const result = await scheduleAutoOrganize(person.id, configWith(false), logger);

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(called).toBe(0);
  });

  it("skips when there is no fresh raw input (already organized)", async () => {
    const dir = await setupTestDir("auto-organize-no-fresh");
    const { person } = await createPerson("阿宁", dir);
    await appendEntry(person.id, { kind: "line", speaker: "them", text: "周五见" }, dir);
    await applyAutoOrganizeResult(person.id, "约定周五见面。", (await readEntries(person.id, dir))[0].at, dir);

    let called = 0;
    setOrganizeCompleter(async () => {
      called += 1;
      return { raw: "不该被调用" };
    });
    const result = await scheduleAutoOrganize(person.id, configWith(true), logger);

    expect(result).toEqual({ status: "skipped", reason: "no-fresh-entries" });
    expect(called).toBe(0);
  });

  it("lets a running manual organize take precedence", async () => {
    const dir = await setupTestDir("auto-organize-manual-busy");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有内容", dir);
    markManualOrganize(person.id, true);
    try {
      const result = await scheduleAutoOrganize(person.id, configWith(true), logger);
      expect(result).toEqual({ status: "skipped", reason: "busy" });
    } finally {
      markManualOrganize(person.id, false);
    }
  });

  it("runs only one organize per person at a time", async () => {
    const dir = await setupTestDir("auto-organize-serial");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有内容", dir);

    let running = 0;
    let maxRunning = 0;
    setOrganizeCompleter(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { raw: "简报。\n<<<当前>>>\n判断。" };
    });

    const first = scheduleAutoOrganize(person.id, configWith(true), logger);
    expect(isAutoOrganizeRunning(person.id)).toBe(true);
    const second = await scheduleAutoOrganize(person.id, configWith(true), logger);
    expect(second).toEqual({ status: "skipped", reason: "busy" });
    await first;
    expect(maxRunning).toBe(1);
    // 中途进来的请求会在第一轮结束后补跑一轮，且那时不再占着「在跑」。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(isAutoOrganizeRunning(person.id)).toBe(false);
  });

  it("leaves a readable failure on meta.json instead of only a log line", async () => {
    const dir = await setupTestDir("auto-organize-failure-visible");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有内容", dir);

    setOrganizeCompleter(async () => {
      throw new Error("整理用的模型没有配置");
    });
    const result = await scheduleAutoOrganize(person.id, configWith(true), logger);

    expect(result).toEqual({ status: "skipped", reason: "error" });
    // 只进日志等于没发生：人物页要能看到上次为什么没整理。
    const after = await getPersonRecord(person.id, dir);
    expect(after.person.lastOrganize).toMatchObject({
      status: "failed",
      message: "整理用的模型没有配置",
    });
    // 失败不动游标，也不动简报。
    expect(after.person.organizedAt).toBeUndefined();
  });

  it("records a skipped outcome when the model finds nothing to write", async () => {
    const dir = await setupTestDir("auto-organize-skip-visible");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "在吗", dir);

    setOrganizeCompleter(async () => ({ raw: "无" }));
    await scheduleAutoOrganize(person.id, configWith(true), logger);

    const after = await getPersonRecord(person.id, dir);
    expect(after.person.lastOrganize).toMatchObject({
      status: "skipped",
      message: "这次没有需要写进简报的内容",
    });
  });

  it("records success with the time it finished, not the cursor", async () => {
    const dir = await setupTestDir("auto-organize-ok-visible");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有实质内容", dir);

    setOrganizeCompleter(async () => ({ raw: "简报。\n<<<当前>>>\n判断。" }));
    await scheduleAutoOrganize(person.id, configWith(true), logger);

    const after = await getPersonRecord(person.id, dir);
    expect(after.person.lastOrganize?.status).toBe("ok");
    // 结局是「跑完的钟点」，游标是「读到哪条原文」，两者不是一回事。
    expect(after.person.lastOrganize?.at).not.toBe(after.person.organizedAt);
  });

  it("cancels the in-flight auto organize when the human starts a manual one", async () => {
    const dir = await setupTestDir("auto-organize-cancel");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "有内容", dir);

    let sawAbort = false;
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    setOrganizeCompleter(async (_materials, _config, signal) => {
      started();
      // 模拟真实模型的取消行为：信号一 abort 就抛 AbortError。
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(Object.assign(new Error("已取消"), { name: "AbortError" }));
        });
      });
      return { raw: "不该走到这里" };
    });

    const running = scheduleAutoOrganize(person.id, configWith(true), logger);
    await startedPromise;
    markManualOrganize(person.id, true);

    const result = await running;
    expect(result).toEqual({ status: "skipped", reason: "cancelled" });
    expect(sawAbort).toBe(true);
    // 被手动踩掉不算失败：人物页不该挂一条假错误。
    expect((await getPersonRecord(person.id, dir)).person.lastOrganize).toBeUndefined();
    // 手动整理自己会把游标推到最新，自动侧不用补跑。
    markManualOrganize(person.id, false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(isAutoOrganizeRunning(person.id)).toBe(false);
  });

  it("does not rerun when a manual organize interrupted the queued round", async () => {
    const dir = await setupTestDir("auto-organize-cancel-rerun");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "第一条", dir);

    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    setOrganizeCompleter(async (_materials, _config, signal) => {
      calls += 1;
      if (calls === 1) {
        started();
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("已取消"), { name: "AbortError" })));
        });
      }
      return { raw: "简报。\n<<<当前>>>\n判断。" };
    });

    const first = scheduleAutoOrganize(person.id, configWith(true), logger);
    await startedPromise;
    // 跑着的时候又来一条：记成补跑。随后人点了手动整理。
    await scheduleAutoOrganize(person.id, configWith(true), logger);
    markManualOrganize(person.id, true);
    await first;
    markManualOrganize(person.id, false);

    await new Promise((resolve) => setTimeout(resolve, 80));
    // 手动整理会把游标推到最新，补跑那一轮不该再烧一次模型。
    expect(calls).toBe(1);
  });

  it("does not rerun after a failure, so it cannot fail twice on one message", async () => {
    const dir = await setupTestDir("auto-organize-fail-no-rerun");
    const { person } = await createPerson("阿宁", dir);
    await recordPersonInput(person.id, "第一条", dir);

    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      started();
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("模型挂了");
    });

    const first = scheduleAutoOrganize(person.id, configWith(true), logger);
    await startedPromise;
    // 跑着的时候又来一条：正常会记成补跑。
    await scheduleAutoOrganize(person.id, configWith(true), logger);
    const result = await first;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(result).toEqual({ status: "skipped", reason: "error" });
    // 游标没前进，下一条消息会重新触发；此刻补跑只会立刻再撞一次同样的错误。
    expect(calls).toBe(1);
  });

  it("gives up on a hung model call and says so on the person page", async () => {
    vi.useFakeTimers();
    try {
      const dir = await setupTestDir("auto-organize-timeout");
      const { person } = await createPerson("阿宁", dir);
      await recordPersonInput(person.id, "有内容", dir);

      let started: () => void = () => undefined;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      setOrganizeCompleter(async (_materials, _config, signal) => {
        started();
        // 模型一直不返回：只有我们自己那道上限能停住它。
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("已取消"), { name: "AbortError" })));
        });
        return { raw: "不该走到这里" };
      });

      const running = scheduleAutoOrganize(person.id, configWith(true), logger);
      // 让 loadAppState 和 completer 都跑起来，再推进时钟。
      await vi.waitFor(() => { if (!isAutoOrganizeRunning(person.id)) throw new Error("not started"); });
      startedPromise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      started();
      await vi.advanceTimersByTimeAsync(ORGANIZE_TIMEOUT_MS + 10);

      const result = await running;
      expect(result).toEqual({ status: "skipped", reason: "error" });
      // 超时要说出来：只进日志的话，人只会觉得「简报怎么一直不变」。
      const after = await getPersonRecord(person.id, dir);
      expect(after.person.lastOrganize).toMatchObject({
        status: "failed",
        message: "整理超时，没有写入",
      });
      expect(after.person.organizedAt).toBeUndefined();
      expect(isAutoOrganizeRunning(person.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("auto organize cadence", () => {
  it("organizes at most once per Beijing day", async () => {
    const dir = await setupTestDir("auto-organize-daily");
    const { person } = await createPerson("阿宁", dir);
    const daily = { autoOrganizeCadence: "daily" as const };

    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      return { raw: "她周五搬家。\n<<<当前>>>\n先别追问。" };
    });

    await recordPersonInput(person.id, "她说周五要搬家", dir);
    const first = await scheduleAutoOrganize(person.id, configWith(true, daily), logger);
    expect(first.status).toBe("applied");
    expect(calls).toBe(1);

    // 当天之后又说了几句：不再整理，留到明天那一轮一起。
    await recordPersonInput(person.id, "她还说别提前问", dir);
    const second = await scheduleAutoOrganize(person.id, configWith(true, daily), logger);
    expect(second).toEqual({ status: "skipped", reason: "already-today" });
    expect(calls).toBe(1);
    // 原文照常落盘，游标没动，不会漏。
    expect((await readEntries(person.id, dir)).length).toBe(2);
  });

  it("runs again on the next day and catches up the backlog", async () => {
    const dir = await setupTestDir("auto-organize-daily-next");
    const { person } = await createPerson("阿宁", dir);
    const daily = { autoOrganizeCadence: "daily" as const };

    let calls = 0;
    const seen: string[] = [];
    setOrganizeCompleter(async (materials) => {
      calls += 1;
      seen.push(materials);
      return { raw: `第${calls}段。\n<<<当前>>>\n判断。` };
    });

    await recordPersonInput(person.id, "第一天的内容", dir);
    await scheduleAutoOrganize(person.id, configWith(true, daily), logger);
    await recordPersonInput(person.id, "第二天追加的内容", dir);

    // 把「今天已经跑过」改到昨天，模拟第二天。
    const record = await getPersonRecord(person.id, dir);
    expect(record.person.organizeWindow?.day).toBe(beijingDay());
    await markOrganizeDay(person.id, "2020-01-01", dir);

    const second = await scheduleAutoOrganize(person.id, configWith(true, daily), logger);
    expect(second.status).toBe("applied");
    expect(calls).toBe(2);
    // 只整理了第二天新增的那一条，昨天那段不重复。
    expect(seen[1]).toContain("第二天追加的内容");
    expect(seen[1]).not.toContain("第一天的内容");
  });

  it("does not gate by default, so a 40-character fact is never dropped", async () => {
    const dir = await setupTestDir("auto-organize-no-gate");
    const { person } = await createPerson("阿宁", dir);

    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      return { raw: "简报。\n<<<当前>>>\n判断。" };
    });

    // 39 个字说完整一件事。旧的 40 字门槛会把它拦掉，而它恰恰很值得整理。
    const fact = "她周五要搬家，让我别提前问，也别告诉别人，等她说完再提。";
    expect(fact.length).toBeLessThan(40);
    await recordPersonInput(person.id, fact, dir);
    const result = await scheduleAutoOrganize(person.id, configWith(true), logger);
    expect(result.status).toBe("applied");
    expect(calls).toBe(1);
  });

  it("counts information units per language, not raw characters", () => {
    // 中文每字算 1。
    expect(contentUnits("她周五搬家")).toBe(5);
    // 英文每 2 个字母算 1：同样信息量时，英文需要的字符数大约翻倍。
    expect(contentUnits("she moves friday")).toBe(7);
    // 空白与标点不承载内容。
    expect(contentUnits("，。！   ")).toBe(0);
    // 混排按各自比例相加。
    expect(contentUnits("她说 ok 了")).toBe(3 + 1);
    // 门槛比较的是折算值，不是字符数：60 个英文字母只有 30 单位，
    // 40 个汉字有 40 单位。中文更密，所以同一个门槛对中文更宽松地「够格」。
    expect(contentUnits("a".repeat(60))).toBe(30);
    expect(contentUnits("字".repeat(40))).toBe(40);
  });

  it("skips when there is too little fresh text, but does not burn the day", async () => {
    const dir = await setupTestDir("auto-organize-min-chars");
    const { person } = await createPerson("阿宁", dir);
    // 门槛设 30 而不是 40：这句话折算约 37 单位，留出余量，
    // 免得测试变成「刚好卡在边界」的脆弱断言。
    const gated = { autoOrganizeCadence: "daily" as const, autoOrganizeMinUnits: 30 };

    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      return { raw: "简报。\n<<<当前>>>\n判断。" };
    });

    await recordPersonInput(person.id, "在吗", dir);
    const first = await scheduleAutoOrganize(person.id, configWith(true, gated), logger);
    expect(first).toEqual({ status: "skipped", reason: "too-little-fresh" });
    expect(calls).toBe(0);
    // 没跑就不占当天的名额：后来补了实质内容，当天还能整理。
    expect((await getPersonRecord(person.id, dir)).person.organizeWindow).toBeUndefined();

    await recordPersonInput(
      person.id,
      "她说这周五要搬家，让我千万别提前问，也不要跟别人提起，等她自己想好了再跟我说细节。",
      dir,
    );
    const second = await scheduleAutoOrganize(person.id, configWith(true, gated), logger);
    expect(second.status).toBe("applied");
    expect(calls).toBe(1);
  });

  it("keeps the day when the model fails, so it does not retry all day", async () => {
    const dir = await setupTestDir("auto-organize-daily-fail");
    const { person } = await createPerson("阿宁", dir);
    const daily = { autoOrganizeCadence: "daily" as const };

    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      throw new Error("模型挂了");
    });

    await recordPersonInput(person.id, "有实质内容的一段话", dir);
    expect(await scheduleAutoOrganize(person.id, configWith(true, daily), logger))
      .toEqual({ status: "skipped", reason: "error" });
    expect(calls).toBe(1);

    // 同一个下午再发几条：不该反复撞同一个错误。
    await recordPersonInput(person.id, "又说了几句", dir);
    expect(await scheduleAutoOrganize(person.id, configWith(true, daily), logger))
      .toEqual({ status: "skipped", reason: "already-today" });
    expect(calls).toBe(1);
  });

  it("debounces a burst into a single run", async () => {
    const dir = await setupTestDir("auto-organize-debounce");
    const { person } = await createPerson("阿宁", dir);
    const burst = { autoOrganizeCadence: "message" as const, autoOrganizeDebounceMs: 30 };

    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      return { raw: "简报。\n<<<当前>>>\n判断。" };
    });

    await recordPersonInput(person.id, "第一条", dir);
    expect((await scheduleAutoOrganize(person.id, configWith(true, burst), logger)))

      .toEqual({ status: "skipped", reason: "debounced" });
    // 排了计时器但还没开跑：不该显示「整理中」。
    expect(isAutoOrganizeRunning(person.id)).toBe(false);

    await recordPersonInput(person.id, "第二条", dir);
    await recordPersonInput(person.id, "第三条", dir);
    await scheduleAutoOrganize(person.id, configWith(true, burst), logger);
    await scheduleAutoOrganize(person.id, configWith(true, burst), logger);

    // 静默 30ms 之后只跑一轮，且一次读到全部三条。
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(calls).toBe(1);
    const after = await getPersonRecord(person.id, dir);
    expect(after.digest).toContain("简报。");
  });

  it("cancels a debounced round when the user organizes manually", async () => {
    const dir = await setupTestDir("auto-organize-debounce-manual");
    const { person } = await createPerson("阿宁", dir);
    const burst = { autoOrganizeCadence: "message" as const, autoOrganizeDebounceMs: 30 };

    let calls = 0;
    setOrganizeCompleter(async () => {
      calls += 1;
      return { raw: "简报。\n<<<当前>>>\n判断。" };
    });

    await recordPersonInput(person.id, "有实质内容的一段话", dir);
    await scheduleAutoOrganize(person.id, configWith(true, burst), logger);
    markManualOrganize(person.id, true);
    markManualOrganize(person.id, false);

    // 手动整理会把游标推到最新，那一轮已经没内容可整理：不该再花一次调用。
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(calls).toBe(0);
  });

  it("gives up on the debounce max wait when the user never stops", () => {
    // 纯函数验证：一直有新消息时，等待时间随「第一条消息」的年龄递减，最终归零。
    // 端到端跑这一条需要真实 I/O，假时钟推不动 `loadAppState`，所以这里只测排程算术。
    const start = 1_000_000;
    // 防抖 60s 比最长等待还长，所以实际最多等 45s。
    expect(computeDebounceDelay(60_000, start, start)).toBe(DEBOUNCE_MAX_WAIT_MS);
    expect(computeDebounceDelay(60_000, start, start + 30_000)).toBe(15_000);
    expect(computeDebounceDelay(60_000, start, start + DEBOUNCE_MAX_WAIT_MS)).toBe(0);
    expect(computeDebounceDelay(60_000, start, start + DEBOUNCE_MAX_WAIT_MS + 5_000)).toBe(0);
    // 防抖短于上限时，就按防抖等。
    expect(computeDebounceDelay(8_000, start, start + 3_000)).toBe(8_000);
  });
});

describe("auto organize materials", () => {  it("excludes the profile, so the model is not nudged into writing one", () => {
    const materials = buildAutoOrganizeMaterials("旧简报", "旧判断", [
      { id: "e1", at: "2026-01-01T00:00:00.000Z", kind: "note", text: "她说周五搬家" },
    ]);
    expect(materials).toContain(AUTO_ORGANIZE_INSTRUCTIONS_MARKER);
    expect(materials).toContain("旧简报");
    expect(materials).toContain("旧判断");
    expect(materials).toContain("她说周五搬家");
    expect(materials).not.toContain("现有档案");
    expect(materials).toContain("不要写档案");
  });

  it("splits the current marker and never leaks a partial marker", () => {
    expect(splitAutoOrganizeReply("简报。\n<<<当前>>>\n判断。")).toEqual({ brief: "简报。", current: "判断。" });
    expect(splitAutoOrganizeReply("只有简报。")).toEqual({ brief: "只有简报。", current: "" });
    expect(visibleBeforeMarker("简报。<<<当")).toBe("简报。");
    expect(visibleBeforeMarker("简报。<<<当前>>>判断")).toBe("简报。");
  });
});
