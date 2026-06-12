import type { Annotation, RecoveryResult } from '../types/annotation';

/**
 * 4 层偏移恢复引擎
 * 移植自 note-vault annotationHighlight.ts recoverOffsets
 * 数据源从 DOM Range 换成 Obsidian editor.getValue() 纯文本
 *
 * 策略优先级：
 * 1. Full context match (contextBefore + text + contextAfter)
 * 2. Left-anchored (contextBefore + text)
 * 3. Right-anchored (text + contextAfter)
 * 4. Pure text match
 */
export function recoverOffsets(
  fullText: string,
  annotation: Annotation,
): RecoveryResult | null {
  const { text, contextBefore, contextAfter, startOffset: origStart } = annotation;
  if (!text) return null;

  // Strategy 1: Full context match
  if (contextBefore && contextAfter) {
    const needle = contextBefore + text + contextAfter;
    const idx = fullText.indexOf(needle);
    if (idx !== -1) {
      return {
        startOffset: idx + contextBefore.length,
        endOffset: idx + contextBefore.length + text.length,
        drifted: false,
      };
    }
  }

  // Strategy 2: Left-anchored (contextBefore + text)
  if (contextBefore) {
    const needle = contextBefore + text;
    const adjustedPreferred = origStart - contextBefore.length;
    const result = findClosestMatch(fullText, needle, Math.max(0, adjustedPreferred));
    if (result) {
      return {
        startOffset: result.startOffset + contextBefore.length,
        endOffset: result.startOffset + contextBefore.length + text.length,
        drifted: true,
      };
    }
  }

  // Strategy 3: Right-anchored (text + contextAfter)
  if (contextAfter) {
    const needle = text + contextAfter;
    const result = findClosestMatch(fullText, needle, origStart);
    if (result) {
      return { ...result, drifted: true };
    }
  }

  // Strategy 4: Pure text match
  const result = findClosestMatch(fullText, text, origStart);
  if (result) return { ...result, drifted: true };

  return null;
}

/**
 * 在全文中查找最接近 preferredOffset 的匹配
 */
function findClosestMatch(
  haystack: string,
  needle: string,
  preferredOffset: number,
): { startOffset: number; endOffset: number } | null {
  if (!needle || needle.length === 0) return null;

  let bestIdx = -1;
  let bestDist = Infinity;
  let searchFrom = 0;

  while (searchFrom <= haystack.length) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;
    const dist = Math.abs(idx - preferredOffset);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
    searchFrom = idx + 1;
  }

  if (bestIdx === -1) return null;
  return { startOffset: bestIdx, endOffset: bestIdx + needle.length };
}

/**
 * 批量恢复文件中所有标注的偏移量
 * 用于文件打开时全量校正
 */
export function batchRecoverOffsets(
  fullText: string,
  annotations: Annotation[],
): Array<{ uuid: string; startOffset: number; endOffset: number; drifted: boolean }> {
  const results: Array<{ uuid: string; startOffset: number; endOffset: number; drifted: boolean }> = [];

  for (const annotation of annotations) {
    const recovery = recoverOffsets(fullText, annotation);
    if (recovery) {
      results.push({
        uuid: annotation.uuid,
        startOffset: recovery.startOffset,
        endOffset: recovery.endOffset,
        drifted: recovery.drifted,
      });
    }
  }

  return results;
}
