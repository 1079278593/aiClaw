/**
 * `remember`：Agent 写记忆的唯一工具（plan §3.4 / §8.3）。
 *
 * 为什么不用通用的 `write`：
 * - `write` 是整篇覆盖，一次手滑就把整层记忆清空；
 * - 记忆需要结构化元数据（`importance` / `pinned` / `writtenBy`），
 *   这些字段不该由模型自由填成任意字符串；
 * - 体积上限与归档必须在**服务端**强制，不能靠模型自觉。
 *
 * 它写的是 `agents/main/**`，属 §3.5 的 `session` 档：同一会话首次弹一次，
 * 之后同类操作不再问。
 */

import type { FSPolicy } from "../config/schema.js";
import { addEntry } from "../memory/store.js";
import { LAYER_BYTE_MAX, MEMORY_LAYERS, type MemoryImportance, type MemoryLayer } from "../memory/types.js";
import type { ToolDefinition } from "./types.js";

type RememberInput = {
  layer: MemoryLayer;
  text: string;
  importance?: MemoryImportance;
  pinned?: boolean;
  /** `true` 时替换该层全部内容（`focus` 的「刷新关注点」语义）。 */
  replace?: boolean;
};

const LAYER_DESC = MEMORY_LAYERS
  .map((layer) => `${layer}（上限 ${LAYER_BYTE_MAX[layer]} 字节）`)
  .join("、");

export function createRememberTool(policy: FSPolicy): ToolDefinition<RememberInput> {
  return {
    name: "remember",
    description:
      "写入一条长期记忆。用于记住用户的稳定偏好、事实、约定。"
      + `可选层：${LAYER_DESC}。`
      + "text 为要记住的内容（第一行会作为该条目的标题）。"
      + "importance=high 表示用户明确表达关心，medium（默认）表示你推断值得记。"
      + "pinned=true 表示每轮都要看到（慎用，占预算）。"
      + "该层已满时会拒绝写入并说明原因，此时应先整理或归档。",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          enum: MEMORY_LAYERS,
          description: "写哪一层。focus=当前关注点，longterm=长期记忆，runtime=工作记忆，user=用户画像。",
        },
        text: { type: "string", description: "要记住的内容。第一行会成为条目标题。" },
        importance: {
          type: "string",
          enum: ["high", "medium"],
          description: "high=用户明确关心；medium=推断值得记（默认）",
        },
        pinned: { type: "boolean", description: "是否每轮恒定注入（默认 false）" },
        replace: { type: "boolean", description: "是否替换该层全部内容（仅 focus 常用）" },
      },
      required: ["layer", "text"],
    },
    async execute(input, context) {
      void policy;
      const layer = input.layer;
      if (!MEMORY_LAYERS.includes(layer)) {
        return { content: `未知的记忆层：${String(layer)}`, isError: true };
      }
      const text = String(input.text ?? "");
      if (!text.trim()) return { content: "内容为空，未写入", isError: false };

      try {
        // replace 语义暂时只保留给 addEntry：整体覆盖走 replaceLayer 会清掉元数据，
        // 这里显式拒绝，避免模型误以为能「重置」一层而实际丢掉了 used 历史。
        if (input.replace) {
          return {
            content: "暂不支持整体替换；请用 remove 逐条删除，或直接写 focus.md（用户手工操作）。",
            isError: true,
          };
        }
        const entry = await addEntry({
          layer,
          text,
          importance: input.importance === "high" ? "high" : "medium",
          pinned: Boolean(input.pinned),
          writtenBy: "agent",
          sourceSessionId: context?.sessionId ?? "",
        });
        if (!entry) return { content: "内容为空，未写入", isError: false };
        return { content: `已记住（${layer}，id=${entry.id}）。` };
      } catch (error) {
        const message = (error as Error).message;
        return { content: `写入记忆失败：${message}`, isError: true };
      }
    },
  };
}
