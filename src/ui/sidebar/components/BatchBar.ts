import { App, Menu, Notice, TFile } from 'obsidian';
import type { Annotation, AnnotationFilter } from '../../../types/annotation';
import { PRESET_COLORS } from '../../../types/annotation';
import type { MarkVaultPluginInterface } from '../../../utils/plugin-interface';
import { ConfirmModal } from '../../confirm-modal';
import {
  removeBlockAnchor,
  removeSpanAnchor,
  removeMarkTag,
  updateSpanAnchor,
  updateBlockAnchor,
  updateMarkTag,
} from '../../../core/annotation-parser';
import {
  getAnnotationByUuid,
  deleteAnnotation,
  addAnnotation,
  updateAnnotation,
  queryAnnotations,
  getRelations,
} from '../../../db/annotation-repo';

/**
 * BatchBar —— 侧边栏批量操作栏
 *
 * 负责批量选择、批量改色、批量删除、导出功能。
 */
export interface BatchBarHost {
  app: App;
  getPluginInstance(): MarkVaultPluginInterface | null;
  selectedUuids: Set<string>;
  getActiveTab(): 'current' | 'all' | 'stats' | 'orphans' | 'tags';
  getCurrentFilePath(): string | null;
  getFilter(): AnnotationFilter;
  renderContent(): Promise<void>;
}

export class BatchBar {
  constructor(private host: BatchBarHost) {}

  render(container: HTMLElement): void {
    const bar = container.createDiv({ cls: 'markvault-batch-bar' });

    const selectAllBtn = bar.createEl('button', {
      text: 'Select All',
      cls: 'markvault-batch-btn',
    });
    selectAllBtn.addEventListener('click', async () => {
      const listContainer = container.querySelector('.markvault-sidebar-list');
      if (listContainer) {
        const checkboxes = listContainer.querySelectorAll('.markvault-card-checkbox');
        checkboxes.forEach((cb) => {
          const input = cb as HTMLInputElement;
          input.checked = true;
          const uuid = input.dataset.uuid;
          if (uuid) this.host.selectedUuids.add(uuid);
        });
      }
      this.updateBatchBarCount(bar);
    });

    const deselectBtn = bar.createEl('button', {
      text: 'Deselect',
      cls: 'markvault-batch-btn',
    });
    deselectBtn.addEventListener('click', () => {
      this.host.selectedUuids.clear();
      const listContainer = container.querySelector('.markvault-sidebar-list');
      if (listContainer) {
        const checkboxes = listContainer.querySelectorAll('.markvault-card-checkbox');
        checkboxes.forEach((cb) => {
          (cb as HTMLInputElement).checked = false;
        });
      }
      this.updateBatchBarCount(bar);
    });

    // 批量改色
    const colorBtn = bar.createEl('button', {
      text: '🎨 Color',
      cls: 'markvault-batch-btn',
    });
    colorBtn.addEventListener('click', () => {
      this.showBatchColorMenu(colorBtn);
    });

    // 批量删除
    const deleteBtn = bar.createEl('button', {
      text: '🗑️ Delete',
      cls: 'markvault-batch-btn markvault-batch-delete',
    });
    deleteBtn.addEventListener('click', async () => {
      await this.handleBatchDelete();
    });

    // Phase 3: 导出按钮
    const exportBtn = bar.createEl('button', {
      text: '📥 Export',
      cls: 'markvault-batch-btn',
    });
    exportBtn.addEventListener('click', () => {
      this.showExportMenu(exportBtn);
    });

    // 选中计数
    const countEl = bar.createSpan({ cls: 'markvault-batch-count', text: '0 selected' });
    countEl.id = 'markvault-batch-count';
  }

  private updateBatchBarCount(bar: HTMLElement) {
    const countEl = bar.querySelector('#markvault-batch-count');
    if (countEl) {
      countEl.textContent = `${this.host.selectedUuids.size} selected`;
    }
  }

  private showBatchColorMenu(anchor: HTMLElement) {
    const menu = new Menu();
    for (const pc of PRESET_COLORS) {
      menu.addItem((item) => {
        item.setTitle(`Change to ${pc.label}`)
          .setChecked(false)
          .onClick(async () => {
            await this.batchChangeColor(pc.id);
          });
      });
    }
    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async batchChangeColor(colorId: string) {
    if (this.host.selectedUuids.size === 0) return;

    const plugin = this.host.getPluginInstance();
    if (!plugin) return;

    const byFile = new Map<string, Array<{ uuid: string; kind: string; originalColor: string }>>();

    for (const uuid of this.host.selectedUuids) {
      const annotation = await getAnnotationByUuid(uuid);
      if (!annotation) continue;

      const originalColor = annotation.color;
      await updateAnnotation(uuid, { color: colorId });

      let group = byFile.get(annotation.filePath);
      if (!group) {
        group = [];
        byFile.set(annotation.filePath, group);
      }
      group.push({ uuid, kind: annotation.kind || 'inline', originalColor });
    }

    const affectedFiles = new Set<string>();
    for (const [filePath, items] of byFile) {
      try {
        const file = this.host.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) continue;

        const content = await this.host.app.vault.read(file);
        let newContent = content;

        for (const item of items) {
          if (item.kind === 'span') {
            newContent = updateSpanAnchor(newContent, item.uuid, { color: colorId });
          } else if (item.kind === 'block') {
            newContent = updateBlockAnchor(newContent, item.uuid, { color: colorId });
          } else {
            newContent = updateMarkTag(newContent, item.uuid, { color: colorId });
          }
        }

        if (newContent !== content) {
          plugin.modifyGuard.acquire(filePath);
          try {
            await this.host.app.vault.modify(file, newContent);
          } catch (mdErr) {
            console.error(`MarkVault: batch color change MD error for ${filePath}, rolling back`, mdErr);
            for (const item of items) {
              await updateAnnotation(item.uuid, { color: item.originalColor });
            }
            throw mdErr;
          } finally {
            plugin.modifyGuard.release(filePath);
          }
        }

        plugin.markFileSynced(filePath);
        affectedFiles.add(filePath);
      } catch (err) {
        plugin.modifyGuard.releaseNow(filePath);
        console.error('MarkVault: batch color change error', filePath, err);
      }
    }

    for (const filePath of affectedFiles) {
      try {
        await plugin.updateSpanCache(filePath);
      } catch (err) {
        console.error('MarkVault: batch color change spanCache error', filePath, err);
      }
    }

    this.host.selectedUuids.clear();
    await this.host.renderContent();
  }

  private async handleBatchDelete() {
    if (this.host.selectedUuids.size === 0) return;
    const count = this.host.selectedUuids.size;

    // 🔧 v5.1: 统计涉及的关联关系数量
    let totalRels = 0;
    for (const uuid of this.host.selectedUuids) {
      const rels = getRelations(uuid);
      totalRels += rels.outgoing.length + rels.incoming.length;
    }
    const confirmMsg = totalRels > 0
      ? `Delete ${count} annotations? This will also remove ${totalRels} relation${totalRels > 1 ? 's' : ''}.`
      : `Delete ${count} annotations?`;
    const confirmed = await ConfirmModal.open(this.host.app, {
      message: confirmMsg,
      title: 'Batch Delete',
      okText: 'Delete',
      dangerous: true,
    });
    if (!confirmed) return;

    const plugin = this.host.getPluginInstance();
    if (!plugin) return;

    type BatchDeleteFileEntry = {
      file: TFile;
      originalContent: string;
      items: Array<{ uuid: string; kind: string }>;
      backups: Map<string, Annotation>;
    };

    const byFile = new Map<string, BatchDeleteFileEntry>();
    const missingUuids: string[] = [];

    for (const uuid of this.host.selectedUuids) {
      const annotation = await getAnnotationByUuid(uuid);
      if (!annotation) {
        missingUuids.push(uuid);
        continue;
      }

      plugin.unmarkAnnotationActive(uuid, annotation.filePath);

      let entry = byFile.get(annotation.filePath);
      if (!entry) {
        const file = this.host.app.vault.getAbstractFileByPath(annotation.filePath);
        if (!(file instanceof TFile)) {
          missingUuids.push(uuid);
          continue;
        }
        const content = await this.host.app.vault.read(file);
        entry = {
          file,
          originalContent: content,
          items: [],
          backups: new Map(),
        };
        byFile.set(annotation.filePath, entry);
      }

      entry.backups.set(uuid, JSON.parse(JSON.stringify(annotation)));
      entry.items.push({ uuid, kind: annotation.kind || 'inline' });
    }

    for (const entry of byFile.values()) {
      for (const uuid of entry.backups.keys()) {
        await deleteAnnotation(uuid);
      }
    }

    const modifiedFiles: string[] = [];
    let hasFailure = false;
    let lastError: unknown = null;

    for (const [filePath, entry] of byFile) {
      plugin.markFileSynced(filePath);
      plugin.modifyGuard.acquire(filePath);
      try {
        await this.host.app.vault.process(entry.file, (content) => {
          let newContent = content;
          for (const item of entry.items) {
            if (item.kind === 'block') {
              newContent = removeBlockAnchor(newContent, item.uuid);
            } else if (item.kind === 'span') {
              newContent = removeSpanAnchor(newContent, item.uuid);
            } else {
              const result = removeMarkTag(newContent, item.uuid);
              if (result) newContent = result.content;
            }
          }
          return newContent;
        });
        modifiedFiles.push(filePath);
      } catch (processErr) {
        lastError = processErr;
        hasFailure = true;
        break;
      } finally {
        plugin.modifyGuard.release(filePath);
      }
    }

    if (hasFailure) {
      for (const entry of byFile.values()) {
        for (const backup of entry.backups.values()) {
          try {
            await addAnnotation(backup);
          } catch (addErr) {
            console.error('MarkVault: batch delete rollback add failed', addErr);
          }
        }
      }

      for (const filePath of modifiedFiles) {
        const entry = byFile.get(filePath)!;
        const originalContent = entry.originalContent;
        plugin.modifyGuard.acquire(filePath);
        try {
          await this.host.app.vault.process(entry.file, () => originalContent);
        } catch (restoreErr) {
          console.error(`MarkVault: batch delete MD restore failed for ${filePath}`, restoreErr);
        } finally {
          plugin.modifyGuard.release(filePath);
        }
      }

      new Notice(
        `Batch delete failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
        5000,
      );
    } else {
      new Notice(
        `Deleted ${this.host.selectedUuids.size - missingUuids.length} annotations`,
        4000,
      );
    }

    for (const filePath of byFile.keys()) {
      try {
        await plugin.updateSpanCache(filePath);
      } catch (err) {
        console.error('MarkVault: batch delete spanCache error', filePath, err);
      }
    }

    this.host.selectedUuids.clear();
    await this.host.renderContent();
  }

  private showExportMenu(anchor: HTMLElement) {
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('Export filtered (JSON)')
        .onClick(async () => {
          await this.exportFiltered('json');
        });
    });

    menu.addItem((item) => {
      item.setTitle('Export filtered (Markdown)')
        .onClick(async () => {
          await this.exportFiltered('markdown');
        });
    });

    if (this.host.selectedUuids.size > 0) {
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(`Export ${this.host.selectedUuids.size} selected (JSON)`)
          .onClick(async () => {
            await this.exportSelected('json');
          });
      });
      menu.addItem((item) => {
        item.setTitle(`Export ${this.host.selectedUuids.size} selected (Markdown)`)
          .onClick(async () => {
            await this.exportSelected('markdown');
          });
      });
    }

    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async exportFiltered(format: 'json' | 'markdown') {
    let annotations: Annotation[];

    if (this.host.getActiveTab() === 'current' && this.host.getCurrentFilePath()) {
      const currentFilePath = this.host.getCurrentFilePath()!;
      annotations = await queryAnnotations({ ...this.host.getFilter() });
      annotations = annotations.filter(a => a.filePath === currentFilePath);
    } else {
      annotations = await queryAnnotations(this.host.getFilter());
    }

    this.doExport(annotations, format);
  }

  private async exportSelected(format: 'json' | 'markdown') {
    const annotations: Annotation[] = [];
    for (const uuid of this.host.selectedUuids) {
      const ann = await getAnnotationByUuid(uuid);
      if (ann) annotations.push(ann);
    }
    this.doExport(annotations, format);
  }

  private doExport(annotations: Annotation[], format: 'json' | 'markdown') {
    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      const content = JSON.stringify(annotations, null, 2);
      this.downloadFile(content, `markvault-export-${dateStr}.json`, 'application/json');
    } else {
      const byFile = new Map<string, Annotation[]>();
      for (const a of annotations) {
        const fileName = a.filePath.split('/').pop() || a.filePath;
        if (!byFile.has(fileName)) byFile.set(fileName, []);
        byFile.get(fileName)!.push(a);
      }

      let md = `# MarkVault Export\n\nExported: ${new Date().toLocaleString()}\nTotal: ${annotations.length} annotations\n\n---\n\n`;

      for (const [fileName, items] of byFile) {
        md += `## ${fileName}\n\n`;
        for (const a of items) {
          md += `> ${a.text.replace(/\n/g, '\n> ')}\n\n`;
          if (a.note) md += `**Note**: ${a.note}\n\n`;
          if (a.fields && Object.keys(a.fields).length > 0) {
            const fieldsStr = Object.entries(a.fields).map(([k, v]) => `${k}=${v}`).join(', ');
            md += `**Fields**: ${fieldsStr}\n\n`;
          }
          if (a.tags.length > 0) {
            md += `**Tags**: ${a.tags.map(t => `#${t}`).join(' ')}\n\n`;
          }
          md += `---\n\n`;
        }
      }

      this.downloadFile(md, `markvault-export-${dateStr}.md`, 'text/markdown');
    }
  }

  private downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
