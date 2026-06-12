# MarkVault Obsidian 插件 — 开发概览

## 项目位置
`E:/Development/MyAwesomeApp/obsidian-markvault`

## 已完成

### 构建状态
- ✅ TypeScript 类型检查通过（源码零错误）
- ✅ esbuild 生产构建成功（main.js 300KB）

### 文件清单 (16 个源文件)

| 文件 | 功能 | 状态 |
|------|------|------|
| `src/main.ts` | 插件入口，注册 CM6 扩展/命令/事件/视图 | ✅ |
| `src/types/annotation.ts` | Annotation interface + 5色 + 设置类型 | ✅ |
| `src/db/database.ts` | Dexie 初始化 + schema (8个索引) | ✅ |
| `src/db/annotation-repo.ts` | CRUD + 过滤查询 + 统计 + 偏移修正 | ✅ |
| `src/core/offset-recovery.ts` | 4层偏移恢复引擎 (移植自 note-vault) | ✅ |
| `src/core/offset-tracker.ts` | **CM6 增量偏移修正引擎** | ✅ 新增 |
| `src/core/annotation-parser.ts` | Markdown <mark> 解析/生成/更新/删除 | ✅ |
| `src/core/markdown-sync.ts` | Markdown ↔ IndexedDB 双写同步 | ✅ |
| `src/core/highlight-applier.ts` | **CM6 Decoration 编辑模式高亮** + 阅读模式 DOM | ✅ 重写 |
| `src/ui/sidebar/AnnotationSidebar.ts` | 侧边栏 (搜索/过滤/排序/跳转) | ✅ |
| `src/ui/editor/context-menu.ts` | 右键菜单 + 命令面板 (8个命令) | ✅ |
| `src/ui/editor/annotation-modal.ts` | 批注编辑 Modal | ✅ |
| `src/ui/settings/settings-tab.ts` | 插件设置页 | ✅ |
| `src/utils/id.ts` | UUID 生成 | ✅ |
| `src/utils/context.ts` | 上下文截取 (50 chars window) | ✅ |
| `src/utils/debounce.ts` | 防抖 | ✅ |
| `styles.css` | 5色×3类型样式 + 侧边栏 + Modal | ✅ |

### 核心架构

```
数据层:   IndexedDB (Dexie) ←→ Markdown <mark data-uuid>
业务层:   偏移恢复(4层) + 增量偏移修正(CM6) + 双写同步
表现层:   CM6 Decoration(编辑) + PostProcessor(阅读) + 侧边栏 + 右键菜单 + Modal
```

### CM6 Decoration 实现细节

**编辑模式（Source / Live Preview）渲染策略：**

```
原始 Markdown:  <mark data-uuid="abc" data-type="highlight" data-color="yellow">标注文本</mark>

CM6 渲染:
  ┌──────────────┬──────────┬───────────┐
  │  开标签隐藏   │ 内部文本  │ 闭标签隐藏 │
  │  replace      │ mark     │ replace    │
  │  Widget       │ deco     │ Widget     │
  │  (display:    │ (bg-color│ (display:  │
  │   none)       │  +style) │  none)     │
  └──────────────┴──────────┴───────────┘

用户看到:       [标注文本]  ← 带高亮背景色
```

**阅读模式渲染策略：**
- `registerMarkdownPostProcessor` 拦截渲染后的 HTML
- 找到 `mark[data-uuid]` 元素，添加 class + 内联样式

### 增量偏移修正实现细节

**3种变更情况处理：**

| 情况 | 条件 | 处理方式 |
|------|------|---------|
| 标注在变更之前 | `endOffset <= changeFrom` | 不处理 |
| 标注在变更之后 | `startOffset >= changeTo` | startOffset += delta, endOffset += delta |
| 变更与标注重叠 | 重叠 >50% | 删除标注；否则调整偏移 |

**CM6 偏移追踪 Extension：**
- 轻量 ViewPlugin，不渲染任何 decoration
- 监听 `update.docChanged`，提取 `ChangeInfo[]`
- 通过回调通知 main.ts，微任务队列异步修正 IndexedDB
- 不阻塞 CM6 更新循环

### 关键差异化 (vs Highlightr-Plus)

| 能力 | Highlightr-Plus | MarkVault |
|---|---|---|
| 编辑模式高亮 | 旧式 DOM 操作 (setValue) | ✅ CM6 Decoration API |
| 阅读模式高亮 | CSS class 注入 | ✅ MarkdownPostProcessor |
| 偏移修正 | ❌ 不做 | ✅ CM6 增量 + 4层 batch |
| 点击跳转 | ❌ | ✅ offsetToPos + scrollIntoView |
| UUID 关联 | ❌ | ✅ data-uuid 双向桥梁 |
| 跨笔记搜索 | ❌ | ✅ Dexie where() |
| 标注被删检测 | ❌ | ✅ 重叠>50%自动删除 |

## 待完善 (后续迭代)

1. ✅ ~~CM6 Decoration — 编辑模式实时高亮~~ (已完成)
2. ✅ ~~精确增量偏移修正 — CM6 Transaction delta 计算~~ (已完成)
3. **实际 Obsidian 环境测试** — 安装到 vault 验证
4. **标注悬浮提示优化** — 编辑模式下悬浮显示批注内容
5. **批量操作** — 全选/批量删除/批量修改颜色
6. **Obsidian 主题适配** — dark/light 主题颜色微调

## 使用方式

```bash
# 开发
cd E:/Development/MyAwesomeApp/obsidian-markvault
npm run dev

# 构建
npm run build

# 安装到 Obsidian vault
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/obsidian-markvault/
```
