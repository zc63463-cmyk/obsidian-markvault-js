import { annotationStore } from '../db/annotation-store';
import type { Annotation } from '../types/annotation';
import { parseAllAnnotationsFromMarkdown, buildMarkTag, removeMarkTag, updateMarkTag, removeBlockAnchor, updateBlockAnchor, removeSpanAnchor, updateSpanAnchor } from './annotation-parser';
import { batchRecoverOffsets } from './offset-recovery';
import { batchUpdateOffsets, getAnnotationsForFile, addAnnotation } from '../db/annotation-repo';

/**
 * Markdown ↔ AnnotationStore 双写同步引擎
 *
 * 策略：
 * - Markdown 是 source of truth（保证可移植性）
 * - AnnotationStore 是查询加速层（支持跨笔记搜索、过滤、统计）
 * - data-uuid 是双向关联的桥梁
 */

/**
 * 同步：从 Markdown 解析标注，与 AnnotationStore 做增量同步
 * 用于文件打开时调用
 *
 * 升级策略：
 * - 对于 Highlightr 格式或纯 <mark> 标签（_needsUpgrade=true），
 *   自动将其转换为 MarkVault 格式（添加 data-uuid 等属性）
 *
 * 🔧 v2.0 关键修复：不再从 DB 删除"MD中没有"的标注
 * 原因：vault.read() 存在竞态条件，切换笔记再切回来时
 * 可能读到旧缓存内容（不含最新 <mark>），导致误删 DB 标注。
 * 新策略：只在 DB 中添加/更新，永远不删除。
 * 标注的删除只由用户操作（Modal删除 / 侧边栏删除）触发，
 * 不由 sync 引擎触发。
 */
export async function syncFromMarkdown(
  content: string,
  filePath: string,
): Promise<{ added: number; removed: number; updated: number; upgraded: number }> {
  const markdownAnnotations = parseAllAnnotationsFromMarkdown(content, filePath);
  console.log(`MarkVault sync: parsed ${markdownAnnotations.length} annotations (incl. block anchors) from markdown for ${filePath}`);
  const dbAnnotations = await getAnnotationsForFile(filePath);
  console.log(`MarkVault sync: found ${dbAnnotations.length} annotations in DB for ${filePath}`);

  const mdUuids = new Set(markdownAnnotations.map(a => a.uuid));
  const dbUuids = new Set(dbAnnotations.map(a => a.uuid));

  console.log(`MarkVault sync: mdUuids=${mdUuids.size}, dbUuids=${dbUuids.size}`);

  let added = 0;
  let removed = 0;
  let updated = 0;
  let upgraded = 0;

  // 1. Markdown 有但 DB 没有 → 添加到 DB
  const toAdd = markdownAnnotations.filter(a => !dbUuids.has(a.uuid));
  if (toAdd.length > 0) {
    // 🔧 P0 修复：fullText 计算移到循环外，避免 O(n×content_size)
    // 🔧 修复：fullText 计算时同时 strip <mark> 标签和 %%markvault%% 锚点行
    // 防止锚点行碎片混入 contextBefore/contextAfter
    const fullText = content
      .replace(/<mark[^>]*>([\s\S]*?)<\/mark>/g, '$1')
      .replace(/%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%\n?/g, '');
    for (const ann of toAdd) {
      const startOffset = computeOffsetInPlainContent(content, ann.startOffset);
      const { contextBefore, contextAfter } = extractContextFromContent(fullText, startOffset, ann.text);

      const annotationToAdd: Annotation = {
        ...ann,
        note: ann.note || '',
        tags: ann.tags || [],
        startOffset,
        contextBefore,
        contextAfter,
        createdAt: ann.createdAt || Date.now(),
        updatedAt: ann.updatedAt || Date.now(),
      };

      await addAnnotation(annotationToAdd);
      added++;
    }
  }

  // 2. DB 有但 Markdown 没有 → 🔧 不再自动删除！
  // 只记录日志，标注的删除只由用户操作触发
  // 这修复了 vault.read() 竞态条件导致的数据丢失问题
  const dbOnlyAnnotations = dbAnnotations.filter(a => !mdUuids.has(a.uuid));
  if (dbOnlyAnnotations.length > 0) {
    console.log(`MarkVault sync: ${dbOnlyAnnotations.length} annotations exist in DB but not in MD — keeping (user deletion only)`);
    // 注：如果用户真的手动从MD中删除了 <mark> 标签，
    // 这些 DB 中的"孤儿"标注会在下次打开文件时被标记为"MD中不存在"，
    // 但我们仍然保留它们，因为无法区分"vault.read竞态"和"用户手动删除"
    // 更安全的做法是保留，让用户通过侧边栏手动清理
  }

    // 3. 两边都有 → 更新 DB 中可能变化的字段 (note, tags, color, type)
  // 策略：以 DB 为准，只有当 Markdown 中的值非空且与 DB 不同时才更新 DB
  // 这样可以防止 sync 覆盖用户在 Modal 中输入的批注
  const toUpdate = markdownAnnotations.filter(a => dbUuids.has(a.uuid));
  if (toUpdate.length > 0) {
    // 🔧 P1 修复：构建 O(1) 查找 Map，避免循环内 O(k) 的 .find()
    const dbMap = new Map(dbAnnotations.map(a => [a.uuid, a]));
    for (const mdAnn of toUpdate) {
      const dbAnn = dbMap.get(mdAnn.uuid);
      if (!dbAnn) continue;

      // 确定需要更新的字段
      const updates: Partial<Annotation> = {};

      // note: DB-first 策略 — 优先保留 DB 中的值
      // - 如果 MD 有值且 DB 不同 → 用户可能在 MD 中手动编辑了，更新 DB
      // - 如果 MD 为空但 DB 有值 → 保留 DB 值（可能是 sync 读到了旧 MD）
      // - 如果 MD 有值且 DB 为空 → 更新 DB
      // 🔧 安全检查：如果 MD note 看起来像另一个标注的锚点格式，拒绝更新
      const mdNote = mdAnn.note || '';
      const dbNote = dbAnn.note || '';
      const looksLikeAnchor = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(highlight|bold|underline):(yellow|green|blue|pink|purple):?$/.test(mdNote.trim());
      if (mdNote !== dbNote) {
        if (looksLikeAnchor) {
          // 拒绝：MD note 字段包含另一个标注的锚点格式数据
          console.warn(`MarkVault sync: refusing to update note for ${mdAnn.uuid} — MD note looks like anchor: "${mdNote}"`);
        } else if (mdNote && !dbNote) {
          // MD 有值，DB 为空 → 更新 DB
          updates.note = mdNote;
        } else if (mdNote && dbNote) {
          // 双方都有值但不同 → 以 MD 为准（用户可能手动编辑了 MD）
          updates.note = mdNote;
        }
        // 如果 MD 为空但 DB 有值 → 不更新，保留 DB 的值
      }

      // tags: 类似逻辑
      const mdTags = mdAnn.tags.join(',');
      const dbTags = dbAnn.tags.join(',');
      if (mdTags !== dbTags) {
        // 以非空的一方为准
        if (mdTags && !dbTags) {
        updates.tags = mdAnn.tags;
      } else if (!mdTags && dbTags) {
        // Markdown 为空，保留 DB 值，不更新
      } else if (mdTags && dbTags) {
        // 双方都有值，以 Markdown 为准（用户可能手动编辑了 md）
        updates.tags = mdAnn.tags;
      }
    }

    // color/type: 以 Markdown 为准（这些通常通过 UI 修改，会同步到 MD）
    if (mdAnn.color !== dbAnn.color) {
      updates.color = mdAnn.color;
    }
    if (mdAnn.type !== dbAnn.type) {
      updates.type = mdAnn.type;
    }

    // targetHash: block/span 的目标内容指纹，从 Markdown 重新计算
    if ((mdAnn.kind === 'block' || mdAnn.kind === 'span') && mdAnn.targetHash && mdAnn.targetHash !== dbAnn.targetHash) {
      updates.targetHash = mdAnn.targetHash;
    }

    // 🆕 Phase 3: fields 同步
    // 仅对 inline 标注同步 fields（block/span 的 fields 不在 MD 中）
    if (mdAnn.kind === 'inline' || mdAnn.kind === undefined) {
      const mdFields = mdAnn.fields || {};
      const dbFields = dbAnn.fields || {};
      const mdFieldsStr = JSON.stringify(mdFields);
      const dbFieldsStr = JSON.stringify(dbFields);
      if (mdFieldsStr !== dbFieldsStr) {
        if (Object.keys(mdFields).length > 0 && Object.keys(dbFields).length === 0) {
          // MD 有 fields，DB 无 → 更新 DB
          updates.fields = mdFields;
        } else if (Object.keys(mdFields).length > 0 && Object.keys(dbFields).length > 0) {
          // 双方都有但不同 → 以 MD 为准（用户可能手动编辑了 MD）
          updates.fields = mdFields;
        }
        // MD 无 fields 但 DB 有 → 保留 DB（防止 inline 标注的 MD 中 data-fields 被手动删除后 DB 数据被清除）
      }
    }

    if (Object.keys(updates).length > 0) {
      console.log(`MarkVault sync: updating annotation ${mdAnn.uuid} with`, updates);
      await annotationStore.updateAnnotation(mdAnn.uuid, {
        ...updates,
        updatedAt: Date.now(),
      });
      updated++;
    }
  }
  } // if (toUpdate.length > 0)

  return { added, removed, updated, upgraded };
}

/**
 * 升级 Markdown 中的旧格式标注为 MarkVault 格式
 * 将 Highlightr 格式或纯 <mark> 标签替换为带 data-uuid 的 MarkVault 格式
 *
 * @returns 升级后的新内容（如果没有需要升级的，返回 null）
 */
export async function upgradeMarkdownAnnotations(
  content: string,
  filePath: string,
): Promise<string | null> {
  const annotations = parseAllAnnotationsFromMarkdown(content, filePath);
  const toUpgrade = annotations.filter((a: { _needsUpgrade?: boolean }) => a._needsUpgrade);

  if (toUpgrade.length === 0) return null;

  let newContent = content;

  for (const ann of toUpgrade) {
    // 构建 MarkVault 格式的 <mark> 标签
    const newTag = buildMarkTag(ann);

    // 替换旧的标签
    // 先尝试匹配 Highlightr 格式
    const hltrRegex = new RegExp(
      `<(mark|span)\\s+class="hltr-\\w+"[^>]*>${escapeRegex(ann.text)}</\\1>`,
      'g',
    );
    if (hltrRegex.test(newContent)) {
      newContent = newContent.replace(hltrRegex, newTag);
      continue;
    }

    // 再尝试匹配纯 <mark> 标签
    const plainRegex = new RegExp(
      `<mark(?![^>]*data-uuid)(?![^>]*class="hltr-)[^>]*>${escapeRegex(ann.text)}</mark>`,
      'g',
    );
    if (plainRegex.test(newContent)) {
      newContent = newContent.replace(plainRegex, newTag);
    }
  }

  return newContent;
}

/**
 * 偏移恢复：文件打开后用 4 层恢复引擎校正偏移
 */
export async function recoverAndSyncOffsets(
  content: string,
  filePath: string,
): Promise<number> {
  // 🔧 修复：plainContent 同时 strip <mark> 标签和 %%markvault%% 锚点行
  const plainContent = content
    .replace(/<mark[^>]*>([\s\S]*?)<\/mark>/g, '$1')
    .replace(/%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%\n?/g, '');
  const dbAnnotations = await getAnnotationsForFile(filePath);

  if (dbAnnotations.length === 0) return 0;

  const recoveryResults = batchRecoverOffsets(plainContent, dbAnnotations);
  const validResults = recoveryResults.filter(r => r !== null);

  if (validResults.length > 0) {
    await batchUpdateOffsets(
      validResults.map(r => ({
        uuid: r.uuid,
        startOffset: r.startOffset,
        endOffset: r.endOffset,
      })),
    );
  }

  return validResults.length;
}

// ─── 辅助函数 ──────────────────────────────────────

/**
 * 计算 <mark> 标注在纯文本内容中的偏移
 * （Markdown 中 <mark> 标签占位，纯文本中不存在）
 */
function computeOffsetInPlainContent(markdownContent: string, markTagOffset: number): number {
  const beforeMark = markdownContent.substring(0, markTagOffset);
  // 🔧 修复：移除之前所有 mark 标签 + anchor 锚点行
  const plainBefore = beforeMark
    .replace(/<mark[^>]*>([\s\S]*?)<\/mark>/g, '$1')
    .replace(/%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%\n?/g, '');
  return plainBefore.length;
}

/**
 * 获取用于偏移恢复的纯文本（移除 <mark> 标签和块级/span 锚点）
 */
export function getPlainTextForOffsetRecovery(markdownContent: string): string {
  return markdownContent
    .replace(/<mark[^>]*>([\s\S]*?)<\/mark>/g, '$1')
    .replace(/%%markvault(-span)?:[^:%]+:[^:%]+:[^:%]+(?::[^%]*)?%%\n?/g, '');
}

/**
 * 从纯文本内容中提取上下文
 */
export function extractContextFromContent(
  fullText: string,
  startOffset: number,
  text: string,
  windowSize: number = 50,
): { contextBefore: string; contextAfter: string } {
  const beforeStart = Math.max(0, startOffset - windowSize);
  const rawBefore = fullText.substring(beforeStart, startOffset);
  const lastBreak = rawBefore.lastIndexOf('\n\n');
  const contextBefore = lastBreak !== -1 ? rawBefore.substring(lastBreak + 2) : rawBefore;

  const textEnd = startOffset + text.length;
  const afterEnd = Math.min(fullText.length, textEnd + windowSize);
  const rawAfter = fullText.substring(textEnd, afterEnd);
  const firstBreak = rawAfter.indexOf('\n\n');
  const contextAfter = firstBreak !== -1 ? rawAfter.substring(0, firstBreak) : rawAfter;

  return { contextBefore, contextAfter };
}

export { buildMarkTag, removeMarkTag, updateMarkTag, removeSpanAnchor, updateSpanAnchor };

/** 正则特殊字符转义 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
