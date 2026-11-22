/**
 * Config schema validation using Zod
 */

import { z } from "zod";

export const SUPPORTED_PROVIDERS = ["zai", "dashscope", "deepseek", "commandcode"] as const;
export const THINKING_EFFORTS = ["off", "minimal", "low", "medium", "high"] as const;
export const TAVILY_SEARCH_DEPTHS = ["basic", "advanced", "fast", "ultra-fast"] as const;
export const TAVILY_FETCH_DEPTHS = ["basic", "advanced"] as const;
export const TAVILY_FETCH_FORMATS = ["markdown", "text"] as const;

export const ProviderNameSchema = z.enum(SUPPORTED_PROVIDERS);
export const ThinkingEffortSchema = z.enum(THINKING_EFFORTS);
export const TavilySearchDepthSchema = z.enum(TAVILY_SEARCH_DEPTHS);
export const TavilyFetchDepthSchema = z.enum(TAVILY_FETCH_DEPTHS);
export const TavilyFetchFormatSchema = z.enum(TAVILY_FETCH_FORMATS);

export const ThinkingParamsSchema = z.record(z.string(), z.unknown());

export const ThinkingOptionSchema = z.object({
  id: z.string().min(1).refine((value) => value !== "off", {
    message: "'none' is added by the system and must not be configured on a model",
  }),
  label: z.string().min(1).optional(),
  params: ThinkingParamsSchema,
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 分时段价格：weekdays 1=周一…7=周日，缺省每天；窗口含头不含尾，end<=start 视为跨天 */
export const CostScheduleSchema = z
  .object({
    name: z.string().min(1).optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).optional(),
    start: z.string().regex(TIME_RE, "start must be HH:MM"),
    end: z.string().regex(TIME_RE, "end must be HH:MM"),
    input: z.number().min(0),
    output: z.number().min(0),
    cachedRead: z.number().min(0),
    cachedWrite: z.number().min(0).default(0),
  })
  .refine((s) => s.start !== s.end, { message: "start and end must differ" });

export const CostConfigSchema = z.object({
  input: z.number().min(0).default(0),
  output: z.number().min(0).default(0),
  cachedRead: z.number().min(0).default(0),
  cachedWrite: z.number().min(0).default(0),
  schedules: z.array(CostScheduleSchema).optional(),
});

export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  modal: z.enum(["l", "vl"]).optional(),
  /** 上下文窗口。未配置时退回 contextMaxTokens。 */
  contextWindow: z.number().int().min(1000).optional(),
  thinking: z.array(ThinkingOptionSchema).optional(),
  thinkingOff: ThinkingParamsSchema.optional(),
  cost: CostConfigSchema.optional(),
});

export const ProviderCredentialSchema = z.object({
  apiKey: z.string().default(""),
  baseUrl: z.string().url().optional(),
  models: z.array(ModelOptionSchema).min(1),
});

export const ServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("127.0.0.1"),
  /** Empty = no auth when bound to loopback. Required when host is non-loopback. */
  accessToken: z.string().default(""),
  /** Empty = no CORS headers. Use explicit origins or ["*"] for cross-origin clients. */
  corsOrigins: z.array(z.string()).default([]),
});

export const FS_CONFIRM_LEVELS = ["never", "session", "always"] as const;
export type FSConfirmLevel = (typeof FS_CONFIRM_LEVELS)[number];

/** 三档 ACL：denied 优先于 writable，writable 优先于 readable。 */
export const FSPolicySchema = z.object({
  /** 工具可读的目录前缀 / 精确文件。 */
  readable: z.array(z.string()).default(["reflections", "people", "knowledge_base", "distill", "pending", "agents"]),
  /** 工具可写的目录前缀 / 精确文件。 */
  writable: z.array(z.string()).default(["people", "distill", "pending", "agents"]),
  /** Agent 工具禁域（目录前缀或精确文件），优先级最高。 */
  denied: z.array(z.string()).default([
    "conversations",
    "logs",
    "files/prompts",
    "files/app_state.json",
    "agents/main/AGENT.md",
  ]),
});

export const DEFAULT_FS_POLICY = {
  readable: ["reflections", "people", "knowledge_base", "distill", "pending", "agents"],
  writable: ["people", "distill", "pending", "agents"],
  denied: [
    "conversations",
    "logs",
    "files/prompts",
    "files/app_state.json",
    "agents/main/AGENT.md",
  ],
};

export const FSConfigSchema = z.object({
  /** 旧字段：存在时映射为 readable ∪ writable（仅配置字段兼容，不做路径兼容）。 */
  allowedDirs: z.array(z.string()).optional(),
  allowedFiles: z.array(z.string()).optional(),
  policy: FSPolicySchema.optional(),
  /** 授权分级：只影响「会话内一次授权」这一档，危险操作永远确认。缺省按 session。 */
  confirm: z.enum(FS_CONFIRM_LEVELS).optional(),
});

export const DEFAULT_TAVILY_TOOL_CONFIG = {
  enabled: false,
  apiKey: "",
  baseUrl: "https://api.tavily.com",
  searchDepth: "basic" as const,
  maxResults: 10,
  includeAnswer: false,
  includeRawContent: false,
  includeUsage: false,
  timeoutMs: 30_000,
  maxSearchContentChars: 2000,
  fetchDepth: "basic" as const,
  fetchFormat: "markdown" as const,
  maxFetchedChars: 20_000,
};

export const DEFAULT_TRILIUM_TOOL_CONFIG = {
  enabled: false,
  baseUrl: "http://127.0.0.1:8080",
  token: "",
  ancestorNoteId: "",
  timeoutMs: 15_000,
};

export const DEFAULT_TOOLS_CONFIG = {
  tavily: DEFAULT_TAVILY_TOOL_CONFIG,
  trilium: DEFAULT_TRILIUM_TOOL_CONFIG,
};

/**
 * App 内更新（移动端「检查更新」）。
 *
 * 为什么 token 放服务端而不是打进 App：
 * `FIR_API_TOKEN` 是**账号级**凭证。用它不仅能查版本，还能列出/操作账号下
 * 全部应用（实测 `GET http://api.appmeta.cn/apps?api_token=…` 会返回应用列表）。
 * APK/IPA 是可解包的文件，把 token 写进客户端等于对拿到安装包的所有人公开。
 * 所以移动端只请求本服务，由这里代理去问 fir，token 永不出现在客户端。
 *
 * 默认关闭：没配 token 时接口返回 `configured:false`，移动端据此隐藏入口，
 * 而不是显示一个点了就报错的按钮。
 */
export const AppUpdateConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** fir / betaqr 的 API Token（32 位）。只存在服务端配置或环境变量里。 */
  apiToken: z.string().default(""),
  /** 查询用的 API 基址。fir 有两个域名，这里留成可配以免单点失效。 */
  apiBase: z.string().url().default("https://api.bq04.com"),
  /** iOS 的 Bundle ID，与 `mobile/scripts/fir.env` 保持一致。 */
  iosBundleId: z.string().default("com.aiclaw.aiclawMobile"),
  /** Android 的 applicationId。fir 上没有该应用时查询会返回 app is not found，属正常。 */
  androidBundleId: z.string().default("com.aiclaw.aiclaw_mobile"),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
});

export const DEFAULT_APP_UPDATE_CONFIG = {
  enabled: false,
  apiToken: "",
  apiBase: "https://api.bq04.com",
  iosBundleId: "com.aiclaw.aiclawMobile",
  androidBundleId: "com.aiclaw.aiclaw_mobile",
  timeoutMs: 15_000,
};

export const CompactionConfigSchema = z.object({
  provider: ProviderNameSchema.default("zai"),
  model: z.string().min(1).default("glm-4.5-air"),
  thinkingEffort: ThinkingEffortSchema.default("off"),
  keepRecentRounds: z.number().int().min(0).max(10).default(0),
});

export const AutoOrganizeCadenceSchema = z.enum(["daily", "message"]);

export const TavilyToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().default(""),
  baseUrl: z.string().url().default("https://api.tavily.com"),
  searchDepth: TavilySearchDepthSchema.default("basic"),
  maxResults: z.number().int().min(1).max(10).default(10),
  includeAnswer: z.boolean().default(false),
  includeRawContent: z.boolean().default(false),
  includeUsage: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxSearchContentChars: z.number().int().min(100).max(20_000).default(2000),
  fetchDepth: TavilyFetchDepthSchema.default("basic"),
  fetchFormat: TavilyFetchFormatSchema.default("markdown"),
  maxFetchedChars: z.number().int().min(1000).max(200_000).default(20_000),
});

export const TriliumToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("http://127.0.0.1:8080"),
  token: z.string().default(""),
  ancestorNoteId: z.string().default(""),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
});

export const ToolsConfigSchema = z.object({
  tavily: TavilyToolConfigSchema.default(DEFAULT_TAVILY_TOOL_CONFIG),
  trilium: TriliumToolConfigSchema.default(DEFAULT_TRILIUM_TOOL_CONFIG),
});

export const DEFAULT_SERVER_CONFIG = {
  port: 3000,
  // 本地默认仍是 loopback：新装无令牌时不会意外暴露到公网。
  // 容器/局域网部署通过 HOST=0.0.0.0（见 deploy/aiclaw.env.example）覆盖，
  // 安全性由 accessToken / 多租户鉴权保证（见 assertServerBindSafe）。
  host: "127.0.0.1",
  accessToken: "",
  corsOrigins: [] as string[],
};

export const DEFAULT_FS_CONFIG = {
  policy: DEFAULT_FS_POLICY,
  confirm: "session" as const,
};

export const DEFAULT_CONFIG = {
  providers: {
    zai: {
      apiKey: "",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [
        // contextWindow 取各家官方文档的「上下文长度」，用于 `min(contextMaxTokens, contextWindow)`。
        // 不填会退回 contextMaxTokens，超窗时 provider 报错而预算表看起来仍然安全。
        { id: "GLM-4.5-Air", label: "GLM-4.5-Air", contextWindow: 131_072 },
        { id: "GLM-4.7", label: "GLM-4.7", contextWindow: 204_800 },
        { id: "GLM-5.1", label: "GLM-5.1", contextWindow: 204_800 },
      ],
    },
    dashscope: {
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [
        { id: "qwen3.6-27b", label: "qwen3.6-27b" },
        { id: "qwen3.6-flash", label: "qwen3.6-flash", contextWindow: 1_000_000 },
        { id: "qwen3.6-plus", label: "qwen3.6-plus", contextWindow: 1_000_000 },
        { id: "qwen-vl-max-latest", label: "qwen-vl-max-latest", modal: "vl" as const, contextWindow: 131_072 },
        { id: "qwen-vl-plus-latest", label: "qwen-vl-plus-latest", modal: "vl" as const, contextWindow: 131_072 },
      ],
    },
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      models: [
        { id: "deepseek-v4-flash", label: "v4-flash", contextWindow: 1_048_576 },
        { id: "deepseek-v4-pro", label: "v4-pro", contextWindow: 1_048_576 },
      ],
    },
    commandcode: {
      apiKey: "",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      models: [
        { id: "z-ai/glm-5.3-flash", label: "glm-5.3-flash", contextWindow: 1_048_576 },
      ],
    },
  },
  defaultProvider: "zai" as const,
  defaultModel: "GLM-4.7",
  defaultThinkingEffort: "high" as const,
  maxTokens: 16384,
  contextMaxTokens: 100_000,
  contextMaxMessages: 0,
  injectRootIndex: false,
  injectDistillMap: false,
  autoRefreshDistill: false,
  /**
   * 人物页发消息后是否自动整理（plan_people_reply §4）。默认开：
   * 这是阶段 4 的主行为，关掉它等于回到手工点「整理」。
   * 每次发送多一次模型调用，用的是 `compaction` 那套便宜的模型。
   */
  autoOrganize: true,
  /**
   * 自动整理的节奏（plan_people_reply §4 成本）。
   *
   * `daily`（默认）：同一个人每个自然日（北京时间）最多整理一次。
   * 原文照常按条落盘，当天没整理的会在第二天一次补齐——游标没前进就不会漏。
   * `message`：旧行为，每条有实质内容的消息之后都跑一次。
   */
  autoOrganizeCadence: "daily" as const,
  /**
   * 等这么久没新消息才开跑（防抖）。连发几条时只算一轮。
   * 0 表示不等待，排到就立刻跑。
   */
  autoOrganizeDebounceMs: 8_000,
  /**
   * 新增原文折算后少于这么多「单位」就不整理。0 表示不设门槛（默认）。
   *
   * 为什么默认关：`daily` 节奏下一天最多跑一次，这个门槛最多省一次调用，
   * 但 `40` 字能说完一整件事，拦掉的往往是真内容。提示词里已有
   * 「这次原文没有实质内容时只输出『无』」，模型自己就是更准的判断器。
   *
   * 什么时候该开：切到 `message`（每条消息都整理）时，寒暄会成倍烧钱，
   * 那时门槛有意义。计数按语言折算，不是裸字符数——同样长的中英文信息量差几倍：
   * 中日韩每字算 1，拉丁字母/数字每 2 个算 1，其余（空白、标点、emoji）不算。
   * 于是 `40` 大致等于「40 个汉字」或「80 个英文字母」，两者的信息量接近。
   */
  autoOrganizeMinUnits: 0,
  maxToolCalls: 10,
  server: DEFAULT_SERVER_CONFIG,
  fs: DEFAULT_FS_CONFIG,
  tools: DEFAULT_TOOLS_CONFIG,
  compaction: {
    provider: "zai" as const,
    model: "glm-4.5-air",
    thinkingEffort: "off" as const,
    keepRecentRounds: 0,
  },
};

export const ConfigSchema = z.object({
  providers: z.record(ProviderNameSchema, ProviderCredentialSchema).default(DEFAULT_CONFIG.providers),
  defaultProvider: ProviderNameSchema.default(DEFAULT_CONFIG.defaultProvider),
  defaultModel: z.string().min(1).default(DEFAULT_CONFIG.defaultModel),
  defaultThinkingEffort: ThinkingEffortSchema.default(DEFAULT_CONFIG.defaultThinkingEffort),
  maxTokens: z.number().int().min(1).default(DEFAULT_CONFIG.maxTokens),
  contextMaxTokens: z.number().int().min(1000).default(DEFAULT_CONFIG.contextMaxTokens),
  contextMaxMessages: z.number().int().min(0).default(DEFAULT_CONFIG.contextMaxMessages),
  /**
   * 是否把 `reflections/_index.md` 注入系统块（plan §5.7）。默认关：
   * 打开后模型能看到根索引，省一次 read；代价是每轮固定成本。
   * 超过 1 KB 时**放弃注入**（不截断成半张地图），只记日志。
   */
  injectRootIndex: z.boolean().default(DEFAULT_CONFIG.injectRootIndex),
  /**
   * 是否把 `distill/meta/overview.md` 注入系统块（plan_distill §4）。默认关：
   * 打开后模型知道有哪些摘要可用，省一次 list；代价是每轮固定成本。
   * 与记忆共用 `MEMORY_TOKEN_MAX` 预算，超了**先丢地图**——它是加速层。
   */
  injectDistillMap: z.boolean().default(DEFAULT_CONFIG.injectDistillMap),
  /**
   * 启动时是否自动重算过期蒸馏（plan_distill §6）。默认关：后台重算会烧 token，
   * 而「摘要变了但我没让你改」很难解释。打开后只处理 `stale`（来源确实改动过）
   * 且刷新于 30 天内的摘要，单轮最多 `maxItems` 篇，失败只记日志。
   */
  autoRefreshDistill: z.boolean().default(DEFAULT_CONFIG.autoRefreshDistill),
  /**
   * 人物页发消息后自动跑整理（plan_people_reply §4）。默认开。
   * 只追加简报、整篇替换当前判断；不写档案。
   */
  autoOrganize: z.boolean().default(DEFAULT_CONFIG.autoOrganize),
  autoOrganizeCadence: AutoOrganizeCadenceSchema.default(DEFAULT_CONFIG.autoOrganizeCadence),
  autoOrganizeDebounceMs: z.number().int().min(0).max(120_000).default(DEFAULT_CONFIG.autoOrganizeDebounceMs),
  autoOrganizeMinUnits: z.number().int().min(0).max(10_000).default(DEFAULT_CONFIG.autoOrganizeMinUnits),
  maxToolCalls: z.number().int().min(1).default(DEFAULT_CONFIG.maxToolCalls),
  server: ServerConfigSchema.optional().default(DEFAULT_CONFIG.server),
  fs: FSConfigSchema.optional().default(DEFAULT_CONFIG.fs),
  tools: ToolsConfigSchema.optional().default(DEFAULT_CONFIG.tools),
  appUpdate: AppUpdateConfigSchema.optional(),
  compaction: CompactionConfigSchema.default(DEFAULT_CONFIG.compaction),
}).superRefine((config, ctx) => {
  const defaultModels = config.providers[config.defaultProvider]?.models ?? [];
  if (!defaultModels.some((model) => model.id === config.defaultModel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultModel"],
      message: `defaultModel must belong to provider '${config.defaultProvider}'`,
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;
export type CostConfig = z.infer<typeof CostConfigSchema>;
export type CostSchedule = z.infer<typeof CostScheduleSchema>;
export type ProviderName = z.infer<typeof ProviderNameSchema>;
export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type ThinkingOption = z.infer<typeof ThinkingOptionSchema>;
export type ThinkingParams = z.infer<typeof ThinkingParamsSchema>;
export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type FSConfig = z.infer<typeof FSConfigSchema>;
export type FSPolicy = z.infer<typeof FSPolicySchema>;

/**
 * 从配置读策略，缺省回退到默认三档。
 * 配置加载后 `policy` 一定有值；这里兜底的是测试里手写的部分 Config 字面量。
 */
export function getFsPolicy(config: { fs?: FSConfig }): FSPolicy {
  return config.fs?.policy ?? DEFAULT_FS_POLICY;
}
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type TavilyToolConfig = z.infer<typeof TavilyToolConfigSchema>;
export type TriliumToolConfig = z.infer<typeof TriliumToolConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type AutoOrganizeCadence = z.infer<typeof AutoOrganizeCadenceSchema>;
