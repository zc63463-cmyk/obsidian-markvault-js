/**
 * orphan-detector.ts — 孤儿标注检测引擎
 *
 * Phase C-3: 检测 DB 中存在但 Markdown 中已丢失的标注（孤儿标注）。
 * 与 cleanOrphanAnnotations 不同，此模块只检测不删除，供 UI 层展示和逐条确认。
 *
 * 三类孤立原因：
 * - file_deleted: 标注所属文件已被删除
 * - anchor_missing: 文件存在但 MD 中找不到对应的锚点/标签
 * - content_changed: 锚点存在但目标内容指纹不匹配（锚点漂移）
 */

import type { App, TFile } from 'obsidian';
import type { AnnotationStore } from './annotation-store';
import { parseAllAnnotationsFromMarkdown } from '../core/annotation-parser';
import {
  computeBlockSignature,
  computeSpanSignature,
  computeSignature,
  findBlockLineBySignature,
  findSpanLineBySignature,
  detectBlockTypeAtLine,
} from '../core/block-fingerprint';

/** 孤儿标注信息 */
export interface OrphanInfo {
  uuid: string;
  filePath: string;
  reason: 'file_deleted' | 'anchor_missing' | 'content_changed';
  text: string;           // DB 中的标注文本（用于预览）
  detectedAt: number;     // 检测时间戳
  recoverable: boolean;   // 是否可通过 targetHash 恢复
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
          recoverable: false,
        });
      }
      continue;
    }

    // 原因 2 & 3: 文件存在但 MD 中找不到对应 UUID / 或锚点存在但内容漂移
    try {
      const content = await app.vault.read(file as TFile);
      const lines = content.split('\n');
      const mdAnnotations = parseAllAnnotationsFromMarkdown(content, filePath);
      const mdUuids = new Set(mdAnnotations.map(a => a.uuid));

      for (const ann of annotations) {
        if (!mdUuids.has(ann.uuid)) {
          // 锚点在 MD 中完全缺失 → 尝试 targetHash 恢复判断
          const recoverable = canRecoverByHash(ann, lines);
          orphans.push({
            uuid: ann.uuid,
            filePath,
            reason: 'anchor_missing',
            text: ann.text,
            detectedAt: now,
            recoverable,
          });
        } else {
          // 锚点存在，检查 targetHash 是否匹配（内容漂移检测）
          if (ann.targetHash && (ann.kind === 'block' || ann.kind === 'span')) {
            const currentSig = computeCurrentSignature(ann, lines);
            if (currentSig && currentSig !== ann.targetHash) {
              // 指纹不匹配 → 内容已变更，但锚点仍在
              // 检查是否能在附近找到匹配（可恢复）
              const foundLine = findMatchByHash(ann, lines);
              orphans.push({
                uuid: ann.uuid,
                filePath,
                reason: 'content_changed',
                text: ann.text,
                detectedAt: now,
                recoverable: foundLine !== null,
              });
            }
          }
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
          recoverable: false,
        });
      }
    }
  }

  return orphans;
}

/**
 * 判断标注是否可通过 targetHash 在当前文档中恢复位置
 */
function canRecoverByHash(ann: typeof ann extends infer T ? T : never, lines: string[]): boolean {
  if (!ann.targetHash) return false;
  if (ann.kind !== 'block' && ann.kind !== 'span') return false;

  return findMatchByHash(ann, lines) !== null;
}

/**
 * 在文档中搜索 targetHash 匹配的行
 */
function findMatchByHash(
  ann: { kind: string; targetHash: string; targetLine?: number; anchorLine?: number; blockType?: string },
  lines: string[],
): number | null {
  const preferredLine = ann.targetLine ?? ann.anchorLine ?? 0;

  if (ann.kind === 'block') {
    return findBlockLineBySignature(
      lines,
      ann.blockType || 'paragraph',
      ann.targetHash,
      preferredLine,
    );
  } else if (ann.kind === 'span') {
    return findSpanLineBySignature(
      lines,
      ann.targetHash,
      preferredLine,
    );
  }

  return null;
}

/**
 * 计算标注在当前文档中对应位置的签名
 */
function computeCurrentSignature(
  ann: { kind: string; targetLine?: number; anchorLine?: number; blockType?: string; text?: string },
  lines: string[],
): string | null {
  const preferredLine = ann.targetLine ?? ann.anchorLine ?? 0;

  if (ann.kind === 'block') {
    return computeBlockSignature(lines, preferredLine, ann.blockType) || null;
  } else if (ann.kind === 'span') {
    if (preferredLine >= 0 && preferredLine < lines.length) {
      return computeSpanSignature(lines[preferredLine]) || null;
    }
  }

  return null;
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
