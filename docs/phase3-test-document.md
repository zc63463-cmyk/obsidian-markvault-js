# MarkVault Phase 3 — Fields System 测试文档

> 版本: 3.0.0 | 更新日期: 2026-06-13  
> 测试范围: 自定义字段（Fields）全链路功能

---

## 一、功能概述

Phase 3 Fields System 为标注新增了**自定义键值对**能力，覆盖以下功能模块：

| 模块 | 功能点 | 涉及文件 |
|------|--------|----------|
| 数据模型 | `fields: Record<string, string>` + `FieldDef` + `FieldTemplate` | `types/annotation.ts` |
| 字段工具 | encode / decode / applyTemplate | `utils/fields.ts` |
| 存储引擎 | `_byField` 倒排索引 + `_stripExtraFields` + queryByField | `db/annotation-store.ts` |
| Markdown 解析 | `data-fields="..."` 属性读/写/更新 | `core/annotation-parser.ts` |
| 数据同步 | MD↔Store 双向 fields 合并 | `core/markdown-sync.ts` |
| 编辑 Modal | Fields 编辑区 + 模板应用 + 软长度警告 | `ui/editor/annotation-modal.ts` |
| 右键菜单 | "Annotate with field" + 快捷模板标注 | `ui/editor/context-menu.ts` |
| 侧边栏 | 字段过滤 + 字段标签展示 + 导出 | `ui/sidebar/AnnotationSidebar.ts` |
| 设置页 | 字段模板 CRUD | `ui/settings/settings-tab.ts` |

---

## 二、测试环境准备

### 前置条件

1. Obsidian 已安装 markvault-js 插件（Phase 3 版本）
2. 插件已启用，侧边栏 MarkVault 视图可用
3. 准备一个测试用笔记文件（如 `测试笔记.md`），内容包含中英文混合文本

### 测试数据

在设置页确认默认模板已存在：
- **学术标注模板** (`academic`): category / importance / understanding
- **阅读笔记模板** (`reading`): type / action

---

## 三、测试用例

### 模块 A：字段编码/解码（`utils/fields.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| A1 | 基本编码 | `encodeFields({ category: "定义", importance: "高" })` | 返回 URL 编码字符串，含中文 percent-encoding | P0 |
| A2 | 基本解码 | `decodeFields("category=定义&importance=高")` | 返回 `{ category: "定义", importance: "高" }` | P0 |
| A3 | 空字符串解码 | `decodeFields("")` | 返回 `{}` | P0 |
| A4 | 空键过滤 | `encodeFields({ "": "value", "key": "val" })` | 空键被过滤，结果只有 `key=val` | P1 |
| A5 | 特殊字符编码 | `encodeFields({ "key": "a&b=c" })` | `&` 和 `=` 被 URL 编码 | P1 |
| A6 | Round-trip | `decodeFields(encodeFields({ "类别": "定理" }))` | 结果与原始对象完全一致 | P0 |
| A7 | 模板应用-空字段 | `applyTemplate(academic, {})` | 填入每个字段的第一个预设值 | P0 |
| A8 | 模板应用-保留已有 | `applyTemplate(academic, { category: "定理" })` | category 保留 "定理"，仅新增缺失字段 | P0 |

### 模块 B：Markdown 解析器（`core/annotation-parser.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| B1 | 解析带 fields 的 mark | 解析含 `data-fields` 属性的 `<mark>` 标签 | `fields` 解析为正确的键值对象 | P0 |
| B2 | 生成带 fields 的 mark | `buildMarkTag()` 生成含 fields 的标注 | 输出包含 `data-fields="..."` 属性 | P0 |
| B3 | 更新 mark 的 fields | `updateMarkTag()` 传入 fields 参数 | `data-fields` 属性正确更新 | P0 |
| B4 | 移除 fields 属性 | `updateMarkTag()` 传入 `fields: ""` | `data-fields` 属性被完整移除 | P0 |
| B5 | 无 fields 的标注 | 解析不含 `data-fields` 的 `<mark>` | `fields` 为 `undefined`（非空对象） | P0 |
| B6 | HTML 实体 round-trip | 生成含 `&` 或 `"` 的 fields 值再解析 | 值一致，无双重编码 | P1 |

### 模块 C：AnnotationStore 字段索引（`db/annotation-store.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| C1 | 添加带 fields 的标注 | `addAnnotation()` 写入 `{ fields: { category: "定义" } }` | `_byField` 索引包含 `category → { "定义" → Set<uuid> }` | P0 |
| C2 | 查询字段键列表 | `getFieldKeys()` | 返回所有已出现字段键名（排序后） | P0 |
| C3 | 查询字段值列表 | `getFieldValues("category")` | 返回该键的所有已出现值（排序后） | P0 |
| C4 | 字段过滤查询 | `queryAnnotations({ fieldFilters: { category: "定义" } })` | 仅返回 category="定义" 的标注 | P0 |
| C5 | 多字段组合过滤 | 同时传两个 fieldFilters | 返回同时满足所有条件的标注 | P1 |
| C6 | 删除标注时索引清理 | 删除有 fields 的标注 | `_byField` 索引不再包含该 uuid | P0 |
| C7 | 更新标注的 fields | `updateAnnotation()` 修改 fields | 旧索引清理 + 新索引建立 | P0 |
| C8 | 空 fields 不持久化 | `addAnnotation()` 写入 `{ fields: {} }` | 分片 JSON 中不含 `fields` 键 | P1 |
| C9 | 统计含字段计数 | `getAnnotationStats()` | `withFields` 数量正确 | P1 |
| C10 | 偏移修复不改 updatedAt | `batchUpdateOffsets()` | `updatedAt` 不变（时间戳保护） | P1 |

### 模块 D：编辑 Modal（`ui/editor/annotation-modal.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| D1 | 打开带 fields 的标注 | 双击带 fields 的标注 | Modal 显示 Fields 区域及已有字段行 | P0 |
| D2 | 新增字段行 | 点击 "+ Add Field" | 新增一行空字段（key 默认 `fieldN`） | P0 |
| D3 | 编辑字段键 | 修改 key 输入框 | `fieldsValue` 实时更新 | P0 |
| D4 | 编辑字段值 | 修改 value 输入框 | `fieldsValue` 实时更新 | P0 |
| D5 | 删除字段行 | 点击字段行 "✕" 按钮 | 该字段从列表移除 | P0 |
| D6 | 应用模板 | 选择 "学术标注" 模板 | 缺失字段被自动填充 | P0 |
| D7 | 模板保留已有值 | 先设 category="定理" 再应用模板 | category 保持 "定理" 不变 | P1 |
| D8 | 保存带 fields | 编辑后点 Save | Markdown `data-fields` 被正确更新 | P0 |
| D9 | 清除所有 fields | 删除所有字段行后 Save | Markdown `data-fields` 属性被移除 | P0 |
| D10 | 空键过滤 | 保留 key 为空的行后 Save | 空键字段不写入保存结果 | P1 |
| D11 | 超长值警告 | 输入 >1000 字符 | 输入框边框变红 + tooltip | P2 |
| D12 | 无 fields 的标注 | 打开无 fields 的标注 | Fields 区域为空 | P0 |

### 模块 E：右键菜单字段操作（`ui/editor/context-menu.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| E1 | "Annotate with field" | 选中文字后右键 | 菜单出现该选项 | P0 |
| E2 | 使用默认模板标注 | 点击 "Annotate with field" | 创建标注并自动填充模板 fields | P0 |
| E3 | 模板字段子菜单 | 展开 "Annotate with field" | 显示模板每个字段的子菜单 | P1 |
| E4 | 快捷标注 | 选择 category→"定理" | 创建标注，fields 含 category="定理" | P1 |
| E5 | 无默认模板 | 默认模板 ID 为空 | 选项仍可用，fields 为空 | P2 |

### 模块 F：侧边栏字段功能（`ui/sidebar/AnnotationSidebar.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| F1 | 字段标签展示 | 查看带 fields 的标注卡片 | 卡片底部显示字段标签 | P0 |
| F2 | 标签点击过滤 | 点击卡片中的字段标签 | 触发过滤，仅显示匹配标注 | P1 |
| F3 | 添加字段过滤 | 点击 "Add field filter" | 弹出字段键菜单 | P0 |
| F4 | 选择键和值 | 选键 "category"→值 "定义" | 过滤生效，列表更新 | P0 |
| F5 | 移除过滤 | 点击过滤条目 ✕ | 该条件移除，列表更新 | P1 |
| F6 | 多字段组合过滤 | 添加两个过滤条件 | 同时满足才显示 | P1 |
| F7 | MD 导出含 fields | 导出 Markdown 格式 | 含 `**Fields**: key=value` | P2 |
| F8 | JSON 导出含 fields | 导出 JSON 格式 | 含 fields 对象 | P2 |

### 模块 G：设置页模板管理（`ui/settings/settings-tab.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| G1 | 查看模板列表 | 打开设置页 | 显示默认两个模板 | P0 |
| G2 | 展开模板详情 | 点击模板名 | 显示字段定义列表 | P0 |
| G3 | 新建模板 | 点击 "+ New Template" | 创建空模板 | P0 |
| G4 | 添加字段 | 点击 "Add Field" | 新增字段行 | P0 |
| G5 | 编辑预设值 | 修改 values 文本框 | 预设值更新 | P1 |
| G6 | 删除字段 | 点击字段 ✕ | 字段移除 | P0 |
| G7 | 删除模板 | 点击模板 🗑️ | 模板移除 | P0 |
| G8 | 恢复默认模板 | 点击 "Restore Default Templates" | 恢复到初始状态 | P1 |
| G9 | 设置默认模板 | 下拉选择默认模板 | 保存到设置 | P1 |

### 模块 H：数据同步（`core/markdown-sync.ts`）

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| H1 | MD 有 fields，DB 无 | 手动添加 `data-fields` 后切换文件 | Store 更新为 MD 的值 | P0 |
| H2 | MD 和 DB 都有 | 两者一致 | 无额外更新 | P1 |
| H3 | MD 无 fields，DB 有 | 手动删除 `data-fields` 后切换文件 | DB 中 fields 保留不丢失 | P0 |
| H4 | block/span 的 fields | 编辑 block 标注 fields | fields 仅存 Store，不写 MD 锚点 | P1 |
| H5 | 保存后防重入 | Modal 保存 fields | modifyGuard 阻止重复 sync | P0 |

### 模块 I：边界条件与回归

| ID | 测试项 | 步骤 | 预期结果 | 优先级 |
|----|--------|------|----------|--------|
| I1 | 值含特殊字符 | 设置 fields 值 `a&b=c` | 编码/解码正确 | P0 |
| I2 | 值含中文 | 设置 fields 值 "重要定理" | URL 编码/解码正确 | P0 |
| I3 | 大量字段 | 添加 20+ 字段 | UI 正常，保存/加载无错 | P2 |
| I4 | 重复键 | 两行输入相同 key | 后者覆盖前者 | P1 |
| I5 | 仅改 fields | 只修改 fields 后保存 | updatedAt 更新，其他不变 | P1 |
| I6 | 重启后持久化 | 重启 Obsidian | fields 数据从分片 JSON 正确加载 | P0 |
| I7 | 迁移兼容 | 从旧版升级 | fields 数据保留 | P1 |

---

## 四、手动测试操作指南

### 测试 1：基本字段创建流程

1. 打开测试笔记，选中一段文字
2. 使用快捷键或右键创建高亮标注
3. 双击标注，打开编辑 Modal
4. 在 Fields 区域点击 **"+ Add Field"**
5. 输入 key: `category`，value: `定义`
6. 再添加一个字段：key: `importance`，value: `高`
7. 点击 **Save**

**验证点**：
- 打开 Markdown 源文件，确认 `<mark>` 标签包含 `data-fields="category=%E5%AE%9A%E4%B9%89&importance=%E9%AB%98"`
- 侧边栏卡片底部显示 `category: 定义` 和 `importance: 高` 标签
- 重新打开编辑 Modal，fields 区域仍显示两个字段行

### 测试 2：模板应用

1. 创建一个新标注
2. 双击打开 Modal
3. 在 "Apply template" 下拉框选择 **"学术标注"**
4. 观察 fields 自动填充为：
   - category: 定义
   - importance: 高
   - understanding: 已掌握
5. 修改 category 为 "定理"
6. 再次选择 "学术标注" 模板
7. **验证**：category 保持 "定理" 不变（模板不覆盖已有值）

### 测试 3：侧边栏字段过滤

1. 确保笔记中有多个带不同 fields 值的标注
2. 在侧边栏点击 **"Add field filter"** 按钮
3. 从菜单中选择 `category`
4. 从值菜单中选择 `定义`
5. **验证**：列表仅显示 category="定义" 的标注
6. 点击过滤条目的 ✕ 移除过滤
7. **验证**：列表恢复显示所有标注

### 测试 4：右键菜单快捷标注

1. 在设置页设置默认模板为 "学术标注"
2. 选中一段文字，右键
3. 点击 **"Annotate with field"**
4. **验证**：创建标注并自动填充学术标注模板的 fields
5. 展开子菜单，选择 `category → 定理`
6. **验证**：创建的标注 fields 中 category="定理"

### 测试 5：设置页模板管理

1. 打开设置 → MarkVault Settings
2. 点击 **"+ New Template"**
3. 命名为 "错题本"
4. 添加字段：key=`subject`，values=`数学,英语,物理`
5. 添加字段：key=`difficulty`，values=`简单,中等,困难`，取消勾选 allowCustom
6. 设置为默认模板
7. **验证**：新建标注时自动应用 "错题本" 模板

### 测试 6：数据持久化验证

1. 创建带 fields 的标注并保存
2. 完全关闭 Obsidian
3. 重新打开 Obsidian 和测试笔记
4. **验证**：
   - 标注仍带有之前保存的 fields
   - 侧边栏正确显示字段标签
   - 编辑 Modal 正确显示字段内容

### 测试 7：block/span 标注的 fields

1. 选中一个代码块或公式块，创建 block 标注
2. 双击打开 Modal，添加 fields
3. 保存
4. **验证**：
   - 侧边栏卡片显示 fields
   - Markdown 源文件中 block 锚点**不含** fields 数据（fields 仅存 Store）
   - 重启后 fields 仍存在

### 测试 8：MD↔Store 双向同步

1. 在 Markdown 源文件中手动编辑 `<mark>` 的 `data-fields` 属性值
2. 切换到其他笔记再切回
3. **验证**：Store 中的 fields 更新为 MD 中的新值
4. 在 Markdown 源文件中手动删除 `data-fields` 属性
5. 切换到其他笔记再切回
6. **验证**：Store 中的 fields **保留**（不被 MD 缺失而清除）

---

## 五、自动化测试参考

已有单元测试文件：
- `tests/anchor-roundtrip.test.js` — 16 个 round-trip 测试用例（73 个断言）
- `tests/annotation-store.test.ts` — AnnotationStore 11 个测试用例

建议新增的自动化测试：

```
tests/fields-utils.test.ts    — encode/decode/applyTemplate 单元测试
tests/fields-parser.test.ts   — data-fields 解析/生成/更新 单元测试
tests/fields-sync.test.ts     — MD↔Store fields 同步 集成测试
```

---

## 六、已知限制

| 限制 | 说明 | 计划 |
|------|------|------|
| block/span 锚点不含 fields | `%%markvault:%%` 格式仅存 note，fields 仅在 Store | Phase 4 可能扩展锚点格式 |
| 字段值无硬长度限制 | 超过 1000 字符仅软警告（红框+tooltip） | 暂不硬限制 |
| 字段无类型系统 | 所有值均为 string，无数字/日期/布尔类型 | Phase 4 可能引入字段类型 |
| 模板 ID 生成 | 使用 `tpl-` + `Date.now()` | 够用，暂不优化 |

---

## 七、测试结果记录表

| 模块 | 用例数 | 通过 | 失败 | 阻塞 | 执行人 | 日期 |
|------|--------|------|------|------|--------|------|
| A: 编码/解码 | 8 | | | | | |
| B: Markdown 解析 | 6 | | | | | |
| C: Store 索引 | 10 | | | | | |
| D: 编辑 Modal | 12 | | | | | |
| E: 右键菜单 | 5 | | | | | |
| F: 侧边栏 | 8 | | | | | |
| G: 设置页 | 9 | | | | | |
| H: 数据同步 | 5 | | | | | |
| I: 边界/回归 | 7 | | | | | |
| **合计** | **70** | | | | | |
