import { describe, expect, it } from "vitest";
import { PERSON_INPUT_INLINE_LIMIT, preparePersonInput, recordPersonInput } from "./input.js";
import { createPerson, readEntries } from "./store.js";
import { setupTestDir } from "../test-utils.js";

describe("person input", () => {
  it("records the raw text as a note before analysis", async () => {
    const dir = await setupTestDir("people-input");
    const { person } = await createPerson("阿宁", dir);
    const saved = await recordPersonInput(person.id, "这句话怎么回", dir);
    expect(saved.entry.kind).toBe("note");
    expect(saved.entry.text).toBe("这句话怎么回");
    expect(saved.visibleContent).toBe("这句话怎么回");
    expect((await readEntries(person.id, dir)).map((entry) => entry.text)).toEqual(["这句话怎么回"]);
  });

  it("keeps the full text on disk but truncates the injected copy", async () => {
    const dir = await setupTestDir("people-input-long");
    const { person } = await createPerson("阿宁", dir);
    const long = "嗯".repeat(PERSON_INPUT_INLINE_LIMIT + 200);
    const saved = await recordPersonInput(person.id, long, dir);
    expect(saved.entry.text).toBe(long);
    expect(saved.visibleContent.startsWith("嗯".repeat(PERSON_INPUT_INLINE_LIMIT))).toBe(true);
    expect(saved.visibleContent).toContain(saved.entry.id);
    expect(saved.visibleContent).toContain("people/" + person.id + "/entries.jsonl");
  });

  it("prepares an injected copy that names the entry holding the full text", () => {
    const text = "啊".repeat(PERSON_INPUT_INLINE_LIMIT + 1);
    const prepared = preparePersonInput("abc123", "entry-1", text);
    expect(prepared).toContain("[entry-1]");
    expect(prepared.length).toBeGreaterThan(PERSON_INPUT_INLINE_LIMIT);
    expect(preparePersonInput("abc123", "entry-1", "短句")).toBe("短句");
  });
});
