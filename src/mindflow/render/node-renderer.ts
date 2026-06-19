/**
 * Node Renderer — 节点 DOM 渲染（Phase 2 Markdown 渲染）
 *
 * 为每个 MindNode 创建 DOM 元素，内容通过 Obsidian MarkdownRenderer 渲染：
 *   - md-seed:   实线边框，普通样式
 *   - free:      实线边框 + 右上角 "F" 角标
 *   - annotation: 虚线边框 + 左上角批注图标（Phase 3+ 预留）
 *
 * Phase 2 变更：
 *   - renderNode 不再渲染内容（只创建骨架），内容由 renderNodeContent 异步渲染
 *   - 新增 RenderCache 缓存渲染结果
 *   - 节点宽度支持动态（渲染后测量）
 */

import type { App, Component } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';
import { logger } from '../../utils/logger';
import type { MindNode } from '../types/mind-node';
import { estimateNodeHeight, estimateNodeWidth } from '../layout/tree-layout';
import { RenderCache } from './render-cache';

/** 节点 CSS 类名前缀 */
const NODE_CLS = 'mf-node';

/** R2-2: 渲染代次计数器类，每个 MindFlowView 实例独立一份，避免多视图竞态 */
export class RenderGenerationCounter {
  private _generation = 0;
  get current(): number { return this._generation; }
  increment(): number { return ++this._generation; }
}

/**
 * 创建单个节点的 DOM 骨架（不含内容）
 *
 * Phase 2: 内容渲染分离到 renderNodeContent()
 * @param node 已布局的 MindNode
 * @returns 节点 DOM 元素（未挂载到文档，内容为空）
 */
export function renderNode(node: MindNode): HTMLElement {
  const el = document.createElement('div');
  el.className = `${NODE_CLS} ${NODE_CLS}--${node.type}`;
  el.dataset.nodeId = node.id;
  el.dataset.nodeType = node.type;

  // 定位 — 显式设宽度（参考 xmind: JS 测量后设像素宽度）
  // 首次用估算值，异步渲染后由 renderNodeContent 更新为实际测量值
  const layout = node.layout;
  if (layout) {
    el.style.left = `${layout.x}px`;
    el.style.top = `${layout.y}px`;
    el.style.width = `${layout.width}px`;
    el.style.minHeight = `${layout.height}px`;
  }

  // 内容容器（MarkdownRenderer 渲染目标）
  const contentEl = document.createElement('div');
  contentEl.className = `${NODE_CLS}__content`;
  el.appendChild(contentEl);

  // Free 节点角标
  if (node.type === 'free') {
    const badge = document.createElement('span');
    badge.className = `${NODE_CLS}__badge ${NODE_CLS}__badge--free`;
    badge.textContent = 'F';
    el.appendChild(badge);
  }

  // Annotation 节点角标（Phase 3+ 预留）
  if (node.type === 'annotation') {
    const badge = document.createElement('span');
    badge.className = `${NODE_CLS}__badge ${NODE_CLS}__badge--annotation`;
    badge.textContent = 'A';
    el.appendChild(badge);
  }

  // Note 角标（有备注时显示）
  if (node.note) {
    const noteBadge = document.createElement('span');
    noteBadge.className = `${NODE_CLS}__badge ${NODE_CLS}__badge--note`;
    noteBadge.textContent = '\u{1F4DD}';
    noteBadge.dataset.action = 'view-note';
    el.appendChild(noteBadge);
  }

  // Detail 角标（md-seed 节点有详情时显示）
  if (node.detail) {
    const detailBadge = document.createElement('span');
    detailBadge.className = `${NODE_CLS}__badge ${NODE_CLS}__badge--detail`;
    detailBadge.textContent = '\u{1F4D6}';
    detailBadge.dataset.action = 'view-detail';
    el.appendChild(detailBadge);
  }

  // 折叠指示器
  if (node.children.length > 0) {
    const indicator = document.createElement('span');
    indicator.className = `${NODE_CLS}__collapse`;
    indicator.textContent = node.collapsed ? '+' : '-';
    indicator.dataset.action = 'toggle-collapse';
    el.appendChild(indicator);
  }

  // 折叠状态
  if (node.collapsed) {
    el.classList.add(`${NODE_CLS}--collapsed`);
  }

  return el;
}

/**
 * 异步渲染节点内容（Markdown → HTML）
 *
 * 使用 Obsidian MarkdownRenderer.render() 渲染节点文本：
 *   - 加粗/斜体/代码 → HTML 标签
 *   - LaTeX $...$ → MathJax 排版
 *   - 内部链接 [[note]] → 可点击链接
 *
 * 渲染完成后测量实际高度/宽度并回写到 MindNode。
 *
 * @param app Obsidian App 实例
 * @param node 要渲染的节点
 * @param el 节点 DOM 元素（renderNode 创建的）
 * @param sourcePath 源文件路径（用于解析内部链接）
 * @param component Component（管理渲染子组件生命周期）
 * @param cache 渲染缓存
 * @returns 实际渲染高度（用于判断是否需要重布局）
 */
export async function renderNodeContent(
  app: App,
  node: MindNode,
  el: HTMLElement,
  sourcePath: string,
  component: Component,
  cache: RenderCache,
  generationCounter?: RenderGenerationCounter,
): Promise<{ height: number; width: number }> {
  // R2-2: 使用实例级代次计数器，防止多视图竞态
  const generation = generationCounter?.current ?? 0;
  const contentEl = el.querySelector(`.${NODE_CLS}__content`) as HTMLElement;
  if (!contentEl) return { height: 0, width: 0 };

  // 1. 检查缓存
  const cached = cache.get(node.id, node.text);
  if (cached) {
    contentEl.innerHTML = cached.html;
    node.renderedHeight = cached.height;
    node.renderedWidth = cached.width;
    el.style.width = `${cached.width}px`; // P0-2: 缓存命中也更新 DOM 宽度
    el.classList.add(`${NODE_CLS}--rendered`);
    return { height: cached.height, width: cached.width };
  }

  // 2. 未缓存 → 异步渲染
  contentEl.empty();
  el.classList.add(`${NODE_CLS}--rendering`);

  // P0-1: 临时移除父元素宽度约束，让内容按自然宽度渲染
  const savedWidth = el.style.width;
  el.style.width = 'auto';

  try {
    await MarkdownRenderer.render(
      app,
      node.text,
      contentEl,
      sourcePath,
      component,
    );

    // 诊断: 检查渲染输出是否包含 HTML 标签
    const html = contentEl.innerHTML;
    const hasHtmlTags = /<[a-z][\s\S]*?>/i.test(html);
    if (!hasHtmlTags) {
      logger.warn('MindFlow: renderNodeContent output has no HTML tags for', node.id, 'text:', node.text.slice(0, 80), 'html:', html.slice(0, 200));
    } else {
      logger.debug('MindFlow: renderNodeContent OK for', node.id, 'html length:', html.length);
    }

    // 3. 测量实际尺寸 — width:auto 下 offsetWidth 是自然内容宽度
    // 使用 double rAF 确保浏览器+MathJax 完成排版
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

    // M4: 若代次不匹配，说明 resync 已清空 DOM，放弃测量（下次 render 会重新测）
    if (generationCounter && generation !== generationCounter.current) {
      return { height: 0, width: 0 };
    }

    // P0-1: 在 width:auto 状态下测量自然宽度
    // Fix 1: 测量完整元素高度 (含 padding+border)，而非 contentEl 高度
    const savedMinHeight = el.style.minHeight;
    el.style.minHeight = '';
    const height = el.offsetHeight;
    const contentWidth = contentEl.offsetWidth;
    el.style.minHeight = savedMinHeight;

    // M4: 兜底检查 — DOM 已被移除时 offsetHeight 为 0
    if (height === 0 || contentWidth === 0) {
      return { height: 0, width: 0 };
    }

    // 4. 回写 + 设最终宽度
    // Fix 2: 宽度补偿 padding(28) + border(4) = 32
    const finalWidth = Math.min(Math.max(contentWidth + 32, 140), 500);
    node.renderedHeight = height;
    node.renderedWidth = finalWidth;
    el.style.width = `${finalWidth}px`;

    // 5. 写入缓存
    cache.set(node.id, node.text, contentEl.innerHTML, node.renderedHeight, node.renderedWidth);

    el.classList.remove(`${NODE_CLS}--rendering`);
    el.classList.add(`${NODE_CLS}--rendered`);

    return { height: node.renderedHeight, width: node.renderedWidth };
  } catch (err) {
    logger.error('MindFlow: renderNodeContent failed for', node.id, '-> fallback', err);

    // P0-2+P1: 渲染失败 → 先尝试无公式的基础 MD 渲染
    const stripped = stripLatex(node.text);
    if (stripped !== node.text) {
      try {
        contentEl.empty();
        await MarkdownRenderer.render(
          app,
          stripped,
          contentEl,
          sourcePath,
          component,
        );
        logger.debug('MindFlow: fallback MD render succeeded for', node.id);
      } catch (e2) {
        logger.error('MindFlow: fallback MD render also failed for', node.id, e2);
        contentEl.innerHTML = simpleMarkdownRender(node.text);
      }
    } else {
      contentEl.innerHTML = simpleMarkdownRender(node.text);
    }

    el.classList.remove(`${NODE_CLS}--rendering`);
    el.classList.add(`${NODE_CLS}--rendered`);

    // P0-1: 在 width:auto 状态下测量自然宽度
    // Fix 1: 测量完整元素高度 (含 padding+border)，而非 contentEl 高度
    const savedMinHeight = el.style.minHeight;
    el.style.minHeight = '';
    const height = el.offsetHeight;
    const contentWidth = contentEl.offsetWidth;
    el.style.minHeight = savedMinHeight;
    node.renderedHeight = height;
    // Fix 2: 宽度补偿 padding(28) + border(4) = 32
    node.renderedWidth = Math.min(Math.max(contentWidth + 32, 140), 500);
    el.style.width = `${node.renderedWidth}px`;

    return { height: node.renderedHeight, width: node.renderedWidth };
  } finally {
    // N4: 确保 width 不停留在 'auto'
    // try 和 catch 分支都已设 el.style.width 为最终像素值，
    // 此处仅防御：如果因未预期异常导致 width 仍为 'auto'，用估算值兜底
    if (el.style.width === 'auto') {
      const w = node.renderedWidth ?? 200;
      el.style.width = `${w}px`;
    }
  }
}

/**
 * 移除文本中的 LaTeX 公式（$...$ 和 $$...$$），保留其余 Markdown 语法
 */
function stripLatex(text: string): string {
  // 移除块级公式 $$...$$
  let result = text.replace(/\$\$[\s\S]+?\$\$/g, '[公式]');
  // 移除行内公式 $...$（不匹配 $$）
  result = result.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, '[公式]');
  return result;
}

/**
 * 轻量 Markdown → HTML 渲染（不依赖 Obsidian/MathJax）
 *
 * 当 MarkdownRenderer.render() 完全不可用时作为最终回退。
 * 支持: 粗体、斜体、行内代码、链接、$...$ 公式占位。
 */
function simpleMarkdownRender(text: string): string {
  // 先转义 HTML 特殊字符
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 块级公式 $$...$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) =>
    `<span class="math-block" style="display:inline-block;padding:2px 6px;background:rgba(0,0,0,0.05);border-radius:4px;font-family:serif;font-style:italic;">${formula.trim()}</span>`
  );

  // 行内公式 $...$
  html = html.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_, formula) =>
    `<span style="font-family:serif;font-style:italic;">${formula.trim()}</span>`
  );

  // 粗体 **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 斜体 *text* (不匹配 **)
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  // 行内代码 `code`
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
  // 内部链接 [[note]]
  html = html.replace(/\[\[([^\]]+?)\]\]/g, '<a class="internal-link" href="#">$1</a>');

  return html;
}

/**
 * 批量创建节点骨架到容器
 *
 * Phase 2: 只创建骨架，内容异步渲染
 *
 * @param nodes 已布局的可见节点列表
 * @param container DOM 容器
 * @returns nodeId → HTMLElement 映射（供交互绑定）
 */
export function renderNodes(
  nodes: MindNode[],
  container: HTMLElement,
): Map<string, HTMLElement> {
  const elementMap = new Map<string, HTMLElement>();

  for (const node of nodes) {
    const el = renderNode(node);
    container.appendChild(el);
    elementMap.set(node.id, el);
  }

  return elementMap;
}

/**
 * 批量异步渲染节点内容
 *
 * 分批渲染：用 requestAnimationFrame 每帧渲染 N 个节点，
 * 避免大量节点阻塞主线程。
 *
 * @param app Obsidian App
 * @param nodes 要渲染的节点列表
 * @param elementMap nodeId → DOM 映射
 * @param sourcePath 源文件路径
 * @param component Component
 * @param cache 渲染缓存
 * @param batchSize 每批数量（默认 10）
 * @returns 需要重布局的节点列表（高度变化超过阈值的）
 */
export async function renderNodesContent(
  app: App,
  nodes: MindNode[],
  elementMap: Map<string, HTMLElement>,
  sourcePath: string,
  component: Component,
  cache: RenderCache,
  generationCounter?: RenderGenerationCounter,
  batchSize: number = 10,
): Promise<MindNode[]> {
  // R2-2: 递增实例级代次，使旧批次的异步回调能检测到清空
  generationCounter?.increment();
  const needsRelayout: MindNode[] = [];

  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);

    // 等待下一帧
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    // 并行渲染当前批次
    const results = await Promise.all(
      batch.map(async node => {
        const el = elementMap.get(node.id);
        if (!el) return null;

        const beforeH = estimateNodeHeight(node);
        const beforeW = estimateNodeWidth(node);
        const { height, width } = await renderNodeContent(
          app, node, el, sourcePath, component, cache, generationCounter,
        );

        // 高度或宽度差异 > 8px → 需要重布局
        if (Math.abs(beforeH - height) > 8 || Math.abs(beforeW - width) > 8) {
          return node;
        }
        return null;
      }),
    );

    // 收集需要重布局的节点
    for (const node of results) {
      if (node) needsRelayout.push(node);
    }
  }

  return needsRelayout;
}

/**
 * 清空容器中所有节点 DOM
 */
export function clearNodes(container: HTMLElement): void {
  const nodes = container.querySelectorAll(`.${NODE_CLS}`);
  nodes.forEach((n) => n.remove());
}

/**
 * 设置节点选中态
 *
 * 参考 mind-elixir selectNode：选中节点添加 CSS 类，
 * 取消其他节点的选中态。
 *
 * @param elementMap nodeId → DOM 映射
 * @param selectedId 选中的节点 ID（null = 取消选中）
 */
export function setSelectedNode(
  elementMap: Map<string, HTMLElement>,
  selectedId: string | null,
): void {
  // 清除所有选中态
  for (const [, el] of elementMap) {
    el.classList.remove(`${NODE_CLS}--selected`);
  }
  // 设置新选中
  if (selectedId) {
    const el = elementMap.get(selectedId);
    if (el) el.classList.add(`${NODE_CLS}--selected`);
  }
}

/**
 * 获取节点 DOM 元素（便捷方法）
 */
export function getNodeElement(
  elementMap: Map<string, HTMLElement>,
  nodeId: string,
): HTMLElement | null {
  return elementMap.get(nodeId) ?? null;
}

/**
 * 更新单个节点的折叠指示器
 */
export function updateCollapseIndicator(node: MindNode, el: HTMLElement): void {
  const indicator = el.querySelector(`.${NODE_CLS}__collapse`);
  if (indicator) {
    indicator.textContent = node.collapsed ? '+' : '-';
  }
  if (node.collapsed) {
    el.classList.add(`${NODE_CLS}--collapsed`);
  } else {
    el.classList.remove(`${NODE_CLS}--collapsed`);
  }
}

/**
 * 进入编辑态：清空渲染内容，恢复原始 MD 源码
 */
export function enterEditMode(el: HTMLElement, node: MindNode): void {
  const contentEl = el.querySelector(`.${NODE_CLS}__content`) as HTMLElement;
  if (!contentEl) return;

  // 清空渲染的 HTML
  contentEl.empty();

  // 显示原始 MD 源码
  contentEl.textContent = node.text;
  contentEl.contentEditable = 'true';
  contentEl.focus();

  // 全选
  const range = document.createRange();
  range.selectNodeContents(contentEl);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  el.classList.add(`${NODE_CLS}--editing`);
  el.classList.remove(`${NODE_CLS}--rendered`);
}

/**
 * 退出编辑态
 */
export function exitEditMode(el: HTMLElement): void {
  const contentEl = el.querySelector(`.${NODE_CLS}__content`) as HTMLElement;
  if (!contentEl) return;

  contentEl.contentEditable = 'false';
  el.classList.remove(`${NODE_CLS}--editing`);
}
