/**
 * Tag Manager v2 — 标签治理面板（Group 分组视图）
 *
 * 标签按所属 Group 分组展示，未分组标签归入"自由"分组。
 * Group 本身支持重命名 / 删除。
 */

import { App, Modal, Notice, Setting, TextComponent } from 'obsidian';
import { getTagFrequencies, getGroupNames, getAllAnnotations } from '../../../db/annotation-repo';
import type { AnnotationStore } from '../../../db/annotation-store';

interface TagManagerHost {
  app: App;
  store: AnnotationStore;
  refresh(): Promise<void>;
}

/** tag 及其出现的 group 信息 */
interface TagInfo {
  name: string;
  count: number;
  groups: Set<string>;  // 该 tag 出现在哪些 group 的标注中
}

export class TagManager {
  private host: TagManagerHost;
  private _knownGroups: string[] = [];

  constructor(host: TagManagerHost) {
    this.host = host;
  }

  render(container: HTMLElement): void {
    container.empty();
    const header = container.createDiv({ cls: 'markvault-tagmanager-header' });
    header.style.cssText = 'padding:8px 0 12px;border-bottom:1px solid var(--background-modifier-border,#ddd);margin-bottom:8px';
    header.createSpan({ text: '🏷️ Tag Manager', cls: 'markvault-tagmanager-title' }).style.cssText = 'font-weight:600;font-size:14px';

    const actions = header.createSpan();
    actions.style.cssText = 'float:right;display:flex;gap:4px';

    const newGroupBtn = actions.createEl('button', { text: '+ Group' });
    newGroupBtn.style.cssText = 'font-size:11px;padding:2px 8px;cursor:pointer;border:1px solid var(--background-modifier-border,#ccc);border-radius:4px;background:var(--interactive-accent,#483699);color:#fff';
    newGroupBtn.addEventListener('click', () => { this.showNewGroupDialog(container); });

    const refreshBtn = actions.createEl('button', { text: '🔄' });
    refreshBtn.style.cssText = 'font-size:14px;padding:2px 6px;cursor:pointer;border:1px solid var(--background-modifier-border,#ccc);border-radius:4px;background:transparent;line-height:1';
    Object.assign(refreshBtn, { title: 'Refresh' });
    refreshBtn.addEventListener('click', () => { this.render(container); new Notice('Tags refreshed'); });

    const listEl = container.createDiv({ cls: 'markvault-tagmanager-list' });
    listEl.style.cssText = 'max-height:calc(100vh - 220px);overflow-y:auto';
    this.renderGrouped(listEl);
  }

  /** 按 tag 分组所在 annotation 收集 tag → groups 映射 */
  private async collectTagGroups(): Promise<Map<string, Set<string>>> {
    const tagGroups = new Map<string, Set<string>>();
    const all = await getAllAnnotations();
    for (const ann of all) {
      const annGroups = ann.groups ?? [];
      for (const tag of ann.tags) {
        let set = tagGroups.get(tag);
        if (!set) { set = new Set(); tagGroups.set(tag, set); }
        for (const g of annGroups) set.add(g);
      }
    }
    return tagGroups;
  }

  private async renderGrouped(listEl: HTMLElement): Promise<void> {
    listEl.empty();
    const frequencies = getTagFrequencies();
    if (frequencies.length === 0) {
      listEl.createDiv({ text: 'No tags.', cls: '' }).style.cssText = 'padding:20px;text-align:center;color:var(--text-muted,#888)';
      return;
    }

    const tagGroups = await this.collectTagGroups();
    const groups = getGroupNames();

    // 合并已知分组（用户手动创建但尚无标注使用的）
    for (const kg of this._knownGroups) {
      if (!groups.includes(kg)) groups.push(kg);
    }

    // 构建 group → tags 映射
    const grouped = new Map<string, Array<{ name: string; count: number }>>();
    for (const g of groups) grouped.set(g, []);

    // 收集未分组的 tags
    const freeTags: Array<{ name: string; count: number }> = [];

    for (const f of frequencies) {
      const gs = tagGroups.get(f.name);
      if (!gs || gs.size === 0) {
        freeTags.push({ name: f.name, count: f.count });
      } else {
        for (const g of gs) {
          const arr = grouped.get(g);
          if (arr) arr.push({ name: f.name, count: f.count });
        }
      }
    }

    // 渲染 Group sections
    const sortedGroups = [...groups].sort();
    for (const g of sortedGroups) {
      const tags = grouped.get(g) ?? [];
      this.renderGroupSection(listEl, g, tags);
    }

    // 渲染 "自由" 分组
    if (freeTags.length > 0 || groups.length === 0) {
      this.renderGroupSection(listEl, '自由', freeTags);
    }
  }

  private renderGroupSection(parent: HTMLElement, groupName: string, tags: Array<{ name: string; count: number }>): void {
    // Group header
    const header = parent.createDiv({ cls: 'markvault-tagmanager-group-header' });
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;margin:4px 0 2px;background:var(--background-secondary,#f5f5f5);border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;user-select:none';

    const left = header.createSpan();
    left.style.cssText = 'display:flex;align-items:center;gap:6px';
    const collapseIcon = left.createSpan({ text: '▾' });
    collapseIcon.style.cssText = 'font-size:10px;width:12px';
    left.appendText(`📂 ${groupName}`);
    const countBadge = header.createSpan({ text: `${tags.length}` });
    countBadge.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;padding:0 6px;border-radius:8px;font-size:11px';

    // Group actions (non-"自由")
    if (groupName !== '自由') {
      const actions = header.createSpan();
      actions.style.cssText = 'display:flex;gap:4px';
      const renameBtn = actions.createEl('button', { text: '✏️', attr: { title: 'Rename group' } });
      renameBtn.style.cssText = 'padding:0 4px;cursor:pointer;border:none;background:none;font-size:12px;opacity:.7';
      renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showGroupRenameDialog(groupName, tags); });

      const delBtn = actions.createEl('button', { text: '🗑', attr: { title: 'Delete group' } });
      delBtn.style.cssText = 'padding:0 4px;cursor:pointer;border:none;background:none;font-size:12px;opacity:.7';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showGroupDeleteConfirm(groupName); });
    }

    // Tag body（可折叠）
    const body = parent.createDiv();
    body.style.cssText = 'padding-left:8px';

    let collapsed = false;
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      collapseIcon.textContent = collapsed ? '▸' : '▾';
    });

    if (tags.length === 0 && groupName !== '自由') {
      body.createDiv({ text: 'No tags in this group' }).style.cssText = 'padding:8px 16px;color:var(--text-muted,#888);font-size:12px';
      return;
    }

    for (const t of tags) {
      const row = body.createDiv();
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 12px;border-radius:6px;font-size:12px;transition:background .1s';
      row.addEventListener('mouseenter', () => row.style.background = 'var(--background-modifier-hover,rgba(0,0,0,.05))');
      row.addEventListener('mouseleave', () => row.style.background = '');

      const tagLeft = row.createSpan();
      tagLeft.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';
      tagLeft.createSpan({ text: t.name });
      const cnt = tagLeft.createSpan({ text: ` ${t.count}` });
      cnt.style.cssText = 'color:var(--text-muted,#888);font-size:11px;margin-left:4px';

      const tagActions = row.createSpan();
      tagActions.style.cssText = 'display:flex;gap:3px;flex-shrink:0';

      const rn = tagActions.createEl('button', { text: '✏️', attr: { title: 'Rename' } });
      rn.style.cssText = 'padding:0 4px;cursor:pointer;border:none;background:none;font-size:12px;opacity:.7';
      rn.addEventListener('click', (e) => { e.stopPropagation(); this.showRenameDialog(t.name); });

      const mg = tagActions.createEl('button', { text: '⇄', attr: { title: 'Merge' } });
      mg.style.cssText = 'padding:0 4px;cursor:pointer;border:none;background:none;font-size:12px;opacity:.7';
      mg.addEventListener('click', (e) => { e.stopPropagation(); this.showMergeDialog(t.name); });

      const dl = tagActions.createEl('button', { text: '🗑', attr: { title: 'Delete' } });
      dl.style.cssText = 'padding:0 4px;cursor:pointer;border:none;background:none;font-size:12px;opacity:.7';
      dl.addEventListener('click', (e) => { e.stopPropagation(); this.showDeleteConfirm(t.name); });
    }
  }

  // ─── Group 操作 ───

  private showNewGroupDialog(container: HTMLElement): void {
    const modal = new Modal(this.host.app);
    const { contentEl } = modal;
    contentEl.style.cssText = 'padding:16px;min-width:280px';
    modal.titleEl.setText('New Group');

    new Setting(contentEl)
      .setName('Group name')
      .setDesc('Create a new group to categorize tags')
      .addText((text: TextComponent) => {
        text.setPlaceholder('e.g. 学习, 测试, 练习');
        text.inputEl.style.width = '100%';
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && text.getValue().trim()) {
            this._knownGroups.push(text.getValue().trim());
            modal.close();
            this.render(container);
          }
        });
      });

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const okBtn = footer.createEl('button', { text: 'Create' });
    okBtn.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    okBtn.addEventListener('click', () => {
      const input = contentEl.querySelector('input') as HTMLInputElement;
      if (input?.value.trim()) {
        this._knownGroups.push(input.value.trim());
        modal.close();
        this.render(container);
      }
    });
    modal.open();
  }

  private showGroupRenameDialog(oldName: string, tags: Array<{ name: string; count: number }>): void {
    const modal = new Modal(this.host.app);
    const { contentEl } = modal;
    contentEl.style.cssText = 'padding:16px;min-width:280px';
    modal.titleEl.setText(`Rename group "${oldName}"`);

    new Setting(contentEl)
      .setName('New group name')
      .addText((text: TextComponent) => {
        text.setValue(oldName);
        text.inputEl.style.width = '100%';
      });

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const confirmBtn = footer.createEl('button', { text: 'Rename' });
    confirmBtn.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    confirmBtn.addEventListener('click', async () => {
      const input = contentEl.querySelector('input') as HTMLInputElement;
      if (!input?.value.trim() || input.value.trim() === oldName) return;
      const newName = input.value.trim();
      let count = 0;
      const all2 = await getAllAnnotations();
      for (const ann of all2) {
        if (ann.groups?.includes(oldName)) {
          ann.groups = (ann.groups ?? []).map((g: string) => g === oldName ? newName : g);
          count++;
        }
      }
      new Notice(`Renamed group "${oldName}" → "${newName}" (${count} annotations)`);
      modal.close();
      await this.host.refresh();
    });
    modal.open();
  }

  private showGroupDeleteConfirm(group: string): void {
    const modal = new Modal(this.host.app);
    const { contentEl } = modal;
    contentEl.style.cssText = 'padding:16px;min-width:280px';
    modal.titleEl.setText(`Delete group "${group}"?`);
    contentEl.createDiv({ text: `This will remove group "${group}" from ALL annotations. Tags will not be deleted.` })
      .style.cssText = 'margin:8px 0;color:var(--text-muted,#888);font-size:13px';

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const delBtn = footer.createEl('button', { text: 'Delete Group' });
    delBtn.style.cssText = 'background:#e74c3c;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    delBtn.addEventListener('click', async () => {
      let count2 = 0;
      const all3 = await getAllAnnotations();
      for (const ann of all3) {
        if (ann.groups?.includes(group)) {
          ann.groups = (ann.groups ?? []).filter((g: string) => g !== group);
          count2++;
        }
      }
      new Notice(`Removed group "${group}" from ${count2} annotations`);
      modal.close();
      await this.host.refresh();
    });
    modal.open();
  }

  // ─── Tag 操作（保持原有逻辑）───

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
            const cnt = await this.host.store.renameTag(oldName, text.getValue().trim());
            new Notice(`Renamed: ${oldName} → ${text.getValue().trim()} (${cnt} annotations)`);
            modal.close();
            await this.host.refresh();
          }
        });
      });

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const confirmBtn = footer.createEl('button', { text: 'Rename' });
    confirmBtn.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    confirmBtn.addEventListener('click', async () => {
      const input = contentEl.querySelector('input') as HTMLInputElement;
      if (input?.value.trim() && input.value.trim() !== oldName) {
        const cnt = await this.host.store.renameTag(oldName, input.value.trim());
        new Notice(`Renamed: ${oldName} → ${input.value.trim()} (${cnt} annotations)`);
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
      .addText((text: TextComponent) => {
        text.setPlaceholder('Enter target tag name');
        text.inputEl.style.width = '100%';
      });

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const confirmBtn = footer.createEl('button', { text: 'Merge' });
    confirmBtn.style.cssText = 'background:var(--interactive-accent,#483699);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    confirmBtn.addEventListener('click', async () => {
      const input = contentEl.querySelector('input') as HTMLInputElement;
      if (input?.value.trim()) {
        const cnt = await this.host.store.mergeTags(input.value.trim(), [sourceName]);
        new Notice(`Merged: ${sourceName} → ${input.value.trim()} (${cnt} annotations)`);
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
    contentEl.createDiv({ text: `This will remove "${tag}" from ALL annotations. Cannot be undone.` })
      .style.cssText = 'margin:8px 0;color:var(--text-muted,#888);font-size:13px';

    const footer = contentEl.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    const delBtn = footer.createEl('button', { text: 'Delete' });
    delBtn.style.cssText = 'background:#e74c3c;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer';
    delBtn.addEventListener('click', async () => {
      const cnt = await this.host.store.deleteTag(tag);
      new Notice(`Deleted "${tag}" from ${cnt} annotations`);
      modal.close();
      await this.host.refresh();
    });
    modal.open();
  }
}
