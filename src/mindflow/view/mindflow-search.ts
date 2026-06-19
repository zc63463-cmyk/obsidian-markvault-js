/**
 * MindFlow Annotation Search — 标注搜索 + 导图高亮 MVP
 *
 * 功能: 搜索标注文本/标签, 在导图中高亮匹配的 @A 节点,
 *       支持单击跳转、高亮全部、聚焦模式.
 */

import { App, Modal, Notice } from 'obsidian';
import type { MindNode } from '../types/mind-node';
import { getAnnotationStore } from './mindflow-connections';

/** 搜索结果项 */
interface SearchResult {
  uuid: string;
  text: string;
  note?: string;
  nodeId: string;    // 导图中对应的 @A 节点 ID
  tags?: string[];
  filePath?: string;
}

/** 搜索上下文 — MindFlowView 暴露的状态 */
export interface SearchContext {
  rootNode: MindNode | null;
  nodeElements: Map<string, HTMLElement>;
  app: App;
  scrollToNode: (id: string) => void;
  selectNode: (id: string | null) => void;
}

/** 当前活跃的高亮匹配 ID 集合 */
let _activeHighlightIds: Set<string> = new Set();

/** 收集导图中所有 @A 节点: annotationRef → nodeId */
function collectAnnNodes(root: MindNode): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (n: MindNode) => {
    if (n.type === 'annotation' && n.annotationRef) {
      map.set(n.annotationRef, n.id);
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return map;
}

/** 对标注文本做模糊匹配 */
function matchesSearch(ann: SearchResult, query: string): boolean {
  const q = query.toLowerCase();
  const fields = [ann.text, ann.note ?? '', ann.tags?.join(' ') ?? '', ann.filePath ?? ''];
  return fields.some(f => f.toLowerCase().includes(q));
}

/** ... (rest of helpers) */

/** 高亮导图中的匹配节点 (脉冲边框) */
export function highlightSearchMatches(
  ctx: SearchContext,
  nodeIds: string[],
  focusMode: boolean,
): void {
  clearSearchHighlights();
  _activeHighlightIds = new Set(nodeIds);

  for (const nodeId of nodeIds) {
    const el = ctx.nodeElements.get(nodeId);
    if (!el) continue;
    el.classList.add('mf-node--search-match');
  }

  // 聚焦模式: 非匹配节点淡化
  if (focusMode && ctx.rootNode) {
    const walk = (n: MindNode) => {
      const el = ctx.nodeElements.get(n.id);
      if (el && !_activeHighlightIds.has(n.id)) {
        el.classList.add('mf-node--search-dim');
      }
      for (const c of n.children) walk(c);
    };
    walk(ctx.rootNode);
  }
}

/** 清除所有搜索高亮 */
export function clearSearchHighlights(): void {
  const matches = document.querySelectorAll('.mf-node--search-match');
  const dims = document.querySelectorAll('.mf-node--search-dim');
  matches.forEach(el => el.classList.remove('mf-node--search-match'));
  dims.forEach(el => el.classList.remove('mf-node--search-dim'));
  _activeHighlightIds.clear();
}

/** 打开标注搜索面板 */
export function openAnnotationSearch(ctx: SearchContext): void {
  const modal = new AnnotationSearchModal(ctx);
  modal.open();
}

/** 标注搜索 Modal */
export class AnnotationSearchModal extends Modal {
  private ctx: SearchContext;
  private results: SearchResult[] = [];
  private listEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private resultCountEl: HTMLElement;
  private focusMode = false;

  constructor(ctx: SearchContext) {
    super(ctx.app);
    this.ctx = ctx;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-annotation-search');
    contentEl.style.minWidth = '380px';
    contentEl.style.maxWidth = '480px';
    contentEl.style.padding = '12px';

    // 标题栏
    this.titleEl.setText('Search Annotations');

    // 搜索框
    const searchRow = contentEl.createDiv();
    searchRow.style.display = 'flex';
    searchRow.style.gap = '8px';
    searchRow.style.marginBottom = '8px';
    searchRow.style.alignItems = 'center';

    this.inputEl = searchRow.createEl('input', { type: 'text', cls: 'mf-search__input' });
    this.inputEl.style.flex = '1';
    this.inputEl.style.padding = '6px 10px';
    this.inputEl.style.borderRadius = '6px';
    this.inputEl.style.border = '1px solid var(--background-modifier-border, #ddd)';
    this.inputEl.style.background = 'var(--background-primary, #fff)';
    this.inputEl.style.fontSize = '14px';
    this.inputEl.placeholder = 'Search annotations...';
    this.inputEl.addEventListener('input', () => this._doSearch());

    this.resultCountEl = searchRow.createEl('span');
    this.resultCountEl.style.fontSize = '12px';
    this.resultCountEl.style.color = 'var(--text-muted, #888)';
    this.resultCountEl.style.whiteSpace = 'nowrap';

    // 快捷键提示
    const hint = contentEl.createDiv();
    hint.style.fontSize = '11px';
    hint.style.color = 'var(--text-faint, #bbb)';
    hint.style.marginBottom = '8px';
    hint.textContent = 'Enter: jump to first result  |  Esc: close';

    // 结果列表
    this.listEl = contentEl.createDiv({ cls: 'mf-search__list' });
    this.listEl.style.maxHeight = '320px';
    this.listEl.style.overflow = 'auto';

    // 底部操作栏
    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.marginTop = '10px';
    footer.style.justifyContent = 'flex-end';

    const highlightAllBtn = footer.createEl('button', { text: 'Highlight All' });
    highlightAllBtn.addEventListener('click', () => {
      const nodeIds = this.results.map(r => r.nodeId);
      highlightSearchMatches(this.ctx, nodeIds, this.focusMode);
      new Notice(`Highlighted ${nodeIds.length} node(s) in mindmap`);
    });

    const focusBtn = footer.createEl('button', { text: this.focusMode ? 'Focus: ON' : 'Focus: OFF' });
    focusBtn.addEventListener('click', () => {
      this.focusMode = !this.focusMode;
      focusBtn.textContent = this.focusMode ? 'Focus: ON' : 'Focus: OFF';
      focusBtn.style.background = this.focusMode ? 'var(--interactive-accent, #483699)' : '';
      focusBtn.style.color = this.focusMode ? '#fff' : '';
    });

    const clearBtn = footer.createEl('button', { text: 'Clear' });
    clearBtn.addEventListener('click', () => {
      clearSearchHighlights();
      new Notice('Search highlights cleared');
    });

    // 键盘快捷键
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.close(); }
      if (e.key === 'Enter') {
        const first = this.listEl.querySelector('.mf-search__item') as HTMLElement;
        if (first) first.click();
      }
    });

    // 自动聚焦
    setTimeout(() => this.inputEl.focus(), 50);

    // 初始搜索 (可能已有内容)
    this._doSearch();
  }

  onClose() {
    this.contentEl.empty();
  }

  /** 执行搜索 */
  private _doSearch(): void {
    if (!this.ctx.rootNode) return;

    const query = this.inputEl.value.trim();
    const annToNode = collectAnnNodes(this.ctx.rootNode);
    const store = getAnnotationStore(this.ctx.app);
    const allAnnotations = store?.getAllAnnotations?.() ?? [];

    // 筛选 + 匹配
    this.results = [];
    for (const ann of allAnnotations) {
      const nodeId = annToNode.get(ann.uuid);
      if (!nodeId) continue; // 不在当前导图

      const item: SearchResult = {
        uuid: ann.uuid,
        text: ann.text ?? '',
        note: ann.note,
        nodeId,
        tags: ann.tags,
        filePath: ann.filePath,
      };

      if (query) {
        if (!matchesSearch(item, query)) continue;
      }

      this.results.push(item);
    }

    // 渲染结果
    this._renderList();

    // 更新计数
    if (query) {
      this.resultCountEl.textContent = `${this.results.length} result(s)`;
    } else {
      this.resultCountEl.textContent = `${this.results.length} annotation(s) in mindmap`;
    }
  }

  /** 渲染搜索结果列表 */
  private _renderList(): void {
    this.listEl.empty();

    if (this.results.length === 0) {
      const noResult = this.listEl.createDiv();
      noResult.style.padding = '16px';
      noResult.style.textAlign = 'center';
      noResult.style.color = 'var(--text-muted, #888)';
      noResult.textContent = this.inputEl.value.trim()
        ? 'No matching annotations in this mindmap'
        : 'No annotation nodes in this mindmap';
      return;
    }

    for (const item of this.results) {
      const row = this.listEl.createDiv({ cls: 'mf-search__item' });
      row.style.padding = '6px 8px';
      row.style.borderRadius = '6px';
      row.style.cursor = 'pointer';
      row.style.marginBottom = '3px';
      row.style.border = '1px solid transparent';
      row.style.transition = 'background 0.1s';

      // 标注文本
      const text = row.createEl('div');
      text.textContent = item.text.length > 60 ? item.text.slice(0, 60) + '\u2026' : item.text;
      text.style.fontSize = '13px';
      text.style.fontWeight = '500';

      // 副文本: note 预览
      if (item.note) {
        const noteEl = row.createEl('div');
        noteEl.textContent = item.note.length > 40 ? item.note.slice(0, 40) + '\u2026' : item.note;
        noteEl.style.fontSize = '12px';
        noteEl.style.color = 'var(--text-muted, #999)';
      }

      // 标签 + 文件路径
      const meta = row.createEl('div');
      const metaParts: string[] = [];
      if (item.tags?.length) metaParts.push(item.tags.map(t => '#' + t).join(' '));
      if (item.filePath) metaParts.push(item.filePath.split('/').pop() ?? '');
      meta.textContent = metaParts.join(' | ');
      meta.style.fontSize = '11px';
      meta.style.color = 'var(--text-faint, #bbb)';

      // Hover 效果
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
      });

      // 点击 → 跳转到导图节点
      row.addEventListener('click', () => {
        this.ctx.selectNode(item.nodeId);
        this.ctx.scrollToNode(item.nodeId);
        // 对单个节点高亮
        highlightSearchMatches(this.ctx, [item.nodeId], false);
        // 不关闭 Modal (用户可能想继续搜索)
      });
    }
  }
}
