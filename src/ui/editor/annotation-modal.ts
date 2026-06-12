import { App, Modal, TextAreaComponent, TextComponent, Setting, TFile, MarkdownRenderer, Component } from 'obsidian';
import type { Annotation, AnnotationType, PresetColorId } from '../../types/annotation';
import { PRESET_COLORS } from '../../types/annotation';
import { updateAnnotation, deleteAnnotation } from '../../db/annotation-repo';
import { updateMarkTag, removeMarkTag, updateBlockAnchor, removeBlockAnchor, updateSpanAnchor, removeSpanAnchor } from '../../core/annotation-parser';
import type MarkVaultPlugin from '../../main';

/**
 * 批注编辑 Modal
 * 查看/编辑标注的批注内容、标签、颜色和类型
 */
export class AnnotationModal extends Modal {
  private annotation: Annotation;
  private plugin: MarkVaultPlugin;
  private noteValue: string;
  private tagsValue: string;
  private selectedColor: string;
  private selectedType: AnnotationType;
  private onSave: (annotation: Annotation) => void;
  private onDelete: (uuid: string) => void;
  private component_: Component;

  constructor(
    app: App,
    plugin: MarkVaultPlugin,
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

    console.log(`MarkVault modal: saving annotation ${this.annotation.uuid}`, updates);

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
      } else {
        // 行内标注：更新 <mark> 标签
        newContent = updateMarkTag(content, this.annotation.uuid, {
          note: this.noteValue,
          tags,
          color: updates.color,
          type: updates.type,
        });
      }

      // 验证内容确实发生了变化
      if (newContent !== content) {
        this.plugin.modifyGuard.acquire(this.annotation.filePath);
        try {
          await this.app.vault.modify(file, newContent);
          console.log(`MarkVault modal: updated markdown for ${this.annotation.uuid}`);
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
    this.onSave(this.annotation);
  }

  private async remove() {
    // 从 AnnotationStore 删除
    await deleteAnnotation(this.annotation.uuid);

    // 从 Markdown 移除标注
    const file = this.app.vault.getAbstractFileByPath(this.annotation.filePath);
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      let newContent: string | null = null;

      if (this.annotation.kind === 'span') {
        // Span 标注：移除 %%markvault-span:...%% 锚点
        const result = removeSpanAnchor(content, this.annotation.uuid);
        if (result !== content) newContent = result;
      } else if (this.annotation.kind === 'block') {
        // 块级标注：移除 %%markvault:...%% 锚点
        const result = removeBlockAnchor(content, this.annotation.uuid);
        if (result !== content) newContent = result;
      } else {
        // 行内标注：移除 <mark> 标签
        const result = removeMarkTag(content, this.annotation.uuid);
        if (result) newContent = result.content;
      }

      if (newContent) {
        this.plugin.modifyGuard.acquire(this.annotation.filePath);
        try {
          await this.app.vault.modify(file, newContent);
        } finally {
          this.plugin.modifyGuard.release(this.annotation.filePath);
        }
      }
    }

    this.onDelete(this.annotation.uuid);
  }
}
