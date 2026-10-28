# 阶段 7 规格说明：Provider / 配置 / Thinking / 会话恢复重构

本文档定义阶段 7 的正式规格。  
目标是收敛配置结构、统一 provider 接入方式、统一 thinking 抽象、修正最终回复链路，并让会话恢复逻辑符合当前产品预期。

---

## 1. 目标

- 收敛 `config.json`，只保留用户真正需要维护的配置项
- 去掉默认 `日常` session 逻辑
- 启动时默认恢复“上一次退出时所在的最后会话”
- provider 模型列表改为用户配置，不再前端硬编码
- 去掉独立 `Thinking` 开关与数字型 budget 输入
- 对用户统一暴露 thinking 五档：
  - `none`
  - `minimal`
  - `low`
  - `medium`
  - `high`
- 最终回复链路采用方案 C：
  - 工具调用阶段继续使用非流式 `complete()`
  - 最终文本基于最后一次 `complete()` 的结果做服务端伪流式输出
  - 不再对同一条最终回复重复发起第二次模型请求

---

## 2. 配置结构

### 2.1 初始化配置收敛

初始化生成的 `config.json` 中不再写入以下内容：

- `session.defaultSession`
- `server`
- `fs`

说明：

- `server` 与 `fs` 仍然在代码内保留默认值
- 只是它们不再作为初始化时直接暴露给用户的配置项

### 2.2 `server` 配置规则

- 初始化生成的 `config.json` 不写入 `server`
- 代码内保留默认值：
  - `port`
  - `host`
- 如果用户手动在 `config.json` 中加入：
  - `server.port`
  - `server.host`
  则优先使用用户配置

### 2.3 `fs` 配置规则

- 初始化生成的 `config.json` 不写入：
  - `fs.allowedDirs`
  - `fs.allowedFiles`
- 文件系统访问白名单改为代码内固定默认值

### 2.4 `providers.<name>.models` 结构

provider 对应的模型候选列表放入 `config.json`，不再前端硬编码。

固定结构为：

- `providers.zai.models = [{ id, label }]`
- `providers.dashscope.models = [{ id, label }]`

当前默认模型列表示例：

- `zai`
  - `GLM-4.5-Air`
  - `GLM-4.7`
  - `GLM-5.1`
- `dashscope`
  - `qwen3.6-27b`
  - `qwen3.6-flash`
  - `qwen3.6-plus`

### 2.5 默认 provider / model / tokens

- `defaultProvider = "zai"`
- `defaultModel = "GLM-4.7"`
- `defaultThinkingEffort = "low"`
- `maxTokens = 4096`

### 2.6 ZAI 默认 endpoint

初始化默认配置中，`zai.baseUrl` 使用 CN endpoint：

- `https://open.bigmodel.cn/api/paas/v4`

### 2.7 `compaction` 默认值

初始化配置中的 `compaction` 默认值为：

- `provider = "zai"`
- `model = "glm-4.5-air"`
- `thinkingEffort = "none"`

并且：

- `compaction.provider` 必填
- 若缺失则 compaction 直接报错
- 不回退到 `defaultProvider`

### 2.8 新配置结构示例

```json
{
  "providers": {
    "zai": {
      "apiKey": "",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "models": [
        { "id": "GLM-4.5-Air", "label": "GLM-4.5-Air" },
        { "id": "GLM-4.7", "label": "GLM-4.7" },
        { "id": "GLM-5.1", "label": "GLM-5.1" }
      ]
    },
    "dashscope": {
      "apiKey": "",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "models": [
        { "id": "qwen3.6-27b", "label": "qwen3.6-27b" },
        { "id": "qwen3.6-flash", "label": "qwen3.6-flash" },
        { "id": "qwen3.6-plus", "label": "qwen3.6-plus" }
      ]
    }
  },
  "defaultProvider": "zai",
  "defaultModel": "GLM-4.7",
  "defaultThinkingEffort": "low",
  "maxTokens": 4096,
  "contextMaxTokens": 100000,
  "contextMaxMessages": 0,
  "maxToolCalls": 10,
  "compaction": {
    "provider": "zai",
    "model": "glm-4.5-air",
    "thinkingEffort": "none"
  }
}
```

### 2.9 Schema 约束

核心约束如下：

- provider enum 固定为：
  - `"zai"`
  - `"dashscope"`
- 不支持旧格式自动迁移
- 如果 `config.json` 不符合新 schema，则启动时报错，提示用户手动更新
- `defaultModel` 必须属于 `defaultProvider` 对应的 `models` 列表

---

## 3. 会话默认进入与恢复逻辑

### 3.1 去掉默认 `日常`

- 去掉默认 `日常` session 的相关逻辑
- 去掉 `config.json` 中的 `session.defaultSession`

### 3.2 最后活跃会话恢复

每次进入项目时：

- 不再自动创建或进入默认 `日常` 会话
- 改为默认进入“上一次退出项目时所在的最后一个会话”

实现方式：

- 使用独立状态文件：
  - `files/app_state.json`

初版只存一个字段：

```json
{
  "lastActiveSessionId": "abc123"
}
```

写入时机：

- 切换会话时立即写入 `app_state.json`

恢复顺序：

1. 若记录的最后活跃会话存在，则进入它
2. 否则如果已有会话，则进入最近活跃会话
3. 否则自动创建一个空白新会话

### 3.3 首次启动无会话

如果首次启动且当前没有任何会话：

- 自动创建一个空白新会话
- 不叫 `日常`
- 标题可使用 `New Chat`

---

## 4. Thinking 抽象统一

### 4.1 用户侧统一抽象

对用户暴露的 thinking 强度统一为五档：

- `none`
- `minimal`
- `low`
- `medium`
- `high`

语义约定：

- `none`：不推理
- 其余四档：开启推理，强度逐级增加

### 4.2 运行时字段命名

运行时统一使用字段名：

- `thinkingEffort`

适用范围：

- 前端发送给后端的本次请求参数
- `CompletionOptions`
- provider 内部映射输入
- `compaction.thinkingEffort`

不再使用：

- `enableThinking`
- `thinkingBudget`
- `thinkingLevel`

### 4.3 前端交互

- 去掉独立 `Thinking` 按钮
- 去掉数字型 budget 输入框
- 前端只暴露一个 `thinking effort` 下拉选择
- 选项固定为：
  - `none`
  - `minimal`
  - `low`
  - `medium`
  - `high`

### 4.4 provider 内部映射原则

- 各 provider 在自己的实现文件内部负责把五档映射为对应的原生参数
- 不直接对用户暴露 provider 原生 budget 格式

### 4.5 ZAI 映射

`zai` 的映射固定为：

- `none` -> `thinking: { type: "disabled" }`
- `minimal` -> `thinking: { type: "enabled" }`
- `low` -> `thinking: { type: "enabled" }`
- `medium` -> `thinking: { type: "enabled" }`
- `high` -> `thinking: { type: "enabled" }`

说明：

- `zai` 当前不支持数值型 thinking budget
- 因此除 `none` 外，其余四档当前统一映射为开启 thinking

### 4.6 DashScope 映射

`dashscope` 的映射固定为：

- `none` -> 不开启 thinking，不传数值 budget
- `minimal` -> `512`
- `low` -> `1024`
- `medium` -> `4096`
- `high` -> `8192`

说明：

- `none`
  - `enable_thinking = false`
  - 不传 `thinking_budget`
- 其余四档
  - `enable_thinking = true`
  - 按档位传 `thinking_budget`

---

## 5. Provider API 与调用约定

### 5.1 DashScope

**Provider 标识**：`dashscope`

**API 信息**：

- Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- 协议：OpenAI 兼容 `/chat/completions`

**调用约定**：

- 工具调用阶段使用非流式 `complete()`
- 最终回复阶段在阶段 7 中不再使用 provider `stream()`
- thinking 通过：
  - `enable_thinking`
  - `thinking_budget`
 传入

**Token usage 约定**：

- `outputTokens = completion_tokens_details.text_tokens`
- `billingOutputTokens = completion_tokens`
- `thinkingTokens = completion_tokens_details.reasoning_tokens`
- `cachedTokens` 当前省略

### 5.2 ZAI

**Provider 标识**：`zai`

**API 信息**：

- Base URL 默认使用：
  - `https://open.bigmodel.cn/api/paas/v4`

**调用约定**：

- 工具调用阶段使用非流式 `complete()`
- 最终回复阶段在阶段 7 中不再使用 provider `stream()`
- thinking 通过：
  - `thinking: { type: "enabled" | "disabled" }`
 传入

---

## 6. 最终回复链路重构

### 6.1 当前问题

旧实现中：

- 工具调用阶段使用非流式 `complete()`
- 当最后一轮 `complete()` 已经返回最终回复后
- 又再次调用一次 `stream()`

这会导致：

- 对同一条最终回复重复发起第二次模型请求
- 增加延迟和成本
- `complete()` 与 `stream()` 返回内容可能不一致
- token usage 统计失真

### 6.2 目标方案

最终回复阶段采用方案 C：

- 工具调用阶段仍然使用非流式 `complete()`
- 当最后一轮 `complete()` 已返回最终回复文本后：
  - 不再再次调用 `stream()`
  - 改为服务端基于该文本做伪流式分段输出给前端

### 6.3 伪流式切块策略

伪流式切块规则固定为：

- 优先按句子 / 标点切块
- 过长时再按长度切块

### 6.4 usage 统计口径

最终 usage 统计规则固定为：

- 总 usage = 整个 agent loop 中所有 `complete()` 的 usage 累加
- 不再叠加已取消的第二次 `stream()` 成本

---

## 7. 前端与后端接口

### 7.1 `GET /api/config`

返回：

```json
{
  "availableProviders": ["zai", "dashscope"],
  "providers": {
    "zai": {
      "models": [{ "id": "GLM-4.7", "label": "GLM-4.7" }]
    },
    "dashscope": {
      "models": [{ "id": "qwen3.6-plus", "label": "qwen3.6-plus" }]
    }
  },
  "defaultProvider": "zai",
  "defaultModel": "GLM-4.7",
  "defaultThinkingEffort": "low"
}
```

约束：

- 只返回已配置 apiKey 的 provider 到 `availableProviders`
- 不暴露 apiKey
- provider 的模型列表从配置中读取，不再前端硬编码

### 7.2 `GET /api/app-state`

返回：

```json
{
  "lastActiveSessionId": "abc123"
}
```

### 7.3 WebSocket `chatMessage`

发送结构：

```ts
{
  type: "chatMessage";
  sessionId: string;
  content: string;
  provider: "zai" | "dashscope";
  model: string;
  thinkingEffort: "none" | "minimal" | "low" | "medium" | "high";
}
```

### 7.4 会话 metadata

每个会话的 metadata 记录：

- `lastProvider`
- `lastModel`

用途：

- 切回会话时恢复该会话上次使用的 provider / model

不记录：

- `thinkingEffort`

切换会话时：

- `thinkingEffort` 重置为 `defaultThinkingEffort`

---

## 8. 实现顺序建议

建议按以下顺序实施：

1. 配置 schema 与初始化收敛
2. 会话默认进入与恢复逻辑重构
3. provider / model 配置化
4. thinking effort 五档抽象与 provider 映射
5. 最终回复伪流式替代第二次 `stream()`
6. 测试与文档同步

---

## 9. 验收标准

- 初始化生成的 `config.json` 更简洁，只包含用户真正需要维护的项
- `config.json` 初始化中不再包含：
  - `session`
  - `server`
  - `fs`
- 代码内仍保留 `server` / `fs` 默认值，且允许用户手动覆盖 `server`
- 默认不再进入 `日常` 会话
- 启动时默认恢复最后活跃会话
- `app_state.json` 初版只保存 `lastActiveSessionId`
- provider 模型列表来自配置，不再前端硬编码
- `providers.<name>.models` 使用 `[{ id, label }]`
- 前端不再有独立 `Thinking` 按钮和数字 budget 输入
- 用户始终只看到：
  - `none`
  - `minimal`
  - `low`
  - `medium`
  - `high`
- `zai` / `dashscope` 都能正确映射到各自底层 thinking 参数
- 最终回复阶段不再重复发起第二次模型请求
- usage 为整个 agent loop 所有 `complete()` 的累加值
