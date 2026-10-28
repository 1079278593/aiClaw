import { afterEach, describe, expect, it } from "vitest";
import { formatServerVersion, serverVersion } from "./version.js";

describe("serverVersion", () => {
  const previous = {
    build: process.env.AICLAW_BUILD,
    commit: process.env.AICLAW_COMMIT,
  };

  afterEach(() => {
    restore("AICLAW_BUILD", previous.build);
    restore("AICLAW_COMMIT", previous.commit);
  });

  it("reads the build number and commit baked in at image build", () => {
    process.env.AICLAW_BUILD = "12";
    process.env.AICLAW_COMMIT = "abc1234";
    expect(serverVersion()).toEqual({ version: "12", commit: "abc1234" });
    expect(formatServerVersion()).toBe("12 · abc1234");
  });

  it("falls back to dev when the image was not built by the NAS export", () => {
    delete process.env.AICLAW_BUILD;
    delete process.env.AICLAW_COMMIT;
    expect(serverVersion()).toEqual({ version: "dev", commit: "" });
    expect(formatServerVersion()).toBe("dev");
  });
});

function restore(key: "AICLAW_BUILD" | "AICLAW_COMMIT", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
