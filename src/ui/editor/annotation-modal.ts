import { App, Modal, TextAreaComponent, TextComponent, Setting, TFile, MarkdownRenderer, Component } from 'obsidian';
import type { Annotation, AnnotationType, PresetColorId } from '../../types/annotation';
import { PRESET_COLORS } from '../../types/annotation';
import { updateAnnotation, deleteAnnotation, addAnnotation } from '../../db/annotation-repo';
import { updateMarkTag, removeMarkTag, updateBlockAnchor, removeBlockAnchor, updateSpanAnchor, removeSpanAnchor } from '../../core/annotation-parser';
import { updateNativeAnnotation, removeNativeAnnotation } from '../../core/native-annotation';
import { updateRegionAnnotation, removeRegionAnnotation } from '../../core/region-annotation';
import { encodeFields, applyTemplate } from '../../utils/fields';
import type { MarkVaultPluginInterface } from '../../utils/plugin-interface';

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

    // 操作按钮
    const buttonBar = contentEl.createDiv({ cls: 'markvault-modal-buttons' });

    const saveBtn = buttonBar.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', async () => {
      await this.save();
      this.close();
    });

    const deleteBtn = buttonBar.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', async () => {
      const confirmed = confirm('Delete this annotation?');
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

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.component_.unload();
  }

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

    // 🆕 Phase 3: 收集 fields（过滤空键）
    const filteredFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.fieldsValue)) {
      if (k.trim()) {
        filteredFields[k.trim()] = v;
      }
    }
    if (Object.keys(filteredFields).length > 0 || this.annotation.fields) {
      updates.fields = filteredFields;
    }

    console.log(`MarkVault modal: saving annotation ${this.annotation.uuid}`, updates);

    // 🔧 P0 修复：捕获原始值用于 MD 失败时回滚
    const originalNote = this.annotation.note;
    const originalTags = [...this.annotation.tags];
    const originalColor = this.annotation.color;
    const originalType = this.annotation.type;
    const originalFields = this.annotation.fields ? { ...this.annotation.fields } : undefined;

    // ① 更新 AnnotationStore（先写 Store，再写 Markdown）
    await updateAnnotation(this.annotation.uuid, updates);

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
        });
      } else if (this.annotation.kind === 'block') {
        // 块级标注：更新 %%markvault:...%% 锚点
        newContent = updateBlockAnchor(content, this.annotation.uuid, {
          note: this.noteValue,
          color: updates.color,
          type: updates.type,
        });
      } else if (this.annotation.kind === 'region') {
        // 区域标注：双锚点包围
        newContent = updateRegionAnnotation(content, this.annotation.uuid, {
          color: updates.color,
          type: updates.type,
          note: this.noteValue,
        }) ?? content;
      } else if (this.annotation.format === 'native') {
        // 自然语法标注：隐身锚点 + 原生 Markdown 包裹
        // note/tags/fields 只存在 Store 中，锚点只保存 uuid/type/color
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
        });
      }

      // 验证内容确实发生了变化
      if (newContent !== content) {
        this.plugin.modifyGuard.acquire(this.annotation.filePath);
        try {
          await this.app.vault.modify(file, newContent);
          console.log(`MarkVault modal: updated markdown for ${this.annotation.uuid}`);
        } catch (mdErr) {
          // 🔧 P0 修复：MD 写入失败，回滚 DB
          console.error(`MarkVault modal: MD update failed, rolling back DB for ${this.annotation.uuid}`, mdErr);
          await updateAnnotation(this.annotation.uuid, {
            note: originalNote,
            tags: originalTags,
            color: originalColor,
            type: originalType,
            fields: originalFields,
          });
          // 恢复内存中的 annotation 引用
          this.annotation.note = originalNote;
          this.annotation.tags = originalTags;
          this.annotation.color = originalColor;
          this.annotation.type = originalType;
          this.annotation.fields = originalFields;
          throw mdErr; // 重新抛出，让外部感知
        } finally {
          this.plugin.modifyGuard.release(this.annotation.filePath);
        }
      } else {
        console.warn(`MarkVault modal: markdown content unchanged for ${this.annotation.uuid}`);
      }
    }

    // ③ 更新内存中的 annotation
    this.annotation.note = this.noteValue;
    this.annotation.tags = tags;
    if (updates.color) this.annotation.color = updates.color;
    if (updates.type) this.annotation.type = updates.type;
    if (updates.fields !== undefined) this.annotation.fields = updates.fields;

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
