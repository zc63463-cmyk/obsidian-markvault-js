import { App, Component, Menu, TFile, MarkdownRenderer } from 'obsidian';
import type { Annotation } from '../../../types/annotation';
import { PRESET_COLORS } from '../../../types/annotation';
import type { MarkVaultPluginInterface } from '../../../utils/plugin-interface';
import { updateSpanAnchor, updateBlockAnchor, updateMarkTag } from '../../../core/annotation-parser';
import { updateAnnotation } from '../../../db/annotation-repo';

/**
 * AnnotationCard —— 单个标注卡片
 *
 * 负责渲染标注卡片、字段标签、快速改色、操作按钮。
 */
export interface AnnotationCardHost {
  app: App;
  isBatchMode(): boolean;
  selectedUuids: Set<string>;
  fieldFilterEntries: Array<{ key: string; value: string }>;
  getBatchCountElement(): HTMLElement | null;
  getMarkdownComponent(): Component | null;
  getPluginInstance(): MarkVaultPluginInterface | null;
  formatRelativeTime(date: Date): string;
  onEdit(annotation: Annotation): void;
  onJump(annotation: Annotation): void;
  onDelete(annotation: Annotation): Promise<void>;
  refreshListOnly(): Promise<void>;
}

export class AnnotationCard {
  constructor(private host: AnnotationCardHost) {}

  render(container: HTMLElement, annotation: Annotation, showFilePath: boolean): void {
    const card = container.createDiv({ cls: 'markvault-card' });

    // 批量模式 checkbox
    if (this.host.isBatchMode()) {
      const checkbox = card.createEl('input', {
        type: 'checkbox',
        cls: 'markvault-card-checkbox',
      });
      checkbox.dataset.uuid = annotation.uuid;
      if (this.host.selectedUuids.has(annotation.uuid)) {
        checkbox.checked = true;
      }
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.host.selectedUuids.add(annotation.uuid);
        } else {
          this.host.selectedUuids.delete(annotation.uuid);
        }
        const countEl = this.host.getBatchCountElement();
        if (countEl) {
          countEl.textContent = `${this.host.selectedUuids.size} selected`;
        }
      });
    }

    // 卡片头部
    const header = card.createDiv({ cls: 'markvault-card-header' });

    const preset = PRESET_COLORS.find(c => c.id === annotation.color);
    const colorHex = preset ? preset.hex : annotation.color;

    const colorDot = header.createDiv({ cls: 'markvault-card-color-dot' });
    colorDot.style.backgroundColor = colorHex;

    const typeLabel = header.createDiv({ cls: 'markvault-card-type' });
    typeLabel.textContent = annotation.type;

    if (showFilePath) {
      const fileLabel = header.createDiv({ cls: 'markvault-card-file' });
      const fileName = annotation.filePath.split('/').pop()?.replace('.md', '') || annotation.filePath;
      fileLabel.textContent = `📄 ${fileName}`;
      fileLabel.title = annotation.filePath;
    } else {
      const lineLabel = header.createDiv({ cls: 'markvault-card-line' });
      lineLabel.textContent = `Line ${annotation.startLine + 1}`;
    }

    // 操作按钮区
    const actionsHeader = header.createDiv({ cls: 'markvault-card-header-actions' });

    // 快速改色按钮
    const colorBtn = actionsHeader.createEl('button', {
      cls: 'markvault-card-quick-color',
      text: '🎨',
    });
    colorBtn.title = 'Change color';
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showQuickColorMenu(colorBtn, annotation);
    });

    // 标注原文
    const textEl = card.createDiv({ cls: 'markvault-card-text' });
    const component = this.host.getMarkdownComponent();
    if (component) {
      MarkdownRenderer.renderMarkdown(
        annotation.text,
        textEl,
        annotation.filePath,
        component,
      ).catch((err: unknown) => {
        console.error('MarkVault: failed to render annotation text', err);
        textEl.textContent = annotation.text;
      });
    } else {
      textEl.textContent = annotation.text;
    }

    // 批注内容
    if (annotation.note) {
      const noteEl = card.createDiv({ cls: 'markvault-card-note' });
      noteEl.textContent = annotation.note;
    }

    // 标签
    if (annotation.tags.length > 0) {
      const tagsEl = card.createDiv({ cls: 'markvault-card-tags' });
      for (const tag of annotation.tags) {
        tagsEl.createSpan({ cls: 'markvault-tag', text: `#${tag}` });
      }
    }

    // Phase 3: Fields 展示
    if (annotation.fields && Object.keys(annotation.fields).length > 0) {
      const fieldsEl = card.createDiv({ cls: 'markvault-card-fields' });
      const entries = Object.entries(annotation.fields);
      const showCount = Math.min(entries.length, 3);

      for (let i = 0; i < showCount; i++) {
        const [k, v] = entries[i];
        const fieldTag = fieldsEl.createSpan({ cls: 'markvault-field-tag' });
        fieldTag.createSpan({ text: k, cls: 'markvault-field-tag-key' });
        fieldTag.createSpan({ text: ':', cls: 'markvault-field-tag-sep' });
        fieldTag.createSpan({ text: v, cls: 'markvault-field-tag-value' });

        fieldTag.addEventListener('click', (e) => {
          e.stopPropagation();
          const exists = this.host.fieldFilterEntries.some(fe => fe.key === k && fe.value === v);
          if (!exists) {
            this.host.fieldFilterEntries.push({ key: k, value: v });
            this.host.refreshListOnly();
          }
        });
      }

      if (entries.length > 3) {
        const moreEl = fieldsEl.createSpan({
          cls: 'markvault-field-more',
          text: `${entries.length - 3} more...`,
        });
        let expanded = false;
        moreEl.addEventListener('click', (e) => {
          e.stopPropagation();
          expanded = !expanded;
          if (expanded) {
            for (let i = 3; i < entries.length; i++) {
              const [k, v] = entries[i];
              const fieldTag = fieldsEl.createSpan({ cls: 'markvault-field-tag' });
              fieldTag.createSpan({ text: k, cls: 'markvault-field-tag-key' });
              fieldTag.createSpan({ text: ':', cls: 'markvault-field-tag-sep' });
              fieldTag.createSpan({ text: v, cls: 'markvault-field-tag-value' });
            }
            moreEl.textContent = 'less';
          } else {
            const allFieldTags = fieldsEl.querySelectorAll('.markvault-field-tag');
            for (let i = 3; i < allFieldTags.length; i++) {
              allFieldTags[i].remove();
            }
            moreEl.textContent = `${entries.length - 3} more...`;
          }
        });
      }
    }

    // 底部操作
    const actions = card.createDiv({ cls: 'markvault-card-actions' });

    const timeEl = actions.createSpan({ cls: 'markvault-card-time' });
    timeEl.textContent = this.host.formatRelativeTime(new Date(annotation.updatedAt));

    const editBtn = actions.createEl('button', { cls: 'markvault-action-btn', text: '✏️' });
    editBtn.title = 'Edit annotation';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onEdit(annotation);
    });

    const jumpBtn = actions.createEl('button', { cls: 'markvault-action-btn', text: '↩️' });
    jumpBtn.title = 'Jump to source';
    jumpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onJump(annotation);
    });

    const deleteBtn = actions.createEl('button', { cls: 'markvault-action-btn markvault-delete-btn', text: '🗑️' });
    deleteBtn.title = 'Delete annotation';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.host.onDelete(annotation);
    });

    card.addEventListener('click', () => {
      if (this.host.isBatchMode()) {
        const cb = card.querySelector('.markvault-card-checkbox') as HTMLInputElement;
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      } else {
        this.host.onJump(annotation);
      }
    });
  }

  private showQuickColorMenu(anchor: HTMLElement, annotation: Annotation) {
    const menu = new Menu();
    for (const pc of PRESET_COLORS) {
      menu.addItem((item) => {
        item.setTitle(`${pc.label} (${pc.id === annotation.color ? 'current' : ''})`)
          .setChecked(pc.id === annotation.color)
          .onClick(async () => {
            await this.quickChangeColor(annotation, pc.id);
          });
      });
    }
    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async quickChangeColor(annotation: Annotation, colorId: string) {
    const plugin = this.host.getPluginInstance();
    if (!plugin) return;

    const originalColor = annotation.color;
    await updateAnnotation(annotation.uuid, { color: colorId });

    try {
      const file = this.host.app.vault.getAbstractFileByPath(annotation.filePath);
      if (!(file instanceof TFile)) return;
        const content = await this.host.app.vault.read(file);
        let newContent: string;

        if (annotation.kind === 'span') {
          newContent = updateSpanAnchor(content, annotation.uuid, { color: colorId });
        } else if (annotation.kind === 'block') {
          newContent = updateBlockAnchor(content, annotation.uuid, { color: colorId });
        } else {
          newContent = updateMarkTag(content, annotation.uuid, { color: colorId });
        }

        if (newContent !== content) {
          plugin.modifyGuard.acquire(annotation.filePath);
          try {
            await this.host.app.vault.modify(file, newContent);
          } catch (mdErr) {
            console.error('MarkVault: quickChangeColor MD error, rolling back', mdErr);
            await updateAnnotation(annotation.uuid, { color: originalColor });
            throw mdErr;
          } finally {
            plugin.modifyGuard.release(annotation.filePath);
          }
        }

        plugin.markFileSynced(annotation.filePath);
        await plugin.updateSpanCache(annotation.filePath);
    } catch (err) {
      plugin.modifyGuard.releaseNow(annotation.filePath);
      console.error('MarkVault: quick color change error', err);
    }
    await this.host.refreshListOnly();
  }
}
