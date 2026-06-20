/**
 * Tag Manager — 标签治理面板
 *
 * 参考 Obsidian Tag Wrangler 设计，提供标签重命名 / 合并 / 删除功能。
 * 通过 byTag 索引获取使用该标签的所有标注，批量操作。
 */

import { App, Modal, Notice, Setting, TextComponent } from 'obsidian';
import { getTagFrequencies } from '../../../db/annotation-repo';
import type { AnnotationStore } from '../../../db/annotation-store';

export interface TagManagerHost {
  app: App;
  store: AnnotationStore;
  refresh(): Promise<void>;
}

export class TagManager {
  constructor(private host: TagManagerHost) {}

  render(container: HTMLElement): void {
    container.empty();

    const header = container.createDiv({ cls: 'markvault-tagmanager-header' });
    header.style.cssText = 'padding:8px 0 12px;border-bottom:1px solid var(--background-modifier-border,#ddd);margin-bottom:8px';
    header.createSpan({ text: '🏷️ Tag Manager', cls: 'markvault-tagmanager-title' }).style.cssText = 'font-weight:600;font-size:14px';

    // 刷新按钮
    const refreshBtn = header.createEl('button', { text: '🔄 Refresh', cls: 'markvault-tagmanager-refresh-btn' });
    refreshBtn.style.cssText = 'float:right;font-size:11px;padding:2px 8px;cursor:pointer';
    refreshBtn.addEventListener('click', async () => { await this.renderCurrent(container); });

    // 标签列表容器
    const listEl = container.createDiv({ cls: 'markvault-tagmanager-list' });
    listEl.style.cssText = 'max-height:calc(100vh - 220px);overflow-y:auto';

    this.renderList(listEl);
  }

  private renderList(listEl: HTMLElement): void {
    listEl.empty();
    const frequencies = getTagFrequencies();

    if (frequencies.length === 0) {
      listEl.createDiv({ text: 'No tags in any annotation.' }).style.cssText = 'padding:20px;text-align:center;color:var(--text-muted,#888)';
      return;
    }

    for (const f of frequencies) {
      const row = listEl.createDiv({ cls: 'markvault-tagmanager-row' });
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;transition:background .1s';
      row.addEventListener('mouseenter', () => row.style.background = 'var(--background-modifier-hover,rgba(0,0,0,.05))');
      row.addEventListener('mouseleave', () => row.style.background = '');

      // 标签名 + 计数
      const left = row.createDiv();
      left.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
      left.createSpan({ text: f.name }).style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const badge = left.createSpan({ text: `${f.count}`, cls: 'markvault-tagmanager-count' });
      badge.style.cssText = 'background:var(--background-modifier-hover,#e0e0e0);padding:0 6px;border-radius:8px;font-size:11px;color:var(--text-muted,#666)';

      // 操作按钮
      const actions = row.createDiv();
      actions.style.cssText = 'display:flex;gap:4px;flex-shrink:0';

      const renameBtn = actions.createEl('button', { text: '✏️', attr: { title: 'Rename' } });
      renameBtn.style.cssText = 'padding:1px 6px;cursor:pointer;border:none;background:none;font-size:14px;opacity:.7';
      renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showRenameDialog(f.name); });

      const mergeBtn = actions.createEl('button', { text: '⇄', attr: { title: 'Merge into...' } });
      mergeBtn.style.cssText = 'padding:1px 6px;cursor:pointer;border:none;background:none;font-size:14px;opacity:.7';
      mergeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showMergeDialog(f.name); });

      const deleteBtn = actions.createEl('button', { text: '🗑', attr: { title: 'Delete' } });
      deleteBtn.style.cssText = 'padding:1px 6px;cursor:pointer;border:none;background:none;font-size:14px;opacity:.7';
      deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showDeleteConfirm(f.name); });
    }
  }

  private showRenameDialog(oldName: string): void {
    const modal = new Modal(this.host.app);
    const { contentEl } = modal;
    contentEl.style.cssText = 'padding:16px;min-width:300px';
    modal.titleEl.setText(`Rename "${oldName}"`);

    new Setting(contentEl)
      .setName('New tag name')
      .addText((text: TextComponent) => {
        text.setValue(oldName);
        text.inputEl.style.width = '100%';
        text.inputEl.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter' && text.getValue().trim() && text.getValue().trim() !== oldName) {
            const count = await this.host.store.renameTag(oldName, text.getValue().trim());
            new Notice(`Renamed tag: ${oldName} → ${text.getValue().trim()} (${count} annotations updated)`);
            modal.close();
            await this.host.refresh();
          }
        });
      });

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    const cancelBtn = footer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => modal.close());
    const confirmBtn = footer.createEl('button', { text: 'Rename' });
    confirmBtn.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    confirmBtn.addEventListener('click', async () => {
      const input = contentEl.querySelector('input') as HTMLInputElement;
      if (input && input.value.trim() && input.value.trim() !== oldName) {
        const count = await this.host.store.renameTag(oldName, input.value.trim());
        new Notice(`Renamed: ${oldName} → ${input.value.trim()} (${count} annotations)`);
        modal.close();
        await this.host.refresh();
      }
    });

    modal.open();
  }

  private showMergeDialog(sourceName: string): void {
    const modal = new Modal(this.host.app);
    const { contentEl } = modal;
    contentEl.style.cssText = 'padding:16px;min-width:300px';
    modal.titleEl.setText(`Merge "${sourceName}" into...`);

    new Setting(contentEl)
      .setName('Target tag')
      .setDesc(`All annotations with "${sourceName}" will be changed to this tag`)
      .addText((text: TextComponent) => {
        text.setPlaceholder('Enter target tag name');
        text.inputEl.style.width = '100%';
        text.inputEl.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter' && text.getValue().trim()) {
            const count = await this.host.store.mergeTags(text.getValue().trim(), [sourceName]);
            new Notice(`Merged: ${sourceName} → ${text.getValue().trim()} (${count} annotations)`);
            modal.close();
            await this.host.refresh();
          }
        });
      });

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const confirmBtn = footer.createEl('button', { text: 'Merge' });
    confirmBtn.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    confirmBtn.addEventListener('click', async () => {
      const input = contentEl.querySelector('input') as HTMLInputElement;
      if (input && input.value.trim()) {
        const count = await this.host.store.mergeTags(input.value.trim(), [sourceName]);
        new Notice(`Merged: ${sourceName} → ${input.value.trim()} (${count} annotations)`);
        modal.close();
        await this.host.refresh();
      }
    });
    modal.open();
  }

  private showDeleteConfirm(tag: string): void {
    const modal = new Modal(this.host.app);
    const { contentEl } = modal;
    contentEl.style.cssText = 'padding:16px;min-width:280px';
    modal.titleEl.setText(`Delete "${tag}"?`);

    contentEl.createDiv({ text: `This will remove "${tag}" from ALL annotations. This action cannot be undone.` })
      .style.cssText = 'margin:8px 0;color:var(--text-muted,#888);font-size:13px';

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const delBtn = footer.createEl('button', { text: 'Delete' });
    delBtn.style.cssText = 'background:#e74c3c;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    delBtn.addEventListener('click', async () => {
      const count = await this.host.store.deleteTag(tag);
      new Notice(`Deleted tag "${tag}" from ${count} annotations`);
      modal.close();
      await this.host.refresh();
    });
    modal.open();
  }

  private async renderCurrent(container: HTMLElement): Promise<void> {
    const listEl = container.querySelector('.markvault-tagmanager-list') as HTMLElement;
    if (listEl) this.renderList(listEl);
  }
}
