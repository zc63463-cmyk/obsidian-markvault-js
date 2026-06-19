import { App, Notice, TFile } from 'obsidian';
import { logger } from '../../../utils/logger';
import type { Annotation } from '../../../types/annotation';
import { getAnnotationsForFile, deleteAnnotation, addAnnotation } from '../../../db/annotation-repo';
import type { MarkVaultPluginInterface } from '../../../utils/plugin-interface';
import { ConfirmModal } from '../../confirm-modal';

/**
 * CurrentFileToolbar —— 当前文件操作工具栏
 *
 * 渲染文件名 + "Clear all" 按钮，并处理整文件标注的安全删除与回滚。
 */
export interface CurrentFileToolbarHost {
  app: App;
  getCurrentFilePath(): string | null;
  getPluginInstance(): MarkVaultPluginInterface | null;
  removeAnnotationFromContent(content: string, annotation: Annotation): string | null;
  onCleared(filePath: string): Promise<void>;
  syncCurrentFile(filePath: string): Promise<{
    added: number;
    updated: number;
    inlineRecovered: number;
    blocksRecovered: number;
    spansRecovered: number;
    failed: number;
  }>;
}

export class CurrentFileToolbar {
  constructor(private host: CurrentFileToolbarHost) {}

  /** 渲染当前文件操作工具栏（文件名 + 清空标注按钮） */
  render(container: HTMLElement): void {
    const currentFilePath = this.host.getCurrentFilePath();
    if (!currentFilePath) return;

    const toolbar = container.createDiv({ cls: 'markvault-file-toolbar' });

    // 文件名
    const fileName = currentFilePath.split('/').pop() || currentFilePath;
    toolbar.createSpan({ cls: 'markvault-file-name', text: `📄 ${fileName}` });

    // 同步当前文件按钮
    const syncBtn = toolbar.createEl('button', {
      cls: 'markvault-sync-file-btn',
      title: 'Sync annotation offsets for this file',
    });
    syncBtn.createSpan({ text: '🔄', cls: 'markvault-sync-icon' });
    syncBtn.createSpan({ text: 'Sync', cls: 'markvault-sync-label' });

    syncBtn.addEventListener('click', async () => {
      const fp = this.host.getCurrentFilePath();
      if (!fp) return;
      await this.handleSync(fp);
    });

    // 清空标注按钮
    const clearBtn = toolbar.createEl('button', {
      cls: 'markvault-clear-file-btn',
      title: 'Delete all annotations in this file',
    });
    clearBtn.createSpan({ text: '🗑️', cls: 'markvault-clear-icon' });
    clearBtn.createSpan({ text: 'Clear all', cls: 'markvault-clear-label' });

    clearBtn.addEventListener('click', async () => {
      const fp = this.host.getCurrentFilePath();
      if (!fp) return;
      const name = fp.split('/').pop() || fp;
      await this.handleClearAll(fp, name);
    });
  }

  private async handleSync(filePath: string) {
    const plugin = this.host.getPluginInstance();
    if (!plugin) return;

    const notice = new Notice('MarkVault: syncing annotations...', 0);
    try {
      const result = await this.host.syncCurrentFile(filePath);
      notice.hide();

      const recoveredTotal = result.inlineRecovered + result.blocksRecovered + result.spansRecovered;
      const parts = [
        result.added > 0 ? `${result.added} added` : '',
        result.updated > 0 ? `${result.updated} updated` : '',
        result.inlineRecovered > 0 ? `${result.inlineRecovered} inline offsets recovered` : '',
        result.blocksRecovered > 0 ? `${result.blocksRecovered} blocks recovered` : '',
        result.spansRecovered > 0 ? `${result.spansRecovered} spans recovered` : '',
        result.failed > 0 ? `${result.failed} failed` : '',
      ].filter(Boolean);
      const msg = parts.length > 0 ? parts.join(', ') : 'no changes detected';
      new Notice(`MarkVault: synced (${msg})`, 4000);
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`MarkVault: sync failed — ${msg}`, 5000);
    }
  }

  private async handleClearAll(filePath: string, fileName: string) {
    const annotations = await getAnnotationsForFile(filePath);
    if (annotations.length === 0) return;

    const confirmed = await ConfirmModal.open(this.host.app, {
      message: `Delete all ${annotations.length} annotations in "${fileName}"?\n\nThis will remove all highlights, blocks, and spans from this file.`,
      title: 'Clear All Annotations',
      okText: 'Delete All',
      dangerous: true,
    });
    if (!confirmed) return;

    const plugin = this.host.getPluginInstance();
    if (!plugin) return;
    const notice = new Notice(`Deleting ${annotations.length} annotations...`, 0);

    // 先设置冷却，关闭 onFileOpen 同步窗口
    plugin.markFileSynced(filePath);

    // 备份所有标注 + 清理保护状态（深拷贝避免回滚时字段丢失）
    const backups = new Map<string, Annotation>();
    for (const ann of annotations) {
      backups.set(ann.uuid, JSON.parse(JSON.stringify(ann)));
      plugin.unmarkAnnotationActive(ann.uuid, ann.filePath);
    }

    try {
      // ── ① 批量删除 DB ──
      let dbDeleted = 0;
      for (const ann of annotations) {
        await deleteAnnotation(ann.uuid);
        dbDeleted++;
      }
      logger.debug(`MarkVault: clear all — ${dbDeleted} DB annotations deleted`);

      // ── ② 清理 MD ──
      const file = this.host.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const stripAnchors = (content: string): string => {
          let newContent = content;
          for (const ann of annotations) {
            const result = this.host.removeAnnotationFromContent(newContent, ann);
            if (result) newContent = result;
          }
          return newContent;
        };

        plugin.modifyGuard.acquire(filePath);
        try {
          logger.debug('MarkVault: clear all — calling vault.process');
          const written = await this.host.app.vault.process(file, stripAnchors);
          if (written.length === file.stat.size) {
            console.warn('MarkVault: clear all — markdown content unchanged after strip');
          } else {
            logger.debug(`MarkVault: clear all — removed ${file.stat.size - written.length} bytes`);
          }
        } catch (processErr) {
          // 首次 process 失败，短暂等待后重试一次（处理文件瞬态锁定）
          console.warn('MarkVault: clear all — vault.process failed, retrying in 200ms', processErr);
          await new Promise(r => setTimeout(r, 200));
          await this.host.app.vault.process(file, stripAnchors);
        } finally {
          plugin.modifyGuard.release(filePath);
        }
        // vault.process 完成后再次延长冷却期，覆盖元数据重解析耗时
        plugin.markFileSynced(filePath);
        logger.debug(`MarkVault: clear all — MD cleaned`);
      } else {
        console.warn('MarkVault: clear all — source file not found, DB annotations deleted only');
      }

      await this.host.onCleared(filePath);
      notice.hide();
      new Notice(`✅ Deleted ${annotations.length} annotations from "${fileName}"`, 4000);
    } catch (err) {
      // 统一回滚：恢复所有备份标注
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('MarkVault: clear all failed, rolling back DB', err);
      let restored = 0;
      for (const [uuid, backup] of backups) {
        try {
          await addAnnotation(backup);
          restored++;
        } catch (addErr) {
          console.error(`MarkVault: rollback add failed for ${uuid}`, addErr);
        }
      }
      notice.hide();
      new Notice(
        `❌ Clear all failed: ${errMsg} (${restored}/${backups.size} rolled back)`,
        8000,
      );
      // 失败时仍通知宿主刷新，确保 UI 与回滚后的 DB 一致
      await this.host.onCleared(filePath);
    }
  }
}
