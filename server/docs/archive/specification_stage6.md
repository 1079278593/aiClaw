# 阶段 6 规格文档：知识库总览

## 1. 功能概述

在右侧边栏新增一个知识库按钮，点击后展示当前所有知识库的情况。知识库本身由 AI 通过对话管理，本阶段不提供手动增删操作。

---

## 2. 后端 API

### `GET /api/knowledge`

扫描 `$AICLAW_DATA_DIR/knowledge_base/` 目录，返回所有知识库的信息。

**响应格式：**

```typescript
{
  bases: Array<{
    name: string;        // 目录名
    description: string; // 从 knowledge_base/index.md 表格中解析，找不到则为空字符串
    files: string[];     // 目录下所有文件，排除 index.md，仅文件名
  }>
}
```

**实现细节：**

1. 读取 `knowledge_base/index.md`，解析 Markdown 表格，提取 `name → description` 映射
   - 表格格式：`| name | description |`（知识库名为纯文本，不是链接）
   - 解析失败或文件不存在时，description 全部为空字符串
2. 扫描 `knowledge_base/` 下的一级子目录，每个子目录为一个知识库
3. 对每个子目录，列出所有文件（`fs.readdir`），过滤掉 `index.md`
4. 合并目录扫描结果和 index.md 解析结果，返回

**错误处理：**
- `knowledge_base/` 目录不存在：返回 `{ bases: [] }`
- 单个知识库目录读取失败：跳过该知识库，不影响其他

---

## 3. 前端 UI

### 3.1 右侧边栏按钮

- 在现有右侧边栏（已有 Token 统计、Thinking 开关）新增一个知识库按钮
- 显示： “Knowledge Base”
- 点击后打开知识库面板（与 Token 统计面板同样的 modal/drawer 形式）,注意页面风格保持一致

### 3.2 知识库面板

**面板标题：** 知识库

**内容布局：**

每个知识库显示为一个卡片/区块：

```
知识库名称
简介文字（如有）
  文件1.md
  文件2.md
  文件3.md
  文件4.md
  文件5.md
  [展开查看全部 N 个文件 ▼]   ← 超过5个时显示
```

**折叠规则：**
- 文件数 ≤ 5：直接展示全部文件名，无折叠
- 文件数 > 5：默认只显示前5个，底部显示"展开查看全部 N 个文件"按钮，点击后展开全部，再次点击收起

**空状态：**
- 没有任何知识库时：显示"暂无知识库"

**加载时机：**
- 每次点击按钮时重新请求 `GET /api/knowledge`（不缓存）

---

## 4. 知识库写作规则机制

### 4.1 `knowledge_base/instructions.md`

初始化时创建（已存在则跳过），内容为知识库的写作规范，例如：

```markdown
# 知识库写作规则

## 目录结构

- `inputs/`：用户放入原始资料的地方（文章、笔记、摘录等）
- `knowledge_base/index.md`：全局索引，列出所有知识库名称和简介
- `knowledge_base/<库名>/index.md`：该库的局部索引，说明库的主题和文件列表
- `knowledge_base/<库名>/<文章>.md`：知识库中的具体文章

## 文章写作

- 每篇文章聚焦一个概念或主题，内容来自对原始资料的提炼和综合，而非简单复制
- 文章之间用 `[[文章名]]` 或 Markdown 链接互相引用（backlink）
- 如果一个概念在多篇文章中出现，提取为独立文章，其他文章链接到它

## 索引维护

- 新增文章后，同步更新该库的 `index.md` 文件列表
- 新增知识库后，同步更新全局 `knowledge_base/index.md`，表格格式：`| 知识库名 | 简介 |`（知识库名为纯文本，不是链接）
- 删除文章或知识库后，同步清理对应的索引条目

## 整理原始资料的流程

1. 读取 `inputs/` 中的文件，理解内容
2. 判断归属：放入已有知识库，或新建知识库，不确定时询问用户
3. 将内容提炼为文章，写入对应知识库目录
4. 更新索引
```

### 4.2 System Prompt 变更

`agent_system_prompt.txt` 默认内容更新为：

```
你是一个私人 AI 助手。
- 回答简洁、直接，避免废话
- 优先用中文回复
- 遇到不确定的事情，直接说不知道

## 工具使用

你有文件读写工具，路径均相对于数据目录。

## 知识库

知识库位于 knowledge_base/ 目录：
1. 先读 `knowledge_base/index.md` 了解有哪些知识库
2. 再读对应知识库的 `knowledge_base/<库名>/index.md` 了解该库内容
3. 按需读取具体文件
4. 新增知识库时，直接写文件（目录自动创建），并更新两级 index.md
5. 新增或修改知识库内容前，先读 `knowledge_base/instructions.md` 了解写作规则

## 记忆

- 每次对话会自动注入当前记忆
```

初始化代码（`src/config/index.ts`）需同步：
1. 新增 `knowledge_base/instructions.md` 的初始化逻辑
2. 更新 `agent_system_prompt.txt` 的默认内容

---

## 5. 不在本阶段实现

- 知识库的创建、删除、重命名（由 AI 通过对话操作文件系统完成）
- 文件内容预览
- inputs/ 文件列表展示
- 知识库搜索
