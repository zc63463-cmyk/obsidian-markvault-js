/**
 * orphan-detector.ts — 孤儿标注检测引擎
 *
 * Phase C-3: 检测 DB 中存在但 Markdown 中已丢失的标注（孤儿标注）。
 * 与 cleanOrphanAnnotations 不同，此模块只检测不删除，供 UI 层展示和逐条确认。
 *
 * 三类孤立原因：
 * - file_deleted: 标注所属文件已被删除
 * - anchor_missing: 文件存在但 MD 中找不到对应的锚点/标签
 */

import type { App, TFile } from 'obsidian';
import type { AnnotationStore } from './annotation-store';
import { parseAllAnnotationsFromMarkdown } from '../core/annotation-parser';

/** 孤儿标注信息 */
export interface OrphanInfo {
  uuid: string;
  filePath: string;
  reason: 'file_deleted' | 'anchor_missing';
  text: string;           // DB 中的标注文本（用于预览）
  detectedAt: number;     // 检测时间戳
}

/**
 * 检测所有孤儿标注（不执行删除）
 *
 * @param app Obsidian App 实例
 * @param store AnnotationStore 实例
 * @returns OrphanInfo[] 孤儿标注列表
 */
export async function detectOrphans(app: App, store: AnnotationStore): Promise<OrphanInfo[]> {
  const allAnnotations = store.getAllAnnotations();
  if (allAnnotations.length === 0) return [];

  const now = Date.now();
  const orphans: OrphanInfo[] = [];

  // 按文件分组，减少 vault.read 调用
  const byFile = new Map<string, typeof allAnnotations>();
  for (const ann of allAnnotations) {
    let list = byFile.get(ann.filePath);
    if (!list) {
      list = [];
      byFile.set(ann.filePath, list);
    }
    list.push(ann);
  }

  for (const [filePath, annotations] of byFile) {
    const file = app.vault.getAbstractFileByPath(filePath);

    // 原因 1: 文件不存在或不是 md 文件
    if (!file || !('extension' in file) || (file as TFile).extension !== 'md') {
      for (const ann of annotations) {
        orphans.push({
          uuid: ann.uuid,
          filePath,
          reason: 'file_deleted',
          text: ann.text,
          detectedAt: now,
        });
      }
      continue;
    }

    // 原因 2: 文件存在但 MD 中找不到对应 UUID
    try {
      const content = await app.vault.read(file as TFile);
      const mdAnnotations = parseAllAnnotationsFromMarkdown(content, filePath);
      const mdUuids = new Set(mdAnnotations.map(a => a.uuid));

      for (const ann of annotations) {
        if (!mdUuids.has(ann.uuid)) {
          orphans.push({
            uuid: ann.uuid,
            filePath,
            reason: 'anchor_missing',
            text: ann.text,
            detectedAt: now,
          });
        }
      }
    } catch (err) {
      // vault.read 失败时，该文件所有标注标记为 anchor_missing
      console.warn(`MarkVault orphan detector: failed to read "${filePath}"`, err);
      for (const ann of annotations) {
        orphans.push({
          uuid: ann.uuid,
          filePath,
          reason: 'anchor_missing',
          text: ann.text,
          detectedAt: now,
        });
      }
    }
  }

  return orphans;
}

/**
 * 删除指定孤儿标注
 *
 * @param uuids 要删除的 UUID 列表
 * @param store AnnotationStore 实例
 * @returns 实际删除的数量
 */
export async function deleteOrphans(uuids: string[], store: AnnotationStore): Promise<number> {
  let deleted = 0;
  for (const uuid of uuids) {
    try {
      await store.deleteAnnotation(uuid);
      deleted++;
    } catch (err) {
      console.error(`MarkVault: failed to delete orphan ${uuid}`, err);
    }
  }
  return deleted;
}
