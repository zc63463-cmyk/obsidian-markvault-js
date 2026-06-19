/**
 * AnnotationSyncEngine — 文件同步引擎
 *
 * 职责：
 * 1. onFileOpen：轻量级同步（ensureFileLoaded + 缓存刷新）
 * 2. forceSyncFile：全量同步（Markdown 元数据同步 + 偏移恢复 + block/span/region 位置恢复）
 * 3. markFileSynced：冷却期标记（30s 防重入）
 * 4. scheduleSidebarRefresh：requestAnimationFrame 去重刷新
 * 5. 文件事件处理：delete / rename / active-leaf-change
 */

import { TFile, MarkdownView, Notice } from 'obsidian';
import { logger } from '../utils/logger';
import MarkVaultPlugin from '../main';
import { annotationStore } from '../db/annotation-store';
import { getAnnotationByUuid } from '../db/annotation-repo';
import { syncFromMarkdown, getPlainTextForOffsetRecovery, extractContextFromContent } from '../core/markdown-sync';
import {
  computeBlockSignature,
  computeSpanSignature,
  findBlockLineBySignature,
  findSpanLineBySignature,
  detectBlockTypeAtLine,
  computeSignature,
} from '../core/block-fingerprint';
import {
  parseBlockAnchors,
  findBlockDoubleAnchorRange,
  findBlockTargetLine,
  computeSpanRanges,
  findSpanEndLine,
} from '../core/annotation-parser';
import { batchRecoverOffsets } from '../core/offset-recovery';
import { parseRegionAnnotations } from '../core/region-annotation';
import { setActiveEditorView, requestRegionLayerRedraw, clearSpanCacheForFile } from '../core/highlight-applier';

export class AnnotationSyncEngine {
  private _syncCooldown: Map<string, number> = new Map();
  private _pendingSidebarRefresh = false;

  constructor(private plugin: MarkVaultPlugin) {}

  /** 标记文件数据已一致，跳过 onFileOpen 的重复 sync（30s 冷却） */
  markFileSynced(filePath: string): void {
    this._syncCooldown.set(filePath, Date.now());
  }

  /** 调度侧边栏刷新，使用 requestAnimationFrame 并去重 */
  scheduleSidebarRefresh(): void {
    if (this._pendingSidebarRefresh) return;
    this._pendingSidebarRefresh = true;

    requestAnimationFrame(() => {
      this._pendingSidebarRefresh = false;
      this.plugin.refreshSidebar().catch((err: any) => {
        console.error('MarkVault: scheduled sidebar refresh failed', err);
      });
    });
  }

  /**
   * 文件打开时的轻量级同步
   * - 更新 EditorView 引用
   * - 防重入检查（modifyGuard / activeState / cooldown）
   * - ensureFileLoaded + 缓存刷新
   */
  async onFileOpen(file: TFile): Promise<void> {
    // 🔧 BUG-5.1 修复：更新活跃的 EditorView 引用
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      const cmView = (activeView.editor as any).cm as import('@codemirror/view').EditorView | undefined;
      setActiveEditorView(cmView || null);
    }

    // 防重入：如果当前文件正在被插件自身修改，跳过此次同步
    if (this.plugin.modifyGuard.isLocked(file.path)) {
      return;
    }

    // 防重入：如果有标注正在被编辑（Modal 打开中），也跳过同步
    if (this.plugin.activeState.activeFilePaths.has(file.path)) {
      return;
    }

    // 冷却期检查：文件最近被插件修改过，跳过短时间内重复的 sync
    const lastSync = this._syncCooldown.get(file.path);
    if (lastSync && (Date.now() - lastSync) < 30000) {
      return;
    }

    if (!this.plugin.settings.enableAutoSync) {
      return;
    }

    // 🔧 P1 修复：冷却期在 sync 开始前设置，防止并发 onFileOpen
    this._syncCooldown.set(file.path, Date.now());

    // 🔧 性能修复：onFileOpen 只做轻量级同步。
    try {
      await annotationStore.ensureFileLoaded(file.path);
      await this.plugin.updateSpanCache(file.path);
      await this.plugin.updateRegionCache(file.path);

      // 刷新侧边栏调度到下一帧，避免阻塞当前事件循环并去重
      this.scheduleSidebarRefresh();
    } catch (err) {
      console.error('MarkVault: error in lightweight file open sync', file.path, err);
    }
  }

  /**
   * 强制同步当前文件：
   * 1. 从 Markdown 同步元数据（note / tags / color / type / fields / targetHash）
   * 2. 对行内标注执行偏移恢复
   * 3. 对 block/span 标注执行目标位置恢复（基于 targetHash 指纹）
   * 4. 更新 span 缓存并刷新侧边栏
   */
  async forceSyncFile(filePath: string): Promise<{
    added: number;
    updated: number;
    inlineRecovered: number;
    blocksRecovered: number;
    spansRecovered: number;
    failed: number;
  }> {
    if (!this.plugin.isStoreReady()) {
      throw new Error('MarkVault: annotation database not initialized');
    }

    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`MarkVault: file not found: ${filePath}`);
    }

    // 防重入：文件正在被插件修改或 Modal 编辑中时跳过
    if (this.plugin.modifyGuard.isLocked(filePath)) {
      throw new Error('MarkVault: file is currently being modified by the plugin');
    }
    if (this.plugin.activeState.activeFilePaths.has(filePath)) {
      throw new Error('MarkVault: an annotation modal is open for this file');
    }

    let added = 0;
    let updated = 0;
    let inlineRecovered = 0;
    let blocksRecovered = 0;
    let spansRecovered = 0;
    let failed = 0;
    const failedDetails: Array<{ uuid: string; reason: string }> = [];

    this.plugin.modifyGuard.acquire(filePath);
    try {
      const content = await this.plugin.app.vault.read(file);

      // 1. 元数据同步
      const syncResult = await syncFromMarkdown(content, filePath);
      added = syncResult.added;
      updated = syncResult.updated;

      // 2. 行内标注偏移恢复
      const plainText = getPlainTextForOffsetRecovery(content);
      const inlineAnnotations = (await annotationStore.getAnnotationsForFile(filePath)).filter(
        (a) => !a.kind || a.kind === 'inline',
      );

      if (inlineAnnotations.length > 0 && plainText.length > 0) {
        const recoverResults = batchRecoverOffsets(plainText, inlineAnnotations);
        for (const r of recoverResults) {
          const ann = inlineAnnotations.find((a) => a.uuid === r.uuid);
          if (!ann) continue;

          const offsetChanged = r.startOffset !== ann.startOffset || r.endOffset !== ann.endOffset;
          if (offsetChanged) {
            const { contextBefore, contextAfter } = extractContextFromContent(
              plainText,
              r.startOffset,
              ann.text,
              this.plugin.settings.contextWindowSize,
            );
            await annotationStore.updateAnnotation(r.uuid, {
              startOffset: r.startOffset,
              endOffset: r.endOffset,
              contextBefore,
              contextAfter,
            });
            inlineRecovered++;
          }
        }
        failed += inlineAnnotations.length - recoverResults.length;
      }

      // 3. block / span 目标位置恢复
      const blockSpanAnnotations = (await annotationStore.getAnnotationsForFile(filePath)).filter(
        (a) => a.kind === 'block' || a.kind === 'span',
      );

      if (blockSpanAnnotations.length > 0) {
        const lines = content.split('\n');
        const anchors = parseBlockAnchors(content);
        const anchorByUuid = new Map(anchors.map((a) => [a.uuid, a]));
        const doubleRanges = new Map<string, ReturnType<typeof findBlockDoubleAnchorRange>>();
        for (const ann of blockSpanAnnotations) {
          if (ann.kind !== 'block') continue;
          const range = findBlockDoubleAnchorRange(content, ann.uuid);
          if (range) doubleRanges.set(ann.uuid, range);
        }

        for (const ann of blockSpanAnnotations) {
          const anchor = anchorByUuid.get(ann.uuid);
          const doubleRange = doubleRanges.get(ann.uuid);

          if (!anchor && !doubleRange) {
            // Markdown 中已找不到该锚点，无法自动恢复
            failedDetails.push({ uuid: ann.uuid, reason: 'anchor_missing' });
            failed++;
            continue;
          }

          if (ann.kind === 'block') {
            // 优先使用新的双锚点范围进行精确恢复
            if (doubleRange) {
              const changed =
                doubleRange.targetLine !== ann.targetLine ||
                doubleRange.anchorLine !== ann.anchorLine ||
                doubleRange.startLine !== ann.startLine ||
                doubleRange.endLine !== ann.endLine ||
                doubleRange.text !== ann.text;
              if (changed) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: doubleRange.targetLine,
                  anchorLine: doubleRange.anchorLine,
                  startLine: doubleRange.startLine,
                  endLine: doubleRange.endLine,
                  text: doubleRange.text,
                  blockType: ann.blockType || detectBlockTypeAtLine(lines, doubleRange.targetLine),
                  targetHash: computeBlockSignature(lines, doubleRange.targetLine, ann.blockType) || computeSignature(doubleRange.text),
                });
                blocksRecovered++;
              }
              continue;
            }

            // 旧单锚点恢复逻辑
            const preferredLine = ann.targetLine ?? anchor!.anchorLine + 1;
            const currentSig = computeBlockSignature(lines, preferredLine, ann.blockType);

            if (ann.targetHash && currentSig && currentSig !== ann.targetHash) {
              const foundLine = findBlockLineBySignature(
                lines,
                ann.blockType || 'paragraph',
                ann.targetHash,
                preferredLine,
              );
              if (foundLine !== null) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: foundLine,
                  anchorLine: anchor!.anchorLine,
                  blockType: ann.blockType || detectBlockTypeAtLine(lines, foundLine),
                });
                blocksRecovered++;
              } else {
                failedDetails.push({ uuid: ann.uuid, reason: 'block_fingerprint_search_failed' });
                failed++;              }
            } else {
              // 指纹一致或没有指纹，仅同步 anchorLine
              if (anchor!.anchorLine !== ann.anchorLine) {
                await annotationStore.updateAnnotation(ann.uuid, { anchorLine: anchor!.anchorLine });
              }
            }
          } else if (ann.kind === 'span') {
            // 跳过锚点行、空行、特殊围栏，找到 span 实际内容起始行
            let actualTargetLine = anchor!.anchorLine + 1;
            for (let i = actualTargetLine; i < lines.length; i++) {
              const trimmed = lines[i].trim();
              if (
                trimmed.startsWith('%%markvault') ||
                trimmed === '$$' ||
                trimmed === '$$$' ||
                trimmed.startsWith('```') ||
                trimmed === ''
              ) {
                actualTargetLine = i + 1;
                continue;
              }
              actualTargetLine = i;
              break;
            }

            if (actualTargetLine < lines.length) {
              const endLine = findSpanEndLine(lines, actualTargetLine);
              const fullSpanText = lines.slice(actualTargetLine, endLine + 1).join('\n');
              const currentSig = computeSpanSignature(fullSpanText);

              // 如果指纹不匹配，在附近搜索
              if (ann.targetHash && currentSig && currentSig !== ann.targetHash) {
                const foundLine = findSpanLineBySignature(
                  lines,
                  ann.targetHash,
                  actualTargetLine,
                );
                if (foundLine !== null) {
                  actualTargetLine = foundLine;
                } else {
                  failedDetails.push({ uuid: ann.uuid, reason: 'span_fingerprint_search_failed' });
                  failed++;
                  continue;
                }
              }

              const newSpanRanges = computeSpanRanges(content, actualTargetLine, fullSpanText);
              const changed =
                actualTargetLine !== ann.targetLine ||
                anchor!.anchorLine !== ann.anchorLine ||
                JSON.stringify(newSpanRanges) !== JSON.stringify(ann.spanRanges);

              if (changed) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: actualTargetLine,
                  anchorLine: anchor!.anchorLine,
                  spanRanges: newSpanRanges,
                });
                spansRecovered++;
              }
            } else {
              failedDetails.push({ uuid: ann.uuid, reason: 'span_target_line_out_of_bounds' });
              failed++;
            }
          }
        }
      }

      // 3.5 region 标注位置恢复
      const regionAnnotations = (await annotationStore.getAnnotationsForFile(filePath)).filter(
        (a) => a.kind === 'region',
      );
      if (regionAnnotations.length > 0) {
        const parsedRegions = parseRegionAnnotations(content, filePath);
        const regionByUuid = new Map(parsedRegions.map((r) => [r.uuid, r]));

        // 🔧 P1-2 修复：检测半残 region（只有 start 或只有 end）
        const regionAnchorMap = new Map<string, { hasStart: boolean; hasEnd: boolean }>();
        const regionAnchorRegex = /%%markvault-region:([^:%]+):[^:%]+:[^:%]+:(start|end):[^%]*%%/g;
        let raMatch: RegExpExecArray | null;
        while ((raMatch = regionAnchorRegex.exec(content)) !== null) {
          const raUuid = raMatch[1];
          const raPos = raMatch[2] as 'start' | 'end';
          const entry = regionAnchorMap.get(raUuid) || { hasStart: false, hasEnd: false };
          if (raPos === 'start') entry.hasStart = true;
          else entry.hasEnd = true;
          regionAnchorMap.set(raUuid, entry);
        }

        for (const ann of regionAnnotations) {
          const parsed = regionByUuid.get(ann.uuid);
          if (!parsed) {
            // 检查是否半残
            const anchorState = regionAnchorMap.get(ann.uuid);
            if (anchorState && (anchorState.hasStart || anchorState.hasEnd)) {
              failedDetails.push({ uuid: ann.uuid, reason: 'region_anchor_pair_incomplete' });
            } else {
              failedDetails.push({ uuid: ann.uuid, reason: 'region_anchor_missing' });
            }
            failed++;
            continue;
          }

          const newEndLine = content.substring(0, parsed.endOffset).split('\n').length - 1;
          const changed =
            parsed.startOffset !== ann.startOffset ||
            parsed.endOffset !== ann.endOffset ||
            parsed.text !== ann.text;

          if (changed) {
            await annotationStore.updateAnnotation(ann.uuid, {
              startOffset: parsed.startOffset,
              endOffset: parsed.endOffset,
              startLine: parsed.startLine,
              endLine: newEndLine,
              text: parsed.text,
              targetHash: computeSpanSignature(parsed.text),
            });
          }
        }
      }

      // 4. 刷新缓存与 UI
      this.markFileSynced(filePath);
      await this.plugin.updateSpanCache(filePath);
      await this.plugin.updateRegionCache(filePath);
      this.scheduleSidebarRefresh();

      // P0-1 修复：恢复失败时发送通知并标记标注状态
      if (failedDetails.length > 0) {
        for (const detail of failedDetails) {
          try {
            const ann = await getAnnotationByUuid(detail.uuid);
            if (ann) {
              await annotationStore.updateAnnotation(detail.uuid, {
                flags: { ...ann.flags, needsCorrection: true },
              });
            }
          } catch (err) {
            // 标注可能已被删除 — 记录日志但不应阻塞其他标注的恢复
            logger.warn(`failed to mark needsCorrection for ${detail.uuid}`, err);
          }
        }
        new Notice(`⚠️ ${failedDetails.length} 个标注恢复失败，已标记为需修正`, 5000);
      }
      if (inlineRecovered + blocksRecovered + spansRecovered > 0) {
        new Notice(`✅ 已恢复 ${inlineRecovered + blocksRecovered + spansRecovered} 个标注位置`, 3000);
      }
    } finally {
      this.plugin.modifyGuard.release(filePath);
    }

    return { added, updated, inlineRecovered, blocksRecovered, spansRecovered, failed };
  }

  // ─── 事件处理器注册 ─────────────────────────────

  /**
   * 注册文件删除事件处理器
   * 应在 plugin.onload() 中调用：this.registerEvent(this.app.vault.on('delete', syncEngine.handleFileDelete))
   */
  handleFileDelete = async (file: any): Promise<void> => {
    if (!(file instanceof TFile) || file.extension !== 'md') return;

    logger.debug(`MarkVault: file deleted — cleaning up annotations for "${file.path}"`);
    try {
      // 如果当前活跃文件是被删除文件，清空引用
      if (this.plugin.activeFilePath === file.path) {
        this.plugin.activeFilePath = null;
      }

      // 关闭该文件上所有打开的 AnnotationModal
      this.plugin.activeState.closeActiveModalsForFile(file.path);

      // 清理该文件的活跃标注保护状态
      const activeUuids = Array.from(this.plugin.activeState.activeUuids);
      for (const uuid of activeUuids) {
        if (this.plugin.activeState.uuidToFilePath.get(uuid) === file.path) {
          this.plugin.activeState.unmarkAnnotationActive(uuid, file.path);
        }
      }

      const deletedCount = await annotationStore.deleteAnnotationsForFile(file.path);
      clearSpanCacheForFile(file.path);
      await this.plugin.refreshSidebar();

      if (deletedCount > 0) {
        new Notice(`Cleaned up ${deletedCount} annotations for deleted file`, 4000);
      }
      logger.debug(`MarkVault: annotations cleaned up for deleted file "${file.path}" (${deletedCount})`);
    } catch (err) {
      console.error('MarkVault: failed to clean up annotations for deleted file', file.path, err);
      new Notice('Failed to clean up annotations for deleted file', 5000);
    }
  };

  /**
   * 注册文件重命名事件处理器
   */
  handleFileRename = async (file: any, oldPath: string): Promise<void> => {
    if (!(file instanceof TFile) || file.extension !== 'md') return;

    logger.debug(`MarkVault: file renamed "${oldPath}" → "${file.path}"`);
    try {
      // 关闭旧文件上打开的 Modal，避免保存时路径错误
      this.plugin.activeState.closeActiveModalsForFile(oldPath);

      await annotationStore.renameAnnotationsForFile(oldPath, file.path);

      // 如果当前活跃文件就是被重命名的文件，更新 activeFilePath
      if (this.plugin.activeFilePath === oldPath) {
        this.plugin.activeFilePath = file.path;
      }

      // 🔧 审计修复：更新活跃标注的 uuid→filePath 映射
      for (const [uuid, fp] of this.plugin.activeState.uuidToFilePath) {
        if (fp === oldPath) {
          this.plugin.activeState.uuidToFilePath.set(uuid, file.path);
        }
      }

      // 🔧 审计修复：更新 activeFilePaths，防止 Modal 编辑保护失效
      if (this.plugin.activeState.activeFilePaths.has(oldPath)) {
        this.plugin.activeState.activeFilePaths.delete(oldPath);
        this.plugin.activeState.activeFilePaths.add(file.path);
      }

      // 🔧 审计修复：更新 _syncCooldown 中的冷却条目
      const cooldownTime = this._syncCooldown.get(oldPath);
      if (cooldownTime !== undefined) {
        this._syncCooldown.delete(oldPath);
        this._syncCooldown.set(file.path, cooldownTime);
      }

      await this.plugin.refreshSidebar();
      new Notice(`Annotations migrated for renamed file`, 4000);
      logger.debug(`MarkVault: annotations migrated for renamed file`);
    } catch (err) {
      console.error('MarkVault: failed to migrate annotations for renamed file', oldPath, '→', file.path, err);
    }
  };

  /**
   * 注册 active-leaf-change 事件处理器
   */
  handleActiveLeafChange = async (): Promise<void> => {
    // 🔧 BUG-5.1 修复：注入当前活跃的 EditorView，用于 region 缓存更新后强制 layer 重绘
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      // Obsidian 的 Editor 对象可能包含 CM6 EditorView
      const cmView = (activeView.editor as any).cm as import('@codemirror/view').EditorView | undefined;
      setActiveEditorView(cmView || null);
    } else {
      setActiveEditorView(null);
    }

    const file = this.plugin.app.workspace.getActiveFile();
    if (file instanceof TFile && file.extension === 'md') {
      // 文件真正切换时由 file-open 处理；这里主要处理同文件不同视图切换
      if (this.plugin.activeFilePath === file.path) {
        try {
          await annotationStore.ensureFileLoaded(file.path);
          await this.plugin.updateSpanCache(file.path);
          await this.plugin.updateRegionCache(file.path);
          requestRegionLayerRedraw();
          this.scheduleSidebarRefresh();
        } catch (err) {
          console.error('MarkVault: active-leaf-change cache refresh failed', err);
        }
      }
    }
  };
}
