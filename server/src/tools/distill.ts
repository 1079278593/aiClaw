/**
 * `distill` 工具：Agent 按需把一组原文蒸馏成一篇摘要（plan_distill §9 第 6 步）。
 *
 * 为什么给 Agent 一个显式工具、而不是让它 `write` 到 `distill/`：
 * - `write` 写不出头部（`id` / `refreshed`），产物会变成「无主文件」——系统不认；
 * - 归档、地图重建、体积上限都必须在服务端做；
 * - 蒸馏会调模型（有成本），走工具才能在结果里明确告诉 Agent 花了什么。
 *
 * 风险档：`session`（与 `remember` 一致）——它只写 `distill/`，属 AI 可写区，
 * 同一会话首次确认后不再追问。
 */

import type { Config } from "../config/index.js";
import type { FSPolicy } from "../config/schema.js";
import { generateDistill } from "../distill/generate.js";
import { DISTILL_SCOPES, isDistillScope } from "../distill/store.js";
import type { ToolDefinition } from "./types.js";

type DistillInput = {
  scope: (typeof DISTILL_SCOPES)[number];
  /** `scope` 下的相对路径，如 `agent-memory.md`。 */
  path: string;
  /** 来源文件（相对数据根），如 `reflections/inbox/a.md`。 */
  sources: string[];
  title?: string;
};

/**
 * `config` 是必需的：生成摘要要调模型，缺了它每次都会以「未提供配置」失败。
 * 不用 `ToolContext` 传——那会让每个工具都背一个可能为 undefined 的配置字段。
 */
export function createDistillTool(policy: FSPolicy, config?: Config): ToolDefinition<DistillInput> {
  return {
    name: "distill",
    description:
      "把一组原文压缩成一篇主题摘要，存到 distill/。"
      + `scope 可选：${DISTILL_SCOPES.join(" / ")}。`
      + "path 是摘要文件在 scope 下的相对路径（必须以 .md 结尾）。"
      + "sources 是来源文件路径（相对数据根，如 reflections/inbox/a.md）。"
      + "摘要会出现在 distill/meta/overview.md 地图里，方便以后少读原文。"
      + "原文改动后再调一次即会刷新，旧版本自动归档。",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: [...DISTILL_SCOPES],
          description: "摘要放在哪个子树：reflections（心得）/ knowledge（知识库）",
        },
        path: {
          type: "string",
          description: "摘要文件在 scope 下的相对路径，如 agent-memory.md",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "来源文件路径列表（相对数据根），最多 20 个",
        },
        title: { type: "string", description: "摘要标题；缺省按首篇来源的文件名推断" },
      },
      required: ["scope", "path", "sources"],
    },
    async execute(input) {
      void policy;
      const scope = String(input.scope ?? "");
      if (!isDistillScope(scope)) {
        return {
          content: `scope 必须是 ${DISTILL_SCOPES.join(" 或 ")}，收到：${scope}`,
          isError: true,
        };
      }
      const relative = String(input.path ?? "").trim();
      if (!relative) return { content: "path 不能为空", isError: true };
      const sources = Array.isArray(input.sources)
        ? input.sources.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      if (sources.length === 0) return { content: "sources 不能为空", isError: true };

      if (!config) {
        return { content: "蒸馏工具未初始化配置（initTools 未传入 config）", isError: true };
      }
      const result = await generateDistill({
        scope,
        relative,
        sources,
        title: typeof input.title === "string" ? input.title : undefined,
        config,
      });
      if (!result.ok) {
        // 失败时明确说「原文没动、旧摘要还在」，避免 Agent 反复重试。
        return { content: `蒸馏失败：${result.error}。原文未改动，旧摘要（若有）仍然可用。`, isError: true };
      }
      return {
        content: `已生成蒸馏摘要：distill/${result.path}（id=${result.id}，来源 ${result.sources} 篇）。`
          + "摘要已进入 distill/meta/overview.md 地图。",
      };
    },
  };
}
