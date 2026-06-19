# MindFlow 新功能深度审查

> 审查日期: 2026-06-19 00:55 | 范围: P1(拖拽+时间轴) + P2(大纲+导出) + P3(小地图+外框) + 布局引擎

## 审查结论

新功能整体可用，但存在 **3 个 P1 级** 和 **8 个 P2 级** 问题。

---

## P1 — 功能缺陷（影响体验）

### F1: 拖拽缺少移动阈值 — 单击即触发拖拽

**文件**: `mindflow-view.ts:1220-1229`

**问题**: `mousedown` 直接调 `_startDrag()`，没有判断鼠标是否实际移动了 >5px。用户单击 Free 节点 → 立即创建幽灵副本 → 释放时可能误触发 `moveNode`。

**修复**: 在 `mousedown` 中只记录起始位置，在 `mousemove` 中判断距离 >5px 后才真正 `_startDrag`。

### F2: 大纲模式不随树变化刷新

**文件**: `mindflow-view.ts:786-886`

**问题**: `showOutline()` 只在 `toggleOutline()` 时渲染一次。之后添加/删除/移动/编辑节点 → 大纲内容过期，显示已删除的节点或缺少新节点。

**修复**: `layoutAndRender()` 末尾如果 `_isOutlineMode` 为 true，调 `hideOutline()` + `showOutline()` 重建大纲。

### F3: 外框数据不持久化 + 不随文件切换清理

**文件**: `mindflow-view.ts:1095-1185`

**问题**:
- `_boundaries` 数组纯内存，重载文件后丢失
- `loadFile()` / `resync()` 不清空 `_boundaries` → 切换文件后看到上一个文件的外框
- 删除节点后 `boundary.nodeIds` 引用已删除节点 → `findNode` 返回 null → 外框缩小或消失

**修复**: `loadFile()` 和 `resync()` 中清空 `_boundaries`；考虑持久化到 frontmatter（或标注为 session-only 功能）。

---

## P2 — 代码质量 / 边界情况

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| F4 | `timeline-layout.ts:57` | `children.length - 1` 当只有 1 个子节点时 `totalWidth=0`，轴起点=终点，退化 | 无害但视觉怪异，可接受 |
| F5 | `timeline-layout.ts:102` | `parent.children[0]` 直接访问无 null check（虽然前面有 length>0 检查） | 安全但脆弱 |
| F6 | `fishbone-layout.ts:62` | 同 F4，1 个分支时脊线退化为点 | 同上 |
| F7 | `mindflow-view.ts:996-997` | 小地图 mousemove 每帧调 `updateMinimap()` → Canvas 重绘，大文件可能卡顿 | 添加 rAF 节流 |
| F8 | `mindflow-view.ts:976-978` | Canvas 未使用 `devicePixelRatio` → Retina 屏模糊 | 设置 `canvas.width = 160 * dpr` |
| F9 | `mindflow-view.ts:919-926` | SVG 导出用 `foreignObject` 嵌入 HTML，但 CSS 样式未内联 → 导出文件在其他查看器中无样式 | 克隆时内联关键 CSS |
| F10 | `mindflow-view.ts:1235` | `_startDrag` 参数 `startX/startY` 未使用（幽灵位置在 `_updateGhostPosition` 中计算） | 清理参数 |
| F11 | `mindflow-view.ts:1254-1260` | 拖拽中 `_updateDropTarget` 用 `parseFloat(el.style.left)` 解析位置 — 如果 `el.style.left` 为空（首次未布局），返回 0 → 误判碰撞 | 用 `node.layout` 代替 DOM 解析 |

---

## 架构评估

### 做得好的部分

| 功能 | 评价 |
|------|------|
| 拖拽防环 | `_isDescendant` 检查到位 |
| 拖拽视觉反馈 | 幽灵副本 + 目标高亮，体验完整 |
| 时间轴连线 | 主轴圆点 + 垂直连线，视觉效果好 |
| 小地图导航 | 点击跳转 + 视口指示框，功能完整 |
| 小地图生命周期 | AbortController 清理 + onClose 清理 |
| 外框视觉 | 虚线 + 标签，符合 XMind 风格 |

### 需要改进的部分

| 模块 | 问题 | 优先级 |
|------|------|--------|
| 拖拽启动 | 无移动阈值，单击误触发 | **P1** |
| 大纲刷新 | 树变化后不更新 | **P1** |
| 外框生命周期 | 不持久化/不清理 | **P1** |
| 小地图性能 | mousemove 无节流 | P2 |
| SVG 导出 | CSS 未内联 | P2 |
| 碰撞检测 | 用 DOM style 解析代替 layout 数据 | P2 |

---

## 建议修复顺序

```
1. F1: 拖拽阈值 (5px minimum)
2. F2: 大纲自动刷新
3. F3: 外框 loadFile/resync 清理
4. F7: 小地图 rAF 节流
5. F11: 碰撞检测改用 node.layout
6. F8: Canvas devicePixelRatio
7. F9: SVG 导出内联 CSS
8. F4/F6: 退化情况处理
```
