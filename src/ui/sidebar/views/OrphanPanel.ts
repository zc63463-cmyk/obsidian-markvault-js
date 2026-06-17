/**
 * OrphanPanel — 侧边栏孤儿标注视图
 *
 * Phase C-3.2: 显示孤儿标注列表，支持逐条删除/忽略操作。
 */

import { App, Notice } from 'obsidian';
import type { MarkVaultPluginInterface } from '../../../utils/plugin-interface';
import { detectOrphans, deleteOrphans, type OrphanInfo } from '../../../db/orphan-detector';
import { annotationStore } from '../../../db/annotation-store';

export interface OrphanPanelHost {
  app: App;
  getPluginInstance: () => MarkVaultPluginInterface | null;
}

export class OrphanPanel {
  private orphans: OrphanInfo[] = [];
  private selectedUuids: Set<string> = new Set();
  private isScanning = false;

  constructor(private host: OrphanPanelHost) {}

  async render(container: HTMLElement): Promise<void> {
    container.empty();
    container.createEl('h3', { text: 'Orphan Annotations', cls: 'markvault-orphans-title' });
    container.createDiv({
      cls: 'markvault-orphans-desc',
      text: 'Annotations that exist in the database but are missing from their Markdown files.',
    });

    // 操作栏
    const toolbar = container.createDiv({ cls: 'markvault-orphans-toolbar' });

    const scanBtn = toolbar.createEl('button', {
      text: this.orphans.length > 0 ? 'Rescan' : 'Scan for Orphans',
      cls: 'mod-cta',
    });
    scanBtn.addEventListener('click', async () => {
      await this.scan(container);
    });

    if (this.orphans.length > 0) {
      const selectAllBtn = toolbar.createEl('button', { text: 'Select All' });
      selectAllBtn.addEventListener('click', () => {
        for (const o of this.orphans) this.selectedUuids.add(o.uuid);
        this.renderOrphanList(listContainer);
      });

      const deleteSelectedBtn = toolbar.createEl('button', {
        text: `Delete Selected (${this.selectedUuids.size})`,
        cls: 'mod-warning',
      });
      deleteSelectedBtn.addEventListener('click', async () => {
        if (this.selectedUuids.size === 0) {
          new Notice('No orphans selected');
          return;
        }
        const count = await deleteOrphans([...this.selectedUuids], annotationStore);
        new Notice(`Deleted ${count} orphan annotation${count > 1 ? 's' : ''}`);
        this.selectedUuids.clear();
        await this.scan(container);
        // 通知侧边栏刷新
        const plugin = this.host.getPluginInstance();
        if (plugin) plugin.refreshSidebar();
      });
    }

    // 列表区
    const listContainer = container.createDiv({ cls: 'markvault-orphans-list' });

    if (this.orphans.length === 0 && !this.isScanning) {
      if (this.isScanning) {
        listContainer.createDiv({ text: 'Scanning...', cls: 'markvault-orphans-empty' });
      } else {
        listContainer.createDiv({
          text: 'No orphan annotations detected. Click "Scan for Orphans" to check.',
          cls: 'markvault-orphans-empty',
        });
      }
    } else {
      this.renderOrphanList(listContainer);
    }
  }

  private renderOrphanList(container: HTMLElement): void {
    container.empty();

    // 按文件分组
    const byFile = new Map<string, OrphanInfo[]>();
    for (const o of this.orphans) {
      let list = byFile.get(o.filePath);
      if (!list) { list = []; byFile.set(o.filePath, list); }
      list.push(o);
    }

    for (const [filePath, orphans] of byFile) {
      const fileGroup = container.createDiv({ cls: 'markvault-orphans-file-group' });
      fileGroup.createDiv({ cls: 'markvault-orphans-file-name', text: filePath });
      fileGroup.createDiv({ cls: 'markvault-orphans-file-count', text: `${orphans.length} orphan${orphans.length > 1 ? 's' : ''}` });

      for (const o of orphans) {
        const item = fileGroup.createDiv({ cls: 'markvault-orphans-item' });

        // 勾选框
        const checkbox = item.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.selectedUuids.has(o.uuid);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            this.selectedUuids.add(o.uuid);
          } else {
            this.selectedUuids.delete(o.uuid);
          }
        });

        // 信息区
        const info = item.createDiv({ cls: 'markvault-orphans-item-info' });
        info.createDiv({ cls: 'markvault-orphans-item-text', text: o.text.slice(0, 60) + (o.text.length > 60 ? '...' : '') });
        const meta = info.createDiv({ cls: 'markvault-orphans-item-meta' });
        const reasonLabel = o.reason === 'file_deleted' ? 'File deleted'
          : o.reason === 'content_changed' ? 'Content changed'
          : 'Anchor missing';
        meta.createSpan({ text: reasonLabel });
        if (o.recoverable) {
          meta.createSpan({ text: ' · ', cls: 'markvault-orphans-recoverable-dot' });
          meta.createSpan({ text: 'Recoverable', cls: 'markvault-orphans-recoverable' });
        } else {
          meta.createSpan({ text: ' · ' });
        }
        meta.createSpan({ text: o.uuid.slice(0, 8) + '...' });

        // 单条删除按钮
        const deleteBtn = item.createEl('button', { text: 'Delete', cls: 'mod-warning' });
        deleteBtn.addEventListener('click', async () => {
          await deleteOrphans([o.uuid], annotationStore);
          new Notice(`Deleted orphan annotation ${o.uuid.slice(0, 8)}`);
          this.selectedUuids.delete(o.uuid);
          this.orphans = this.orphans.filter(x => x.uuid !== o.uuid);
          // 刷新列表
          const parent = item.parentElement;
          if (parent) this.renderOrphanList(parent);
        });
      }
    }
  }

  private async scan(container: HTMLElement): Promise<void> {
    this.isScanning = true;
    try {
      this.orphans = await detectOrphans(this.host.app, annotationStore);
      this.selectedUuids.clear();
      new Notice(`Found ${this.orphans.length} orphan annotation${this.orphans.length !== 1 ? 's' : ''}`);
    } catch (err) {
      console.error('MarkVault: orphan scan failed', err);
      new Notice('Orphan scan failed. Check console for details.');
    } finally {
      this.isScanning = false;
      this.render(container);
    }
  }
}
