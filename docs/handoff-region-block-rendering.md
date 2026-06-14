# MarkVault Region/Block 渲染问题交接文档

## 项目背景

- **源码目录**：`E:/Development/MyAwesomeApp/markvault-js/`
- **部署目标**：`E:/Notes/数据库系统概论/.obsidian/plugins/markvault-js/`
- **构建命令**：`npm run build`（tsc + esbuild production）
- **测试命令**：`npm test`（目前 Block/Region 单元测试均通过）
- **版本**：`manifest.json` / `package.json` 3.0.0
- **当前 Git 提交**：`b73359d` — "WIP: block double-anchor list-aware + region inline/list experiments"

## 当前目标

让 **Region 标注**在阅读模式下采用 **Block 风格的段落级整块渲染**：

1. Region 锚点格式保持 `%%markvault-region:<uuid>:<type>:<color>:start|end:<note>%%`
2. 选中文本所在的整个段落/列表项作为一个块加背景色
3. 如果选区跨越多个段落，则每个段落独立加背景（不要求视觉合并）
4. 侧边栏中 Region 的 `text` 仍记录用户实际选中的文本
5. 可选边界标记：首块前 `▸`，末块后 `◂`

Block 标注部分已相对稳定；当前主要问题集中在 Region 的阅读模式渲染。

## 已实现的改动

### Block 双锚点（已相对稳定）

- 文件：`src/core/annotation-parser.ts`、`src/ui/editor/context-menu.ts`、`src/main.ts`
- 格式：`%%markvault-block:<uuid>:<type>:<color>:start|end:<note>%%`
- 阅读模式渲染：`applyBlockDecorationsFromSource` 从源文件行号映射到当前 section 的叶子块
- 列表感知：`getBlockAnchorPrefixesForListItem` 让 start/end 锚点缩进成列表项子内容，避免打断列表

### Region 段落级渲染（本次主要改动）

- 文件：`src/main.ts`
- 新方法：`highlightRegionBlocks`（约 line 1885）
  - 找到 start/end 锚点的最近块级祖先
  - 收集其间所有叶子块级元素
  - 给每个块添加 `markvault-region-block-mark` + type + color
  - 第一个块加 `markvault-region-block-first`
  - 最后一个块加 `markvault-region-block-last`
  - 中间块加 `markvault-region-block-middle`
- 内联锚点提取：`extractInlineRegionAnchors` / `extractInlineRegionAnchorsFromTextNode`
  - 把嵌入在普通文本节点中的 Region 锚点提取为隐藏 `<span class="markvault-region-anchor-hidden">`
  - 让 `highlightRegionBlocks` 能定位到段落/列表项
- Comment 节点正则修复：`collectRegionAnchor` 同时支持带 `%%` 和不带 `%%` 的格式
- CSS：`styles.css` 中新增 `.markvault-region-block-mark` 及首/尾伪元素 `▸ / ◂`

## 当前异常

从用户反馈和截图看，**Region 仍然以文本级高亮呈现**，而非段落级整块高亮：

- `selected text`、`inline code`、`const x = 1` 等被包裹为 inline span 高亮
- 整个段落/列表项没有背景色
- 没有看到 `▸ / ◂` 边界标记
- 控制台 `[MarkVault DEBUG]` 日志显示的是 Block 的 `applyBlockDecorationsFromSource`，未见 Region 相关调试输出

这意味着 Region 处理大概率仍走 **fallback 路径**（`applyRegionStyleToSectionPrecise` / `applyRegionStyleToSection`），而没有进入 scheme A 的 `highlightRegionBlocks`。

## 关键代码位置

| 功能 | 文件 | 位置 |
|---|---|---|
| Region 阅读模式入口 | `src/main.ts` | `processRegionAnnotations`（约 line 1712） |
| Region 段落级高亮 | `src/main.ts` | `highlightRegionBlocks`（约 line 1885） |
| 内联锚点提取 | `src/main.ts` | `extractInlineRegionAnchors` / `extractInlineRegionAnchorsFromTextNode` |
| Region 解析 | `src/core/region-annotation.ts` | `parseRegionAnnotations`、`buildRegionAnchor` |
| Block 阅读模式渲染 | `src/main.ts` | `applyBlockDecorationsFromSource`（约 line 1320） |
| 叶子块收集 | `src/main.ts` | `collectLeafBlocks`（约 line 1476） |
| Region 样式 | `styles.css` | `.markvault-region-block-mark` 及伪元素 |

## 测试文档

- **Region 专用测试文档**：`E:/Notes/数据库系统概论/docs/MarkVault-Region-Test.md`
  - 12 个场景：单段落、有序/无序列表项、跨项、嵌套列表、行内代码/公式、段落+列表混合、bold/underline 类型
- **Block/Region 混合测试文档**：`E:/Notes/数据库系统概论/docs/MarkVault-Block-List-Test.md`
  - Block 7 个场景 + Region 7 个场景 + Inline-Style 12 个场景

## 已知线索

1. `processRegionAnnotations` scheme A 调用 `highlightRegionBlocks` 的条件是 `regionAnchors.size > 0`
2. Region 锚点可能被 Obsidian 渲染为：
   - HTML Comment 节点（内容通常不带外层 `%%`）
   - 独立元素节点（`<p>%%markvault-region...%%</p>`）
   - 内联文本节点（和正文混在一起）
3. 已修复 comment 正则同时支持带/不带 `%%`
4. 已添加 inline 锚点提取逻辑
5. 用户已禁用/启用插件重载，仍无效

## 待解决事项

1. **确定 Region 为何没进入 scheme A**
   - 是否 `regionAnchors` 始终为空？
   - 是 comment 检测失败、元素检测失败，还是 inline 提取失败？
   - 建议在 `processRegionAnnotations` 开头和 scheme A 分支加 `console.log` 输出 `regionAnchors` 内容

2. **验证 `highlightRegionBlocks` 是否能正确找到块级祖先**
   - 如果 scheme A 进入但高亮仍不对，检查 `findNearestBlockAncestor` 返回值
   - 检查 `collectLeafBlocks` 是否把隐藏锚点 span 误当叶子块

3. **CSS 是否生效**
   - 确认 `styles.css` 中的 `.markvault-region-block-mark` 和伪元素规则已加载
   - 检查是否有其他样式覆盖

4. **清理调试日志**
   - 当前 `applyBlockDecorationsFromSource` 仍有 `[MarkVault DEBUG]` 日志，修复后可移除

5. **测试覆盖**
   - 建议新增针对 Region 阅读模式渲染的单元测试或集成测试
   - 目前只有 `tests/region-annotation.test.ts` 覆盖解析，未覆盖阅读模式 DOM 渲染

## 建议排查步骤

1. 在 `processRegionAnnotations` 中加入日志：
   ```ts
   console.log('[Region DEBUG] anchors found', regionAnchors.size, Array.from(regionAnchors.entries()));
   ```
2. 在 `highlightRegionBlocks` 中加入日志：
   ```ts
   console.log('[Region DEBUG] highlight blocks', { startBlock, endBlock, targets: targets.map(t => t.tagName) });
   ```
3. 构建部署后，打开 `MarkVault-Region-Test.md` 阅读模式，查看 DevTools 控制台
4. 根据日志判断问题在哪一步：
   - 如果 `regionAnchors.size === 0` → 锚点检测失败 → 检查 comment/element/text 扫描逻辑
   - 如果 scheme A 进入但 `targets` 为空/错误 → `findNearestBlockAncestor` 或 `collectLeafBlocks` 有问题
   - 如果 targets 正确但无视觉 → CSS 未加载或被覆盖

## 部署说明

构建产物需复制到：
```
E:/Notes/数据库系统概论/.obsidian/plugins/markvault-js/
├── main.js
├── styles.css
└── manifest.json
```

由于 Obsidian 会缓存插件 JS，建议每次修改后：
1. `npm run build`
2. 复制文件到目标目录
3. 在 Obsidian 中：Settings → Community Plugins → 关闭 MarkVault → 重新开启
4. 或完全退出 Obsidian 重新打开
