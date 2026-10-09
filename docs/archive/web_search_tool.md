# Web Search / Fetch Tool 规划

目标：给 aiClaw 增加一组联网工具，让 agent 可以在需要最新信息、外部资料、来源链接时搜索网页，并在拿到 URL 后读取网页正文。

参考文档：https://docs.tavily.com/documentation/api-reference/endpoint/search
参考文档：https://docs.tavily.com/sdk/javascript/reference

## 1. 总体接入方式

推荐把联网能力接成现有工具系统里的内置工具，而不是改 LLM provider 层。第一版内部实现使用 Tavily SDK，但暴露给模型的工具名、工具描述、工具结果都使用中性表述，不出现 Tavily 品牌。

当前项目已有工具链路：

- `src/tools/index.ts`：初始化并注册工具
- `src/tools/registry.ts`：工具注册表
- `src/tools/executor.ts`：按工具名执行
- `src/chat/index.ts`：把工具定义转成 OpenAI-compatible function calling，并处理 tool call / tool result 循环

因此新增联网工具的主要工作是：

- 新增 `src/tools/web-tools.ts` 或 `src/tools/tavily-tools.ts`
- 提供 `web_search` 和 `web_fetch` 两个工具
- 在 `src/tools/index.ts` 根据配置注册这两个工具
- 在 config schema 和默认配置里增加联网工具相关配置
- 新增依赖 `@tavily/core`
- 增加必要测试和文档

## 2. 工具命名

推荐工具名：

- `web_search`
- `web_fetch`

理由：

- 对模型来说语义更自然，容易知道什么时候调用
- 不把底层供应商暴露给模型，未来可以替换实现
- 和用户心智一致：这是“网页搜索”和“读取网页”，不是“某供应商 API”

暂定：

```text
工具名：web_search
描述：Search the web and return concise cited results. Use this when the user explicitly asks for web search or current external information.

工具名：web_fetch
描述：Fetch readable detailed content from one or more web pages by URL.
```

注意：工具描述和工具结果中不暴露 Tavily，只使用 `Search results`、`Fetch results`、`Web search failed`、`Web fetch failed` 等中性文字。

## 3. 配置设计

推荐在 `config.json` 顶层新增：

```json
{
  "tools": {
    "tavily": {
      "enabled": false,
      "apiKey": "",
      "baseUrl": "https://api.tavily.com",
      "searchDepth": "basic",
      "maxResults": 10,
      "includeAnswer": false,
      "includeRawContent": false,
      "includeUsage": false,
      "timeoutMs": 30000,
      "maxSearchContentChars": 2000,
      "fetchDepth": "basic",
      "fetchFormat": "markdown",
      "maxFetchedChars": 20000
    }
  }
}
```

说明：

- `enabled` 默认建议为 `false`，避免没有 key 时默认暴露不可用工具
- `apiKey` 可以写入 `config.json`
- 如果 `apiKey` 为空，或者 `enabled: false`，则不加载 `web_search` 和 `web_fetch` 工具
- `baseUrl` 默认 `https://api.tavily.com`
- `searchDepth` 默认 `basic`
- `maxResults` 默认 `10`
- `includeAnswer` 默认 `false`
- `includeRawContent` 默认 `false`
- `includeUsage` 默认 `false`
- `timeoutMs` 默认 `30000`
- `maxSearchContentChars` 默认 `2000`
- `fetchDepth` 默认 `basic`
- `fetchFormat` 默认 `markdown`
- `maxFetchedChars` 默认 `20000`

## 4. API 与 SDK 范围

第一版使用 `@tavily/core` SDK。

示意：

```ts
import { tavily } from "@tavily/core";

const client = tavily({ apiKey });
const searchResult = await client.search(query, options);
const fetchResult = await client.extract(urls, options);
```

Search 核心参数：

- `query`
- `searchDepth`
- `chunksPerSource`
- `maxResults`
- `topic`
- `timeRange`
- `startDate`
- `endDate`
- `includeAnswer`
- `includeRawContent`
- `includeImages`
- `includeImageDescriptions`
- `includeDomains`
- `excludeDomains`
- `country`
- `autoParameters`
- `includeUsage`

Fetch / Extract 核心参数：

- `urls`
- `extractDepth`
- `format`
- `includeImages`
- `includeFavicon`
- `includeUsage`

## 5. 工具输入 Schema

第一版建议暴露“实用版”参数，不做完整 API 映射。

`web_search` 输入：

```json
{
  "query": "string"
}
```

其中：

- `query` 必填

不暴露给模型、使用内部默认值的搜索参数：

- `searchDepth`：`basic`
- `maxResults`：`10`
- `topic`：`general`
- `timeRange`：不设置，即不过滤发布时间
- `includeDomains`：不设置，即不限制包含域名
- `excludeDomains`：不设置，即不排除域名

`web_fetch` 输入：

```json
{
  "url": "https://example.com/article",
  "urls": ["https://example.com/a", "https://example.com/b"]
}
```

其中：

- `url` 或 `urls` 二选一
- `urls` 建议限制最多 `5` 个
- URL 只允许 `http:` 和 `https:`
- 禁止 localhost、127.0.0.1、0.0.0.0、内网 IP 等地址

暂不开放给模型的参数：

- `includeAnswer`
- `includeRawContent`
- `includeImages`
- `includeImageDescriptions`
- `chunksPerSource`
- `searchDepth`
- `maxResults`
- `country`
- `topic`
- `timeRange`
- `includeDomains`
- `excludeDomains`
- `startDate`
- `endDate`
- `autoParameters`
- `extractDepth`
- `format`

理由：

- 避免模型生成过大的 tool result
- 避免 credit 成本失控
- 第一版先覆盖常见搜索场景

已确定：

- 不支持 `startDate` / `endDate`，默认不限制时间
- 不支持 `country`，默认不限制国家
- 不允许模型选择 `includeRawContent`，搜索结果不输出 raw content
- 不允许模型选择 fetch 的 `format`，默认使用 `markdown`

## 6. 默认策略

推荐 Search 默认：

```json
{
  "searchDepth": "basic",
  "maxResults": 10,
  "topic": "general",
  "timeRange": null,
  "includeDomains": null,
  "excludeDomains": null,
  "includeAnswer": false,
  "includeRawContent": false,
  "includeUsage": false,
  "timeoutMs": 30000,
  "maxSearchContentChars": 2000
}
```

理由：

- `basic` 成本较低，适合默认搜索
- `maxResults: 10` 给模型更多来源用于交叉验证，输出层仍会做摘要和裁剪
- `topic: general` 使用通用网页搜索
- `timeRange/includeDomains/excludeDomains` 不设置，避免默认过滤掉有用结果
- `includeAnswer: false` 让最终回答由当前 LLM 基于搜索结果生成
- `includeRawContent: false` 避免大段网页内容塞进上下文
- `includeUsage: false` 不返回 usage 信息，保持 tool result 简洁
- `timeoutMs: 30000` 搜索请求最多等待 30 秒
- `maxSearchContentChars: 2000` 每条搜索结果 content 最多输出 2000 个字符，可配置

推荐 Fetch 默认：

```json
{
  "fetchDepth": "basic",
  "fetchFormat": "markdown",
  "maxFetchedChars": 20000,
  "includeUsage": false,
  "timeoutMs": 30000
}
```

理由：

- `basic` 成本较低，适合默认读取网页
- `markdown` 更适合模型阅读
- `maxFetchedChars` 防止单个页面撑爆上下文
- `includeUsage: false` 不返回 usage 信息
- `timeoutMs: 30000` fetch 请求最多等待 30 秒

## 7. 工具输出格式

推荐工具返回 Markdown 文本，而不是原始 JSON。

`web_search` 示例：

```md
Search results:
1. Node.js Releases
   URL: https://nodejs.org/en/about/previous-releases
   Content: ...

2. ...
```

`web_fetch` 示例：

```md
Fetch results:
1. Example Article
   URL: https://example.com/article
   Content:
   ...
```

说明：

- `web_search` 的工具结果只给模型返回 `title`、`url`、`content`
- `web_search` 不返回 `score`、`rawContent`、`responseTime`、`requestId`
- SDK 返回值仍是 object；`fetchFormat: "markdown"` 只表示 `web_fetch` 读取到的网页正文内容使用 Markdown 格式，不表示整个工具返回值是 Markdown 对象
- 工具最终会把 object 格式化成 Markdown 字符串，作为 `ToolResult.content`

优点：

- 模型更容易读取和引用
- 前端现有 tool result 展示可以直接复用
- 不需要新增 UI 结构

缺点：

- 以后如果要做结构化搜索结果 UI，需要重新设计输出或附带 JSON

可选方案：

- 工具内部使用结构化类型，最终 `content` 转成 Markdown
- 未来在 `ToolResult` 上扩展 `metadata` 字段，用于 UI 展示

## 8. 权限和隐私

联网工具会把用户 query 或 URL 发送给外部搜索/抓取服务。

第一版明确要求：`web_search` 和 `web_fetch` 都加入实时确认清单。

现有权限确认机制已经覆盖文件写入类工具，服务端目前的受控工具集合包含：

- `write`
- `edit`
- `delete`
- `move`

新增联网工具后，受控工具集合调整为：

- `write`
- `edit`
- `delete`
- `move`
- `web_search`
- `web_fetch`

模型调用 `web_search` 时，确认框需要展示 query。

模型调用 `web_fetch` 时，确认框需要展示 URL 列表。

不新增 `tools.tavily.requireConfirmation` 配置项。联网工具默认总是实时确认。

## 9. Search 与 Fetch 的边界

第一版同时接：

- `web_search`
- `web_fetch`

Search 负责：

- 根据 query 找网页结果
- 返回标题、链接、摘要、分数、发布时间等

Fetch 负责：

- 给定 URL 拉取正文
- 对搜索结果中的某个页面做深入阅读
- 把网页正文转成 Markdown

不单独暴露 `web_extract`，避免模型面对多个近义工具。内部可以用 extract API 实现 `web_fetch`。

## 10. 错误处理

建议错误统一返回 `ToolResult`，不要让异常打断整个聊天流程。

需要处理：

- HTTP 401：key 无效
- HTTP 429：额度或频率限制
- HTTP 400：参数非法
- HTTP 5xx：Tavily 服务端错误
- 网络失败或超时
- 返回结构不符合预期

错误输出示例：

```text
Web search failed: unauthorized request.
```

或：

```text
Web fetch failed: rate limit or quota exceeded.
```

## 11. 超时与结果大小

建议：

- 请求超时：`30s`
- `maxResults` 固定使用配置值，默认 `10`
- `web_search` 每条 content 最大长度使用 `maxSearchContentChars`，默认 `2000`
- `web_search` 默认不输出 `rawContent`，即使 API 响应里带了也忽略
- `web_fetch` 单页正文裁剪到 `maxFetchedChars`
- `web_fetch` 最多一次读取 `5` 个 URL

## 12. 代码改动清单

预计改动：

```text
src/config/schema.ts
src/config/index.ts
src/tools/index.ts
src/tools/web-tools.ts
src/tools/web-tools.test.ts
src/config/index.test.ts
src/server/index.ts
src/server/public/index.html
package.json
pnpm-lock.yaml
```

可选改动：

```text
.env.example
templates/config.json
docs/architecture.md
docs/web_search_tool.md
```

## 13. 测试计划

建议测试：

- config 默认值包含 `tools.tavily`
- 用户配置能覆盖联网工具默认值
- `apiKey` 为空时不注册 `web_search` 和 `web_fetch`
- `enabled: false` 时不注册 `web_search` 和 `web_fetch`
- 工具输入参数会正确映射到 SDK 请求
- 配置里的 `maxResults` 超范围时被限制或校验失败
- `web_search` 成功响应会格式化成 Markdown
- `web_fetch` 成功响应会格式化成 Markdown
- `web_fetch` 会拒绝非 http/https、localhost、内网 URL
- `web_search` 调用前会触发实时确认
- `web_fetch` 调用前会触发实时确认
- 401 / 429 / 400 / 网络错误会返回 `isError: true`

## 14. 推荐第一版决策

暂定方案：

- 工具名：`web_search`、`web_fetch`
- 实现方式：使用 `@tavily/core` SDK
- 配置：使用 `config.json`
- 默认启用：`false`
- 默认搜索深度：`basic`
- 默认结果数：`10`
- 默认不返回 raw content
- 默认不返回 search answer
- 默认 fetch 格式：`markdown`
- 输出：中性的 Markdown `Search results` / `Fetch results`
- 第一版同时做 Search 和 Fetch，不单独暴露 Extract
- `web_search` 和 `web_fetch` 都加入实时确认清单
- 工具描述和工具结果不暴露 Tavily 品牌
