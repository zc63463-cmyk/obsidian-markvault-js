/**
 * Block/Span 锚标注阅读模式处理器
 * 
 * 处理 %%markvault:%% 和 %%markvault-span:%% 格式的块级/span 锚点标注，
 * 以及 %%markvault-block:%% 格式的双锚点 block 标注。
 * 在 Obsidian 阅读模式下给目标块元素添加可视化装饰、徽章和批注指示器。
 * 
 * @module reading-block-processor
 */

import { TFile, type MarkdownPostProcessorContext } from 'obsidian';
import type { AnnotationType } from '../types/annotation';
import { DEFAULT_SETTINGS } from '../types/annotation';
import { annotationStore } from '../db/annotation-store';
import { findBlockTargetLine, findBlockContentEndLine, parseBlockDoubleAnchors } from '../core/annotation-parser';
import { scanMarkdownContexts } from '../core/md-context';
import type { ReadingHost } from './reading-processor';
import { findNextContentElement } from './reading-native-processor';

/**
 * 处理块级/span 锚点标注的阅读模式渲染
 * 从 HTML 注释和元素文本节点中查找 markvault/markvault-span/markvault-block 锚点，
 * 给后续的内容元素添加块级装饰效果。
 */
export async function processBlockAnchors(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  plugin: ReadingHost,
): Promise<void> {
  const sourcePath = ctx.sourcePath;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
  const anchorNodes: { uuid: string; type: string; color: string; note: string; node: Node; anchorKind: 'block' | 'span' }[] = [];
  const doubleAnchors = new Map<string, { start?: Node; end?: Node; type: string; color: string; note: string }>();

  const decodeNote = (raw: string) => raw.replace(/\\p/g, '%').replace(/\\c/g, ':');

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode())) {
    if (currentNode.nodeType === Node.COMMENT_NODE) {
      const text = currentNode.textContent || '';
      const blockMatch = text.match(/^markvault:([^:]+):([^:]+):([^:]+):?([\s\S]*)$/);
      if (blockMatch) {
        anchorNodes.push({
          uuid: blockMatch[1], type: blockMatch[2], color: blockMatch[3],
          note: blockMatch[4] ? blockMatch[4].replace(/\\c/g, ':') : '',
          node: currentNode, anchorKind: 'block',
        });
      }
      const spanMatch = text.match(/^markvault-span:([^:]+):([^:]+):([^:]+):?([\s\S]*)$/);
      if (spanMatch) {
        anchorNodes.push({
          uuid: spanMatch[1], type: spanMatch[2], color: spanMatch[3],
          note: spanMatch[4] ? spanMatch[4].replace(/\\c/g, ':') : '',
          node: currentNode, anchorKind: 'span',
        });
      }
      const doubleMatch = text.match(/^markvault-block:([^:]+):([^:]+):([^:]+):(start|end):?([\s\S]*)$/);
      if (doubleMatch) {
        const uuid = doubleMatch[1];
        const entry = doubleAnchors.get(uuid) || {
          type: doubleMatch[2], color: doubleMatch[3],
          note: doubleMatch[5] ? decodeNote(doubleMatch[5]) : '',
        };
        if (doubleMatch[4] === 'start') entry.start = currentNode;
        else entry.end = currentNode;
        doubleAnchors.set(uuid, entry);
      }
    } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
      const htmlEl = currentNode as HTMLElement;
      if (htmlEl.className && typeof htmlEl.className === 'string' && htmlEl.className.includes('cm-')) continue;
      const text = htmlEl.textContent || '';
      const blockMatch = text.match(/^%%markvault:([^:]+):([^:]+):([^:]+):?([\s\S]*)%%$/);
      if (blockMatch) {
        anchorNodes.push({
          uuid: blockMatch[1], type: blockMatch[2], color: blockMatch[3],
          note: blockMatch[4] ? blockMatch[4].replace(/\\c/g, ':') : '',
          node: currentNode, anchorKind: 'block',
        });
        continue;
      }
      const spanMatch = text.match(/^%%markvault-span:([^:]+):([^:]+):([^:]+):?([\s\S]*)%%$/);
      if (spanMatch) {
        anchorNodes.push({
          uuid: spanMatch[1], type: spanMatch[2], color: spanMatch[3],
          note: spanMatch[4] ? spanMatch[4].replace(/\\c/g, ':') : '',
          node: currentNode, anchorKind: 'span',
        });
        continue;
      }
      const doubleMatch = text.match(/^%%markvault-block:([^:]+):([^:]+):([^:]+):(start|end):?([\s\S]*)%%$/);
      if (doubleMatch) {
        const uuid = doubleMatch[1];
        const entry = doubleAnchors.get(uuid) || {
          type: doubleMatch[2], color: doubleMatch[3],
          note: doubleMatch[5] ? decodeNote(doubleMatch[5]) : '',
        };
        if (doubleMatch[4] === 'start') entry.start = currentNode;
        else entry.end = currentNode;
        doubleAnchors.set(uuid, entry);
        htmlEl.style.display = 'none';
        htmlEl.addClass('markvault-anchor-hidden');
        continue;
      }
    }
  }

  for (const anchor of anchorNodes) {
    if (anchor.node.nodeType === Node.ELEMENT_NODE) {
      const anchorEl = anchor.node as HTMLElement;
      anchorEl.style.display = 'none';
      anchorEl.addClass('markvault-anchor-hidden');
    }
    if (anchor.anchorKind === 'span') {
      const targetEl = findNextContentElement(anchor.node);
      if (targetEl) {
        applyBlockDecoration(targetEl, anchor.uuid, anchor.type, anchor.color, anchor.note, anchor.anchorKind, sourcePath, plugin);
      }
    }
  }

  const decoratedUuids = await applyBlockDecorationsFromSource(el, ctx, sourcePath, plugin);

  for (const anchor of anchorNodes) {
    if (anchor.anchorKind === 'block' && !decoratedUuids.has(anchor.uuid)) {
      const targetEl = findNextContentElement(anchor.node);
      if (targetEl) {
        applyBlockDecoration(targetEl, anchor.uuid, anchor.type, anchor.color, anchor.note, 'block', sourcePath, plugin);
      }
    }
  }
  for (const [uuid, entry] of doubleAnchors.entries()) {
    if (entry.start && !decoratedUuids.has(uuid)) {
      const targetEl = findNextContentElement(entry.start);
      if (targetEl) {
        applyBlockDecoration(targetEl, uuid, entry.type, entry.color, entry.note, 'block', sourcePath, plugin);
      }
    }
  }
}

/**
 * 给阅读模式下的目标块元素添加 block/span 装饰、徽章与批注指示器
 */
export function applyBlockDecoration(
  targetEl: HTMLElement,
  uuid: string,
  type: string,
  color: string,
  note: string,
  anchorKind: 'block' | 'span',
  sourcePath: string,
  plugin: ReadingHost,
): void {
  targetEl.addClass('markvault-block-mark');
  targetEl.addClass(`markvault-block-${type}`);
  targetEl.addClass(`markvault-block-${color}`);
  targetEl.style.cursor = 'pointer';
  targetEl.dataset.uuid = uuid;

  if (anchorKind === 'span') {
    targetEl.addClass('markvault-span-mark');
    highlightSpanFragments(targetEl, uuid, type, color, sourcePath, plugin).catch((err) => {
      console.error('MarkVault: failed to highlight span fragments', err);
    });
  }

  if (anchorKind === 'block') {
    const typeIcon = type === 'bold' ? '𝗕' : type === 'underline' ? 'U̲' : '🎨';
    const badge = document.createElement('span');
    badge.className = `markvault-block-type-badge markvault-block-badge-type-${type} markvault-block-badge-color-${color}`;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'markvault-block-type-badge-icon';
    iconSpan.textContent = typeIcon;
    const dot = document.createElement('span');
    dot.className = 'markvault-block-type-badge-dot';
    badge.appendChild(iconSpan);
    badge.appendChild(dot);
    targetEl.style.position = 'relative';
    targetEl.appendChild(badge);
  }

  if (note) {
    const indicator = document.createElement('span');
    indicator.className = 'markvault-block-note-indicator';
    indicator.textContent = '📝';
    indicator.title = note;
    targetEl.style.position = 'relative';
    targetEl.appendChild(indicator);
  }
}

/**
 * 从源码行号映射，给当前 section 内的 block 锚点添加阅读模式装饰
 */
export async function applyBlockDecorationsFromSource(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  sourcePath: string,
  plugin: ReadingHost,
): Promise<Set<string>> {
  const decorated = new Set<string>();
  const info = ctx.getSectionInfo(el);
  if (!info) return decorated;

  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return decorated;

  try {
    const content = await plugin.app.vault.cachedRead(file);
    const lines = content.split('\n');
    const sectionStart = info.lineStart;
    const sectionEnd = info.lineEnd;

    interface BlockAnchorMatch {
      uuid: string; type: string; color: string; note: string;
      startLine: number; endLine: number;
    }
    const matches: BlockAnchorMatch[] = [];

    const oldRegex = /^%%markvault:([^:%]+):([^:%]+):([^:%]+):([^%]*)%%$/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(oldRegex);
      if (!m) continue;
      const targetLine = findBlockTargetLine(content, i);
      if (targetLine > sectionEnd || targetLine < sectionStart) continue;
      matches.push({
        uuid: m[1], type: m[2], color: m[3],
        note: m[4].replace(/\\c/g, ':').replace(/\\p/g, '%'),
        startLine: targetLine, endLine: targetLine,
      });
    }

    const doubleAnchors = parseBlockDoubleAnchors(content);
    const doubleByUuid = new Map<string, { start?: typeof doubleAnchors[0]; end?: typeof doubleAnchors[0] }>();
    for (const a of doubleAnchors) {
      const entry = doubleByUuid.get(a.uuid) || {};
      if (a.position === 'start') { if (!entry.start) entry.start = a; }
      else { if (!entry.end) entry.end = a; }
      doubleByUuid.set(a.uuid, entry);
    }
    for (const [uuid, entry] of doubleByUuid.entries()) {
      if (!entry.start) continue;
      const startLine = findBlockTargetLine(content, entry.start.anchorLine);
      const endLine = entry.end ? findBlockContentEndLine(content, entry.end.anchorLine) : startLine;
      if (endLine < startLine) continue;
      if (endLine < sectionStart || startLine > sectionEnd) continue;
      matches.push({
        uuid, type: entry.start.type, color: entry.start.color, note: entry.start.note,
        startLine, endLine,
      });
    }

    if (matches.length === 0) return decorated;

    const leafBlocks = collectLeafBlocks(el);
    if (leafBlocks.length === 0) return decorated;

    const blockStarts = computeBlockStarts(lines, sectionStart, sectionEnd);

    for (const match of matches) {
      const targetIndices: number[] = [];
      for (let i = 0; i < blockStarts.length; i++) {
        const absLine = sectionStart + blockStarts[i];
        if (absLine >= match.startLine && absLine <= match.endLine) {
          targetIndices.push(i);
        }
      }
      if (targetIndices.length > 0) decorated.add(match.uuid);
      if (targetIndices.length === 0) {
        let nearest = -1;
        for (let i = 0; i < blockStarts.length; i++) {
          if (sectionStart + blockStarts[i] <= match.startLine) nearest = i;
          else break;
        }
        if (nearest !== -1) targetIndices.push(nearest);
      }
      for (let k = 0; k < targetIndices.length; k++) {
        const idx = targetIndices[k];
        const targetEl = leafBlocks[idx];
        if (!targetEl) continue;
        targetEl.addClass('markvault-block-mark');
        targetEl.addClass(`markvault-block-${match.type}`);
        targetEl.addClass(`markvault-block-${match.color}`);
        targetEl.style.cursor = 'pointer';
        targetEl.dataset.uuid = match.uuid;
        if (k === 0) {
          const typeIcon = match.type === 'bold' ? '𝗕' : match.type === 'underline' ? 'U̲' : '🎨';
          const badge = document.createElement('span');
          badge.className = `markvault-block-type-badge markvault-block-badge-type-${match.type} markvault-block-badge-color-${match.color}`;
          const iconSpan = document.createElement('span');
          iconSpan.className = 'markvault-block-type-badge-icon';
          iconSpan.textContent = typeIcon;
          const dot = document.createElement('span');
          dot.className = 'markvault-block-type-badge-dot';
          badge.appendChild(iconSpan);
          badge.appendChild(dot);
          targetEl.style.position = 'relative';
          targetEl.appendChild(badge);
          if (match.note) {
            const indicator = document.createElement('span');
            indicator.className = 'markvault-block-note-indicator';
            indicator.textContent = '📝';
            indicator.title = match.note;
            targetEl.style.position = 'relative';
            targetEl.appendChild(indicator);
          }
        }
      }
    }
  } catch (err) {
    console.error('MarkVault: block decoration from source failed', err);
  }
  return decorated;
}

/**
 * 收集当前 section 内可作为块级标注目标的叶子块元素
 */
export function collectLeafBlocks(root: HTMLElement): HTMLElement[] {
  const blockTags = new Set([
    'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
    'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
    'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
  ]);

  const candidates: HTMLElement[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const el = node as HTMLElement;
    if (
      el.hasClass('markvault-anchor-hidden') ||
      el.hasClass('markvault-leaked-anchor-hidden') ||
      el.hasClass('markvault-region-anchor-hidden')
    ) continue;
    if (el.style.display === 'none') continue;
    const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');
    if (!isBlock) continue;
    const text = (el.textContent ?? '').trim();
    if (/^%%(markvault|markvault-span|markvault-region|markvault-block):/.test(text) && text.endsWith('%%')) continue;
    if (el.tagName === 'LI' || el.hasClass('callout')) {
      candidates.push(el);
      continue;
    }
    const hasBlockChild = Array.from(el.children).some(
      child => blockTags.has((child as HTMLElement).tagName) || (child as HTMLElement).hasClass?.('callout')
    );
    if (!hasBlockChild) candidates.push(el);
  }
  return candidates
    .filter((el) => !candidates.some(other => other !== el && other.contains(el)))
    .filter((el) => (el.innerText ?? el.textContent ?? '').trim().length > 0);
}

/**
 * 计算 section 内各内容块的起始行
 */
export function computeBlockStarts(lines: string[], sectionStart: number, sectionEnd: number): number[] {
  const starts: number[] = [];
  let inParagraph = false, inCode = false, inCallout = false, inQuote = false, inTable = false;

  for (let i = sectionStart; i <= sectionEnd && i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimStart();
    const trimmed = raw.trim();
    const isBlank = trimmed === '';
    const isAnchor = /^%%(markvault|markvault-span|markvault-region|markvault-block):/.test(trimmed);

    if (isBlank) {
      inParagraph = false;
      if (!inCode) { inCallout = false; inQuote = false; inTable = false; }
      continue;
    }
    if (isAnchor) {
      inParagraph = false;
      if (!inCode) { inCallout = false; inQuote = false; inTable = false; }
      continue;
    }
    if (/^\s*```/.test(raw)) {
      if (!inCode) { starts.push(i - sectionStart); inCode = true; }
      else { inCode = false; }
      inParagraph = false; inCallout = false; inQuote = false; inTable = false;
      continue;
    }
    if (inCode) continue;
    if (/^\s*#{1,6}\s/.test(line)) {
      starts.push(i - sectionStart);
      inParagraph = false; inCallout = false; inQuote = false; inTable = false;
      continue;
    }
    if (/^\s*([-]{3,}|[*]{3,}|[_]{3,})\s*$/.test(trimmed)) {
      starts.push(i - sectionStart); inParagraph = false; continue;
    }
    if (/^\s*>\s*\[!/.test(line)) {
      starts.push(i - sectionStart);
      inCallout = true; inParagraph = false; inQuote = false; inTable = false;
      continue;
    }
    if (inCallout) continue;
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      starts.push(i - sectionStart);
      inParagraph = false; inQuote = false; inTable = false;
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (!inQuote) starts.push(i - sectionStart);
      inQuote = true; inParagraph = false; inTable = false;
      continue;
    }
    if (inQuote) continue;
    if (/^\s*\|/.test(line)) {
      if (!inTable) starts.push(i - sectionStart);
      inTable = true; inParagraph = false;
      continue;
    }
    if (inTable) continue;
    if (!inParagraph) { starts.push(i - sectionStart); inParagraph = true; }
  }
  return starts;
}

/**
 * 高亮 span 标注的文本片段
 */
async function highlightSpanFragments(
  targetEl: HTMLElement, uuid: string, type: string, color: string,
  sourcePath: string, plugin: ReadingHost,
): Promise<void> {
  const annotation = await annotationStore.getAnnotationByUuid(uuid);
  if (!annotation || annotation.kind !== 'span' || !annotation.spanRanges || annotation.spanRanges.length === 0) return;

  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;

  const content = await plugin.app.vault.cachedRead(file);
  const fragments: string[] = [];
  for (const range of annotation.spanRanges) {
    const slice = content.substring(range.from, range.to);
    const scan = scanMarkdownContexts(slice);
    for (const seg of scan.segments) {
      if (seg.type === 'text' && seg.content.trim().length > 0) {
        fragments.push(seg.content.trim());
      }
    }
  }
  if (fragments.length === 0) return;
  wrapTextFragments(targetEl, fragments, type, color);
}

/**
 * 在容器内查找并包裹指定的文本片段
 */
export function wrapTextFragments(
  container: HTMLElement, fragments: string[], type: string, color: string,
): void {
  const preset = DEFAULT_SETTINGS.presetColors.find((c) => c.id === color);
  const hex = preset ? preset.hex : color;

  for (const raw of fragments) {
    const frag = raw.trim();
    if (!frag) continue;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) textNodes.push(node as Text);

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (parent?.hasClass('markvault-span-fragment')) continue;
      const text = textNode.textContent || '';
      const idx = text.indexOf(frag);
      if (idx === -1) continue;

      const before = text.substring(0, idx);
      const after = text.substring(idx + frag.length);
      const span = document.createElement('span');
      span.className = `markvault-span-fragment markvault-${type} markvault-${color}`;
      span.textContent = frag;

      switch (type) {
        case 'bold':
          span.style.fontWeight = 'bold';
          span.style.borderBottom = `2px solid ${hex}`; break;
        case 'underline':
          span.style.textDecoration = 'underline';
          span.style.textDecorationColor = hex;
          span.style.textUnderlineOffset = '2px'; break;
        case 'highlight':
          span.style.backgroundColor = `${hex}66`;
          span.style.borderRadius = '2px'; break;
      }

      const containerNode = textNode.parentNode!;
      if (before) containerNode.insertBefore(document.createTextNode(before), textNode);
      containerNode.insertBefore(span, textNode);
      if (after) containerNode.insertBefore(document.createTextNode(after), textNode);
      containerNode.removeChild(textNode);
      break;
    }
  }
}
