/**
 * Region 标注阅读模式处理器
 *
 * 处理 %%markvault-region:%% 格式的区域标注。
 * 在 Obsidian 阅读模式下给 region 范围内的块元素添加可视化装饰、徽章和批注指示器。
 *
 * 🔧 Phase 5B Step 8: 从 reading-processor.ts 提取，所有方法转为 export function
 *
 * @module reading-region-processor
 */

import { TFile, type MarkdownPostProcessorContext } from 'obsidian';
import type { AnnotationType, Annotation } from '../types/annotation';
import { parseRegionAnnotations, REGION_ANCHOR_REGEX, buildRegionAnchor } from '../core/region-annotation';
import { markdownToPlainWithMap } from '../core/markdown-plain';
import { collectLeafBlocks, computeBlockStarts } from './reading-block-processor';
import type { ReadingHost } from './reading-processor';

// ─── Region 解析缓存 (P0-2 修复) ────────────────────────

interface RegionCacheEntry {
  content: string;
  regions: Array<Annotation & { _source: 'markdown' }>;
  timestamp: number;
}

const _regionParseCache = new Map<string, RegionCacheEntry>();
const REGION_CACHE_TTL = 5000;

/**
 * 获取缓存的 region 解析结果（5s TTL）
 * 同一文件在 TTL 内只解析一次，避免每个 section 重复全文档正则扫描
 */
export function getCachedRegions(filePath: string, content: string): Array<Annotation & { _source: 'markdown' }> {
  const now = Date.now();
  const cached = _regionParseCache.get(filePath);
  if (cached && cached.content === content && (now - cached.timestamp) < REGION_CACHE_TTL) {
    return cached.regions;
  }
  const regions = parseRegionAnnotations(content, filePath);
  _regionParseCache.set(filePath, { content, regions, timestamp: now });
  // 惰性淘汰过期缓存
  for (const [key, entry] of _regionParseCache) {
    if ((now - entry.timestamp) >= REGION_CACHE_TTL) {
      _regionParseCache.delete(key);
    }
  }
  return regions;
}

/** 清空 region 解析缓存 — call from destroy() */
export function clearRegionParseCache(): void {
  _regionParseCache.clear();
}

// ─── 常量 ──────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
  'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
  'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
]);

// ─── 主入口 ─────────────────────────────────────────────

/**
 * 处理 region 标注的阅读模式渲染
 */
export async function processRegionAnnotations(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  plugin: ReadingHost,
): Promise<void> {
  const sourcePath = ctx.sourcePath;
  const info = ctx.getSectionInfo(el);
  if (!info) return;

  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;

  try {
    const content = await plugin.app.vault.cachedRead(file);
    const lines = content.split('\n');
    const sectionStart = info.lineStart;
    const sectionEnd = info.lineEnd;

    const regions = getCachedRegions(sourcePath, content);
    if (regions.length === 0) return;

    const matched = regions.filter(r => {
      const rs = r.startLine ?? 0;
      const re = r.endLine ?? rs;
      return rs <= sectionEnd && re >= sectionStart;
    });
    if (matched.length === 0) return;

    const leafBlocks = collectLeafBlocks(el);
    if (leafBlocks.length === 0) return;
    const blockStarts = computeBlockStarts(lines, sectionStart, sectionEnd);

    for (let i = sectionStart; i <= sectionEnd && i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^%%markvault-region:/.test(trimmed) && !trimmed.startsWith('>')) {
        const rel = i - sectionStart;
        if (!blockStarts.includes(rel)) blockStarts.push(rel);
      }
    }
    blockStarts.sort((a, b) => a - b);

    for (const region of matched) {
      const rs = region.startLine ?? 0;
      const re = region.endLine ?? rs;

      let targetIndices: number[] = [];
      for (let i = 0; i < blockStarts.length; i++) {
        const absLine = sectionStart + blockStarts[i];
        if (absLine >= rs && absLine <= re) {
          targetIndices.push(i);
        }
      }

      targetIndices = targetIndices.filter(i => i < leafBlocks.length);

      if (targetIndices.length === 0 && rs > 0 && lines[rs]?.trimStart().startsWith('>')) {
        const adjustedRs = rs - 1;
        for (let i = 0; i < blockStarts.length; i++) {
          const absLine = sectionStart + blockStarts[i];
          if (absLine >= adjustedRs && absLine <= re) {
            targetIndices.push(i);
          }
        }
        targetIndices = targetIndices.filter(i => i < leafBlocks.length);
      }
      if (targetIndices.length === 0) continue;

      for (let k = 0; k < targetIndices.length; k++) {
        const idx = targetIndices[k];
        const targetEl = leafBlocks[idx];
        if (!targetEl) continue;

        const isFirst = k === 0;
        const isLast = k === targetIndices.length - 1;

        targetEl.addClass(
          'markvault-region-block-mark',
          `markvault-region-${region.type}`,
          `markvault-region-${region.color}`,
          'markvault-clickable',
        );
        if (isFirst) targetEl.addClass('markvault-region-block-first');
        if (isLast) targetEl.addClass('markvault-region-block-last');
        if (!isFirst && !isLast) targetEl.addClass('markvault-region-block-middle');
        targetEl.dataset.uuid = region.uuid;
        targetEl.dataset.type = region.type;
        targetEl.dataset.color = region.color;
        targetEl.style.cursor = 'pointer';

        if (k === 0) {
          addRegionBadge(targetEl, region.type as AnnotationType, region.color, region.note);
          if (region.note) {
            targetEl.setAttribute('title', region.note);
            targetEl.addClass('markvault-has-note');
          }
        }
      }
    }
  } catch (err) {
    console.error('MarkVault: region decoration failed', err);
  }
}

// ─── Region 段落级整块高亮 ─────────────────────────────

export function highlightRegionBlocks(
  root: HTMLElement,
  start: Node,
  end: Node,
  uuid: string,
  type: AnnotationType,
  color: string,
): HTMLElement | null {
  const startBlock = findNearestBlockAncestor(start);
  const endBlock = findNearestBlockAncestor(end);
  if (!startBlock || !endBlock) return null;

  const targets: HTMLElement[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let collecting = false;
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const el = node as HTMLElement;
    if (!BLOCK_TAGS.has(el.tagName) && !el.hasClass('callout')) continue;

    const hasBlockChildren = Array.from(el.children).some(
      child => BLOCK_TAGS.has((child as HTMLElement).tagName) || (child as HTMLElement).hasClass?.('callout')
    );
    if (hasBlockChildren) continue;

    if (el === startBlock || el.contains(startBlock) || startBlock.contains(el)) {
      collecting = true;
    }
    if (collecting && !targets.includes(el)) {
      targets.push(el);
    }
    if (el === endBlock || el.contains(endBlock) || endBlock.contains(el)) {
      break;
    }
  }

  if (targets.length === 0) {
    targets.push(startBlock);
  }

  for (let i = 0; i < targets.length; i++) {
    const el = targets[i];
    const positionClass = i === 0 && targets.length === 1
      ? 'markvault-region-block-first markvault-region-block-last'
      : i === 0
        ? 'markvault-region-block-first'
        : i === targets.length - 1
          ? 'markvault-region-block-last'
          : 'markvault-region-block-middle';
    el.addClass('markvault-region-block-mark', positionClass, `markvault-region-${type}`, `markvault-region-${color}`, 'markvault-clickable');
    el.dataset.uuid = uuid;
    el.dataset.type = type;
    el.dataset.color = color;
    el.style.cursor = 'pointer';
  }

  return targets[0] ?? null;
}

/** 找到节点的最近块级祖先元素 */
export function findNearestBlockAncestor(node: Node): HTMLElement | null {
  let current: Node | null = node.parentNode;
  while (current && current !== document.body) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement;
      if (BLOCK_TAGS.has(el.tagName) || el.hasClass('callout')) return el;
    }
    current = current.parentNode;
  }
  return null;
}

// ─── 泄漏锚点文本清理 ──────────────────────────────────

/** 防御性清理：隐藏阅读模式中泄漏的 markvault 锚点文本 */
export function hideLeakedAnchorText(root: HTMLElement): void {
  const ANCHOR_PATTERNS = [
    /%%markvault-region:[^\n]*?%%/g,
    /%%markvault(-span|-block)?:[^\n]*?%%/g,
    /%%mv:i:[^\n]*?%%/g,
    /%+markvault[^\n]*?%+/g,
  ];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!text.includes('markvault') && !text.includes('mv:i')) continue;

    for (const pattern of ANCHOR_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        const wrapper = document.createElement('span');
        wrapper.className = 'markvault-leaked-anchor-hidden';
        wrapper.style.display = 'none';
        wrapper.textContent = text;
        textNode.parentNode?.replaceChild(wrapper, textNode);
        console.debug('MarkVault: hid leaked anchor text in reading mode');
        break;
      }
    }
  }
}

// ─── 内联 Region 锚点提取 ───────────────────────────────

/**
 * 从文本节点中提取内联的 region 锚点
 */
export function extractInlineRegionAnchors(
  root: HTMLElement,
  regionAnchors: Map<string, { start?: Node; end?: Node; type: AnnotationType; color: string }>,
  anchorNodesToHide: Set<Node>,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const text = node.textContent || '';
    if (text.includes('markvault-region')) textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const parentEl = textNode.parentElement;
    if (
      parentEl?.hasClass('markvault-region-anchor-hidden') ||
      parentEl?.hasClass('markvault-anchor-hidden') ||
      parentEl?.hasClass('markvault-leaked-anchor-hidden')
    ) {
      continue;
    }
    extractInlineRegionAnchorsFromTextNode(textNode, regionAnchors, anchorNodesToHide);
  }
}

function extractInlineRegionAnchorsFromTextNode(
  textNode: Text,
  regionAnchors: Map<string, { start?: Node; end?: Node; type: AnnotationType; color: string }>,
  anchorNodesToHide: Set<Node>,
): void {
  const text = textNode.textContent || '';
  const regex = /%%markvault-region:([^:%]+):([^:%]+):([^:%]+):(start|end):([^%]*)%%/g;
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match);
  }
  if (matches.length === 0) return;

  const parent = textNode.parentNode;
  if (!parent) return;

  let lastIndex = 0;
  for (const m of matches) {
    if (m.index > lastIndex) {
      parent.insertBefore(document.createTextNode(text.substring(lastIndex, m.index)), textNode);
    }

    const span = document.createElement('span');
    span.className = 'markvault-region-anchor-hidden';
    span.style.display = 'none';
    span.textContent = m[0];
    parent.insertBefore(span, textNode);

    const uuid = m[1];
    const type = m[2] as AnnotationType;
    const color = m[3];
    const pos = m[4] as 'start' | 'end';
    const entry = regionAnchors.get(uuid) || { type, color };
    if (pos === 'start') entry.start = span;
    else entry.end = span;
    regionAnchors.set(uuid, entry);
    anchorNodesToHide.add(span);

    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < text.length) {
    parent.insertBefore(document.createTextNode(text.substring(lastIndex)), textNode);
  }
  parent.removeChild(textNode);
}

// ─── Section 级 Region 样式 ────────────────────────────

/** 给整个 section 加 region 样式 */
export function applyRegionStyleToSection(root: HTMLElement, uuid: string, type: AnnotationType, color: string, regionText?: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const styledAncestors = new Set<Element>();

  const normalizedRegionText = regionText ? normalizeRegionMatchText(regionText) : undefined;
  const regionTokens = normalizedRegionText ? tokenizeRegionMatchText(normalizedRegionText) : [];

  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as HTMLElement).tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    }

    let ancestor: Element | null = node.parentElement;
    let skip = false;
    while (ancestor && ancestor !== root) {
      if (styledAncestors.has(ancestor)) {
        skip = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (skip) continue;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const isBlock = BLOCK_TAGS.has(el.tagName) || el.hasClass('callout');

      if (isBlock) {
        const hasBlockChildren = Array.from(el.children).some(
          child => BLOCK_TAGS.has(child.tagName) || (child as HTMLElement).hasClass?.('callout')
        );
        if (hasBlockChildren) {
          continue;
        }
      }

      if (normalizedRegionText) {
        const blockText = normalizeRegionMatchText(el.textContent || '');
        const containsRegion = blockText.includes(normalizedRegionText);
        const containedByRegion = normalizedRegionText.includes(blockText) && blockText.length > 0;
        if (!containsRegion && !containedByRegion) {
          const matchedTokens = regionTokens.filter(t => blockText.includes(t)).length;
          if (regionTokens.length === 0 || matchedTokens / regionTokens.length < 0.5) {
            continue;
          }
        }
      }

      styleRegionBlockBorderAndText(el, uuid, type, color);
      styledAncestors.add(el);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (!text.trim()) continue;
      const parent = node.parentElement;
      if (parent?.hasClass('markvault-region')) continue;
      const span = document.createElement('span');
      span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
      span.dataset.uuid = uuid;
      span.dataset.type = type;
      span.dataset.color = color;
      span.style.cursor = 'pointer';
      span.textContent = text;
      node.parentNode?.replaceChild(span, node);
    }
  }
}

/** 给块级元素加左侧竖线，并把其内部文本节点包裹为 inline span */
export function styleRegionBlockBorderAndText(
  el: HTMLElement,
  uuid: string,
  type: AnnotationType,
  color: string,
): void {
  el.addClass('markvault-region-block-border', `markvault-region-${color}`, 'markvault-clickable');
  el.dataset.uuid = uuid;
  el.dataset.type = type;
  el.dataset.color = color;
  el.style.cursor = 'pointer';

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    textNodes.push(n as Text);
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!text.trim()) continue;
    const parent = textNode.parentElement;
    if (parent?.hasClass('markvault-region')) continue;

    const span = document.createElement('span');
    span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
    span.dataset.uuid = uuid;
    span.dataset.type = type;
    span.dataset.color = color;
    span.style.cursor = 'pointer';
    span.textContent = text;
    textNode.parentNode?.replaceChild(span, textNode);
  }
}

/** 归一化 region/块文本 */
export function normalizeRegionMatchText(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[*=_~`#\[\]()|<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 region 文本拆成可用于限域匹配的词元 */
export function tokenizeRegionMatchText(text: string): string[] {
  return text
    .split(/[\s,.;:!?，。；：！？、（）()\[\]【】《》""''「」『』—–\-\/\\]+/)
    .filter(token => token.length >= 2);
}

// ─── 精确匹配 ──────────────────────────────────────────

/** 精确匹配 section 内的 region 内容并高亮 */
export function applyRegionStyleToSectionPrecise(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
  let srcStart = -1;
  let srcEnd = sectionSource.length;

  REGION_ANCHOR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_ANCHOR_REGEX.exec(sectionSource)) !== null) {
    const uuid = m[1];
    const pos = m[4] as 'start' | 'end';
    if (uuid === region.uuid && pos === 'start') {
      srcStart = m.index + m[0].length;
    } else if (uuid === region.uuid && pos === 'end') {
      srcEnd = m.index;
    }
  }

  if (srcStart === -1) {
    const startAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'start');
    const endAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'end');

    const startIdx = sectionSource.indexOf(startAnchor);
    if (startIdx !== -1) srcStart = startIdx + startAnchor.length;

    const endIdx = sectionSource.indexOf(endAnchor);
    if (endIdx !== -1) srcEnd = endIdx;
  }

  if (srcStart === -1 || srcStart >= srcEnd) return null;

  const { plain, map } = markdownToPlainWithMap(sectionSource);
  const plainStart = map.findIndex(offset => offset >= srcStart);
  let plainEnd = map.findIndex(offset => offset >= srcEnd);
  if (plainStart === -1 || plainStart >= plain.length) return null;
  if (plainEnd === -1) plainEnd = plain.length;
  const searchText = plain.substring(plainStart, plainEnd).trim();
  if (!searchText) return null;

  const rootText = root.textContent || '';
  const idx = rootText.indexOf(searchText);
  if (idx === -1) return null;

  const firstWrapped = wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
  if (firstWrapped) {
    styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
  }
  return firstWrapped;
}

/** 把 root 内 [startChar, endChar) 范围内的文本节点包裹成 region span */
export function wrapTextRange(
  root: HTMLElement,
  startChar: number,
  endChar: number,
  uuid: string,
  type: AnnotationType,
  color: string,
): HTMLElement | null {
  let current = 0;
  let firstWrapped: HTMLElement | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: { node: Text; start: number; end: number }[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const textNode = node as Text;
    const text = textNode.textContent || '';
    const nodeStart = current;
    const nodeEnd = current + text.length;
    current = nodeEnd;
    if (nodeEnd <= startChar || nodeStart >= endChar) continue;
    ranges.push({
      node: textNode,
      start: Math.max(0, startChar - nodeStart),
      end: Math.min(text.length, endChar - nodeStart),
    });
  }

  for (const { node, start, end } of ranges) {
    const text = node.textContent || '';
    const before = text.substring(0, start);
    const middle = text.substring(start, end);
    const after = text.substring(end);
    const span = document.createElement('span');
    span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
    span.dataset.uuid = uuid;
    span.dataset.type = type;
    span.dataset.color = color;
    span.style.cursor = 'pointer';
    span.textContent = middle;
    if (!firstWrapped) firstWrapped = span;

    const parent = node.parentNode;
    if (!parent) continue;
    if (before) parent.insertBefore(document.createTextNode(before), node);
    parent.insertBefore(span, node);
    if (after) parent.insertBefore(document.createTextNode(after), node);
    parent.removeChild(node);
  }

  return firstWrapped;
}

/** 找到 startEl 的最近块级祖先，给它加上点击事件和徽章 */
export function styleRegionBlockAncestor(startEl: HTMLElement, type: AnnotationType, color: string, note?: string): void {
  let target: HTMLElement | null = startEl;
  while (target && target !== document.body) {
    if (BLOCK_TAGS.has(target.tagName) || target.hasClass('callout')) break;
    target = target.parentElement;
  }
  if (!target || target === document.body) return;

  target.addClass('markvault-region-block-border', `markvault-region-${color}`, 'markvault-clickable');
  target.dataset.uuid = startEl.dataset.uuid || '';
  target.dataset.type = type;
  target.dataset.color = color;
  target.style.cursor = 'pointer';
  addRegionBadge(target, type, color, note);
}

/** 给 region 标注的目标元素添加右上角类型徽章 */
export function addRegionBadge(targetEl: HTMLElement, type: AnnotationType, color: string, note?: string): void {
  targetEl.style.position = 'relative';
  const badge = document.createElement('span');
  badge.className = `markvault-region-type-badge markvault-region-badge-type-${type} markvault-region-badge-color-${color}`;
  const iconSpan = document.createElement('span');
  iconSpan.className = 'markvault-region-type-badge-icon';
  iconSpan.textContent = '▭';
  const dot = document.createElement('span');
  dot.className = 'markvault-region-type-badge-dot';
  badge.appendChild(iconSpan);
  badge.appendChild(dot);
  targetEl.appendChild(badge);

  if (note) {
    const indicator = document.createElement('span');
    indicator.className = 'markvault-region-note-indicator';
    indicator.textContent = '📝';
    indicator.title = note;
    targetEl.appendChild(indicator);
  }
}

// ─── DOM 遍历辅助 ──────────────────────────────────────

/** 找到 region 两个锚点之间的第一个元素节点 */
export function findFirstRegionElement(start: Node, end: Node | null): HTMLElement | null {
  let node: Node | null = start.nextSibling;
  while (node && node !== end) {
    if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
    if (node.firstChild) {
      node = node.firstChild;
    } else {
      while (node && !node.nextSibling && node !== start) {
        node = node.parentNode;
      }
      node = node && node !== start ? node.nextSibling : null;
    }
  }
  return null;
}

/** 高亮从 start Comment 到 el 末尾的 DOM 节点 */
export function highlightRegionFromStart(
  root: HTMLElement,
  start: Node,
  uuid: string,
  type: AnnotationType,
  color: string,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  walker.currentNode = start;
  const nodes: Node[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    nodes.push(n);
  }

  applyRegionStyleToNodes(root, nodes, uuid, type, color);
}

/** 高亮从 el 开头到 end Comment 的 DOM 节点 */
export function highlightRegionToEnd(
  root: HTMLElement,
  end: Node,
  uuid: string,
  type: AnnotationType,
  color: string,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  const nodes: Node[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null && n !== end) {
    nodes.push(n);
  }

  applyRegionStyleToNodes(root, nodes, uuid, type, color);
}

/** 给一组 DOM 节点批量应用 region 样式 */
export function applyRegionStyleToNodes(
  root: HTMLElement,
  nodes: Node[],
  uuid: string,
  type: AnnotationType,
  color: string,
): void {
  const styledAncestors = new Set<Element>();

  for (const node of nodes) {
    let ancestor: Element | null = node.parentElement;
    let skip = false;
    while (ancestor && ancestor !== root) {
      if (styledAncestors.has(ancestor)) {
        skip = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (skip) continue;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const isBlock = BLOCK_TAGS.has(el.tagName) || el.hasClass('callout');

      if (isBlock) {
        const hasBlockChildren = Array.from(el.children).some(
          c => BLOCK_TAGS.has(c.tagName) || (c as HTMLElement).hasClass?.('callout')
        );
        if (hasBlockChildren) {
          continue;
        }

        styleRegionBlockBorderAndText(el, uuid, type, color);
        styledAncestors.add(el);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (!text.trim()) continue;
      const parent = node.parentElement;
      if (parent?.hasClass('markvault-region')) continue;
      const span = document.createElement('span');
      span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
      span.dataset.uuid = uuid;
      span.dataset.type = type;
      span.dataset.color = color;
      span.style.cursor = 'pointer';
      span.textContent = text;
      node.parentNode?.replaceChild(span, node);
    }
  }
}

/** 精确匹配 section 中从 start 锚点到 section 末尾的内容并高亮 */
export function applyRegionStyleFromStartAnchor(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
  let srcStart = -1;

  REGION_ANCHOR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_ANCHOR_REGEX.exec(sectionSource)) !== null) {
    if (m[1] === region.uuid && m[4] === 'start') {
      srcStart = m.index + m[0].length;
      break;
    }
  }

  if (srcStart === -1) {
    const startAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'start');
    const startIdx = sectionSource.indexOf(startAnchor);
    if (startIdx === -1) return null;
    srcStart = startIdx + startAnchor.length;
  }

  const srcEnd = sectionSource.length;

  const { plain, map } = markdownToPlainWithMap(sectionSource);
  const plainStart = map.findIndex(offset => offset >= srcStart);
  let plainEnd = map.findIndex(offset => offset >= srcEnd);
  if (plainStart === -1 || plainStart >= plain.length) return null;
  if (plainEnd === -1) plainEnd = plain.length;
  const searchText = plain.substring(plainStart, plainEnd).trim();
  if (!searchText) return null;

  const rootText = root.textContent || '';
  const idx = rootText.indexOf(searchText);
  if (idx === -1) return null;

  const firstWrapped = wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
  if (firstWrapped) {
    styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
  }
  return firstWrapped;
}

/** 精确匹配 section 中从 section 开头到 end 锚点的内容并高亮 */
export function applyRegionStyleToEndAnchor(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
  let srcEnd = -1;

  REGION_ANCHOR_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGION_ANCHOR_REGEX.exec(sectionSource)) !== null) {
    if (m[1] === region.uuid && m[4] === 'end') {
      srcEnd = m.index;
      break;
    }
  }

  if (srcEnd === -1) {
    const endAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'end');
    const endIdx = sectionSource.indexOf(endAnchor);
    if (endIdx === -1) return null;
    srcEnd = endIdx;
  }

  const srcStart = 0;

  const { plain, map } = markdownToPlainWithMap(sectionSource);
  const plainStart = 0;
  let plainEnd = map.findIndex(offset => offset >= srcEnd);
  if (plainEnd === -1) plainEnd = plain.length;
  if (plainEnd <= 0) return null;
  const searchText = plain.substring(plainStart, plainEnd).trim();
  if (!searchText) return null;

  const rootText = root.textContent || '';
  const idx = rootText.indexOf(searchText);
  if (idx === -1) return null;

  const firstWrapped = wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
  if (firstWrapped) {
    styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
  }
  return firstWrapped;
}

/** 给完全在 region 内的 section 的所有块级子元素加样式 */
export function applyRegionStyleToMiddleSection(
  root: HTMLElement,
  uuid: string,
  type: AnnotationType,
  color: string,
): void {
  for (const child of Array.from(root.children)) {
    const el = child as HTMLElement;
    const isBlock = BLOCK_TAGS.has(el.tagName) || el.hasClass('callout');
    if (isBlock) {
      const hasBlockChildren = Array.from(el.children).some(
        c => BLOCK_TAGS.has(c.tagName) || (c as HTMLElement).hasClass?.('callout')
      );
      if (hasBlockChildren) {
        el.addClass('markvault-clickable');
        el.dataset.uuid = uuid;
        el.dataset.type = type;
        el.dataset.color = color;
        el.style.cursor = 'pointer';
        applyRegionStyleToMiddleSection(el, uuid, type, color);
        continue;
      }

      styleRegionBlockBorderAndText(el, uuid, type, color);
    }
  }
}
