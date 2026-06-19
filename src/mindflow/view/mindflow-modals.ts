/**
 * MindFlow Modals — 导图相关的所有 Modal 类
 *
 * 从 mindflow-view.ts 提取 (Step 1 of P0-1 split)
 *
 * 包含:
 *   - PreviewableEditModal (基类)
 *   - AnnotationPickerModal
 *   - AnnotationDetailModal
 *   - NodeNoteModal
 *   - NodeDetailModal
 *   - StructurePickerModal
 *   - ConnectionEditModal
 */

import {
  App,
  Modal,
  finishRenderMath,
  MarkdownRenderer,
  Setting,
  ButtonComponent,
  SearchComponent,
  Component,
} from 'obsidian';
import type { StructureType } from '../types/mind-node';

// ═══════════════════════════════════════════════════════
// 接口
// ═══════════════════════════════════════════════════════

/** 标注摘要信息（从 store.getAllAnnotations() 返回） */
export interface AnnotationSummary {
  uuid: string;
  text: string;
  note?: string;
  filePath?: string;
  tags?: string[];
}

export interface AnnotationDetail {
  uuid: string;
  filePath: string;
  type: string;
  kind?: string;
  text: string;
  note: string;
  tags: string[];
  fields?: Record<string, string>;
  groups?: string[];
  motivation?: string;
  color: string;
  startLine?: number;
  endLine?: number;
  contextBefore?: string;
  contextAfter?: string;
  createdAt: number;
  updatedAt: number;
  flags?: {
    mastery?: number;
    confidence?: number;
    reviewPriority?: number;
    needsCorrection?: boolean;
  };
  relations?: Array<{ type: string; targetUuid: string }>;
  alias?: string;
  blockType?: string;
}

// ═══════════════════════════════════════════════════════
// 可预览编辑的 Modal 基类 — NodeNoteModal / NodeDetailModal 共享
// ═══════════════════════════════════════════════════════

/** Preview/Edit 切换逻辑提取，消除 ~56 行重复代码 */
export abstract class PreviewableEditModal extends Modal {
  protected _previewComponent: Component | null = null;
  protected _isPreview = false;

  protected bindPreviewToggle(
    toggleBtn: ButtonComponent,
    textArea: HTMLTextAreaElement,
    editArea: HTMLElement,
    previewArea: HTMLElement,
    app: App,
  ): void {
    toggleBtn.onClick(async () => {
      if (!this._isPreview) {
        editArea.style.display = 'none';
        previewArea.style.display = 'block';
        previewArea.empty();
        this._previewComponent = new Component();
        this._previewComponent.load();
        try {
          await MarkdownRenderer.render(app, textArea.value || '*Nothing to preview*', previewArea, '', this._previewComponent);
          await finishRenderMath();
        } catch (err) { previewArea.setText('Preview error: ' + (err as Error).message); }
        toggleBtn.setButtonText('Edit');
        this._isPreview = true;
      } else {
        editArea.style.display = 'block';
        previewArea.style.display = 'none';
        if (this._previewComponent) { this._previewComponent.unload(); this._previewComponent = null; }
        toggleBtn.setButtonText('Preview');
        this._isPreview = false;
        textArea.focus();
      }
    });
  }

  onClose() {
    if (this._previewComponent) { this._previewComponent.unload(); this._previewComponent = null; }
    this.contentEl.empty();
  }
}

// ═══════════════════════════════════════════════════════
// 标注选择器 Modal
// ═══════════════════════════════════════════════════════

export class AnnotationPickerModal extends Modal {
  private annotations: AnnotationSummary[];
  private onSelect: (uuid: string, summary: string) => void;
  private searchComp!: SearchComponent;
  private listEl!: HTMLElement;

  constructor(
    app: App,
    annotations: AnnotationSummary[],
    onSelect: (uuid: string, summary: string) => void,
  ) {
    super(app);
    this.annotations = annotations;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Link annotation' });

    new Setting(contentEl)
      .setName('Search')
      .addSearch((search) => {
        this.searchComp = search;
        search.setPlaceholder('Search annotations...');
        search.onChange((query) => this.renderList(query));
      });

    this.listEl = contentEl.createDiv({ cls: 'mf-annotation-picker__list' });
    this.listEl.style.maxHeight = '400px';
    this.listEl.style.overflow = 'auto';
    this.listEl.style.marginTop = '12px';

    this.renderList('');
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderList(query: string): void {
    this.listEl.empty();

    const q = query.toLowerCase().trim();
    const filtered = q
      ? this.annotations.filter(a => {
          const searchText = `${a.text} ${a.note ?? ''} ${a.tags?.join(' ') ?? ''} ${a.filePath ?? ''}`.toLowerCase();
          return searchText.includes(q);
        })
      : this.annotations;

    if (filtered.length === 0) {
      this.listEl.createEl('p', { text: 'No matching annotations.' });
      return;
    }

    for (const ann of filtered) {
      const item = this.listEl.createDiv({ cls: 'mf-annotation-picker__item' });
      item.style.padding = '8px 12px';
      item.style.borderRadius = '6px';
      item.style.cursor = 'pointer';
      item.style.marginBottom = '4px';
      item.style.border = '1px solid var(--background-modifier-border, #ddd)';

      const text = document.createElement('div');
      text.textContent = ann.text.length > 60 ? ann.text.slice(0, 60) + '...' : ann.text;
      text.style.fontSize = '13px';
      text.style.fontWeight = '500';
      item.appendChild(text);

      if (ann.note) {
        const note = document.createElement('div');
        note.textContent = ann.note.length > 40 ? ann.note.slice(0, 40) + '...' : ann.note;
        note.style.fontSize = '12px';
        note.style.color = 'var(--text-muted, #999)';
        note.style.marginTop = '2px';
        item.appendChild(note);
      }

      const meta = document.createElement('div');
      meta.textContent = `${ann.filePath ?? ''} ${ann.tags?.length ? '#'.concat(ann.tags.join(' #')) : ''}`;
      meta.style.fontSize = '11px';
      meta.style.color = 'var(--text-faint, #bbb)';
      meta.style.marginTop = '2px';
      item.appendChild(meta);

      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = '';
      });

      item.addEventListener('click', () => {
        const summary = ann.note
          ? `${ann.text.slice(0, 30)} (${ann.note.slice(0, 20)})`
          : ann.text.slice(0, 40);
        this.onSelect(ann.uuid, summary);
        this.close();
      });
    }
  }
}

// ═══════════════════════════════════════════════════════
// 标注详情 Modal — 查看标注完整信息
// ═══════════════════════════════════════════════════════

export class AnnotationDetailModal extends Modal {
  private annotation: AnnotationDetail;
  private onJump: (uuid: string) => void;
  private renderComponent: Component | null = null;

  constructor(app: App, annotation: AnnotationDetail, onJump: (uuid: string) => void) {
    super(app);
    this.annotation = annotation;
    this.onJump = onJump;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-annotation-detail');

    const ann = this.annotation;
    if (this.renderComponent) {
      this.renderComponent.unload();
    }
    this.renderComponent = new Component();
    this.renderComponent.load();

    // 标题栏
    const header = contentEl.createDiv({ cls: 'mf-annotation-detail__header' });
    const titleEl = header.createDiv({ cls: 'mf-annotation-detail__title' });
    titleEl.createEl('span', { text: 'Annotation Detail' });

    // 类型徽章
    const badge = header.createEl('span', { cls: 'mf-annotation-detail__badge' });
    badge.textContent = ann.kind ?? ann.type ?? 'inline';
    if (ann.blockType) {
      badge.textContent += ` · ${ann.blockType}`;
    }

    // 标注原文
    const section1 = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
    section1.createEl('div', { cls: 'mf-annotation-detail__label', text: '原文' });
    const textEl = section1.createDiv({ cls: 'mf-annotation-detail__content mf-annotation-detail__content--quoted' });
    MarkdownRenderer.render(this.app, ann.text || '(empty)', textEl, ann.filePath ?? '', this.renderComponent);

    // 批注内容
    if (ann.note) {
      const section2 = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      section2.createEl('div', { cls: 'mf-annotation-detail__label', text: '批注' });
      const noteEl = section2.createDiv({ cls: 'mf-annotation-detail__content' });
      MarkdownRenderer.render(this.app, ann.note, noteEl, ann.filePath ?? '', this.renderComponent);
    }

    // 上下文
    if (ann.contextBefore || ann.contextAfter) {
      const ctxSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      ctxSection.createEl('div', { cls: 'mf-annotation-detail__label', text: '上下文' });
      const ctxEl = ctxSection.createDiv({ cls: 'mf-annotation-detail__content mf-annotation-detail__content--context' });
      const before = ctxEl.createEl('span', { cls: 'mf-annotation-detail__context-before' });
      before.textContent = ann.contextBefore ?? '';
      const highlight = ctxEl.createEl('span', { cls: 'mf-annotation-detail__context-highlight' });
      highlight.textContent = ann.text.slice(0, 50) + (ann.text.length > 50 ? '...' : '');
      const after = ctxEl.createEl('span', { cls: 'mf-annotation-detail__context-after' });
      after.textContent = ann.contextAfter ?? '';
    }

    // 标签
    if (ann.tags && ann.tags.length > 0) {
      const tagSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      tagSection.createEl('div', { cls: 'mf-annotation-detail__label', text: '标签' });
      const tagContainer = tagSection.createDiv({ cls: 'mf-annotation-detail__tags' });
      for (const tag of ann.tags) {
        const tagEl = tagContainer.createEl('span', { cls: 'mf-annotation-detail__tag' });
        tagEl.textContent = `#${tag}`;
      }
    }

    // 分组
    if (ann.groups && ann.groups.length > 0) {
      const groupSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      groupSection.createEl('div', { cls: 'mf-annotation-detail__label', text: '分组' });
      const groupContainer = groupSection.createDiv({ cls: 'mf-annotation-detail__tags' });
      for (const g of ann.groups) {
        const groupEl = groupContainer.createEl('span', { cls: 'mf-annotation-detail__tag mf-annotation-detail__tag--group' });
        groupEl.textContent = g;
      }
    }

    // 自定义字段
    if (ann.fields && Object.keys(ann.fields).length > 0) {
      const fieldSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      fieldSection.createEl('div', { cls: 'mf-annotation-detail__label', text: '自定义字段' });
      const fieldTable = fieldSection.createEl('table', { cls: 'mf-annotation-detail__fields' });
      for (const [key, value] of Object.entries(ann.fields)) {
        const row = fieldTable.createEl('tr');
        row.createEl('td', { cls: 'mf-annotation-detail__field-key', text: key });
        row.createEl('td', { cls: 'mf-annotation-detail__field-value', text: value });
      }
    }

    // 意图
    if (ann.motivation) {
      const motSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      motSection.createEl('div', { cls: 'mf-annotation-detail__label', text: '意图' });
      motSection.createEl('div', { cls: 'mf-annotation-detail__content mf-annotation-detail__content--inline', text: ann.motivation });
    }

    // 学习状态
    if (ann.flags) {
      const flagSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      flagSection.createEl('div', { cls: 'mf-annotation-detail__label', text: '学习状态' });
      const flagContainer = flagSection.createDiv({ cls: 'mf-annotation-detail__flags' });

      if (ann.flags.mastery !== undefined) {
        const m = flagContainer.createEl('span', { cls: 'mf-annotation-detail__flag' });
        m.textContent = `掌握度: ${ann.flags.mastery}/5`;
      }
      if (ann.flags.confidence !== undefined) {
        const c = flagContainer.createEl('span', { cls: 'mf-annotation-detail__flag' });
        c.textContent = `置信度: ${ann.flags.confidence}/5`;
      }
      if (ann.flags.reviewPriority !== undefined) {
        const r = flagContainer.createEl('span', { cls: 'mf-annotation-detail__flag' });
        r.textContent = `复习优先级: ${ann.flags.reviewPriority}`;
      }
      if (ann.flags.needsCorrection) {
        const nc = flagContainer.createEl('span', { cls: 'mf-annotation-detail__flag mf-annotation-detail__flag--warning' });
        nc.textContent = '需纠正';
      }
    }

    // 关联关系
    if (ann.relations && ann.relations.length > 0) {
      const relSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section' });
      relSection.createEl('div', { cls: 'mf-annotation-detail__label', text: `关联 (${ann.relations.length})` });
      const relList = relSection.createDiv({ cls: 'mf-annotation-detail__relations' });
      for (const rel of ann.relations) {
        const relItem = relList.createDiv({ cls: 'mf-annotation-detail__relation' });
        relItem.createEl('span', { cls: 'mf-annotation-detail__relation-type', text: rel.type });
        relItem.createEl('span', { cls: 'mf-annotation-detail__relation-target', text: `→ ${rel.targetUuid.slice(0, 8)}...` });
      }
    }

    // 元信息
    const metaSection = contentEl.createDiv({ cls: 'mf-annotation-detail__section mf-annotation-detail__section--meta' });
    const metaGrid = metaSection.createDiv({ cls: 'mf-annotation-detail__meta' });

    const addMeta = (label: string, value: string) => {
      const item = metaGrid.createDiv({ cls: 'mf-annotation-detail__meta-item' });
      item.createEl('span', { cls: 'mf-annotation-detail__meta-label', text: label });
      item.createEl('span', { cls: 'mf-annotation-detail__meta-value', text: value });
    };

    addMeta('文件', ann.filePath ?? '(unknown)');
    if (ann.startLine !== undefined) addMeta('行号', `L${ann.startLine}${ann.endLine ? `–L${ann.endLine}` : ''}`);
    addMeta('创建', this.formatDate(ann.createdAt));
    addMeta('更新', this.formatDate(ann.updatedAt));
    if (ann.alias) addMeta('别名', ann.alias);
    addMeta('UUID', ann.uuid.slice(0, 12) + '...');

    // 底部操作栏
    const footer = contentEl.createDiv({ cls: 'mf-annotation-detail__footer' });

    new ButtonComponent(footer)
      .setButtonText('跳转到原文')
      .setCta()
      .onClick(() => {
        this.onJump(ann.uuid);
        this.close();
      });

    new ButtonComponent(footer)
      .setButtonText('关闭')
      .onClick(() => {
        this.close();
      });
  }

  onClose() {
    this.contentEl.empty();
    if (this.renderComponent) {
      this.renderComponent.unload();
      this.renderComponent = null;
    }
  }

  private formatDate(ts: number): string {
    if (!ts) return '-';
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }
}

// ═══════════════════════════════════════════════════════
// 节点备注编辑 Modal
// ═══════════════════════════════════════════════════════

export class NodeNoteModal extends PreviewableEditModal {
  private nodeTitle: string;
  private currentNote: string;
  private onSave: (note: string) => void;

  constructor(app: App, nodeTitle: string, currentNote: string, onSave: (note: string) => void) {
    super(app);
    this.nodeTitle = nodeTitle;
    this.currentNote = currentNote;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl, app } = this;
    contentEl.empty();
    contentEl.addClass('mf-node-note');

    contentEl.createEl('h3', { text: `Note: ${this.nodeTitle}` });

    const editArea = contentEl.createDiv();
    const textArea = editArea.createEl('textarea', { cls: 'mf-node-note__textarea' });
    textArea.value = this.currentNote;
    textArea.style.width = '100%';
    textArea.style.minHeight = '120px';
    textArea.style.marginTop = '8px';
    textArea.style.fontSize = '14px';
    textArea.style.fontFamily = 'inherit';
    textArea.style.resize = 'vertical';
    textArea.style.borderRadius = '6px';
    textArea.style.border = '1px solid var(--background-modifier-border, #ddd)';
    textArea.style.padding = '8px';
    textArea.style.background = 'var(--background-primary, #fff)';
    textArea.placeholder = 'Add a note for this node (Markdown supported)...';

    const previewArea = contentEl.createDiv({ cls: 'mf-node-note__preview' });
    previewArea.style.display = 'none';
    previewArea.style.marginTop = '8px';
    previewArea.style.padding = '12px';
    previewArea.style.border = '1px solid var(--background-modifier-border, #ddd)';
    previewArea.style.borderRadius = '6px';
    previewArea.style.background = 'var(--background-primary, #fff)';
    previewArea.style.minHeight = '120px';
    previewArea.style.maxHeight = '400px';
    previewArea.style.overflow = 'auto';

    const footer = contentEl.createDiv({ cls: 'mf-node-note__footer' });
    footer.style.display = 'flex';
    footer.style.gap = '10px';
    footer.style.justifyContent = 'flex-end';
    footer.style.marginTop = '12px';

    const toggleBtn = new ButtonComponent(footer).setButtonText('Preview');
    this.bindPreviewToggle(toggleBtn, textArea, editArea, previewArea, app);

    new ButtonComponent(footer).setButtonText('Clear').onClick(() => { textArea.value = ''; });

    new ButtonComponent(footer).setButtonText('Save').setCta().onClick(() => {
      this.onSave(textArea.value);
      this.close();
    });

    new ButtonComponent(footer).setButtonText('Cancel').onClick(() => { this.close(); });

    setTimeout(() => textArea.focus(), 50);
  }
}

// ═══════════════════════════════════════════════════════
// 节点详情编辑 Modal (md-seed detail 双向编辑)
// ═══════════════════════════════════════════════════════

export class NodeDetailModal extends PreviewableEditModal {
  private nodeTitle: string;
  private currentDetail: string;
  private nodeId: string;
  private onSave: (detail: string) => void;

  constructor(app: App, nodeTitle: string, currentDetail: string, nodeId: string, onSave: (detail: string) => void) {
    super(app);
    this.nodeTitle = nodeTitle;
    this.currentDetail = currentDetail;
    this.nodeId = nodeId;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl, app } = this;
    contentEl.empty();
    contentEl.addClass('mf-node-detail');

    contentEl.createEl('h3', { text: `Detail: ${this.nodeTitle}` });

    const hint = contentEl.createEl('p', {
      text: 'Content is stored in the .md file as a detail block. Edits here sync back to the file.',
      cls: 'mf-node-detail__hint',
    });
    hint.style.fontSize = '11px';
    hint.style.color = 'var(--text-muted, #888)';
    hint.style.margin = '4px 0 8px';

    const editArea = contentEl.createDiv();
    const textArea = editArea.createEl('textarea', { cls: 'mf-node-detail__textarea' });
    textArea.value = this.currentDetail;
    textArea.style.width = '100%';
    textArea.style.minHeight = '200px';
    textArea.style.marginTop = '8px';
    textArea.style.fontSize = '13px';
    textArea.style.fontFamily = 'var(--font-monospace, monospace)';
    textArea.style.resize = 'vertical';
    textArea.style.borderRadius = '6px';
    textArea.style.border = '1px solid var(--background-modifier-border, #ddd)';
    textArea.style.padding = '10px';
    textArea.style.background = 'var(--background-primary, #fff)';
    textArea.placeholder = 'Enter detail content (Markdown supported)...';

    const previewArea = contentEl.createDiv({ cls: 'mf-node-detail__preview' });
    previewArea.style.display = 'none';
    previewArea.style.marginTop = '8px';
    previewArea.style.padding = '12px';
    previewArea.style.border = '1px solid var(--background-modifier-border, #ddd)';
    previewArea.style.borderRadius = '6px';
    previewArea.style.background = 'var(--background-primary, #fff)';
    previewArea.style.minHeight = '200px';
    previewArea.style.maxHeight = '500px';
    previewArea.style.overflow = 'auto';

    const footer = contentEl.createDiv({ cls: 'mf-node-detail__footer' });
    footer.style.display = 'flex';
    footer.style.gap = '10px';
    footer.style.justifyContent = 'flex-end';
    footer.style.marginTop = '12px';

    const toggleBtn = new ButtonComponent(footer).setButtonText('Preview');
    this.bindPreviewToggle(toggleBtn, textArea, editArea, previewArea, app);

    new ButtonComponent(footer).setButtonText('Clear').onClick(() => { textArea.value = ''; });

    new ButtonComponent(footer).setButtonText('Save').setCta().onClick(() => {
      this.onSave(textArea.value);
      this.close();
    });

    new ButtonComponent(footer).setButtonText('Cancel').onClick(() => { this.close(); });

    setTimeout(() => textArea.focus(), 50);
  }
}

// ═══════════════════════════════════════════════════════
// 结构选择器 + 自主连线标签编辑 Modals
// ═══════════════════════════════════════════════════════

const STRUCTURE_OPTIONS: Array<{ type: StructureType; label: string; icon: string; desc: string }> = [
  { type: 'flow',       label: 'Flow',       icon: '\u26a1', desc: 'Sequential or branching process flow' },
  { type: 'skeleton',   label: 'Skeleton',   icon: '\u2726', desc: 'Skeletal outline for brainstorming' },
  { type: 'hierarchy',  label: 'Hierarchy',  icon: '\u229e', desc: 'Top-down organizational structure' },
  { type: 'process',    label: 'Process',    icon: '\u21bb', desc: 'Cyclic or step-by-step workflow' },
  { type: 'fishbone',   label: 'Fishbone',   icon: '\u22ca', desc: 'Cause-and-effect analysis' },
  { type: 'freeform',   label: 'Freeform',   icon: '\u2731', desc: 'Unstructured creative mapping' },
];

export class StructurePickerModal extends Modal {
  private currentType: StructureType;
  private onSelect: (type: StructureType) => void;

  constructor(app: App, currentType: StructureType, onSelect: (type: StructureType) => void) {
    super(app);
    this.currentType = currentType;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Choose structure type' });

    const grid = contentEl.createDiv();
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gap = '8px';
    grid.style.marginTop = '12px';

    for (const opt of STRUCTURE_OPTIONS) {
      const item = grid.createDiv();
      item.style.padding = '10px 14px';
      item.style.borderRadius = '8px';
      item.style.cursor = 'pointer';
      item.style.border = opt.type === this.currentType
        ? '2px solid var(--interactive-accent, #483699)'
        : '1px solid var(--background-modifier-border, #ddd)';
      item.style.background = opt.type === this.currentType
        ? 'var(--background-modifier-hover, rgba(0,0,0,0.05))'
        : 'var(--background-primary, #fff)';

      const header = item.createDiv();
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';

      const iconEl = header.createEl('span');
      iconEl.textContent = opt.icon;
      iconEl.style.fontSize = '18px';

      const label = header.createEl('span');
      label.textContent = opt.label;
      label.style.fontWeight = '500';
      label.style.fontSize = '14px';

      const desc = item.createDiv();
      desc.textContent = opt.desc;
      desc.style.fontSize = '11px';
      desc.style.color = 'var(--text-muted, #888)';
      desc.style.marginTop = '4px';

      item.addEventListener('click', () => {
        this.onSelect(opt.type);
        this.close();
      });

      item.addEventListener('mouseenter', () => {
        if (opt.type !== this.currentType) {
          item.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
        }
      });
      item.addEventListener('mouseleave', () => {
        if (opt.type !== this.currentType) {
          item.style.background = 'var(--background-primary, #fff)';
        }
      });
    }

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.marginTop = '12px';

    new ButtonComponent(footer)
      .setButtonText('Cancel')
      .onClick(() => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class ConnectionEditModal extends Modal {
  private currentLabel: string;
  private currentNote: string;
  private onSave: (label: string, note: string) => void;

  constructor(app: App, currentLabel: string, currentNote: string, onSave: (label: string, note: string) => void) {
    super(app);
    this.currentLabel = currentLabel;
    this.currentNote = currentNote;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Edit connection' });

    const labelSection = contentEl.createDiv();
    labelSection.createEl('label', { text: 'Label' });
    const labelInput = labelSection.createEl('input', { type: 'text' });
    labelInput.value = this.currentLabel;
    labelInput.style.width = '100%';
    labelInput.style.marginBottom = '8px';
    labelInput.style.borderRadius = '4px';
    labelInput.style.border = '1px solid var(--background-modifier-border, #ddd)';
    labelInput.style.padding = '4px 8px';
    labelInput.placeholder = 'e.g. supports, contradicts, related to...';

    const noteSection = contentEl.createDiv();
    noteSection.createEl('label', { text: 'Note (detail)' });
    const noteInput = noteSection.createEl('textarea');
    noteInput.value = this.currentNote;
    noteInput.style.width = '100%';
    noteInput.style.minHeight = '80px';
    noteInput.style.borderRadius = '4px';
    noteInput.style.border = '1px solid var(--background-modifier-border, #ddd)';
    noteInput.style.padding = '6px 8px';
    noteInput.style.fontSize = '13px';
    noteInput.style.resize = 'vertical';
    noteInput.placeholder = 'Add a note explaining this connection...';

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.gap = '10px';
    footer.style.justifyContent = 'flex-end';
    footer.style.marginTop = '12px';

    new ButtonComponent(footer)
      .setButtonText('Save')
      .setCta()
      .onClick(() => {
        this.onSave(labelInput.value, noteInput.value);
        this.close();
      });

    new ButtonComponent(footer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    setTimeout(() => labelInput.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ═══════════════════════════════════════════════════════
// 关系详情 Modal — 左键标注关系连线时弹出
// ═══════════════════════════════════════════════════════

import { RELATION_COLORS } from '../render/svg-connector';

export interface RelationEdgeInfo {
  sourceUuid: string;
  targetUuid: string;
  relationType: string;
  relationNote?: string;
  invalidated: boolean;
}

export class RelationDetailModal extends Modal {
  private edge: RelationEdgeInfo;
  private sourceText: string;
  private targetText: string;
  private onRemove: () => void;
  private onRestore: () => void;

  constructor(
    app: App,
    edge: RelationEdgeInfo,
    sourceText: string,
    targetText: string,
    onRemove: () => void,
    onRestore: () => void,
  ) {
    super(app);
    this.edge = edge;
    this.sourceText = sourceText;
    this.targetText = targetText;
    this.onRemove = onRemove;
    this.onRestore = onRestore;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('Relation Detail');
    contentEl.style.minWidth = '320px';
    contentEl.style.padding = '16px';

    const edge = this.edge;

    const typeRow = contentEl.createDiv();
    typeRow.style.display = 'flex';
    typeRow.style.alignItems = 'center';
    typeRow.style.gap = '12px';
    typeRow.style.marginBottom = '12px';
    typeRow.createEl('span', { text: 'Type' });
    const typeColor = edge.invalidated ? '#D0D0D0' : (RELATION_COLORS[edge.relationType] ?? '#9CA3AF');
    const typeBadge = typeRow.createEl('span');
    typeBadge.textContent = edge.relationType;
    typeBadge.style.background = typeColor;
    typeBadge.style.color = '#fff';
    typeBadge.style.padding = '2px 10px';
    typeBadge.style.borderRadius = '4px';
    typeBadge.style.fontSize = '12px';
    typeBadge.style.fontWeight = '600';

    const statusRow = contentEl.createDiv();
    statusRow.style.display = 'flex';
    statusRow.style.alignItems = 'center';
    statusRow.style.gap = '12px';
    statusRow.style.marginBottom = '16px';
    statusRow.createEl('span', { text: 'Status' });
    const statusVal = statusRow.createEl('span');
    statusVal.textContent = edge.invalidated ? 'Invalidated (soft-deleted)' : 'Active';
    statusVal.style.opacity = edge.invalidated ? '0.5' : '1';

    const hr = contentEl.createEl('hr');
    hr.style.margin = '12px 0';
    hr.style.border = 'none';
    hr.style.borderTop = '1px solid var(--background-modifier-border)';

    const sourceSection = contentEl.createDiv();
    sourceSection.style.marginBottom = '12px';
    sourceSection.createEl('div', {
      text: 'Source Annotation',
      attr: { style: 'font-weight:600; margin-bottom:4px; color:var(--text-muted);' },
    });
    sourceSection.createEl('div', {
      text: this.sourceText.slice(0, 200),
      attr: { style: 'line-height:1.4; margin-bottom:4px;' },
    });
    sourceSection.createEl('div', {
      text: `UUID: ${edge.sourceUuid.slice(0, 16)}\u2026`,
      attr: { style: 'font-size:11px; color:var(--text-faint);' },
    });

    const targetSection = contentEl.createDiv();
    targetSection.style.marginBottom = '12px';
    targetSection.createEl('div', {
      text: 'Target Annotation',
      attr: { style: 'font-weight:600; margin-bottom:4px; color:var(--text-muted);' },
    });
    targetSection.createEl('div', {
      text: this.targetText.slice(0, 200),
      attr: { style: 'line-height:1.4; margin-bottom:4px;' },
    });
    targetSection.createEl('div', {
      text: `UUID: ${edge.targetUuid.slice(0, 16)}\u2026`,
      attr: { style: 'font-size:11px; color:var(--text-faint);' },
    });

    if (edge.relationNote) {
      const noteSection = contentEl.createDiv();
      noteSection.style.marginBottom = '12px';
      noteSection.style.padding = '8px';
      noteSection.style.background = 'var(--background-primary-alt)';
      noteSection.style.borderRadius = '6px';
      noteSection.createEl('div', {
        text: 'Note',
        attr: { style: 'font-weight:600; margin-bottom:4px; color:var(--text-muted);' },
      });
      noteSection.createEl('div', {
        text: edge.relationNote,
        attr: { style: 'line-height:1.4;' },
      });
    }

    const btnBar = contentEl.createDiv();
    btnBar.style.display = 'flex';
    btnBar.style.gap = '8px';
    btnBar.style.marginTop = '16px';

    if (edge.invalidated) {
      const restoreBtn = btnBar.createEl('button', { text: 'Restore', cls: 'mod-cta' });
      restoreBtn.addEventListener('click', () => {
        this.close();
        this.onRestore();
      });
    } else {
      const removeBtn = btnBar.createEl('button', { text: 'Remove', cls: 'mod-warning' });
      removeBtn.addEventListener('click', () => {
        this.close();
        this.onRemove();
      });
    }

    const closeBtn = btnBar.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
