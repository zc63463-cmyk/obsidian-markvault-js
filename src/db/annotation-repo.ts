/**
 * annotation-repo.ts — 薄代理层
 *
 * Phase 2: 所有 Dexie 调用已替换为 AnnotationStore 调用。
 * 对外接口保持兼容，仅 addAnnotation/updateAnnotation 返回值变更。
 */

import type { App, TFile } from 'obsidian';
import { logger } from '../utils/logger';
import { annotationStore, type AnnotationStore } from './annotation-store';
import type { Annotation, AnnotationFilter, AnnotationFlag, AnnotationRelation, AnnotationStats, BatchUpdateItem, RelationType } from '../types/annotation';
import { parseAllAnnotationsFromMarkdown } from '../core/annotation-parser';

// ─── CRUD ──────────────────────────────────────────────

/** 添加标注（返回 void，不再返回自增 id） */
export async function addAnnotation(annotation: Annotation): Promise<void> {
  await annotationStore.addAnnotation(annotation);
}

/** 通过 uuid 获取标注 */
export async function getAnnotationByUuid(uuid: string): Promise<Annotation | undefined> {
  await annotationStore.ensureFileLoadedForUuid(uuid);
  return annotationStore.getAnnotationByUuid(uuid);
}

/** 更新标注（返回 void，不再返回修改数量） */
export async function updateAnnotation(uuid: string, changes: Partial<Annotation>): Promise<void> {
  await annotationStore.updateAnnotation(uuid, changes);
}

/** 删除标注 */
export async function deleteAnnotation(uuid: string): Promise<void> {
  await annotationStore.deleteAnnotation(uuid);
}

// ─── 批量查询 ─────────────────────────────────────────

/** 获取指定笔记的所有标注（按文档顺序） */
export async function getAnnotationsForFile(filePath: string): Promise<Annotation[]> {
  await annotationStore.ensureFileLoaded(filePath);
  return annotationStore.getAnnotationsForFile(filePath);
}

/** 获取所有已加载的标注 */
export async function getAllAnnotations(): Promise<Annotation[]> {
  return annotationStore.getAllAnnotations();
}

/** 删除指定笔记的所有标注 */
export async function deleteAnnotationsForFile(filePath: string): Promise<number> {
  return await annotationStore.deleteAnnotationsForFile(filePath);
}

// ─── 过滤查询 ─────────────────────────────────────────

/** 按过滤条件查询标注 */
export async function queryAnnotations(filter: AnnotationFilter): Promise<Annotation[]> {
  return annotationStore.queryAnnotations(filter);
}

// ─── 统计 ─────────────────────────────────────────────

/** 获取指定笔记的标注统计 */
export async function getAnnotationStats(filePath: string): Promise<AnnotationStats> {
  await annotationStore.ensureFileLoaded(filePath);
  return annotationStore.getAnnotationStats(filePath);
}

// ─── 偏移修正 ─────────────────────────────────────────

/** 批量修正偏移量（文件打开时使用，不更新 updatedAt） */
export async function batchUpdateOffsets(updates: BatchUpdateItem[]): Promise<void> {
  await annotationStore.batchUpdateOffsets(updates);
}

/** 增量偏移修正：编辑后对变更位置之后的标注做偏移调整 */
export async function adjustOffsetsAfterEdit(
  filePath: string,
  changeStart: number,
  changeEnd: number,
  insertedLen: number,
): Promise<void> {
  await annotationStore.ensureFileLoaded(filePath);
  const deletedLen = changeEnd - changeStart;
  const delta = insertedLen - deletedLen;

  if (delta === 0) return; // 替换等长文本，偏移不变

  const annotations = annotationStore.getAnnotationsForFile(filePath);
  const updates: BatchUpdateItem[] = [];

  for (const a of annotations) {
    if (a.startOffset > changeStart) {
      updates.push({
        uuid: a.uuid,
        startOffset: a.startOffset + delta,
        endOffset: a.endOffset + delta,
        spanRanges: a.spanRanges?.map(r => ({
          from: r.from > changeStart ? r.from + delta : r.from,
          to: r.to > changeStart ? r.to + delta : r.to,
        })),
      });
    }
  }

  if (updates.length > 0) {
    await annotationStore.batchUpdateOffsets(updates);
  }
}

// ─── 字段查询 ─────────────────────────────────────────

/** 获取所有已加载标注中出现过的字段键名列表 */
export function getFieldKeys(): string[] {
  return annotationStore.getFieldKeys();
}

/** 获取所有已加载标注中出现过的标签名列表 */
export function getTagNames(): string[] {
  return annotationStore.getTagNames();
}

/** 获取标签及其使用频率（按频率降序） */
export function getTagFrequencies(): Array<{ name: string; count: number }> {
  return annotationStore.getTagFrequencies();
}

/** 获取指定字段键的所有已出现值列表 */
export function getFieldValues(key: string): string[] {
  return annotationStore.getFieldValues(key);
}

// ─── v4.0: Relation 操作 ──────────────────────────────

/** 添加标注间关联 */
export async function addRelation(sourceUuid: string, relation: AnnotationRelation): Promise<void> {
  await annotationStore.addRelation(sourceUuid, relation);
}

/** 移除标注间关联（物理删除） */
export async function removeRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
  await annotationStore.removeRelation(sourceUuid, targetUuid, type);
}

/** v4.2: 使关系失效（软删除，保留历史） — 参考 Graphiti 事实失效 */
export async function invalidateRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
  await annotationStore.invalidateRelation(sourceUuid, targetUuid, type);
}

/** v4.2 P1: 恢复已失效的关系（双向级联清除 invalidAt） */
export async function restoreRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
  await annotationStore.restoreRelation(sourceUuid, targetUuid, type);
}

/** 获取标注的所有关联（出边 + 入边），默认只返回有效关系 */
export function getRelations(uuid: string, options?: { includeInvalidated?: boolean }): { outgoing: AnnotationRelation[]; incoming: Array<{ sourceUuid: string; relation: AnnotationRelation }> } {
  return annotationStore.getRelations(uuid, options);
}

// ─── v4.0: Flag 操作 ──────────────────────────────────

/** 更新标注的学习状态标记 */
export async function updateFlags(uuid: string, flagChanges: Partial<AnnotationFlag>): Promise<void> {
  await annotationStore.updateFlags(uuid, flagChanges);
}

// ─── v4.0: Group 操作 ──────────────────────────────────

/** 给标注添加分组 */
export async function addGroupToAnnotation(uuid: string, group: string): Promise<void> {
  await annotationStore.addGroupToAnnotation(uuid, group);
}

/** 从标注移除分组 */
export async function removeGroupFromAnnotation(uuid: string, group: string): Promise<void> {
  await annotationStore.removeGroupFromAnnotation(uuid, group);
}

/** 获取所有分组名列表（annotation groups + settings knownGroups） */
export function getGroupNames(): string[] {
  const names = new Set(annotationStore.getGroupNames());
  for (const g of __knownGroups) names.add(g);
  return Array.from(names).sort();
}

// v6.1: Settings 中的 knownGroups，由插件在 loadSettings 后同步
let __knownGroups: string[] = [];
export function getKnownGroups(): string[] { return __knownGroups; }
export function setKnownGroups(groups: string[]) { __knownGroups = groups; }
export function addKnownGroup(name: string): void {
  if (!__knownGroups.includes(name)) { __knownGroups.push(name); __knownGroups.sort(); }
}

/** 获取合并分组名（groups 字段 + tags 中 group: 前缀） */
export function getMergedGroupNames(): string[] {
  return annotationStore.getMergedGroupNames();
}

// ─── 孤儿标注清理 ─────────────────────────────────────

/**
 * 清理 DB 中有但 Markdown 中已不存在的标注（孤儿标注）。
 * 由用户手动触发，避免 vault.read 竞态导致误删。
 *
 * @param app Obsidian App 实例
 * @returns 清理的标注数量
 */
export async function cleanOrphanAnnotations(app: App, store: AnnotationStore = annotationStore): Promise<number> {
  const allAnnotations = store.getAllAnnotations();
  if (allAnnotations.length === 0) return 0;

  // 按文件分组
  const byFile = new Map<string, Annotation[]>();
  for (const ann of allAnnotations) {
    let list = byFile.get(ann.filePath);
    if (!list) {
      list = [];
      byFile.set(ann.filePath, list);
    }
    list.push(ann);
  }

  let cleaned = 0;

  for (const [filePath, annotations] of byFile) {
    const file = app.vault.getAbstractFileByPath(filePath);

    // 源文件已不存在：删除该文件全部标注
    // 使用 duck typing，避免在测试环境中导入 obsidian 运行时
    if (!file || (file as any).extension !== 'md') {
      const count = await deleteAnnotationsForFile(filePath);
      cleaned += count;
      logger.debug(`MarkVault clean orphans: deleted ${count} annotations for missing file "${filePath}"`);
      continue;
    }

    try {
      const content = await app.vault.read(file as TFile);
      const mdAnnotations = parseAllAnnotationsFromMarkdown(content, filePath);
      const mdUuids = new Set(mdAnnotations.map(a => a.uuid));

      for (const ann of annotations) {
        if (!mdUuids.has(ann.uuid)) {
          await deleteAnnotation(ann.uuid);
          cleaned++;
          logger.debug(`MarkVault clean orphans: deleted orphan annotation ${ann.uuid} from "${filePath}"`);
        }
      }
    } catch (err) {
      console.warn(`MarkVault clean orphans: failed to read "${filePath}"`, err);
    }
  }

  return cleaned;
}
