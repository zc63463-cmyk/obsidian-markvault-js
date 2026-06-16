import { TFile, MarkdownView, type MarkdownPostProcessorContext } from 'obsidian';
import type { AnnotationType, Annotation } from '../types/annotation';
import { DEFAULT_SETTINGS } from '../types/annotation';
import { annotationStore } from '../db/annotation-store';
import { getAnnotationByUuid } from '../db/annotation-repo';
import { requestRegionLayerRedraw } from '../core/highlight-applier';
import type { ChangeInfo } from '../core/offset-tracker';
import { applyIncrementalOffsetFix } from '../core/offset-tracker';
import { parseRegionAnnotations, REGION_ANCHOR_REGEX, buildRegionAnchor } from '../core/region-annotation';
import { findBlockTargetLine, findBlockContentEndLine, computeSpanRanges, findSpanEndLine, parseBlockDoubleAnchors } from '../core/annotation-parser';
import { computeSignature, computeSpanSignature } from '../core/block-fingerprint';
import { markdownToPlainWithMap } from '../core/markdown-plain';
import { scanMarkdownContexts } from '../core/md-context';
import { ModifyGuard } from '../utils/modify-guard';
import { ReadingModeToolbar } from '../ui/reading/ReadingModeToolbar';
import { ReadingModeClickDelegate } from '../ui/reading/ReadingModeClickDelegate';

/**
 * Minimal interface that MarkVaultPlugin must satisfy for ReadingModeProcessor.
 * Uses TypeScript structural typing — no explicit `implements` needed.
 */
export interface ReadingHost {
  readonly app: import('obsidian').App;
  readonly settings: import('../types/annotation').MarkVaultSettings;
  readonly modifyGuard: ModifyGuard;
  activeFilePath: string | null;
  isStoreReady(): boolean;
  updateSpanCache(filePath: string): Promise<void>;
  updateRegionCache(filePath: string): Promise<void>;
  refreshSidebar(): Promise<void>;
  scheduleSidebarRefresh(): void;
  markFileSynced(filePath: string): void;
  openAnnotationModal(uuid: string): Promise<void>;
  createReadingAnnotation(text: string, color: string, type: AnnotationType, kind: Annotation['kind']): Promise<void>;
  getDefaultColor(): string;
}

export class ReadingModeProcessor {
  private readingToolbar: ReadingModeToolbar | null = null;
  private readingClickDelegate: ReadingModeClickDelegate | null = null;

  // Fields for handleDocChange
  private pendingOffsetFix: Promise<void> | null = null;
  private pendingChanges: ChangeInfo[] = [];

  constructor(private plugin: ReadingHost) {}

  /** Register the markdown post processor — call from plugin.onload() */
  registerPostProcessor(): void {
    try {
      (this.plugin as any).registerMarkdownPostProcessor(async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        try {
          // 1. 处理 <mark> 标注
          const marks = el.findAll('mark[data-uuid]');
          marks.forEach((mark) => {
            const htmlEl = mark as HTMLElement;
            const type = (htmlEl.getAttribute('data-type') || 'highlight') as import('../types/annotation').AnnotationType;
            const color = htmlEl.getAttribute('data-color') || 'yellow';
            const preset = DEFAULT_SETTINGS.presetColors.find(c => c.id === color);
            const hex = preset ? preset.hex : color;

            // 添加标识 class（供全局事件委托识别 + CSS 样式）
            htmlEl.addClass('markvault-mark');
            htmlEl.addClass(`markvault-${type}`);
            htmlEl.addClass(`markvault-${color}`);
            htmlEl.addClass('markvault-clickable');
            htmlEl.style.cursor = 'pointer';

            switch (type) {
              case 'highlight':
                htmlEl.style.backgroundColor = `${hex}66`;
                htmlEl.style.borderRadius = '2px';
                htmlEl.style.padding = '1px 0';
                break;
              case 'bold':
                htmlEl.style.fontWeight = 'bold';
                htmlEl.style.borderBottom = `2px solid ${hex}`;
                htmlEl.style.padding = '1px 0';
                break;
              case 'underline':
                htmlEl.style.textDecoration = 'underline';
                htmlEl.style.textDecorationColor = hex;
                htmlEl.style.textUnderlineOffset = '2px';
                break;
            }

            const note = htmlEl.getAttribute('data-note');
            if (note) {
              htmlEl.setAttribute('title', note);
              htmlEl.addClass('markvault-has-note');
            }
          });

          // 处理自然语法标注（隐身锚点 + 原生 Markdown 包裹）
          await this.processNativeAnnotations(el, ctx.sourcePath);

          // 处理块级锚点标注
          await this.processBlockAnchors(el, ctx);

          // 处理区域标注（双锚点包围）
          await this.processRegionAnnotations(el, ctx);

          // 防御性清理：隐藏阅读模式中泄漏的锚点文本
          this.hideLeakedAnchorText(el);
        } catch (err) {
          console.error('MarkVault: post processor error', err);
        }
      });
    } catch (err) {
      console.error('MarkVault: failed to register markdown post processor', err);
    }
  }

  /** Set up reading mode toolbar and click delegate — call from plugin.onload() */
  setupReadingModeUI(): void {
    // 全局事件委托：捕获阅读模式下对 markvault 标注的点击
    try {
      this.readingClickDelegate = new ReadingModeClickDelegate(this.plugin as any, {
        onOpenAnnotation: (uuid: string) => this.plugin.openAnnotationModal(uuid),
      });
      this.readingClickDelegate.setup();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode click delegate', err);
    }

    // 阅读模式：选中文本浮动工具条
    try {
      const readingHost = {
        createReadingAnnotation: (req: { selectedText: string; color: string; type: AnnotationType; kind: Annotation['kind'] }) =>
          this.plugin.createReadingAnnotation(req.selectedText, req.color, req.type, req.kind),
        getDefaultColor: () => this.plugin.getDefaultColor(),
      };

      this.readingToolbar = new ReadingModeToolbar(this.plugin as any, readingHost);
      this.readingToolbar.setup();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode toolbar/context menu', err);
    }
  }

  /** Destroy reading mode UI — call from plugin.onunload() */
  destroy(): void {
    this.readingToolbar?.destroy();
    this.readingClickDelegate?.destroy();
  }

  /** Handle CM6 document changes for offset tracking */
  handleDocChange(changes: ChangeInfo[]): void {
    if (!this.plugin.activeFilePath) return;

    // 累积变更，避免连续编辑时丢失中间变更
    this.pendingChanges.push(...changes);

    // 如果已经有处理任务在运行，直接返回；队列会被该任务消费
    if (this.pendingOffsetFix) return;

    this.pendingOffsetFix = (async () => {
      try {
        while (this.pendingChanges.length > 0) {
          // 取出当前队列中的所有变更
          const batch = this.pendingChanges.splice(0);

          const filePath = this.plugin.activeFilePath;
          if (!filePath) return;

          const annotations = await annotationStore.getAnnotationsForFile(filePath);
          if (annotations.length === 0) continue;

          const result = await applyIncrementalOffsetFix(filePath, batch, annotations);

          if (result.updated > 0 || result.deleted > 0) {
            console.log(`MarkVault: offset fix — updated: ${result.updated}, deleted: ${result.deleted}`);

            // 偏移修正后刷新 span 缓存，确保 CM6 装饰使用最新偏移
            await this.plugin.updateSpanCache(filePath);
            await this.plugin.updateRegionCache(filePath);

            if (result.deleted > 0) {
              await this.plugin.refreshSidebar();
            }
          }
        }
      } catch (err) {
        console.error('MarkVault: offset fix error', err);
      } finally {
        this.pendingOffsetFix = null;
      }
    })();
  }

  // ─── 阅读模式渲染方法 ──────────────────────────────────────

  /**
   * 处理块级锚点标注的阅读模式渲染
   */
  private async processBlockAnchors(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const sourcePath = ctx.sourcePath;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
    const anchorNodes: { uuid: string; type: string; color: string; note: string; node: Node; anchorKind: 'block' | 'span' }[] = [];
    const doubleAnchors = new Map<string, { start?: Node; end?: Node; type: string; color: string; note: string }>();

    const decodeNote = (raw: string) => raw.replace(/\\p/g, '%').replace(/\\c/g, ':');

    let currentNode: Node | null;
    while ((currentNode = walker.nextNode())) {
      if (currentNode.nodeType === Node.COMMENT_NODE) {
        const text = currentNode.textContent || '';
        // Block 格式：markvault:uuid:type:color:note
        const blockMatch = text.match(/^markvault:([^:]+):([^:]+):([^:]+):?([\s\S]*)$/);
        if (blockMatch) {
          anchorNodes.push({
            uuid: blockMatch[1],
            type: blockMatch[2],
            color: blockMatch[3],
            note: blockMatch[4] ? blockMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'block',
          });
        }
        // Span 格式：markvault-span:uuid:type:color:note
        const spanMatch = text.match(/^markvault-span:([^:]+):([^:]+):([^:]+):?([\s\S]*)$/);
        if (spanMatch) {
          anchorNodes.push({
            uuid: spanMatch[1],
            type: spanMatch[2],
            color: spanMatch[3],
            note: spanMatch[4] ? spanMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'span',
          });
        }
        // 双锚点 block 格式：markvault-block:uuid:type:color:start|end:note
        const doubleMatch = text.match(/^markvault-block:([^:]+):([^:]+):([^:]+):(start|end):?([\s\S]*)$/);
        if (doubleMatch) {
          const uuid = doubleMatch[1];
          const entry = doubleAnchors.get(uuid) || {
            type: doubleMatch[2],
            color: doubleMatch[3],
            note: doubleMatch[5] ? decodeNote(doubleMatch[5]) : '',
          };
          if (doubleMatch[4] === 'start') entry.start = currentNode;
          else entry.end = currentNode;
          doubleAnchors.set(uuid, entry);
        }
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
        const htmlEl = currentNode as HTMLElement;
        if (htmlEl.className && typeof htmlEl.className === 'string' && htmlEl.className.includes('cm-')) {
          continue; // 跳过 CM6 元素
        }
        const text = htmlEl.textContent || '';
        // Block 格式
        const blockMatch = text.match(/^%%markvault:([^:]+):([^:]+):([^:]+):?([\s\S]*)%%$/);
        if (blockMatch) {
          anchorNodes.push({
            uuid: blockMatch[1],
            type: blockMatch[2],
            color: blockMatch[3],
            note: blockMatch[4] ? blockMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'block',
          });
          continue;
        }
        // Span 格式
        const spanMatch = text.match(/^%%markvault-span:([^:]+):([^:]+):([^:]+):?([\s\S]*)%%$/);
        if (spanMatch) {
          anchorNodes.push({
            uuid: spanMatch[1],
            type: spanMatch[2],
            color: spanMatch[3],
            note: spanMatch[4] ? spanMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'span',
          });
          continue;
        }
        // 双锚点 block 格式
        const doubleMatch = text.match(/^%%markvault-block:([^:]+):([^:]+):([^:]+):(start|end):?([\s\S]*)%%$/);
        if (doubleMatch) {
          const uuid = doubleMatch[1];
          const entry = doubleAnchors.get(uuid) || {
            type: doubleMatch[2],
            color: doubleMatch[3],
            note: doubleMatch[5] ? decodeNote(doubleMatch[5]) : '',
          };
          if (doubleMatch[4] === 'start') entry.start = currentNode;
          else entry.end = currentNode;
          doubleAnchors.set(uuid, entry);
          // 可见锚点需要隐藏
          htmlEl.style.display = 'none';
          htmlEl.addClass('markvault-anchor-hidden');
          continue;
        }
      }
    }

    // 给 span 锚点下方的元素添加装饰
    for (const anchor of anchorNodes) {
      if (anchor.node.nodeType === Node.ELEMENT_NODE) {
        const anchorEl = anchor.node as HTMLElement;
        anchorEl.style.display = 'none';
        anchorEl.addClass('markvault-anchor-hidden');
      }

      if (anchor.anchorKind === 'span') {
        const targetEl = this.findNextContentElement(anchor.node);
        if (targetEl) {
          this.applyBlockDecoration(targetEl, anchor.uuid, anchor.type, anchor.color, anchor.note, anchor.anchorKind, sourcePath);
        }
      }
    }

    // 处理 block 锚点：统一按源码行号映射
    const decoratedUuids = await this.applyBlockDecorationsFromSource(el, ctx, sourcePath);

    // 安全网：源码行号映射未覆盖的 block 锚点
    for (const anchor of anchorNodes) {
      if (anchor.anchorKind === 'block' && !decoratedUuids.has(anchor.uuid)) {
        const targetEl = this.findNextContentElement(anchor.node);
        if (targetEl) {
          this.applyBlockDecoration(targetEl, anchor.uuid, anchor.type, anchor.color, anchor.note, 'block', sourcePath);
        }
      }
    }
    for (const [uuid, entry] of doubleAnchors.entries()) {
      if (entry.start && !decoratedUuids.has(uuid)) {
        const targetEl = this.findNextContentElement(entry.start);
        if (targetEl) {
          this.applyBlockDecoration(targetEl, uuid, entry.type, entry.color, entry.note, 'block', sourcePath);
        }
      }
    }
  }

  /**
   * 给阅读模式下的目标块元素添加 block/span 装饰、徽章与批注指示器
   */
  private applyBlockDecoration(
    targetEl: HTMLElement,
    uuid: string,
    type: string,
    color: string,
    note: string,
    anchorKind: 'block' | 'span',
    sourcePath: string,
  ): void {
    targetEl.addClass('markvault-block-mark');
    targetEl.addClass(`markvault-block-${type}`);
    targetEl.addClass(`markvault-block-${color}`);
    targetEl.style.cursor = 'pointer';
    targetEl.dataset.uuid = uuid;

    if (anchorKind === 'span') {
      targetEl.addClass('markvault-span-mark');
      this.highlightSpanFragments(targetEl, uuid, type, color, sourcePath).catch((err) => {
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
   * 判断 a 是否在 b 之前（按文档顺序）
   */
  private isNodeBefore(a: Node, b: Node): boolean {
    const position = a.compareDocumentPosition(b);
    return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  /**
   * 从源码行号映射，给当前 section 内的 block 锚点添加阅读模式装饰
   */
  private async applyBlockDecorationsFromSource(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    sourcePath: string,
  ): Promise<Set<string>> {
    const decorated = new Set<string>();
    const info = ctx.getSectionInfo(el);
    if (!info) return decorated;

    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return decorated;

    try {
      const content = await this.plugin.app.vault.cachedRead(file);
      const lines = content.split('\n');
      const sectionStart = info.lineStart;
      const sectionEnd = info.lineEnd;

      interface BlockAnchorMatch {
        uuid: string;
        type: string;
        color: string;
        note: string;
        startLine: number;
        endLine: number;
      }
      const matches: BlockAnchorMatch[] = [];

      // 旧单锚点 %%markvault:uuid:type:color:note%%
      const oldRegex = /^%%markvault:([^:%]+):([^:%]+):([^:%]+):([^%]*)%%$/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trim().match(oldRegex);
        if (!m) continue;
        const targetLine = findBlockTargetLine(content, i);
        if (targetLine > sectionEnd || targetLine < sectionStart) continue;
        matches.push({
          uuid: m[1],
          type: m[2],
          color: m[3],
          note: m[4].replace(/\\c/g, ':').replace(/\\p/g, '%'),
          startLine: targetLine,
          endLine: targetLine,
        });
      }

      // 新双锚点 %%markvault-block:uuid:type:color:start|end:note%%
      const doubleAnchors = parseBlockDoubleAnchors(content);
      const doubleByUuid = new Map<string, { start?: typeof doubleAnchors[0]; end?: typeof doubleAnchors[0] }>();
      for (const a of doubleAnchors) {
        const entry = doubleByUuid.get(a.uuid) || {};
        if (a.position === 'start') {
          if (!entry.start) entry.start = a;
        } else {
          if (!entry.end) entry.end = a;
        }
        doubleByUuid.set(a.uuid, entry);
      }
      for (const [uuid, entry] of doubleByUuid.entries()) {
        if (!entry.start) continue;
        const startLine = findBlockTargetLine(content, entry.start.anchorLine);
        const endLine = entry.end ? findBlockContentEndLine(content, entry.end.anchorLine) : startLine;
        if (endLine < startLine) continue;
        if (endLine < sectionStart || startLine > sectionEnd) continue;
        matches.push({
          uuid,
          type: entry.start.type,
          color: entry.start.color,
          note: entry.start.note,
          startLine,
          endLine,
        });
      }

      if (matches.length === 0) return decorated;

      const leafBlocks = this.collectLeafBlocks(el);
      if (leafBlocks.length === 0) return decorated;

      const blockStarts = this.computeBlockStarts(lines, sectionStart, sectionEnd);

      for (const match of matches) {
        const targetIndices: number[] = [];
        for (let i = 0; i < blockStarts.length; i++) {
          const absLine = sectionStart + blockStarts[i];
          if (absLine >= match.startLine && absLine <= match.endLine) {
            targetIndices.push(i);
          }
        }
        if (targetIndices.length > 0) {
          decorated.add(match.uuid);
        }

        if (targetIndices.length === 0) {
          let nearest = -1;
          for (let i = 0; i < blockStarts.length; i++) {
            if (sectionStart + blockStarts[i] <= match.startLine) {
              nearest = i;
            } else {
              break;
            }
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
  private collectLeafBlocks(root: HTMLElement): HTMLElement[] {
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
      if (/^%%(markvault|markvault-span|markvault-region|markvault-block):/.test(text) && text.endsWith('%%')) {
        continue;
      }

      if (el.tagName === 'LI' || el.hasClass('callout')) {
        candidates.push(el);
        continue;
      }

      const hasBlockChild = Array.from(el.children).some(
        child => blockTags.has((child as HTMLElement).tagName) || (child as HTMLElement).hasClass?.('callout')
      );
      if (!hasBlockChild) {
        candidates.push(el);
      }
    }

    return candidates
      .filter((el) => !candidates.some(other => other !== el && other.contains(el)))
      .filter((el) => (el.innerText ?? el.textContent ?? '').trim().length > 0);
  }

  /**
   * 计算 section 内各内容块的起始行
   */
  private computeBlockStarts(lines: string[], sectionStart: number, sectionEnd: number): number[] {
    const starts: number[] = [];
    let inParagraph = false;
    let inCode = false;
    let inCallout = false;
    let inQuote = false;
    let inTable = false;

    for (let i = sectionStart; i <= sectionEnd && i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trimStart();
      const trimmed = raw.trim();
      const isBlank = trimmed === '';
      const isAnchor = /^%%(markvault|markvault-span|markvault-region|markvault-block):/.test(trimmed);

      if (isBlank) {
        inParagraph = false;
        if (!inCode) {
          inCallout = false;
          inQuote = false;
          inTable = false;
        }
        continue;
      }

      if (isAnchor) {
        inParagraph = false;
        if (!inCode) {
          inCallout = false;
          inQuote = false;
          inTable = false;
        }
        continue;
      }

      if (/^\s*```/.test(raw)) {
        if (!inCode) {
          starts.push(i - sectionStart);
          inCode = true;
        } else {
          inCode = false;
        }
        inParagraph = false;
        inCallout = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (inCode) continue;

      if (/^\s*#{1,6}\s/.test(line)) {
        starts.push(i - sectionStart);
        inParagraph = false;
        inCallout = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (/^\s*([-]{3,}|[*]{3,}|[_]{3,})\s*$/.test(trimmed)) {
        starts.push(i - sectionStart);
        inParagraph = false;
        continue;
      }

      if (/^\s*>\s*\[!/.test(line)) {
        starts.push(i - sectionStart);
        inCallout = true;
        inParagraph = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (inCallout) continue;

      if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
        starts.push(i - sectionStart);
        inParagraph = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (/^\s*>/.test(line)) {
        if (!inQuote) starts.push(i - sectionStart);
        inQuote = true;
        inParagraph = false;
        inTable = false;
        continue;
      }

      if (inQuote) continue;

      if (/^\s*\|/.test(line)) {
        if (!inTable) starts.push(i - sectionStart);
        inTable = true;
        inParagraph = false;
        continue;
      }

      if (inTable) continue;

      if (!inParagraph) {
        starts.push(i - sectionStart);
        inParagraph = true;
      }
    }

    return starts;
  }

  /**
   * 处理自然 Markdown 语法标注
   */
  private async processNativeAnnotations(el: HTMLElement, sourcePath: string): Promise<void> {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT);
    const anchors: { node: Comment; uuid: string; type: AnnotationType; color: string }[] = [];

    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const text = node.textContent || '';
      const match = text.match(/^mv:i:([^:]+):([^:]+):([^:]+)$/);
      if (match) {
        anchors.push({
          node: node as Comment,
          uuid: match[1],
          type: match[2] as AnnotationType,
          color: match[3],
        });
      }
    }

    for (const anchor of anchors) {
      const targetEl = this.findNextContentElement(anchor.node);
      if (!targetEl) continue;

      const annotation = await getAnnotationByUuid(anchor.uuid);
      const type = anchor.type;
      const color = anchor.color;

      targetEl.addClass('markvault-native', `markvault-${type}`, `markvault-${color}`, 'markvault-clickable');
      targetEl.dataset.uuid = anchor.uuid;
      targetEl.dataset.type = type;
      targetEl.dataset.color = color;
      targetEl.style.cursor = 'pointer';

      if (annotation?.note) {
        targetEl.setAttribute('title', annotation.note);
        targetEl.addClass('markvault-has-note');
      }
    }
  }

  /**
   * Region 标注阅读模式渲染（基于 Block 架构重写）
   */
  private async processRegionAnnotations(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const sourcePath = ctx.sourcePath;
    const info = ctx.getSectionInfo(el);
    if (!info) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.plugin.app.vault.cachedRead(file);
      const lines = content.split('\n');
      const sectionStart = info.lineStart;
      const sectionEnd = info.lineEnd;

      const regions = parseRegionAnnotations(content, sourcePath);
      if (regions.length === 0) return;

      const matched = regions.filter(r => {
        const rs = r.startLine ?? 0;
        const re = r.endLine ?? rs;
        return rs <= sectionEnd && re >= sectionStart;
      });
      if (matched.length === 0) return;

      const leafBlocks = this.collectLeafBlocks(el);
      if (leafBlocks.length === 0) return;
      const blockStarts = this.computeBlockStarts(lines, sectionStart, sectionEnd);

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
            this.addRegionBadge(targetEl, region.type as AnnotationType, region.color, region.note);
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

  /**
   * Region 段落级整块高亮
   */
  private highlightRegionBlocks(
    root: HTMLElement,
    start: Node,
    end: Node,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): HTMLElement | null {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    const startBlock = this.findNearestBlockAncestor(start, blockTags);
    const endBlock = this.findNearestBlockAncestor(end, blockTags);
    if (!startBlock || !endBlock) return null;

    const targets: HTMLElement[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let collecting = false;
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const el = node as HTMLElement;
      if (!blockTags.has(el.tagName) && !el.hasClass('callout')) continue;

      const hasBlockChildren = Array.from(el.children).some(
        child => blockTags.has((child as HTMLElement).tagName) || (child as HTMLElement).hasClass?.('callout')
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

  /**
   * 找到节点的最近块级祖先元素
   */
  private findNearestBlockAncestor(node: Node, blockTags: Set<string>): HTMLElement | null {
    let current: Node | null = node.parentNode;
    while (current && current !== document.body) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as HTMLElement;
        if (blockTags.has(el.tagName) || el.hasClass('callout')) return el;
      }
      current = current.parentNode;
    }
    return null;
  }

  /**
   * 防御性清理：隐藏阅读模式中泄漏的 markvault 锚点文本
   */
  private hideLeakedAnchorText(root: HTMLElement): void {
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

  /**
   * 从文本节点中提取内联的 region 锚点
   */
  private extractInlineRegionAnchors(
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
      this.extractInlineRegionAnchorsFromTextNode(textNode, regionAnchors, anchorNodesToHide);
    }
  }

  private extractInlineRegionAnchorsFromTextNode(
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

  /**
   * 给整个 section 加 region 样式
   */
  private applyRegionStyleToSection(root: HTMLElement, uuid: string, type: AnnotationType, color: string, regionText?: string): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const styledAncestors = new Set<Element>();
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    const normalizedRegionText = regionText ? this.normalizeRegionMatchText(regionText) : undefined;
    const regionTokens = normalizedRegionText ? this.tokenizeRegionMatchText(normalizedRegionText) : [];

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
        const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');

        if (isBlock) {
          const hasBlockChildren = Array.from(el.children).some(
            child => blockTags.has(child.tagName) || (child as HTMLElement).hasClass?.('callout')
          );
          if (hasBlockChildren) {
            continue;
          }
        }

        if (normalizedRegionText) {
          const blockText = this.normalizeRegionMatchText(el.textContent || '');
          const containsRegion = blockText.includes(normalizedRegionText);
          const containedByRegion = normalizedRegionText.includes(blockText) && blockText.length > 0;
          if (!containsRegion && !containedByRegion) {
            const matchedTokens = regionTokens.filter(t => blockText.includes(t)).length;
            if (regionTokens.length === 0 || matchedTokens / regionTokens.length < 0.5) {
              continue;
            }
          }
        }

        this.styleRegionBlockBorderAndText(el, uuid, type, color);
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

  /**
   * 给块级元素加左侧竖线，并把其内部文本节点包裹为 inline span
   */
  private styleRegionBlockBorderAndText(
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

  /**
   * 归一化 region/块文本
   */
  private normalizeRegionMatchText(text: string): string {
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[*=_~`#\[\]()|<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 把 region 文本拆成可用于限域匹配的词元
   */
  private tokenizeRegionMatchText(text: string): string[] {
    return text
      .split(/[\s,.;:!?，。；：！？、（）()\[\]【】《》""''「」『』—–\-\/\\]+/)
      .filter(token => token.length >= 2);
  }

  /**
   * 精确匹配 section 内的 region 内容并高亮
   */
  private applyRegionStyleToSectionPrecise(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
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

    const firstWrapped = this.wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
    if (firstWrapped) {
      this.styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
    }
    return firstWrapped;
  }

  /**
   * 把 root 内 [startChar, endChar) 范围内的文本节点包裹成 region span
   */
  private wrapTextRange(
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

  /**
   * 找到 startEl 的最近块级祖先，给它加上点击事件和徽章
   */
  private styleRegionBlockAncestor(startEl: HTMLElement, type: AnnotationType, color: string, note?: string): void {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    let target: HTMLElement | null = startEl;
    while (target && target !== document.body) {
      if (blockTags.has(target.tagName) || target.hasClass('callout')) break;
      target = target.parentElement;
    }
    if (!target || target === document.body) return;

    target.addClass('markvault-region-block-border', `markvault-region-${color}`, 'markvault-clickable');
    target.dataset.uuid = startEl.dataset.uuid || '';
    target.dataset.type = type;
    target.dataset.color = color;
    target.style.cursor = 'pointer';
    this.addRegionBadge(target, type, color, note);
  }

  /**
   * 给 region 标注的目标元素添加右上角类型徽章
   */
  private addRegionBadge(targetEl: HTMLElement, type: AnnotationType, color: string, note?: string): void {
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

  /**
   * 找到 region 两个锚点之间的第一个元素节点
   */
  private findFirstRegionElement(start: Node, end: Node | null): HTMLElement | null {
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

  /**
   * 高亮从 start Comment 到 el 末尾的 DOM 节点
   */
  private highlightRegionFromStart(
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

    this.applyRegionStyleToNodes(root, nodes, uuid, type, color);
  }

  /**
   * 高亮从 el 开头到 end Comment 的 DOM 节点
   */
  private highlightRegionToEnd(
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

    this.applyRegionStyleToNodes(root, nodes, uuid, type, color);
  }

  /**
   * 给一组 DOM 节点批量应用 region 样式
   */
  private applyRegionStyleToNodes(
    root: HTMLElement,
    nodes: Node[],
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

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
        const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');

        if (isBlock) {
          const hasBlockChildren = Array.from(el.children).some(
            c => blockTags.has(c.tagName) || (c as HTMLElement).hasClass?.('callout')
          );
          if (hasBlockChildren) {
            continue;
          }

          this.styleRegionBlockBorderAndText(el, uuid, type, color);
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

  /**
   * 精确匹配 section 中从 start 锚点到 section 末尾的内容并高亮
   */
  private applyRegionStyleFromStartAnchor(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
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

    const firstWrapped = this.wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
    if (firstWrapped) {
      this.styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
    }
    return firstWrapped;
  }

  /**
   * 精确匹配 section 中从 section 开头到 end 锚点的内容并高亮
   */
  private applyRegionStyleToEndAnchor(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
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

    const firstWrapped = this.wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
    if (firstWrapped) {
      this.styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
    }
    return firstWrapped;
  }

  /**
   * 给完全在 region 内的 section 的所有块级子元素加样式
   */
  private applyRegionStyleToMiddleSection(
    root: HTMLElement,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    for (const child of Array.from(root.children)) {
      const el = child as HTMLElement;
      const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');
      if (isBlock) {
        const hasBlockChildren = Array.from(el.children).some(
          c => blockTags.has(c.tagName) || (c as HTMLElement).hasClass?.('callout')
        );
        if (hasBlockChildren) {
          el.addClass('markvault-clickable');
          el.dataset.uuid = uuid;
          el.dataset.type = type;
          el.dataset.color = color;
          el.style.cursor = 'pointer';
          this.applyRegionStyleToMiddleSection(el, uuid, type, color);
          continue;
        }

        this.styleRegionBlockBorderAndText(el, uuid, type, color);
      }
    }
  }

  /**
   * 在阅读模式下高亮 span 标注的文本片段
   */
  private async highlightSpanFragments(
    targetEl: HTMLElement,
    uuid: string,
    type: string,
    color: string,
    sourcePath: string,
  ): Promise<void> {
    const annotation = await annotationStore.getAnnotationByUuid(uuid);
    if (!annotation || annotation.kind !== 'span' || !annotation.spanRanges || annotation.spanRanges.length === 0) {
      return;
    }

    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const content = await this.plugin.app.vault.cachedRead(file);
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
    this.wrapTextFragments(targetEl, fragments, type, color);
  }

  /**
   * 在容器内查找并包裹指定的文本片段
   */
  private wrapTextFragments(
    container: HTMLElement,
    fragments: string[],
    type: string,
    color: string,
  ): void {
    const preset = DEFAULT_SETTINGS.presetColors.find((c) => c.id === color);
    const hex = preset ? preset.hex : color;

    for (const raw of fragments) {
      const frag = raw.trim();
      if (!frag) continue;

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode()) !== null) {
        textNodes.push(node as Text);
      }

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
            span.style.borderBottom = `2px solid ${hex}`;
            break;
          case 'underline':
            span.style.textDecoration = 'underline';
            span.style.textDecorationColor = hex;
            span.style.textUnderlineOffset = '2px';
            break;
          case 'highlight':
            span.style.backgroundColor = `${hex}66`;
            span.style.borderRadius = '2px';
            break;
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

  /**
   * 从锚点节点查找下一个可装饰的内容元素
   */
  private findNextContentElement(anchorNode: Node): HTMLElement | null {
    // 策略1: 直接向后遍历 nextSibling，跳过空白文本节点
    let sibling: Node | null = anchorNode.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE) {
        const el = sibling as HTMLElement;
        if (el.textContent?.trim()) {
          return el;
        }
      }
      sibling = sibling.nextSibling;
    }

    // 策略2: 向上查找到段落级容器，找下一个兄弟元素
    let parent: Node | null = anchorNode.parentNode;
    while (parent && parent !== document.body) {
      if (parent.nodeType === Node.ELEMENT_NODE) {
        const parentEl = parent as HTMLElement;
        const blockTags = ['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION'];
        if (blockTags.includes(parentEl.tagName) || parentEl.hasClass('markdown-preview-sizer') || parentEl.hasClass('markdown-reading-view')) {
          let nextEl: Element | null = parentEl.nextElementSibling;
          while (nextEl) {
            if ((nextEl as HTMLElement).style.display === 'none' || nextEl.hasClass('markvault-anchor-hidden')) {
              nextEl = nextEl.nextElementSibling;
              continue;
            }
            if (nextEl.textContent?.trim()) {
              return nextEl as HTMLElement;
            }
            nextEl = nextEl.nextElementSibling;
          }
          break;
        }
      }
      parent = parent.parentNode;
    }

    return null;
  }
}
