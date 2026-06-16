/**
 * AnnotationCacheManager — 管理 span/block/region 标注缓存
 *
 * 从 DB 加载标注数据到 highlight-applier 的内存缓存，
 * 供 CM6 decoration plugin 使用。所有缓存方法都是幂等的。
 */

import { MarkdownView, type App } from 'obsidian';
import type { Annotation } from '../types/annotation';
import { annotationStore } from '../db/annotation-store';
import {
  updateSpanCacheForFile,
  clearSpanCacheForFile,
  type SpanAnnotationData,
  updateRegionCacheForFile,
  clearRegionCacheForFile,
  type RegionAnnotationData,
  getRegionCacheForFile,
  updateBlockCacheForFile,
  clearBlockCacheForFile,
  type BlockAnnotationData,
  getBlockCacheForFile,
  requestRegionLayerRedraw,
} from '../core/highlight-applier';

export class AnnotationCacheManager {
  constructor(private app: App) {}

  /**
   * 更新 span / block 标注缓存（供 CM6 装饰器使用）
   * 从 DB 加载指定文件的 span/block 标注数据到缓存
   */
  async updateSpanCache(filePath: string): Promise<void> {
    try {
      const annotations = await annotationStore.getAnnotationsForFile(filePath);

      const spanAnnotations = annotations.filter(a => a.kind === 'span' && a.spanRanges && a.spanRanges.length > 0);
      const spanData: SpanAnnotationData[] = spanAnnotations.map(a => ({
        uuid: a.uuid,
        type: a.type,
        color: a.color,
        anchorLine: a.anchorLine ?? a.startLine,
        spanRanges: a.spanRanges!,
        note: a.note,
      }));
      updateSpanCacheForFile(filePath, spanData);

      const blockAnnotations = annotations.filter(a => a.kind === 'block' && a.targetLine !== undefined);
      const blockData: BlockAnnotationData[] = blockAnnotations.map(a => ({
        uuid: a.uuid,
        type: a.type,
        color: a.color,
        targetLine: a.targetLine ?? a.startLine,
        note: a.note,
      }));
      updateBlockCacheForFile(filePath, blockData);
    } catch (err) {
      console.error('MarkVault: updateSpanCache error', err);
    }
  }

  /**
   * 更新 region 标注缓存（供 CM6 layer 使用）
   * 🔧 BUG-5.1 修复：缓存更新后强制 CM6 layer 重绘，解决异步缓存竞态
   */
  async updateRegionCache(filePath: string): Promise<void> {
    try {
      const annotations = await annotationStore.getAnnotationsForFile(filePath);
      const regionAnnotations = annotations.filter(a => a.kind === 'region');
      const regionData: RegionAnnotationData[] = regionAnnotations.map(a => ({
        uuid: a.uuid,
        type: a.type,
        color: a.color,
        startOffset: a.startOffset,
        endOffset: a.endOffset,
        note: a.note,
      }));
      updateRegionCacheForFile(filePath, regionData);
      // 缓存已更新，通知 CM6 region layer 重新渲染
      requestRegionLayerRedraw();
    } catch (err) {
      console.error('MarkVault: updateRegionCache error', err);
    }
  }

  /**
   * 🔧 BUG-5.1 修复：立即同步更新 region 缓存（预填充）
   *
   * 在 editor.replaceSelection() 之前调用，确保 CM6 layer 首次渲染时
   * 就能看到新创建的 region 标注数据，避免异步缓存竞态导致 layer 为空。
   */
  updateRegionCacheImmediately(filePath: string, newAnnotation: Annotation): void {
    try {
      // 读取当前缓存
      const existingData = getRegionCacheForFile(filePath);
      const newData: RegionAnnotationData[] = [
        ...existingData,
        {
          uuid: newAnnotation.uuid,
          type: newAnnotation.type,
          color: newAnnotation.color,
          startOffset: newAnnotation.startOffset,
          endOffset: newAnnotation.endOffset,
          note: newAnnotation.note,
        },
      ];
      updateRegionCacheForFile(filePath, newData);
      // 预填充后也通知 CM6 重绘
      requestRegionLayerRedraw();
    } catch (err) {
      // 预填充失败不影响主流程，updateRegionCache 会随后修正
      console.warn('MarkVault: updateRegionCacheImmediately failed (will be corrected by updateRegionCache)', err);
    }
  }

  /**
   * 🔧 BUG-5.3 修复：立即同步更新 block 缓存（预填充）
   */
  updateBlockCacheImmediately(filePath: string, newAnnotation: Annotation): void {
    try {
      // 读取当前缓存
      const existingData = getBlockCacheForFile(filePath);
      const newData: BlockAnnotationData[] = [
        ...existingData,
        {
          uuid: newAnnotation.uuid,
          type: newAnnotation.type,
          color: newAnnotation.color,
          targetLine: newAnnotation.targetLine ?? newAnnotation.startLine,
          note: newAnnotation.note,
        },
      ];
      updateBlockCacheForFile(filePath, newData);
      // 预填充后通知 CM6 重绘（decoration plugin 也会读 block 缓存）
      requestRegionLayerRedraw();
    } catch (err) {
      // 预填充失败不影响主流程，updateSpanCache 会随后修正
      console.warn('MarkVault: updateBlockCacheImmediately failed (will be corrected by updateSpanCache)', err);
    }
  }

  /**
   * 在编辑模式下选中 region 的内容范围，触发 Obsidian 原生选区（外部选框）。
   */
  selectRegionInEditor(annotation: Annotation): boolean {
    if (annotation.kind !== 'region') return false;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file || view.file.path !== annotation.filePath) return false;
    if (view.getMode() === 'preview') return false;

    const editor = view.editor;
    const content = editor.getValue();

    const startRegex = new RegExp(`%%markvault-region:${annotation.uuid}:([^:%]+):([^:%]+):start:[^%]*%%`);
    const endRegex = new RegExp(`%%markvault-region:${annotation.uuid}:([^:%]+):([^:%]+):end:[^%]*%%`);

    const startMatch = content.match(startRegex);
    const endMatch = content.match(endRegex);
    if (!startMatch || !endMatch) return false;

    const startOffset = startMatch.index! + startMatch[0].length;
    const endOffset = endMatch.index!;
    if (startOffset >= endOffset) return false;

    try {
      const from = editor.offsetToPos(startOffset);
      const to = editor.offsetToPos(endOffset);
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
      return true;
    } catch (err) {
      console.error('MarkVault: selectRegionInEditor error', err);
      return false;
    }
  }
}
