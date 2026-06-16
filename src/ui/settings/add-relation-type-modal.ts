/**
 * add-relation-type-modal.ts — 新增自定义关系类型对话框
 *
 * 替代 settings-tab.ts 中的 window.prompt 单输入交互。
 * 支持一次性输入 id / label / reverseId / isSymmetric，改善用户体验。
 */

import { Modal, App, Setting } from 'obsidian';
import type { RelationTypeConfig } from '../../types/annotation';

/** AddRelationTypeModal 的回调参数 */
export interface AddRelationTypeResult {
  id: string;
  label: string;
  reverseId: string;
  isSymmetric: boolean;
}

export class AddRelationTypeModal extends Modal {
  private existingIds: Set<string>;
  private onConfirm: (result: AddRelationTypeResult) => void;

  private idInput: HTMLInputElement | null = null;
  private labelInput: HTMLInputElement | null = null;
  private reverseInput: HTMLInputElement | null = null;
  private isSymmetric = false;
  private confirmBtn: HTMLButtonElement | null = null;
  private validationMsg: HTMLElement | null = null;

  constructor(
    app: App,
    existingIds: string[],
    onConfirm: (result: AddRelationTypeResult) => void,
  ) {
    super(app);
    this.existingIds = new Set(existingIds);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('markvault-add-relation-type');

    contentEl.createEl('h3', {
      text: 'Add Custom Relation Type',
      cls: 'markvault-add-relation-type-title',
    });

    // ── ID ──
    new Setting(contentEl)
      .setName('Type ID')
      .setDesc('Unique identifier (e.g. inspires, contradicts). Letters, numbers, underscores only.')
      .addText((text) => {
        text.setPlaceholder('e.g. inspires');
        this.idInput = text.inputEl;
        text.onChange(() => this._validate());
      });

    // ── Label ──
    new Setting(contentEl)
      .setName('Display Label')
      .setDesc('Human-readable label shown in UI (e.g. 启发, 反驳)')
      .addText((text) => {
        text.setPlaceholder('e.g. 启发');
        this.labelInput = text.inputEl;
        text.onChange(() => this._validate());
      });

    // ── Reverse ID ──
    new Setting(contentEl)
      .setName('Reverse Type ID')
      .setDesc('ID of the reverse relation (e.g. isInspiredBy). Auto-generated from ID if left empty.')
      .addText((text) => {
        text.setPlaceholder('e.g. isInspiredBy (auto: inspiresReverse)');
        this.reverseInput = text.inputEl;
        text.onChange(() => this._validate());
      });

    // ── Symmetric toggle ──
    new Setting(contentEl)
      .setName('Symmetric')
      .setDesc('If checked, both directions use the same type (e.g. 关联 ↔ 关联)')
      .addToggle((toggle) => {
        toggle.setValue(false);
        toggle.onChange((value) => {
          this.isSymmetric = value;
          if (this.reverseInput) {
            this.reverseInput.disabled = value;
            if (value && this.idInput?.value) {
              this.reverseInput.value = this.idInput.value;
            }
          }
          this._validate();
        });
      });

    // ── Validation message ──
    this.validationMsg = contentEl.createDiv({
      cls: 'markvault-add-relation-type-validation',
    });

    // ── Buttons ──
    const buttonBar = contentEl.createDiv({ cls: 'markvault-add-relation-type-buttons' });

    const cancelBtn = buttonBar.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    this.confirmBtn = buttonBar.createEl('button', {
      text: 'Add Type',
      cls: 'mod-cta',
    });
    this.confirmBtn.disabled = true;
    this.confirmBtn.addEventListener('click', () => {
      const id = this.idInput?.value.trim().replace(/[^a-zA-Z0-9_]/g, '') || '';
      if (!id) return;
      const isSymmetric = this.isSymmetric;
      const label = this.labelInput?.value.trim() || id;
      const reverseId = isSymmetric ? id : (this.reverseInput?.value.trim() || id + 'Reverse');

      this.onConfirm({ id, label, reverseId, isSymmetric });
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  private _validate() {
    if (!this.idInput || !this.validationMsg || !this.confirmBtn) return;

    const rawId = this.idInput.value.trim();
    const id = rawId.replace(/[^a-zA-Z0-9_]/g, '');
    const errors: string[] = [];

    if (!rawId) {
      errors.push('Type ID is required');
    } else if (id !== rawId) {
      errors.push('Type ID can only contain letters, numbers, and underscores');
    } else if (this.existingIds.has(id)) {
      errors.push(`Type "${id}" already exists`);
    }

    if (errors.length > 0) {
      this.validationMsg.textContent = errors[0];
      this.validationMsg.addClass('markvault-validation-error');
      this.validationMsg.removeClass('markvault-validation-ok');
      this.confirmBtn.disabled = true;
    } else {
      this.validationMsg.textContent = rawId ? `✓ Will create: ${id} ↔ ${this.isSymmetric ? id : (this.reverseInput?.value.trim() || id + 'Reverse')}` : '';
      this.validationMsg.removeClass('markvault-validation-error');
      this.validationMsg.addClass('markvault-validation-ok');
      this.confirmBtn.disabled = !rawId;
    }
  }
}
