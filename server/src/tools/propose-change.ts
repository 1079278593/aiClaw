/**
 * `propose_change`：Agent 通往知识区（reflections / knowledge_base）的唯一出口。
 *
 * 它碰不到真相源，只写 `pending/<id>/`，因此永不进入权限弹窗集合：
 * 确认点在「待应用」列表，不在对话中。
 */

import type { FSPolicy } from "../config/schema.js";
import { createProposal, isKnowledgePath, type PendingKind } from "../pending/store.js";
import type { ToolDefinition } from "./types.js";

type ProposeChangeInput = {
  target: string;
  kind: PendingKind;
  body: string;
  fields?: { title?: string; context?: string; occurredAt?: string };
  summary: string;
  relatesTo?: Array<{ path: string; relation: string }>;
};

export function createProposeChangeTool(policy: FSPolicy): ToolDefinition<ProposeChangeInput> {
  return {
    name: "propose_change",
    description:
      "对知识区（reflections/ 或 knowledge_base/）提出修改提案。它不会直接改文件，只生成一条待应用提案，由用户在界面确认。"
      + "target 用相对数据目录的完整路径，例如 'reflections/认知/某篇.md'；新建时指向将要创建的文件路径。"
      + "kind='reflection' 时 body 只放正文（标题/发生时刻放 fields）；kind='doc' 时 body 放全文。",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "知识区内的完整相对路径，例如 'reflections/认知/某篇.md' 或 'knowledge_base/库名/文档.md'",
        },
        kind: {
          type: "string",
          enum: ["reflection", "doc"],
          description: "reflection = 心得（正文 + front matter 字段）；doc = 普通文档（全文）",
        },
        body: { type: "string", description: "reflection 只放正文；doc 放全文" },
        fields: {
          type: "object",
          description: "可选 front matter 字段（仅 reflection）",
          properties: {
            title: { type: "string" },
            context: { type: "string" },
            occurredAt: { type: "string", description: "ISO-8601 发生时刻" },
          },
        },
        summary: { type: "string", description: "一句话说明这次改动，用于列表展示" },
        relatesTo: {
          type: "array",
          description: "可选：与本提案相关的其他文件（不放主目标）",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              relation: { type: "string" },
            },
          },
        },
      },
      required: ["target", "kind", "body", "summary"],
    },
    async execute(input, context) {
      try {
        const target = String(input.target ?? "").trim();
        if (!target) return { content: "target 不能为空", isError: true };
        if (!isKnowledgePath(target)) {
          return { content: "只能对 reflections/ 或 knowledge_base/ 提案；其他目录请用 write 工具直接写", isError: true };
        }
        // 与 ACL 对齐：知识区可读，但不可写 —— 这里只做可读性校验。
        void policy;
        const meta = await createProposal({
          target,
          kind: input.kind,
          body: String(input.body ?? ""),
          fields: input.fields,
          summary: String(input.summary ?? ""),
          sourceSessionId: context?.sessionId ?? "",
          relatesTo: input.relatesTo,
        });
        return {
          content: `已创建提案 ${meta.id}（${meta.changeType} ${meta.target}），等待用户在「待应用」中确认。`,
        };
      } catch (error) {
        return { content: `创建提案失败：${(error as Error).message}`, isError: true };
      }
    },
  };
}
