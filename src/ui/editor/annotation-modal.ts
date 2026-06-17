import { App, Modal, TextAreaComponent, TextComponent, Setting, TFile, MarkdownRenderer, Component } from 'obsidian';
import type { Annotation, AnnotationType, AnnotationFlag, AnnotationMotivation, AnnotationRelation, PresetColorId, RelationType } from '../../types/annotation';
import { PRESET_COLORS, RELATION_SOURCE_LABELS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS, MOTIVATION_LABELS, MOTIVATION_OPTIONS, normalizeUserFieldKey, inferMotivation } from '../../types/annotation';
import type { MasteryLevel, ReviewPriority } from '../../types/annotation';
import { updateAnnotation, deleteAnnotation, addAnnotation, addRelation, invalidateRelation, restoreRelation, updateFlags, addGroupToAnnotation, removeGroupFromAnnotation, getGroupNames, getRelations } from '../../db/annotation-repo';
import { RelationPickerModal } from './relation-picker-modal';
import { ConfirmModal, PromptModal } from '../confirm-modal';
import { updateMarkTag, removeMarkTag, updateBlockAnchor, removeBlockAnchor, updateSpanAnchor, removeSpanAnchor } from '../../core/annotation-parser';
import { updateNativeAnnotation, removeNativeAnnotation } from '../../core/native-annotation';
import { updateRegionAnnotation, removeRegionAnnotation } from '../../core/region-annotation';
import { encodeFields, applyTemplate } from '../../utils/fields';
import type { MarkVaultPluginInterface } from '../../utils/plugin-interface';
import { containsMermaid, attachMermaidExpandButton, openMermaidPreview } from './mermaid-preview-overlay';

/**
 * 批注编辑 Modal
 * 查看/编辑标注的批注内容、标签、颜色和类型
 */
export class AnnotationModal extends Modal {
  private annotation: Annotation;
  private plugin: MarkVaultPluginInterface;
  private noteValue: string;
  private tagsValue: string;
  private selectedColor: string;
  private selectedType: AnnotationType;
  private fieldsValue: Record<string, string>;
  private flagsValue: AnnotationFlag;
  private groupsValue: string[];
  private motivationValue: AnnotationMotivation | '';
  private aliasValue: string;
  private onSave: (annotation: Annotation) => void;
  private onDelete: (uuid: string) => void;
  private component_: Component;

  constructor(
    app: App,
    plugin: MarkVaultPluginInterface,
    annotation: Annotation,
    onSave: (annotation: Annotation) => void,
    onDelete: (uuid: string) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.annotation = annotation;
    this.noteValue = annotation.note;
    this.tagsValue = annotation.tags.join(', ');
    this.selectedColor = annotation.color;
    this.selectedType = annotation.type;
    this.fieldsValue = annotation.fields ? { ...annotation.fields } : {};
    this.flagsValue = annotation.flags ? { ...annotation.flags } : {};
    this.groupsValue = annotation.groups ? [...annotation.groups] : [];
    this.motivationValue = annotation.motivation || '';
    this.aliasValue = annotation.alias || '';
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.component_ = new Component();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('markvault-modal');

    // 标题
    contentEl.createEl('h2', { text: 'Edit Annotation', cls: 'markvault-modal-title' });

    // 标注原文（只读）— 使用 MarkdownRenderer 渲染，支持 LaTeX/代码块等
    const quoteEl = contentEl.createDiv({ cls: 'markvault-modal-quote' });
    MarkdownRenderer.renderMarkdown(
      this.annotation.text,
      quoteEl,
      this.annotation.filePath,
      this.component_,
    ).catch((err: unknown) => {
      console.error('MarkVault: failed to render annotation quote', err);
      quoteEl.createEl('em', { text: `"${this.annotation.text.substring(0, 200)}${this.annotation.text.length > 200 ? '...' : ''}"` });
    });

    // 检测是否为 mermaid 块，如果是则添加全屏预览按钮
    if (this._containsMermaid(this.annotation.text)) {
      this._attachExpandButton(quoteEl, 'quote');
    }

    // ── v5.3: 图谱别名（Graph Alias） ──
    new Setting(contentEl)
      .setName('🏷️ Graph Alias')
      .setDesc('Short name for this annotation in the relation graph (e.g. "欧拉公式", "费马定理"). Leave empty to hide label.')
      .addText((text: TextComponent) => {
        text.setValue(this.aliasValue)
          .setPlaceholder('e.g. 欧拉公式, Newton\'s 2nd Law...')
          .onChange((value) => {
            this.aliasValue = value.trim();
          });
        text.inputEl.addClass('markvault-modal-alias-input');
      });

    // ── 类型选择 ──
    new Setting(contentEl)
      .setName('Type')
      .setDesc('Annotation display style')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('highlight', 'Highlight')
          .addOption('bold', 'Bold')
          .addOption('underline', 'Underline')
          .setValue(this.selectedType)
          .onChange((value) => {
            this.selectedType = value as AnnotationType;
            this.updatePreview();
          });
      });

    // ── v4.1: Motivation 选择（标注意图） ──
    new Setting(contentEl)
      .setName('Motivation')
      .setDesc('Why you annotated this (W3C Web Annotation)')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (const m of MOTIVATION_OPTIONS) {
          dropdown.addOption(m, MOTIVATION_LABELS[m]);
        }
        dropdown.setValue(this.motivationValue);
        dropdown.onChange((value) => {
          this.motivationValue = value as AnnotationMotivation | '';
        });
      });

    // ── 颜色选择器 ──
    const colorSetting = new Setting(contentEl)
      .setName('Color')
      .setDesc('Choose highlight color');

    const colorPickerContainer = colorSetting.controlEl.createDiv({ cls: 'markvault-modal-color-picker' });

    PRESET_COLORS.forEach((color) => {
      const dot = colorPickerContainer.createEl('button', {
        cls: 'markvault-modal-color-dot',
        attr: {
          'data-color': color.id,
          'title': color.label,
          'style': `background-color: ${color.hex};`,
        },
      });

      if (color.id === this.selectedColor) {
        dot.addClass('active');
      }

      dot.addEventListener('click', () => {
        // 移除其他选中状态
        colorPickerContainer.querySelectorAll('.markvault-modal-color-dot').forEach((el) => {
          el.removeClass('active');
        });
        dot.addClass('active');
        this.selectedColor = color.id;
        this.updatePreview();
      });
    });

    // ── 预览区 ──
    const previewEl = contentEl.createDiv({ cls: 'markvault-modal-preview' });
    this.renderPreview(previewEl);

    // 批注编辑
    new Setting(contentEl)
      .setName('Note')
      .setDesc('Add your annotation note')
      .addTextArea((text: TextAreaComponent) => {
        text.setValue(this.noteValue)
          .onChange((value) => {
            this.noteValue = value;
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addClass('markvault-modal-note-input');
      });

    // 标签编辑
    new Setting(contentEl)
      .setName('Tags')
      .setDesc('Comma-separated tags')
      .addText((text: TextComponent) => {
        text.setValue(this.tagsValue)
          .onChange((value) => {
            this.tagsValue = value;
          });
        text.inputEl.addClass('markvault-modal-tags-input');
      });

    // ── Fields 编辑区 ──
    const fieldsSection = contentEl.createDiv({ cls: 'markvault-modal-fields' });
    fieldsSection.createEl('h3', { text: 'Fields', cls: 'markvault-modal-fields-title' });

    // 字段行容器
    const fieldsListEl = fieldsSection.createDiv({ cls: 'markvault-modal-fields-list' });
    this.renderFieldRows(fieldsListEl);

    // Add Field 按钮
    const addFieldBtn = fieldsSection.createEl('button', {
      text: '+ Add Field',
      cls: 'markvault-modal-add-field-btn',
    });
    addFieldBtn.addEventListener('click', () => {
      const keys = Object.keys(this.fieldsValue);
      const newKey = `field${keys.length + 1}`;
      this.fieldsValue[newKey] = '';
      this.renderFieldRows(fieldsListEl);
    });

    // Apply Template 下拉菜单
    const templates = this.plugin.settings.fieldTemplates;
    if (templates && templates.length > 0) {
      const templateContainer = fieldsSection.createDiv({ cls: 'markvault-modal-template-section' });
      templateContainer.createSpan({ text: 'Apply template: ', cls: 'markvault-modal-template-label' });

      const templateSelect = templateContainer.createEl('select', { cls: 'markvault-modal-template-select' });
      templateSelect.createEl('option', { text: 'Choose template...', value: '' });
      for (const tpl of templates) {
        templateSelect.createEl('option', { text: tpl.name, value: tpl.id });
      }

      templateSelect.addEventListener('change', () => {
        const tplId = templateSelect.value;
        if (!tplId) return;
        const tpl = templates.find(t => t.id === tplId);
        if (tpl) {
          this.fieldsValue = applyTemplate(tpl, this.fieldsValue);
          this.renderFieldRows(fieldsListEl);
          templateSelect.value = ''; // 重置选择
        }
      });
    }

    // ═══════════════════════════════════════════════════════
    // v4.0: 学习状态标记 (Flags)
    // ═══════════════════════════════════════════════════════
    const flagsSection = contentEl.createDiv({ cls: 'markvault-modal-flags' });
    flagsSection.createEl('h3', { text: 'Learning Status', cls: 'markvault-modal-section-title' });

    // 掌握度
    new Setting(flagsSection)
      .setName('Mastery')
      .setDesc('How well you understand this annotation')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (const [value, label] of Object.entries(MASTERY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.flagsValue.mastery || '');
        dropdown.onChange((value) => {
          if (value) {
            this.flagsValue.mastery = value as MasteryLevel;
          } else {
            delete this.flagsValue.mastery;
          }
        });
      });

    // 复习优先级
    new Setting(flagsSection)
      .setName('Review Priority')
      .setDesc('How urgently you need to review this')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (const [value, label] of Object.entries(REVIEW_PRIORITY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.flagsValue.reviewPriority || '');
        dropdown.onChange((value) => {
          if (value) {
            this.flagsValue.reviewPriority = value as ReviewPriority;
          } else {
            delete this.flagsValue.reviewPriority;
          }
        });
      });

    // 信心指数
    new Setting(flagsSection)
      .setName('Confidence')
      .setDesc('Your confidence level (1-5)')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (let i = 1; i <= 5; i++) {
          dropdown.addOption(String(i), `${i} - ${['Very Low', 'Low', 'Medium', 'High', 'Very High'][i - 1]}`);
        }
        dropdown.setValue(this.flagsValue.confidence ? String(this.flagsValue.confidence) : '');
        dropdown.onChange((value) => {
          if (value) {
            this.flagsValue.confidence = Number(value) as 1 | 2 | 3 | 4 | 5;
          } else {
            delete this.flagsValue.confidence;
          }
        });
      });

    // 纠偏标记
    new Setting(flagsSection)
      .setName('Needs Correction')
      .setDesc('Mark if your understanding may be wrong')
      .addToggle((toggle) => {
        toggle.setValue(this.flagsValue.needsCorrection || false);
        toggle.onChange((value) => {
          this.flagsValue.needsCorrection = value || undefined;
        });
      });

    // ═══════════════════════════════════════════════════════
    // v4.0: 标注分组 (Groups)
    // ═══════════════════════════════════════════════════════
    const groupsSection = contentEl.createDiv({ cls: 'markvault-modal-groups' });
    groupsSection.createEl('h3', { text: 'Groups', cls: 'markvault-modal-section-title' });

    const groupsListEl = groupsSection.createDiv({ cls: 'markvault-modal-groups-list' });
    this.renderGroupTags(groupsListEl);

    // Add Group 按钮
    const addGroupBtn = groupsSection.createEl('button', {
      text: '+ Add Group',
      cls: 'markvault-modal-add-group-btn',
    });
    addGroupBtn.addEventListener('click', async () => {
      const existingGroups = getGroupNames();
      const groupName = await PromptModal.open(this.app, {
        title: 'Add Group',
        message: 'Existing groups: ' + (existingGroups.join(', ') || '(none)'),
        placeholder: 'Enter group name...',
        okText: 'Add',
      });
      if (groupName && groupName.trim() && !this.groupsValue.includes(groupName.trim())) {
        this.groupsValue.push(groupName.trim());
        this.renderGroupTags(groupsListEl);
      }
    });

    // ═══════════════════════════════════════════════════════
    // v4.0: 标注间关联 (Relations)
    // ═══════════════════════════════════════════════════════
    const relationsSection = contentEl.createDiv({ cls: 'markvault-modal-relations' });
    relationsSection.createEl('h3', { text: 'Relations', cls: 'markvault-modal-section-title' });

    const relationsListEl = relationsSection.createDiv({ cls: 'markvault-modal-relations-list' });
    this.renderRelations(relationsListEl);

    // Add Relation 按钮
    const addRelBtn = relationsSection.createEl('button', {
      text: '+ Add Relation',
      cls: 'markvault-modal-add-relation-btn',
    });
    addRelBtn.addEventListener('click', () => {
      const engine = this.plugin.getSearchEngine();
      engine.markDirty(); // Ensure index is fresh

      const picker = new RelationPickerModal(
        this.app,
        engine,
        this.plugin.getRelationSchema(),
        this.annotation.uuid,
        this.annotation.filePath,
        (result) => {
          // 立即持久化关联
          // 🔧 BUG-fix: addRelation() 内部已向 store 中的 annotation 对象 push 了 relation
          // this.annotation 与 store 中的对象是同一个引用，无需再手动 push
          addRelation(this.annotation.uuid, {
            targetUuid: result.targetUuid,
            type: result.type,
            createdAt: Date.now(),
            note: result.note,
            source: 'manual',  // v4.2: 来源溯源
          }).then(() => {
            this.renderRelations(relationsListEl);
          }).catch((err) => {
            console.error('MarkVault: failed to add relation', err);
            alert('Failed to add relation: ' + err.message);
          });
        },
      );
      picker.open();
    });

    // 操作按钮
    const buttonBar = contentEl.createDiv({ cls: 'markvault-modal-buttons' });

    const saveBtn = buttonBar.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', async () => {
      await this.save();
      this.close();
    });

    const deleteBtn = buttonBar.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', async () => {
      // 🔧 v5.1: 有关联关系时提示用户，避免误删
      const rels = getRelations(this.annotation.uuid);
      const totalRels = rels.outgoing.length + rels.incoming.length;
      const confirmMsg = totalRels > 0
        ? `Delete this annotation? It has ${totalRels} relation${totalRels > 1 ? 's' : ''} that will also be removed.`
        : 'Delete this annotation?';
      const confirmed = await ConfirmModal.open(this.app, {
        message: confirmMsg,
        title: 'Delete Annotation',
        okText: 'Delete',
        dangerous: true,
      });
      if (confirmed) {
        await this.remove();
        this.close();
      }
    });

    const cancelBtn = buttonBar.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });
  }

  /** 检测文本是否包含 mermaid 代码块 */
  private _containsMermaid(text: string): boolean {
    return containsMermaid(text);
  }

  /**
   * 附加全屏展开按钮到预览/quote 容器
   */
  private _attachExpandButton(container: HTMLElement, _source: 'quote' | 'preview') {
    attachMermaidExpandButton(container, () => this._openMermaidPreview());
  }

  private _openMermaidPreview() {
    openMermaidPreview(this.annotation.text, this.annotation.filePath);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.component_.unload();
  }

  /** 更新预览样式 */
  /** 更新预览样式 */
  private updatePreview() {
    const previewEl = this.contentEl.querySelector('.markvault-modal-preview') as HTMLElement;
    if (previewEl) {
      previewEl.empty();
      this.renderPreview(previewEl);
    }
  }

  /** 渲染预览 — 使用 MarkdownRenderer 支持 LaTeX/代码块 */
  private renderPreview(container: HTMLElement) {
    container.empty();

    container.createSpan({
      text: 'Preview: ',
      cls: 'markvault-modal-preview-label',
    });

    const previewContent = container.createDiv({ cls: 'markvault-modal-preview-content' });

    // 使用 MarkdownRenderer 渲染预览内容
    MarkdownRenderer.renderMarkdown(
      this.annotation.text,
      previewContent,
      this.annotation.filePath,
      this.component_,
    ).catch((err: unknown) => {
      console.error('MarkVault: failed to render preview', err);
      previewContent.createEl('span', {
        text: this.annotation.text.substring(0, 60) + (this.annotation.text.length > 60 ? '...' : ''),
      });
    });

    // 检测 mermaid 块并附加全屏预览按钮
    if (this._containsMermaid(this.annotation.text)) {
      this._attachExpandButton(container, 'preview');
    }

    // 应用当前选择的样式到预览容器
    const preset = PRESET_COLORS.find(c => c.id === this.selectedColor);
    const hex = preset ? preset.hex : this.selectedColor;

    previewContent.style.transition = 'all 0.2s ease';
    switch (this.selectedType) {
      case 'highlight':
        previewContent.style.backgroundColor = `${hex}33`;
        previewContent.style.borderRadius = '4px';
        previewContent.style.padding = '4px 8px';
        break;
      case 'bold':
        previewContent.style.fontWeight = 'bold';
        previewContent.style.borderBottom = `2px solid ${hex}`;
        previewContent.style.padding = '4px 8px';
        break;
      case 'underline':
        previewContent.style.textDecoration = 'underline';
        previewContent.style.textDecorationColor = hex;
        previewContent.style.textUnderlineOffset = '2px';
        break;
    }
  }

  /** 渲染 Fields 编辑行 */
  private renderFieldRows(container: HTMLElement) {
    container.empty();
    const entries = Object.entries(this.fieldsValue);

    for (const [key, value] of entries) {
      const row = container.createDiv({ cls: 'markvault-modal-field-row' });

      const keyInput = row.createEl('input', {
        type: 'text',
        value: key,
        cls: 'markvault-modal-field-key',
        attr: { placeholder: 'Key' },
      });

      const valueInput = row.createEl('input', {
        type: 'text',
        value: value,
        cls: 'markvault-modal-field-value',
        attr: { placeholder: 'Value' },
      });

      const deleteBtn = row.createEl('button', {
        text: '✕',
        cls: 'markvault-modal-field-delete',
      });

      // 事件处理：实时更新 fieldsValue
      keyInput.addEventListener('input', () => {
        const oldKey = key;
        const newKey = keyInput.value;
        if (oldKey !== newKey) {
          delete this.fieldsValue[oldKey];
          this.fieldsValue[newKey] = valueInput.value;
        }
      });

      valueInput.addEventListener('input', () => {
        this.fieldsValue[keyInput.value] = valueInput.value;
        // 软限制：超长字段值警告
        if (valueInput.value.length > 1000) {
          valueInput.style.borderColor = 'var(--text-error, #e74c3c)';
          valueInput.title = '字段值过长，可能影响 Markdown 文件可读性';
        } else {
          valueInput.style.borderColor = '';
          valueInput.title = '';
        }
      });

      deleteBtn.addEventListener('click', () => {
        delete this.fieldsValue[keyInput.value];
        this.renderFieldRows(container);
      });
    }
  }

  /** 渲染 Group 标签 */
  private renderGroupTags(container: HTMLElement) {
    container.empty();

    for (const group of this.groupsValue) {
      const tag = container.createDiv({ cls: 'markvault-modal-group-tag' });
      tag.createSpan({ text: group, cls: 'markvault-modal-group-name' });
      const removeBtn = tag.createEl('button', {
        text: '✕',
        cls: 'markvault-modal-group-remove',
      });
      removeBtn.addEventListener('click', () => {
        this.groupsValue = this.groupsValue.filter(g => g !== group);
        this.renderGroupTags(container);
      });
    }
  }

  /** 渲染 Relations 列表 */
  private renderRelations(container: HTMLElement) {
    container.empty();

    const relations = this.annotation.relations || [];

    if (relations.length === 0) {
      container.createSpan({ text: 'No relations yet', cls: 'markvault-modal-relations-empty' });
      return;
    }

    // v4.2: 有效关系在前，已失效关系在后（灰色显示）
    const activeRels = relations.filter(r => !r.invalidAt);
    const invalidatedRels = relations.filter(r => r.invalidAt);

    for (const rel of activeRels) {
      this._renderRelationRow(container, rel, false);
    }

    for (const rel of invalidatedRels) {
      this._renderRelationRow(container, rel, true);
    }
  }

  /** 渲染单个 relation 行 */
  private _renderRelationRow(container: HTMLElement, rel: AnnotationRelation, isInvalidated: boolean) {
    const row = container.createDiv({
      cls: isInvalidated ? 'markvault-modal-relation-row markvault-relation-invalidated' : 'markvault-modal-relation-row',
    });

    // v5.12: 关系类型标签 — dot 色块 + 文字
    const typeLabel = this.plugin.getRelationSchema().getLabel(rel.type);
    const typeColor = this.plugin.getRelationSchema().getConfig(rel.type)?.color || '#78716C';
    const typeSpan = row.createSpan({ cls: 'markvault-modal-relation-type' });
    typeSpan.createSpan({
      cls: 'markvault-modal-relation-dot',
      attr: { style: `background: ${typeColor}` },
    });
    typeSpan.createSpan({ text: typeLabel });

    // 目标 UUID（截断显示）
    const shortUuid = rel.targetUuid.length > 8
      ? rel.targetUuid.substring(0, 8) + '...'
      : rel.targetUuid;
    row.createSpan({
      text: shortUuid,
      cls: 'markvault-modal-relation-target',
      attr: { title: rel.targetUuid },
    });

    // v4.2: 来源标签
    if (rel.source) {
      const sourceLabel = RELATION_SOURCE_LABELS[rel.source] || rel.source;
      row.createSpan({ text: sourceLabel, cls: 'markvault-modal-relation-source' });
    }

    if (isInvalidated) {
      // 已失效 — 显示失效时间和恢复按钮
      const invalidDate = rel.invalidAt ? new Date(rel.invalidAt).toLocaleDateString() : '?';
      row.createSpan({ text: `(已失效 ${invalidDate})`, cls: 'markvault-relation-invalidated-hint' });

      // 恢复按钮
      const restoreBtn = row.createEl('button', { text: '↺', cls: 'markvault-modal-relation-restore' });
      restoreBtn.title = '恢复此关系（双向级联）';
      restoreBtn.addEventListener('click', async () => {
        try {
          // v4.2 P1: 使用 restoreRelation（双向级联清除 invalidAt）
          await restoreRelation(this.annotation.uuid, rel.targetUuid, rel.type);
          this.renderRelations(container);
        } catch (err) {
          console.error('MarkVault: failed to restore relation', err);
        }
      });
    } else {
      // 有效关系 — 删除按钮（改为软删除/失效）
      const removeBtn = row.createEl('button', {
        text: '✕',
        cls: 'markvault-modal-relation-remove',
      });
      removeBtn.addEventListener('click', async () => {
        try {
          // v4.2: 默认使用软删除（invalidateRelation），保留历史可回溯
          await invalidateRelation(this.annotation.uuid, rel.targetUuid, rel.type);
          this.renderRelations(container);
        } catch (err) {
          console.error('MarkVault: failed to invalidate relation', err);
        }
      });
    }
  }

  private async save() {
    const tags = this.tagsValue
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const updates: Partial<Annotation> = {
      note: this.noteValue,
      tags,
    };

    // 如果颜色或类型发生变化，也一并更新
    if (this.selectedColor !== this.annotation.color) {
      updates.color = this.selectedColor;
    }
    if (this.selectedType !== this.annotation.type) {
      updates.type = this.selectedType;
    }

    // 🆕 Phase 3: 收集 fields（过滤空键） + v4.1: u: 前缀规范化
    const filteredFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.fieldsValue)) {
      if (k.trim()) {
        // 用户自定义字段自动添加 u: 前缀（排除以 _ 开头的系统字段和已有 u: 前缀的）
        const normalizedKey = normalizeUserFieldKey(k.trim());
        filteredFields[normalizedKey] = v;
      }
    }
    if (Object.keys(filteredFields).length > 0 || this.annotation.fields) {
      updates.fields = filteredFields;
    }

    // v4.0: 收集 groups
    if (this.groupsValue.length > 0 || this.annotation.groups) {
      updates.groups = this.groupsValue;
    }

    // v4.1: 收集 motivation
    // 如果用户手动选择了 motivation，使用用户选择；否则根据当前 note/flags 重新推断
    if (this.motivationValue) {
      updates.motivation = this.motivationValue;
    } else {
      // 用户清空了 motivation → 根据当前 note 内容重新推断
      updates.motivation = inferMotivation({
        note: updates.note ?? this.annotation.note,
        needsCorrection: updates.flags?.needsCorrection ?? this.annotation.flags?.needsCorrection,
        kind: this.annotation.kind,
      });
    }

    // v5.3: 收集图谱别名（带校验）
    // 🔧 F1 审计修复：先 trim + replace（移除危险字符），再 slice（截断长度）
    // 这样 replace 移除 < > 后的字符串长度才是最终长度，不会出现截断后再替换导致长度不一致
    // 🔧 F5 审计修复：DB 和 MD 的 alias 语义分离
    // - DB: undefined = "删除 alias 字段", "" = "alias 为空字符串"（语义错误）
    // - MD: "" = "删除 data-alias 属性 / 写 _ 占位", undefined = "不更新"
    // 所以：DB 用 rawAlias || undefined，MD 用 rawAlias || ""
    let aliasForMD: string | undefined; // 传给 updateMarkTag/updateBlockAnchor/updateSpanAnchor
    {
      const rawAlias = this.aliasValue.trim().replace(/[<>]/g, '').slice(0, 50);
      if (rawAlias.length > 0 || this.annotation.alias) {
        updates.alias = rawAlias || undefined; // DB: undefined 表示删除
        aliasForMD = rawAlias; // MD: "" 表示删除 data-alias/写 _ 占位
      }
    }

    console.log(`MarkVault modal: saving annotation ${this.annotation.uuid}`, updates);

    // 🔧 P0 修复：捕获原始值用于 MD 失败时回滚
    const originalNote = this.annotation.note;
    const originalTags = [...this.annotation.tags];
    const originalColor = this.annotation.color;
    const originalType = this.annotation.type;
    const originalFields = this.annotation.fields ? { ...this.annotation.fields } : undefined;
    const originalAlias = this.annotation.alias; // v5.3

    // ① 更新 AnnotationStore（先写 Store，再写 Markdown）
    await updateAnnotation(this.annotation.uuid, updates);

    // v4.0: 更新 Flags（独立 API，不在 updates 中，因为 merge 逻辑需要特殊处理）
    const hasFlags = Object.keys(this.flagsValue).length > 0;
    if (hasFlags) {
      await updateFlags(this.annotation.uuid, this.flagsValue);
    }

    // ② 更新 Markdown — 设置防重入标志，阻止 onFileOpen() 在此期间触发 syncFromMarkdown()
    const file = this.app.vault.getAbstractFileByPath(this.annotation.filePath);
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      console.log(`MarkVault modal: read file ${file.path}, length=${content.length}`);

      let newContent = content;

      if (this.annotation.kind === 'span') {
        // Span 标注：更新 %%markvault-span:...%% 锚点
        newContent = updateSpanAnchor(content, this.annotation.uuid, {
          note: this.noteValue,
          color: updates.color,
          type: updates.type,
          alias: aliasForMD, // F5: "" 表示删除锚点 alias 段
        });
      } else if (this.annotation.kind === 'block') {
        // 块级标注：更新 %%markvault:...%% 锚点
        newContent = updateBlockAnchor(content, this.annotation.uuid, {
          note: this.noteValue,
          color: updates.color,
          type: updates.type,
          alias: aliasForMD, // F5: "" 表示删除锚点 alias 段
        });
      } else if (this.annotation.kind === 'region') {
        // 区域标注：双锚点包围
        // alias 仅存 DB（region 锚点格式不含 alias 段），不写入 Markdown
        newContent = updateRegionAnnotation(content, this.annotation.uuid, {
          color: updates.color,
          type: updates.type,
          note: this.noteValue,
        }) ?? content;
      } else if (this.annotation.format === 'native') {
        // 自然语法标注：隐身锚点 + 原生 Markdown 包裹
        // note/tags/fields/alias 只存在 Store 中，锚点只保存 uuid/type/color
        newContent = updateNativeAnnotation(content, this.annotation.uuid, {
          color: updates.color,
          type: updates.type,
        }) ?? content;
      } else {
        // 行内标注：更新 <mark> 标签
        newContent = updateMarkTag(content, this.annotation.uuid, {
          note: this.noteValue,
          tags,
          color: updates.color,
          type: updates.type,
          fields: Object.keys(filteredFields).length > 0 ? encodeFields(filteredFields) : '',
          alias: aliasForMD, // F5: "" 表示删除 data-alias 属性
        });
      }

      // 验证内容确实发生了变化
      if (newContent !== content) {
        this.plugin.modifyGuard.acquire(this.annotation.filePath);
        try {
          // 🔧 B-2 修复：使用 vault.process 原子读写，try-finally 保证 modifyGuard 释放
          // vault.process 保证：回调抛错 → MD 不变；回调成功 → MD 已更新
          await this.app.vault.process(file, () => newContent);
          console.log(`MarkVault modal: updated markdown for ${this.annotation.uuid}`);
        } catch (processErr) {
          console.error(`MarkVault modal: MD update failed for ${this.annotation.uuid}`, processErr);
          throw processErr;
        } finally {
          this.plugin.modifyGuard.release(this.annotation.filePath);
        }
      } else {
        // 🔧 非异常：block/span/region/native 锚点格式不存 tags/fields/groups/motivation/flags，
        // 仅 Store 更新即可。仅当会写 MD 的字段确实发生变化但 MD 没变时才可能是异常。
        // 注意：不同 kind 写入 MD 的字段不同，需按 kind 判断。
        const kind = this.annotation.kind;
        const fmt = this.annotation.format;
        const noteChanged = this.noteValue !== this.annotation.note;
        const colorChanged = updates.color !== undefined;
        const typeChanged = updates.type !== undefined;
        const oldAlias = this.annotation.alias ?? '';
        const newAlias = aliasForMD ?? '';
        const aliasChanged = newAlias !== oldAlias;

        // 按 kind 确定哪些字段会写入 MD
        // native: 只存 uuid/type/color → 仅 color/type 影响 MD
        // region: 存 note/type/color → note/color/type 影响 MD，alias 不写入
        // block/span/inline: 存 note/type/color/alias → 全部影响 MD
        let mdFieldsChanged: boolean;
        if (fmt === 'native') {
          mdFieldsChanged = colorChanged || typeChanged;
        } else if (kind === 'region') {
          mdFieldsChanged = noteChanged || colorChanged || typeChanged;
        } else {
          mdFieldsChanged = noteChanged || colorChanged || typeChanged || aliasChanged;
        }

        if (mdFieldsChanged) {
          // MD 字段确实变了但 MD 没变，可能是锚点格式不匹配
          console.warn(`MarkVault modal: markdown content unchanged for ${this.annotation.uuid} (kind=${kind})`);
        } else {
          console.log(`MarkVault modal: store-only update for ${this.annotation.uuid} (kind=${kind})`);
        }
      }
    }

    // ③ 更新内存中的 annotation
    this.annotation.note = this.noteValue;
    this.annotation.tags = tags;
    if (updates.color) this.annotation.color = updates.color;
    if (updates.type) this.annotation.type = updates.type;
    if (updates.fields !== undefined) this.annotation.fields = updates.fields;
    if (updates.groups !== undefined) this.annotation.groups = updates.groups;
    if (hasFlags) this.annotation.flags = { ...this.flagsValue };
    if (updates.alias !== undefined) this.annotation.alias = updates.alias;

    // 🔧 P1 修复：标记文件已同步，避免 onFileOpen 触发无意义的全量 sync
    this.plugin.markFileSynced(this.annotation.filePath);
    // 🔧 P1 修复：更新 span 缓存，确保 CM6 装饰立即反映最新修改
    try {
      await this.plugin.updateSpanCache(this.annotation.filePath);
      await this.plugin.updateRegionCache(this.annotation.filePath);
    } catch (err) {
      console.error('MarkVault modal: updateSpanCache error', err);
    }

    this.onSave(this.annotation);
  }

  private async remove() {
    // 🔧 P0 修复：保存原始数据用于 MD 失败时回滚（深拷贝确保不丢失可选字段）
    const backup: Annotation = JSON.parse(JSON.stringify(this.annotation));

    // ① 从 AnnotationStore 删除
    await deleteAnnotation(this.annotation.uuid);

    // ② 从 Markdown 移除标注（使用 vault.process 原子读写）
    const file = this.app.vault.getAbstractFileByPath(this.annotation.filePath);
    if (file instanceof TFile) {
      this.plugin.modifyGuard.acquire(this.annotation.filePath);
      try {
        await this.app.vault.process(file, (content) => {
          if (this.annotation.kind === 'span') {
            return removeSpanAnchor(content, this.annotation.uuid);
          }
          if (this.annotation.kind === 'block') {
            return removeBlockAnchor(content, this.annotation.uuid);
          }
          if (this.annotation.kind === 'region') {
            return removeRegionAnnotation(content, this.annotation.uuid) ?? content;
          }
          if (this.annotation.format === 'native') {
            return removeNativeAnnotation(content, this.annotation.uuid) ?? content;
          }
          const result = removeMarkTag(content, this.annotation.uuid);
          return result ? result.content : content;
        });
        console.log(`MarkVault modal: removed annotation ${this.annotation.uuid} from markdown`);
      } catch (processErr) {
        // 🔧 P0 修复：MD 写入失败，回滚 DB（重新添加标注）
        console.error(`MarkVault modal: MD removal failed, rolling back DB for ${this.annotation.uuid}`, processErr);
        await addAnnotation(backup);
        throw processErr; // 传播错误，阻止 onDelete 回调
      } finally {
        this.plugin.modifyGuard.release(this.annotation.filePath);
      }
    }

    // 🔧 P1 修复：标记文件已同步
    this.plugin.markFileSynced(this.annotation.filePath);
    // 🔧 P1 修复：更新 span 缓存
    try {
      await this.plugin.updateSpanCache(this.annotation.filePath);
    } catch (err) {
      console.error('MarkVault modal: remove updateSpanCache error', err);
    }

    this.onDelete(this.annotation.uuid);
    // 🔧 UX 修复：删除成功后关闭 Modal
    this.close();
  }
}
