/**
 * relation-picker-modal.ts — 标注关联目标选择器
 *
 * 替代 editor-modal.ts 中原始的 prompt('Enter UUID') 交互。
 * 使用 AnnotationSearchEngine 实现实时搜索 + 结果列表。
 *
 * v4.3: 从 RelationSchema 获取动态关系类型配置。
 * v5.2: 高级搜索+筛选升级 — 支持跨文件/跨章节搜索，复用 AnnotationFilter 体系。
 *       - Scope 切换：当前文件 / 全部文件
 *       - 筛选栏：Type / Color / Mastery / Motivation / Group
 *       - 使用 SearchEngine.search() 替代 suggest()，走完整 BM25 + filter 路径
 *       - 结果行显示：标注原文 + 文件名 + 行号 + 类型徽章 + 掌握度
 */

import { Modal, App, Menu, TextComponent } from 'obsidian';
import type { RelationType, AnnotationFilter, AnnotationMotivation } from '../../types/annotation';
import type { RelationSchema } from '../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, MOTIVATION_LABELS, SEMANTIC_GROUPS } from '../../types/annotation';
import type { AnnotationSearchEngine } from '../../search/search-engine';
import type { SearchResult } from '../../search/types';
import { getFieldKeys, getFieldValues } from '../../db/annotation-repo';
import { debounce } from '../../utils/debounce';
import {
  PickerFilterState,
  renderTypeFilterBtn,
  renderMasteryFilterBtn,
  renderTagsFilterBtn,
  renderGroupFilterBtn,
  doPickerSearch,
} from '../components/search-filter-bar';

// v5.12: SEMANTIC_GROUPS 已提取到 annotation.ts 作为共享常量

/** RelationPicker 的回调参数 */
export interface RelationPickResult {
  targetUuid: string;
  type: RelationType;
  note?: string;
}

/** 搜索范围 */
type SearchScope = 'file' | 'all';

export class RelationPickerModal extends Modal {
  private engine: AnnotationSearchEngine;
  private schema: RelationSchema;
  private sourceUuid: string;
  private sourceFilePath: string;
  private onPick: (result: RelationPickResult) => void;

  private selectedUuid: string | null = null;
  private selectedType: RelationType | null = null;
  private searchInput: HTMLInputElement | null = null;
  private linkBtn: HTMLButtonElement | null = null;
  private noteInputComp: TextComponent | null = null;  // P2-1: note 一等公民

  // v5.2: 筛选状态
  // 注意：不能用 `scope` 作为属性名，Obsidian Modal 基类已有 scope: Scope 属性
  private searchScope: SearchScope = 'file';
  private filterState = new PickerFilterState();
  private fieldFilterEntries: Array<{ key: string; value: string }> = [];
  private searchQuery: string = '';

  constructor(
    app: App,
    engine: AnnotationSearchEngine,
    schema: RelationSchema,
    sourceUuid: string,
    sourceFilePath: string,
    onPick: (result: RelationPickResult) => void,
  ) {
    super(app);
    this.engine = engine;
    this.schema = schema;
    this.sourceUuid = sourceUuid;
    this.sourceFilePath = sourceFilePath;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('markvault-relation-picker');

    contentEl.createEl('h3', {
      text: 'Link to Annotation',
      cls: 'markvault-relation-picker-title',
    });

    // ── 搜索输入 ──
    const searchRow = contentEl.createDiv({ cls: 'markvault-relation-picker-search' });
    this.searchInput = searchRow.createEl('input', {
      type: 'text',
      placeholder: 'Search by text, note, tag, or UUID...',
      cls: 'markvault-relation-picker-input',
    });

    this.searchInput.addEventListener(
      'input',
      debounce(() => {
        this.searchQuery = this.searchInput!.value;
        this._doSearch();
      }, 200),
    );

    // ── v5.2: Scope 切换 ──
    const scopeRow = contentEl.createDiv({ cls: 'markvault-relation-picker-scope' });
    const fileScopeBtn = scopeRow.createEl('button', {
      text: '📄 Current File',
      cls: `markvault-scope-btn ${this.searchScope === 'file' ? 'active' : ''}`,
    });
    fileScopeBtn.addEventListener('click', () => {
      this.searchScope = 'file';
      scopeRow.querySelectorAll('.markvault-scope-btn').forEach(b => b.removeClass('active'));
      fileScopeBtn.addClass('active');
      this._doSearch();
    });

    const allScopeBtn = scopeRow.createEl('button', {
      text: '📂 All Files',
      cls: `markvault-scope-btn ${this.searchScope === 'all' ? 'active' : ''}`,
    });
    allScopeBtn.addEventListener('click', () => {
      this.searchScope = 'all';
      scopeRow.querySelectorAll('.markvault-scope-btn').forEach(b => b.removeClass('active'));
      allScopeBtn.addClass('active');
      this._doSearch();
    });

    // ── v5.2: 筛选栏 ──
    const filterRow = contentEl.createDiv({ cls: 'markvault-relation-picker-filters' });

    const _onFilterChange = () => this._doSearch();

    // 共享筛选按钮（Type / Mastery / Tags / Group）
    renderTypeFilterBtn(filterRow, this.filterState, _onFilterChange);
    renderMasteryFilterBtn(filterRow, this.filterState, _onFilterChange);
    renderTagsFilterBtn(filterRow, this.filterState, _onFilterChange);
    renderGroupFilterBtn(filterRow, this.filterState, _onFilterChange);

    // Color 筛选（RelationPicker 独有）
    const colorBtn = filterRow.createEl('button', {
      text: '🎨',
      cls: `markvault-picker-filter-btn ${this.filterState.filter.color !== 'all' ? 'active' : ''}`,
      attr: { title: 'Filter by color' },
    });
    colorBtn.addEventListener('click', () => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('All colors').setChecked(this.filterState.filter.color === 'all')
          .onClick(() => { this.filterState.filter.color = 'all'; colorBtn.removeClass('active'); this._doSearch(); });
      });
      for (const pc of PRESET_COLORS) {
        menu.addItem((item) => {
          item.setTitle(pc.label).setChecked(this.filterState.filter.color === pc.id)
            .onClick(() => { this.filterState.filter.color = pc.id; colorBtn.addClass('active'); this._doSearch(); });
        });
      }
      menu.showAtMouseEvent({ clientX: colorBtn.getBoundingClientRect().left, clientY: colorBtn.getBoundingClientRect().bottom } as MouseEvent);
    });

    // Motivation 筛选（RelationPicker 独有）
    const motBtn = filterRow.createEl('button', {
      text: this.filterState.filter.motivation && this.filterState.filter.motivation !== 'all'
        ? (MOTIVATION_LABELS[this.filterState.filter.motivation] || this.filterState.filter.motivation)
        : '🎯 Intent',
      cls: `markvault-picker-filter-btn ${this.filterState.filter.motivation && this.filterState.filter.motivation !== 'all' ? 'active' : ''}`,
      attr: { title: 'Filter by motivation (annotation intent)' },
    });
    motBtn.addEventListener('click', () => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('All').setChecked(!this.filterState.filter.motivation || this.filterState.filter.motivation === 'all')
          .onClick(() => { this.filterState.filter.motivation = 'all'; motBtn.textContent = '🎯 Intent'; motBtn.removeClass('active'); this._doSearch(); });
      });
      for (const [m, label] of Object.entries(MOTIVATION_LABELS)) {
        menu.addItem((item) => {
          item.setTitle(label).setChecked(this.filterState.filter.motivation === m)
            .onClick(() => { this.filterState.filter.motivation = m as AnnotationMotivation; motBtn.textContent = label; motBtn.addClass('active'); this._doSearch(); });
        });
      }
      menu.showAtMouseEvent({ clientX: motBtn.getBoundingClientRect().left, clientY: motBtn.getBoundingClientRect().bottom } as MouseEvent);
    });

    // Field 筛选（RelationPicker 独有 — 与侧边栏 FilterBar 一致的 + Field 按钮）
    const fieldBtn = filterRow.createEl('button', {
      text: this.fieldFilterEntries.length > 0 ? `🏷️+${this.fieldFilterEntries.length}` : '+ Field',
      cls: `markvault-picker-filter-btn ${this.fieldFilterEntries.length > 0 ? 'active' : ''}`,
      attr: { title: 'Filter by custom field' },
    });
    fieldBtn.addEventListener('click', () => {
      const keys = getFieldKeys();
      const menu = new Menu();
      if (keys.length === 0) {
        menu.addItem((item) => { item.setTitle('No fields found').setDisabled(true); });
      } else {
        for (const key of keys) {
          menu.addItem((item) => {
            item.setTitle(key).onClick(() => {
              const values = getFieldValues(key);
              const subMenu = new Menu();
              for (const val of values) {
                subMenu.addItem((si) => {
                  si.setTitle(val).onClick(() => {
                    this.fieldFilterEntries.push({ key, value: val });
                    fieldBtn.textContent = `🏷️+${this.fieldFilterEntries.length}`;
                    fieldBtn.addClass('active');
                    this._doSearch();
                  });
                });
              }
              subMenu.showAtMouseEvent({ clientX: fieldBtn.getBoundingClientRect().left, clientY: fieldBtn.getBoundingClientRect().bottom } as MouseEvent);
            });
          });
        }
      }
      menu.showAtMouseEvent({ clientX: fieldBtn.getBoundingClientRect().left, clientY: fieldBtn.getBoundingClientRect().bottom } as MouseEvent);
    });

    // ── 活跃筛选条件标签区 ──
    const activeFiltersEl = contentEl.createDiv({ cls: 'markvault-relation-picker-active-filters' });
    activeFiltersEl.id = 'markvault-active-filters';

    // ── 关系类型选择器 v6.1: Tab 分组切换 ──
    const relationSection = contentEl.createDiv({ cls: 'markvault-relation-picker-relation-section' });
    relationSection.createSpan({ cls: 'markvault-relation-picker-relation-label', text: 'Relation type:' });

    const activeTypes = this.schema.getActiveTypes();

    // 构建按 group 分组的类型
    const groupedTypes = SEMANTIC_GROUPS
      .map(g => ({ label: g.label, types: g.types.filter(rt => activeTypes.includes(rt)) }))
      .filter(g => g.types.length > 0);

    // 找到当前选中类型所在的组
    let activeGroupIdx = 0;
    if (this.selectedType) {
      for (let i = 0; i < groupedTypes.length; i++) {
        if (groupedTypes[i].types.includes(this.selectedType)) { activeGroupIdx = i; break; }
      }
    }

    // Group Tab 按钮行
    const tabRow = relationSection.createDiv({ cls: 'markvault-relation-picker-tabs' });
    tabRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin:4px 0 6px';

    const typeChipsArea = relationSection.createDiv({ cls: 'markvault-relation-picker-chips' });
    typeChipsArea.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;min-height:28px';

    const renderTypeChips = (groupIdx: number) => {
      typeChipsArea.empty();
      const group = groupedTypes[groupIdx];
      for (const type of group.types) {
        const label = this.schema.getLabel(type);
        const config = this.schema.getConfig(type);
        const color = config?.color || '#78716C';

        const chip = typeChipsArea.createSpan({
          cls: `markvault-relation-picker-chip ${this.selectedType === type ? 'active' : ''}`,
        });
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid var(--background-modifier-border,#ddd);border-radius:6px;cursor:pointer;font-size:12px;transition:all .15s;user-select:none';
        if (this.selectedType === type) { chip.style.background = 'var(--interactive-accent,#483699)'; chip.style.color = '#fff'; chip.style.borderColor = 'var(--interactive-accent,#483699)'; }

        chip.createSpan({ cls: 'markvault-relation-picker-chip-dot' }).style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}`;
        chip.createSpan({ text: label || type });

        chip.addEventListener('mouseenter', () => {
          if (this.selectedType === type) return;
          chip.style.background = 'var(--background-modifier-hover,rgba(0,0,0,.05))';
        });
        chip.addEventListener('mouseleave', () => {
          if (this.selectedType === type) return;
          chip.style.background = '';
        });
        chip.addEventListener('click', () => {
          this.selectedType = type;
          renderTypeChips(activeGroupIdx);
          this._updateLinkBtnState();
        });
      }
    };

    for (let i = 0; i < groupedTypes.length; i++) {
      const group = groupedTypes[i];
      const tab = tabRow.createSpan({
        text: group.label,
        cls: `markvault-relation-picker-tab ${i === activeGroupIdx ? 'active' : ''}`,
      });
      tab.style.cssText = `padding:2px 10px;border-radius:10px;cursor:pointer;font-size:11px;transition:all .15s;user-select:none;white-space:nowrap`;
      if (i === activeGroupIdx) {
        tab.style.background = 'var(--interactive-accent,#483699)'; tab.style.color = '#fff';
      } else {
        tab.style.background = 'var(--background-secondary,#f0f0f0)'; tab.style.color = 'var(--text-muted,#888)';
      }
      const idx = i;
      tab.addEventListener('click', () => {
        activeGroupIdx = idx;
        tabRow.querySelectorAll('.markvault-relation-picker-tab').forEach((t, j) => {
          (t as HTMLElement).style.background = j === idx ? 'var(--interactive-accent,#483699)' : 'var(--background-secondary,#f0f0f0)';
          (t as HTMLElement).style.color = j === idx ? '#fff' : 'var(--text-muted,#888)';
        });
        renderTypeChips(idx);
      });
    }

    renderTypeChips(activeGroupIdx);

    // ── P2-1: 关系说明 note 输入框（一等公民） ──
    const noteSection = contentEl.createDiv({ cls: 'markvault-relation-picker-note-section' });
    noteSection.createSpan({ cls: 'markvault-relation-picker-note-label', text: 'Note (optional):' });
    this.noteInputComp = new TextComponent(noteSection);
    this.noteInputComp.inputEl.addClass('markvault-relation-picker-note-input');
    this.noteInputComp.setPlaceholder('Describe this relationship...');
    this.noteInputComp.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
      // Enter 键提交（如果已选标注+类型）
      if (ev.key === 'Enter' && this.selectedUuid && this.selectedType) {
        this._submitPick();
      }
    });

    // ── 结果列表容器 ──
    const resultsContainer = contentEl.createDiv({ cls: 'markvault-relation-picker-results' });
    resultsContainer.id = 'markvault-relation-results';

    // ── 结果计数 ──
    const countEl = contentEl.createDiv({ cls: 'markvault-relation-picker-count' });
    countEl.id = 'markvault-relation-count';

    // ── 按钮栏 ──
    const buttonBar = contentEl.createDiv({ cls: 'markvault-relation-picker-buttons' });

    const cancelBtn = buttonBar.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const linkBtn = buttonBar.createEl('button', {
      text: 'Link',
      cls: 'mod-cta',
    });
    this.linkBtn = linkBtn;
    linkBtn.disabled = true;  // 初始禁用：未选标注 + 未选类型
    linkBtn.addEventListener('click', () => {
      this._submitPick();
    });

    // 初始加载
    this._doSearch();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  // ─── Private ──────────────────────────────────────────

  /**
   * v5.2: 统一搜索入口 — 使用 SearchEngine.search() 走完整 BM25 + filter 路径
   */
  private _doSearch() {
    // 构建 fieldFilters（RelationPicker 独有）
    let extraFilter: Partial<AnnotationFilter> = {};
    if (this.fieldFilterEntries.length > 0) {
      extraFilter.fieldFilters = {};
      for (const entry of this.fieldFilterEntries) {
        (extraFilter.fieldFilters as Record<string, string>)[entry.key] = entry.value;
      }
    }

    const { results: rawResults, totalBeforeExclude } = doPickerSearch({
      engine: this.engine,
      filterState: this.filterState,
      query: this.searchQuery || undefined,
      scope: this.searchScope,
      filePath: this.searchScope === 'file' ? this.sourceFilePath : undefined,
      excludeUuid: this.sourceUuid,
    });

    const results = rawResults.slice(0, 30);

    this._renderResults(results);
    this._renderActiveFilters();
    this._renderCount(results.length, totalBeforeExclude);
  }

  /**
   * 渲染搜索结果列表（SearchResult 版本，信息更丰富）
   */
  private _renderResults(results: SearchResult[]) {
    const container = this.contentEl.querySelector('#markvault-relation-results') as HTMLElement;
    if (!container) return;
    container.empty();

    if (results.length === 0) {
      container.createDiv({
        cls: 'markvault-relation-picker-empty',
        text: this.searchQuery?.trim()
          ? 'No matching annotations found'
          : this.searchScope === 'file'
            ? 'No annotations in this file'
            : 'No annotations found',
      });
      return;
    }

    for (const result of results) {
      const ann = result.annotation;
      const row = container.createDiv({
        cls: `markvault-relation-picker-row ${this.selectedUuid === ann.uuid ? 'selected' : ''}`,
      });

      // ── 第一行：标注原文 + 类型徽章 ──
      const topRow = row.createDiv({ cls: 'markvault-picker-row-top' });

      // 类型+颜色小圆点
      const preset = PRESET_COLORS.find(c => c.id === ann.color);
      const colorHex = preset ? preset.hex : ann.color;
      const dotEl = topRow.createSpan({ cls: 'markvault-picker-color-dot' });
      dotEl.style.backgroundColor = colorHex;

      // 标注原文
      const textEl = topRow.createSpan({ cls: 'markvault-relation-picker-body' });
      const displayText = ann.text.length > 60 ? ann.text.slice(0, 57) + '…' : ann.text;
      textEl.textContent = displayText;

      // 匹配字段标签（有搜索词时显示）
      if (this.searchQuery && result.matchSnippets && Object.keys(result.matchSnippets).length > 0) {
        const matchField = Object.keys(result.matchSnippets)[0];
        topRow.createSpan({
          text: matchField,
          cls: 'markvault-relation-picker-match-tag',
        });
      }

      // ── 第二行：元信息（文件名 + 行号 + 徽章） ──
      const metaRow = row.createDiv({ cls: 'markvault-picker-row-meta' });

      // 文件路径（跨文件时显示）
      if (ann.filePath !== this.sourceFilePath) {
        const fileName = ann.filePath.split('/').pop()?.replace('.md', '') || ann.filePath;
        metaRow.createSpan({ cls: 'markvault-picker-file-tag', text: `📄 ${fileName}` });
      }

      // 行号
      metaRow.createSpan({ cls: 'markvault-picker-line-tag', text: `L${ann.startLine + 1}` });

      // 掌握度徽章
      if (ann.flags?.mastery && ann.flags.mastery !== 'unknown') {
        const masteryEmoji: Record<string, string> = { learning: '📖', familiar: '✅', mastered: '🎯' };
        metaRow.createSpan({ cls: 'markvault-picker-meta-badge', text: masteryEmoji[ann.flags.mastery] || '' });
      }

      // Motivation 徽章
      if (ann.motivation && ann.motivation !== 'highlighting') {
        metaRow.createSpan({ cls: 'markvault-picker-meta-badge', text: MOTIVATION_LABELS[ann.motivation] });
      }

      // 批注存在标记
      if (ann.note && ann.note.trim()) {
        metaRow.createSpan({ cls: 'markvault-picker-meta-badge', text: '💬' });
      }

      // 关联数量
      const relCount = ann.relations?.filter(r => !r.invalidAt).length ?? 0;
      if (relCount > 0) {
        metaRow.createSpan({ cls: 'markvault-picker-meta-badge', text: `🔗${relCount}` });
      }

      // 点击选中
      row.addEventListener('click', () => {
        const prev = container.querySelector('.markvault-relation-picker-row.selected');
        prev?.removeClass('selected');
        row.addClass('selected');
        this.selectedUuid = ann.uuid;
        this._updateLinkBtnState();
      });
    }
  }

  /**
   * 渲染活跃筛选条件标签（可单独移除）
   */
  private _renderActiveFilters() {
    const container = this.contentEl.querySelector('#markvault-active-filters') as HTMLElement;
    if (!container) return;
    container.empty();

    const f = this.filterState.filter;
    const tags: Array<{ label: string; onRemove: () => void }> = [];

    if (this.searchScope === 'all') {
      tags.push({ label: '📂 All Files', onRemove: () => { this.searchScope = 'file'; this._doSearch(); } });
    }
    if (f.type && f.type !== 'all') {
      tags.push({ label: `Type: ${f.type}`, onRemove: () => { this.filterState.filter.type = 'all'; this._doSearch(); } });
    }
    if (f.color && f.color !== 'all') {
      tags.push({ label: `Color: ${f.color}`, onRemove: () => { this.filterState.filter.color = 'all'; this._doSearch(); } });
    }
    if (f.mastery && f.mastery !== 'all') {
      tags.push({ label: `Mastery: ${MASTERY_LABELS[f.mastery]}`, onRemove: () => { this.filterState.filter.mastery = 'all'; this._doSearch(); } });
    }
    if (f.motivation && f.motivation !== 'all') {
      tags.push({ label: `${MOTIVATION_LABELS[f.motivation]}`, onRemove: () => { this.filterState.filter.motivation = 'all'; this._doSearch(); } });
    }
    if (f.group && f.group !== 'all') {
      tags.push({ label: `Group: ${f.group}`, onRemove: () => { this.filterState.filter.group = 'all'; this._doSearch(); } });
    }
    // v6.1: tag 多选芯片
    for (const t of this.filterState.selectedTags) {
      tags.push({ label: `#${t}`, onRemove: () => { this.filterState.selectedTags = this.filterState.selectedTags.filter(st => st !== t); this._doSearch(); } });
    }
    for (let i = 0; i < this.fieldFilterEntries.length; i++) {
      const entry = this.fieldFilterEntries[i];
      const idx = i;
      tags.push({ label: `${entry.key}=${entry.value}`, onRemove: () => { this.fieldFilterEntries.splice(idx, 1); this._doSearch(); } });
    }

    if (tags.length === 0) return;

    for (const tag of tags) {
      const el = container.createSpan({ cls: 'markvault-picker-active-tag' });
      el.createSpan({ text: tag.label, cls: 'markvault-picker-active-tag-text' });
      const removeBtn = el.createEl('button', { text: '✕', cls: 'markvault-picker-active-tag-remove' });
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tag.onRemove();
      });
    }

    // 全部清除按钮
    if (tags.length > 1) {
      const clearBtn = container.createEl('button', {
        text: 'Clear all',
        cls: 'markvault-picker-clear-all',
      });
      clearBtn.addEventListener('click', () => {
        this.searchScope = 'file';
        this.filterState.reset();
        this.fieldFilterEntries = [];
        this._doSearch();
      });
    }
  }

  /**
   * 渲染结果计数
   */
  private _renderCount(filteredCount: number, totalCount: number) {
    const countEl = this.contentEl.querySelector('#markvault-relation-count') as HTMLElement;
    if (!countEl) return;

    const excluded = totalCount - filteredCount;  // 被自身排除的数量
    if (this.searchScope === 'all') {
      countEl.textContent = `${filteredCount} annotation${filteredCount !== 1 ? 's' : ''} found across all files`;
    } else {
      const fileName = this.sourceFilePath.split('/').pop()?.replace('.md', '') || 'this file';
      countEl.textContent = `${filteredCount} annotation${filteredCount !== 1 ? 's' : ''} in ${fileName}`;
    }
  }

  /** 更新 Link 按钮启用/禁用状态 */
  private _updateLinkBtnState() {
    if (this.linkBtn) {
      this.linkBtn.disabled = !this.selectedUuid || !this.selectedType;
    }
  }

  /** P2-1: 提交选择 — 包含 note 字段 */
  private _submitPick() {
    if (!this.selectedUuid || !this.selectedType) return;
    const note = this.noteInputComp?.getValue()?.trim() || undefined;
    this.onPick({
      targetUuid: this.selectedUuid,
      type: this.selectedType,
      note: note || undefined,
    });
    this.close();
  }
}
