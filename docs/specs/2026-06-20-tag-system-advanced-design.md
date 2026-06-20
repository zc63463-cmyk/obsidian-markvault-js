# MarkVault 标签系统 — 高级设计方案调研

> **日期**：2026-06-20 | **调研来源**：UE Gameplay Tags / NNGroup 分类法 / 分面分类 / 知识库标签实践 / Obsidian 标签插件生态
>
> **目标**：从业界成熟设计中提炼标签系统的演进方向，超越当前简单线性标签。

---

## 1. 当前状态 vs 理想目标

| 维度 | 当前 MarkVault | 理想方向 |
|------|:----:|------|
| 标签结构 | 扁平 `tags: string[]` | 可选层级化 + 分面维度 |
| 选择 UI | 搜索 Popover（已优化）| 搜索 Popover + 最近使用 + 层级展开 |
| 筛选能力 | 单选（一次一个 tag）| 多选 + AND/OR 逻辑 |
| 关系 | 无标签间关系 | 同义词映射 + 关联标签推荐 |
| 可视化 | Count 徽章 | 标签云 / 关联图谱 / 维度分组 |
| 治理 | 无 | 受控词表 + 自动补全 + 同义词归一 |

---

## 2. 业界四大高级标签模式

### 2.1 UE Gameplay Tags — 层级标签的黄金标准

**核心设计**：点号分隔的层级标签 `Status.Stunned` / `Movement.Mode.Swimming`

```
标签:  Character.Enemy.Zombie
        Character.Enemy.Soldier
        Movement.Mode.Walking
        Movement.Mode.Swimming
        Movement.Mode.Dash
```

**杀手特性 — 部分匹配 (Partial Matching)**：
- `HasTag(Movement.Mode)` 能匹配到 `Movement.Mode.Walking`、`.Swimming`、`.Dash` **全部三个**
- 新增 `Movement.Mode.Teleport` 时，无需修改任何已有逻辑

**MarkVault 可借鉴**：
- 标签命名 `领域/子领域/具体概念`，如 `数据库/范式/BCNF`
- 筛选 `数据库` 时自动包含所有子标签
- 搜索栏支持层级路径展示

**实现成本**：中等。不需要改存储模型，在 tag 名称约定 + 筛选逻辑层做 prefix 匹配即可。

---

### 2.2 分面分类 (Faceted Classification) — 多维正交标签

**核心思想**：标签按「维度」分组，每个维度独立过滤，复合使用 AND 逻辑。

**三大典型场景维度**：

| 场景 | 示例维度 |
|------|---------|
| 考研复习 | 科目(高数/线代/概率) + 掌握度(未掌握/熟练/精通) + 来源(课本/真题/笔记) |
| 技术文档 | 模块(UserAPI/BillingAPI) + 概念(OAuth/Pagination) + 语言(Python/Go) + 版本(v1/v2) |
| 项目管理 | 状态(draft/review/published) + 优先级(P0/P1/P2) + 负责人 |

**实现方式对比**：

| 策略 | 做法 | 适用 |
|------|------|------|
| **命名约定** | `status:approved`, `difficulty:intermediate` | 轻量，无需改数据模型 |
| **元数据层** | 标签表加 `facet` 字段，创建时选择维度 | 结构化，治理严格 |

**MarkVault 当前**：已经有部分分面能力！
- `fields` (key-value) 是分面的雏形
- `mastery` / `reviewPriority` / `motivation` 是内置专用维度
- `tags` 可以升级为支持命名约定（如 `topic:数据库` / `type:定义`）

**建议**：先在 tags 层支持冒号前缀解析（轻量分面），在 FilterBar 中按前缀分组展示。

---

### 2.3 受控词表 — 标签治理 & 同义词归一

**NNGroup 核心原则**：
- 标签系统必须是**受控词表**：不能随心所欲建标签，从既定列表中选择
- **同义词映射**是保障检索完整性的关键

**问题场景**：
> 同一个概念在不同标注中出现为 `#数据库范式`, `#范式`, `#NormalForm`, `#NF`
> → 筛选任何一个都会丢失其他三个的内容

**解决方案**：

```
# 同义词映射（不改变存储，只在搜索筛选层生效）
数据库范式 → [数据库范式, 范式, NormalForm, NF]
纠偏标记 → [纠偏标记, 纠错, correction, fix]
```

**实现建议**：
- 在插件 Settings 中维护一组同义词映射表
- 筛选某 tag 时，自动扩展为同义词组
- 自动补全时优先推荐「首选术语」

---

### 2.4 标签云 & 关联图谱 — 可视化层

| 可视化类型 | 做什么 | MarkVault 借鉴点 |
|-----------|--------|-----------------|
| **标签云** | 按使用频率渲染大小/颜色 | 侧边栏 Tag Cloud 面板，一眼看出知识图谱的热点概念 |
| **标签共现网络** | 同一标注上的 tag → tag 连接 | RelationGraph 中可以加 Tag 节点层 |
| **层级树** | 用 Tree View 展开多级标签 | FilterBar `#` 按钮可选切换到树模式 |

**Obsidian 生态参考**：
- **Tag & Word Cloud** — 在笔记中嵌入标签云
- **Tag Wrangler** — 标签面板中重命名/合并/搜索
- **TagFolder** — 标签模拟文件夹层级
- **graph-nested-tags-v3** — 嵌套标签（`parent/sub` 语法）

---

## 3. MarkVault 标签系统演进路线

### Phase 1：轻量分面（低实现成本，高回报）

当前 tags 是扁平字符串数组。引入冒号前缀约定：

```
topic:数据库
topic:计算机网络  
type:定义
type:习题
level:基础
level:进阶
```

**改动**：
- 创建标注时，标签输入框支持冒号前缀提示
- FilterBar 标签 Popover 按前缀分组渲染

### Phase 2：层级标签（中等成本）

支持 `数据库/范式/BCNF` 路径式标签：

**数据模型不变**：`tags: ["数据库/范式/BCNF"]`  
**筛选增强**：筛选 `数据库` → 自动包含所有 `数据库/*` 标签  
**UI 增强**：Popover 中支持层叠/缩进展示

### Phase 3：同义词映射 + 标签治理

**Plugin Settings 新增**：
```
Tag Synonyms:
  数据库范式 → [NormalForm, NF, 范式]
  纠偏标记 → [correction, 纠错, fix]
```

**效果**：搜索/筛选 `范式` → 自动找到所有标记为 `数据库范式`/`NormalForm`/`NF` 的标注

### Phase 4：多选筛选 + AND 逻辑

FilterBar tag 按钮改为支持**多选模式**：
- 点击一个 tag → 单选筛选
- 再点击另一个 → AND 叠加
- 已选标签以 chips 形式展示在 `#` 按钮旁

### Phase 5：标签可视化

- 侧边栏新增 **Tag Cloud** Tab：按频率渲染，点击即筛选
- RelationGraph 可选显示 **Tag Node** 层：标注 → Tag → 标注的间接路径

---

## 4. 立即可做的 P2 级优化

基于当前系统，以下优化无需改数据模型即可实施：

| 优化 | 描述 | 预估工时 |
|------|------|:--:|
| 🔧 标签 Popover「最近使用」区 | `getTagFrequencies()` 前 5 条标记为常用，固定在列表顶部 | 1h |
| 🔧 标签创建时自动补全 | 输入框中按前缀匹配现有标签，避免重复创建异形同义词 | 2h |
| 🔧 Tag 多选筛选 | FilterBar 支持一次性选多个 tag（AND 逻辑） | 3h |
| 🔧 冒号前缀分面 | 解析 `topic:` / `status:` 前缀在 FilterBar 中分组 | 2h |
| 🔧 层级标签 prefix 匹配 | 筛选 `数据库` → 自动匹配 `数据库/*` | 1h |

---

## 5. 参考项目

| 项目 | 亮点 | URL |
|------|------|-----|
| **UE Gameplay Tags** | 层级部分匹配、Tag Query 复合条件 | [UE Docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-gameplay-tags-in-unreal-engine) |
| **Obsidian Tag Wrangler** | 标签面板重命名/合并/搜索 | [GitHub](https://github.com/pjeby/tag-wrangler) |
| **graph-nested-tags-v3** | 嵌套标签 `parent/sub` 语法 | [GitHub](https://github.com/Herselfta/graph-nested-tags-v3) |
| **Notion Tags** | 多选筛选 + 分组视图 | notion.so |
| **Roam Research** | 双向链接 + 标签即页面 | roamresearch.com |

---

> **文档版本**：v1.0 | **调研人**：Senior Developer (高级开发工程师)
>
> **下一步**：确认 Phase 方向后，可进入 PRD → Issue 拆解 → TDD 开发流程。
