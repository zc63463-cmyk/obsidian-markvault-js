/**
 * relation-picker-modal.ts — 标注关联目标选择器
 *
 * 替代 editor-modal.ts 中原始的 prompt('Enter UUID') 交互。
 * 使用 AnnotationSearchEngine 实现实时搜索 + 结果列表。
 *
 * Phase 4.5 (搜索重构): 新增模块。
 */

import { Modal, App, Setting } from 'obsidian';
import type { AnnotationRelation, RelationType } from '../../types/annotation';
import { RELATION_TYPE_LABELS } from '../../types/annotation';
import type { AnnotationSearchEngine } from '../../search/search-engine';
import type { Suggestion } from '../../search/types';
import { debounce } from '../../utils/debounce';

/** RelationPicker 的回调参数 */
export interface RelationPickResult {
  targetUuid: string;
  type: RelationType;
  note?: string;
}

export class RelationPickerModal extends Modal {
  private engine: AnnotationSearchEngine;
  private sourceUuid: string;
  private sourceFilePath: string;
  private onPick: (result: RelationPickResult) => void;

  private selectedUuid: string | null = null;
  private selectedType: RelationType | null = null;
  private suggestions: Suggestion[] = [];
  private searchInput: HTMLInputElement | null = null;
  private linkBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    engine: AnnotationSearchEngine,
    sourceUuid: string,
    sourceFilePath: string,
    onPick: (result: RelationPickResult) => void,
  ) {
    super(app);
    this.engine = engine;
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
        this._doSearch(this.searchInput!.value);
      }, 200),
    );

    // ── 关系类型选择器 ──
    new Setting(contentEl)
      .setName('Relation type')
      .setDesc(`Linking from current annotation to the selected one`)
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Select type...');
        for (const [value, label] of Object.entries(RELATION_TYPE_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue('');  // 默认空，强制用户主动选择
        dropdown.onChange((value) => {
          this.selectedType = (value || null) as RelationType | null;
          this._updateLinkBtnState();
        });
      });

    // ── 结果列表容器 ──
    const resultsContainer = contentEl.createDiv({ cls: 'markvault-relation-picker-results' });
    resultsContainer.id = 'markvault-relation-results';

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
      if (!this.selectedUuid || !this.selectedType) return;
      this.onPick({
        targetUuid: this.selectedUuid,
        type: this.selectedType,
      });
      this.close();
    });

    // 初始加载最近的标注
    this._loadRecent();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  // ─── Private ──────────────────────────────────────────

  private _doSearch(query: string) {
    if (!query || !query.trim()) {
      this._loadRecent();
      return;
    }

    this.suggestions = this.engine.suggest(query, 20);

    // 过滤掉自己（不能关联到自己）
    this.suggestions = this.suggestions.filter(s => s.uuid !== this.sourceUuid);

    this._renderResults();
  }

  private _loadRecent() {
    // 无搜索词时显示最近标注（按 createdAt 降序）
    const results = this.engine.search({
      query: undefined,
      scope: 'file',
      filePath: this.sourceFilePath,
      sortByRelevance: false,
      limit: 20,
    });

    // 排除自己
    this.suggestions = results
      .filter(r => r.annotation.uuid !== this.sourceUuid)
      .map(r => ({
        uuid: r.annotation.uuid,
        text: r.annotation.text.length > 80 ? r.annotation.text.slice(0, 77) + '…' : r.annotation.text,
        note: r.annotation.note,
        filePath: r.annotation.filePath,
        matchField: 'text',
        matchSnippet: r.annotation.text.slice(0, 60),
      }));

    this._renderResults();
  }

  private _renderResults() {
    const container = this.contentEl.querySelector('#markvault-relation-results') as HTMLElement;
    if (!container) return;
    container.empty();

    if (this.suggestions.length === 0) {
      container.createDiv({
        cls: 'markvault-relation-picker-empty',
        text: this.searchInput?.value?.trim()
          ? 'No matching annotations found'
          : 'No annotations in this file',
      });
      return;
    }

    for (const suggestion of this.suggestions) {
      const row = container.createDiv({
        cls: `markvault-relation-picker-row ${this.selectedUuid === suggestion.uuid ? 'selected' : ''}`,
      });

      // 文本预览
      const textEl = row.createDiv({ cls: 'markvault-relation-picker-text' });
      textEl.createSpan({ text: suggestion.text, cls: 'markvault-relation-picker-body' });

      // 命中字段标签
      if (suggestion.matchSnippet) {
        textEl.createSpan({
          text: suggestion.matchField,
          cls: 'markvault-relation-picker-match-tag',
        });
      }

      // 文件路径
      if (suggestion.filePath !== this.sourceFilePath) {
        row.createDiv({
          cls: 'markvault-relation-picker-path',
          text: suggestion.filePath,
        });
      }

      row.addEventListener('click', () => {
        // 取消旧选择
        const prev = container.querySelector('.markvault-relation-picker-row.selected');
        prev?.removeClass('selected');
        row.addClass('selected');
        this.selectedUuid = suggestion.uuid;
        this._updateLinkBtnState();
      });
    }
  }

  /** 更新 Link 按钮启用/禁用状态 */
  private _updateLinkBtnState() {
    if (this.linkBtn) {
      this.linkBtn.disabled = !this.selectedUuid || !this.selectedType;
    }
  }
}
