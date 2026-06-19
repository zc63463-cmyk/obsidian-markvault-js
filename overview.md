# MindFlow Phase 2 — 节点内 Markdown 渲染 实现完成

> 日期: 2026-06-18 | 状态: ✅ 完成

## 完成内容

实现了 Phase 2 节点内 Markdown 渲染，节点内容通过 Obsidian `MarkdownRenderer.render()` 渲染，支持 LaTeX 公式、加粗、代码、内部链接等完整 Markdown 语法。

## 新增文件

| 文件 | 说明 |
|------|------|
| `src/mindflow/render/render-cache.ts` | 渲染缓存（LRU，MAX 500条，nodeId+text 哈希 key） |

## 修改文件

| 文件 | 改动 |
|------|------|
| `mind-node.ts` | +`renderedHeight?` / `renderedWidth?` 字段 |
| `tree-layout.ts` | `getNodeHeight` → 优先 renderedHeight 否则估算；+`estimateNodeHeight` / `relayoutWithMeasured` / `needsRelayout` / `subtreeNeedsRelayout` |
| `node-renderer.ts` | `renderNode` 只创建骨架 + content 容器；+`renderNodeContent`(async, MarkdownRenderer.render) / `renderNodesContent`(分批) / `enterEditMode` / `exitEditMode` |
| `mindflow-view.ts` | `layoutAndRender` → async 两遍布局管线；多处方法改 async；缓存管理 |
| `styles.css` | 节点内 MD 元素样式 + 渐入动画 + 编辑态 monospace + 位置 transition |

## 核心管线：两遍布局

```
Step 1: 占位布局（同步）
  → estimateNodeHeight() 估算高度
  → layoutTree() 立即定位
  → 用户看到导图骨架

Step 2: 异步渲染内容
  → MarkdownRenderer.render(app, text, el, path, component)
  → 分批: requestAnimationFrame 每帧 10 个
  → MathJax 排版 LaTeX 公式

Step 3: 刷新 MathJax
  → finishRenderMath()

Step 4: 重布局（仅当高度变化 > 8px）
  → relayoutWithMeasured() 用实际高度
  → CSS transition 平滑过渡
```

## 验证结果

| 检查项 | 结果 |
|--------|------|
| `tsc -noEmit -skipLibCheck` | ✅ exit 0 |
| `npm test` (MindFlow 部分) | ✅ 57/57 通过 |
| `esbuild production` | ✅ exit 0 |

## 测试新增（12 个）

- estimateNodeHeight: 纯文本/多行/块级公式/代码块 (4)
- getNodeHeight: 缓存优先/估算回退 (2)
- relayoutWithMeasured: 用实际高度重布局 (1)
- needsRelayout: 差异检测 (1)
- RenderCache: 读写/缓存失效/clear (3)
- subtreeNeedsRelayout: 递归检测 (1)
