/**
 * 增量偏移修正引擎
 *
 * 监听 CodeMirror 6 的 Transaction 变更，
 * 精确计算文本编辑对标注偏移量的影响，
 * 增量更新 IndexedDB 中受影响标注的 startOffset/endOffset。
 *
 * 设计要点：
 * - 使用 CM6 Transaction.changes 而非 Obsidian 的 editor-change 事件
 * - CM6 Transaction 提供精确的变更描述
 * - 只修正变更位置之后的标注（delta 方式）
 * - 处理标注被部分删除的情况
 */

import {
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
  type PluginValue,
} from '@codemirror/view';
import type { Text } from '@codemirror/state';
import type { Annotation, SpanRange } from '../types/annotation';
import { db } from '../db/database';

/**
 * Change 信息：一次编辑操作对文档的影响
 */
export interface ChangeInfo {
  /** 变更起始位置（原文档中的偏移） */
  fromA: number;
  /** 变更结束位置（原文档中的偏移） */
  toA: number;
  /** 插入的文本长度 */
  insertedLen: number;
  /** 删除的文本长度 */
  deletedLen: number;
  /** 净增减字符数 */
  delta: number;
}

/**
 * 从 CM6 ViewUpdate 中提取所有变更信息
 */
export function extractChangesFromUpdate(update: ViewUpdate): ChangeInfo[] {
  const changes: ChangeInfo[] = [];

  try {
    update.changes.iterChanges(
      (fromA: number, toA: number, _fromB: number, _toB: number, inserted: Text) => {
        const deletedLen = toA - fromA;
        const insertedLen = inserted.length;
        changes.push({
          fromA,
          toA,
          insertedLen,
          deletedLen,
          delta: insertedLen - deletedLen,
        });
      },
    );
  } catch (err) {
    console.error('MarkVault: extractChangesFromUpdate error', err);
  }

  return changes;
}

/**
 * 对一组变更应用增量偏移修正到 IndexedDB
 */
export async function applyIncrementalOffsetFix(
  filePath: string,
  changes: ChangeInfo[],
  allAnnotations: Annotation[],
): Promise<{
  updated: number;
  deleted: number;
}> {
  if (changes.length === 0 || allAnnotations.length === 0) return { updated: 0, deleted: 0 };

  // 按 fromA 从大到小排序（从后往前处理，避免后续偏移干扰前面的计算）
  const sortedChanges = [...changes].sort((a, b) => b.fromA - a.fromA);

  const toUpdate: Array<{ uuid: string; startOffset: number; endOffset: number; spanRanges?: SpanRange[] }> = [];
  const toDelete: string[] = [];

  for (const change of sortedChanges) {
    if (change.delta === 0) continue; // 等长替换，偏移不变

    for (const ann of allAnnotations) {
      // ── Span 标注：修正 spanRanges + 锚点偏移 ──
      if (ann.kind === 'span' && ann.spanRanges && ann.spanRanges.length > 0) {
        // 先检查锚点是否被删除：锚点偏移在变更范围内
        // span 的 startOffset === endOffset === 锚点偏移
        const anchorOffset = ann.startOffset;
        if (change.deletedLen > 0 && anchorOffset >= change.fromA && anchorOffset < change.toA) {
          // 锚点行被删除 → 整个 span 标注应被删除
          toDelete.push(ann.uuid);
          continue;
        }

        let rangesModified = false;
        let allDeleted = true;
        const newRanges: SpanRange[] = [];

        for (const range of ann.spanRanges) {
          // 范围完全在变更之后 → 平移
          if (range.from >= change.toA) {
            newRanges.push({ from: range.from + change.delta, to: range.to + change.delta });
            rangesModified = true;
            allDeleted = false;
            continue;
          }

          // 范围完全在变更之前 → 不受影响
          if (range.to <= change.fromA) {
            newRanges.push({ ...range });
            allDeleted = false;
            continue;
          }

          // 范围与变更重叠
          const overlapStart = Math.max(range.from, change.fromA);
          const overlapEnd = Math.min(range.to, change.toA);
          const overlapLen = overlapEnd - overlapStart;
          const rangeLen = range.to - range.from;

          if (change.deletedLen > 0 && overlapLen > rangeLen * 0.5) {
            // 删除了超过 50% 的范围 → 移除此 range
            rangesModified = true;
            continue;
          }

          // 部分重叠 → 保留并调整
          let newFrom = range.from;
          let newTo = range.to;

          if (range.from >= change.fromA) {
            newFrom = change.fromA + change.insertedLen + (range.from - change.toA);
            newTo = change.fromA + change.insertedLen + (range.to - change.toA);
          } else if (range.to >= change.fromA) {
            newTo = range.to + change.delta;
          }

          if (newTo > newFrom && newFrom >= 0) {
            newRanges.push({ from: newFrom, to: newTo });
            allDeleted = false;
          }
          rangesModified = true;
        }

        if (allDeleted) {
          toDelete.push(ann.uuid);
        } else if (rangesModified) {
          // 修正锚点偏移（startOffset/endOffset 都指向锚点位置）
          let newAnchorOffset = ann.startOffset;
          if (ann.startOffset >= change.toA) {
            newAnchorOffset = ann.startOffset + change.delta;
          }
          // 注意：变更在锚点之前、spanRanges 之后的情况不需要特殊处理
          // 因为 spanRanges 已经独立修正了

          toUpdate.push({
            uuid: ann.uuid,
            startOffset: newAnchorOffset,
            endOffset: newAnchorOffset,
            spanRanges: newRanges,
          });
          // 更新内存中的值
          ann.spanRanges = newRanges;
          ann.startOffset = newAnchorOffset;
          ann.endOffset = newAnchorOffset;
        }

        continue; // span 标注已处理，跳过 inline 逻辑
      }

      // ── Inline/Block 标注：原有的偏移修正逻辑 ──

      // 情况 1: 标注完全在变更之前 → 不受影响
      if (ann.endOffset <= change.fromA) continue;

      // 情况 2: 标注完全在变更之后 → 偏移修正
      if (ann.startOffset >= change.toA) {
        toUpdate.push({
          uuid: ann.uuid,
          startOffset: ann.startOffset + change.delta,
          endOffset: ann.endOffset + change.delta,
        });
        // 更新内存中的值，防止后续 change 重复修正
        ann.startOffset += change.delta;
        ann.endOffset += change.delta;
        continue;
      }

      // 情况 3: 变更与标注重叠
      const overlapStart = Math.max(ann.startOffset, change.fromA);
      const overlapEnd = Math.min(ann.endOffset, change.toA);
      const overlapLen = overlapEnd - overlapStart;
      const annotationLen = ann.endOffset - ann.startOffset;

      // 变更删除了标注的大部分内容（>50%）→ 删除标注
      if (change.deletedLen > 0 && overlapLen > annotationLen * 0.5) {
        toDelete.push(ann.uuid);
        continue;
      }

      // 部分重叠 — 保留标注，调整偏移
      let newStart = ann.startOffset;
      let newEnd = ann.endOffset;

      if (ann.startOffset >= change.fromA) {
        newStart = change.fromA + change.insertedLen + (ann.startOffset - change.toA);
        newEnd = change.fromA + change.insertedLen + (ann.endOffset - change.toA);
      } else {
        newEnd = ann.endOffset + change.delta;
      }

      if (newStart >= 0 && newEnd > newStart) {
        toUpdate.push({
          uuid: ann.uuid,
          startOffset: newStart,
          endOffset: newEnd,
        });
        ann.startOffset = newStart;
        ann.endOffset = newEnd;
      } else {
        toDelete.push(ann.uuid);
      }
    }
  }

  // 批量执行数据库更新
  let updatedCount = 0;
  let deletedCount = 0;

  try {
    if (toDelete.length > 0 || toUpdate.length > 0) {
      await db.transaction('rw', db.annotations, async () => {
        for (const uuid of toDelete) {
          await db.annotations.where('uuid').equals(uuid).delete();
          deletedCount++;
        }

        for (const u of toUpdate) {
          const updates: Partial<Annotation> & { updatedAt: number } = {
            startOffset: u.startOffset,
            endOffset: u.endOffset,
            updatedAt: Date.now(),
          };
          if (u.spanRanges) {
            updates.spanRanges = u.spanRanges;
          }
          await db.annotations.where('uuid').equals(u.uuid).modify(updates as any);
          updatedCount++;
        }
      });
    }
  } catch (err) {
    console.error('MarkVault: applyIncrementalOffsetFix DB error', err);
  }

  return { updated: updatedCount, deleted: deletedCount };
}

/**
 * 检测 <mark> 标签是否被手动破坏
 */
export function detectBrokenMarkTags(
  docContent: string,
  annotations: Annotation[],
): string[] {
  const brokenUuids: string[] = [];

  const validUuids = new Set<string>();
  const MARK_FULL = /<mark\s+[^>]*data-uuid="([^"]*)"[^>]*>([\s\S]*?)<\/mark>/g;
  let match: RegExpExecArray | null;
  while ((match = MARK_FULL.exec(docContent)) !== null) {
    validUuids.add(match[1]);
  }

  for (const ann of annotations) {
    if (!validUuids.has(ann.uuid)) {
      brokenUuids.push(ann.uuid);
    }
  }

  return brokenUuids;
}

// ─── CM6 Extension ───────────────────────────────────────

/**
 * 创建偏移追踪的 CM6 Extension
 *
 * 这是一个轻量 ViewPlugin，不渲染任何 decoration，
 * 只监听文档变更，调用回调函数处理偏移修正。
 */
export function createOffsetTrackerExtension(
  onDocChanged: (changes: ChangeInfo[]) => void,
) {
  return ViewPlugin.fromClass(
    class OffsetTrackerPlugin implements PluginValue {
      // 注意：这个 plugin 不需要 decorations 属性
      // 但 CM6 ViewPlugin 接口可能需要它，用空 set
      get decorations(): DecorationSet {
        return Decoration.none;
      }

      constructor() {}

      update(update: ViewUpdate) {
        if (update.docChanged) {
          try {
            const changes = extractChangesFromUpdate(update);
            if (changes.length > 0) {
              onDocChanged(changes);
            }
          } catch (err) {
            console.error('MarkVault: OffsetTracker update error', err);
          }
        }
      }

      destroy() {}
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
