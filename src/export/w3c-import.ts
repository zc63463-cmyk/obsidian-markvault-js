/**
 * W3C 导入 API
 *
 * 将 W3C Web Annotation 数据导入 MarkVault AnnotationStore。
 * 支持从 W3C AnnotationCollection 或单条 W3CAnnotation 导入。
 *
 * 核心功能：
 * 1. UUID 冲突处理（保留原 ID / 重新生成 / 跳过）
 * 2. filePath 映射（W3C target.source → vault 内路径）
 * 3. 批量 relations 重建（导入后自动修复跨标注引用）
 * 4. 类型安全校验（mastery/reviewPriority/confidence 已由 deserializeFlags 处理）
 */

import type { AnnotationStore } from '../db/annotation-store';
import type { Annotation } from '../types/annotation';
import type {
  W3CAnnotation,
  W3CAnnotationCollection,
} from './w3c-types';
import { deserializeAnnotation } from './w3c-serializer';
import { generateId } from '../utils/id';

// ═══════════════════════════════════════════════════════
// 导入选项
// ═══════════════════════════════════════════════════════

/** UUID 冲突处理策略 */
export type UuidConflictStrategy =
  | 'preserve'   // 保留原 UUID（如果 Store 中已存在则跳过）
  | 'regenerate' // 重新生成 UUID（始终导入，确保不冲突）
  | 'skip';      // 跳过冲突标注（不导入）

/** W3C 导入选项 */
export interface W3CImportOptions {
  /** UUID 冲突策略，默认 'regenerate' */
  uuidConflict?: UuidConflictStrategy;
  /** 文件路径映射：W3C source → vault 内路径。未映射的保留原值 */
  filePathMap?: Record<string, string>;
  /** 是否导入 relations，默认 true */
  importRelations?: boolean;
  /** 是否导入 flags，默认 true */
  importFlags?: boolean;
  /** 关系来源标记，默认 'imported' */
  relationSource?: 'manual' | 'template' | 'inferred' | 'imported';
}

/** 导入结果 */
export interface W3CImportResult {
  /** 成功导入的标注数量 */
  imported: number;
  /** 因 UUID 冲突跳过的数量 */
  skipped: number;
  /** 反序列化失败的数量 */
  errors: number;
  /** UUID 重映射表：原 UUID → 新 UUID（用于修复 relations） */
  uuidRemap: Map<string, string>;
  /** 导入失败的原因列表 */
  errorDetails: Array<{ w3cId: string; reason: string }>;
}

// ═══════════════════════════════════════════════════════
// 导入 API
// ═══════════════════════════════════════════════════════

/**
 * 从 W3C AnnotationCollection 导入标注到 Store。
 *
 * 处理流程：
 * 1. 展开分页（如果 Collection 使用了 first/last 分页）
 * 2. 逐条反序列化，处理 UUID 冲突
 * 3. 写入 Store
 * 4. 修复跨标注 relations 中的 UUID 引用
 *
 * @param store AnnotationStore 实例
 * @param collection W3C AnnotationCollection 数据
 * @param options 导入选项
 * @returns 导入结果统计
 */
export async function importFromW3C(
  store: AnnotationStore,
  collection: W3CAnnotationCollection,
  options: W3CImportOptions = {},
): Promise<W3CImportResult> {
  const {
    uuidConflict = 'regenerate',
    filePathMap = {},
    importRelations = true,
    importFlags = true,
    relationSource = 'imported',
  } = options;

  const result: W3CImportResult = {
    imported: 0,
    skipped: 0,
    errors: 0,
    uuidRemap: new Map(),
    errorDetails: [],
  };

  // 1. 提取所有 W3C 标注（展开分页）
  const w3cAnnotations = extractW3CAnnotations(collection);

  // 2. 第一遍：反序列化 + UUID 冲突处理
  const pendingAnnotations: Annotation[] = [];

  for (const w3c of w3cAnnotations) {
    try {
      const partial = deserializeAnnotation(w3c);

      // filePath 映射
      if (partial.filePath && filePathMap[partial.filePath]) {
        partial.filePath = filePathMap[partial.filePath];
      }

      // UUID 冲突处理
      const originalUuid = partial.uuid || '';
      const existing = store.getAnnotationByUuid(originalUuid);

      if (existing) {
        switch (uuidConflict) {
          case 'skip':
            result.skipped++;
            continue;
          case 'preserve':
            // 保留原 UUID，但如果已存在则跳过
            result.skipped++;
            continue;
          case 'regenerate':
            // 重新生成 UUID
            const newUuid = generateId();
            result.uuidRemap.set(originalUuid, newUuid);
            partial.uuid = newUuid;
            break;
        }
      }

      // 可选：过滤 relations
      if (!importRelations) {
        delete partial.relations;
      } else if (partial.relations) {
        // 标记 source 为 imported
        for (const rel of partial.relations) {
          rel.source = relationSource;
        }
      }

      // 可选：过滤 flags
      if (!importFlags) {
        delete partial.flags;
      }

      // 确保必要字段有默认值
      const annotation = ensureRequiredFields(partial);
      pendingAnnotations.push(annotation);
    } catch (e) {
      result.errors++;
      result.errorDetails.push({
        w3cId: w3c.id || '(unknown)',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 3. 写入 Store（逐条添加，确保索引正确）
  for (const annotation of pendingAnnotations) {
    try {
      await store.addAnnotation(annotation);
      result.imported++;
    } catch (e) {
      result.errors++;
      result.errorDetails.push({
        w3cId: annotation.uuid,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. 修复 relations 中的 UUID 引用（如果有重映射）
  if (result.uuidRemap.size > 0 && importRelations) {
    await remapRelationUuids(store, pendingAnnotations, result.uuidRemap);
  }

  return result;
}

/**
 * 从 W3C JSON 字符串导入标注。
 * 便捷方法：解析 JSON + 调用 importFromW3C。
 */
export async function importFromW3CString(
  store: AnnotationStore,
  jsonString: string,
  options: W3CImportOptions = {},
): Promise<W3CImportResult> {
  const data = JSON.parse(jsonString);
  return importFromW3C(store, data, options);
}

/**
 * 导入单条 W3C 标注。
 * 适用于右键菜单"导入此标注"等场景。
 */
export async function importSingleFromW3C(
  store: AnnotationStore,
  w3c: W3CAnnotation,
  options: W3CImportOptions = {},
): Promise<W3CImportResult> {
  const collection: W3CAnnotationCollection = {
    '@context': ['http://www.w3.org/ns/anno.jsonld'],
    id: 'single-import',
    type: 'AnnotationCollection',
    total: 1,
    items: [w3c],
  };
  return importFromW3C(store, collection, options);
}

// ═══════════════════════════════════════════════════════
// 内部工具函数
// ═══════════════════════════════════════════════════════

/** 从 Collection 中提取所有 W3C 标注（展开分页） */
function extractW3CAnnotations(collection: W3CAnnotationCollection): W3CAnnotation[] {
  // 直接内联模式
  if (collection.items && collection.items.length > 0) {
    return collection.items;
  }

  // 分页模式：从 first 开始遍历
  // 注意：跨页数据需要完整加载，这里仅处理已内联的 first page
  const annotations: W3CAnnotation[] = [];

  if (collection.first) {
    annotations.push(...collection.first.items);

    // 如果有 last 页且与 first 不同，警告分页数据不完整
    if (collection.last && collection.last.id !== collection.first.id) {
      console.warn(
        'MarkVault: W3C import received paginated collection — only first page imported. ' +
        `Total: ${collection.total}, first page: ${collection.first.items.length}. ` +
        'Provide full collection with inline items for complete import.'
      );
    }
  }

  return annotations;
}

/** 确保反序列化结果包含所有必需字段 */
function ensureRequiredFields(partial: Partial<Annotation>): Annotation {
  return {
    uuid: partial.uuid || generateId(),
    filePath: partial.filePath || '',
    type: partial.type || 'highlight',
    color: partial.color || 'yellow',
    text: partial.text || '',
    note: partial.note || '',
    tags: partial.tags || [],
    startOffset: partial.startOffset ?? 0,
    endOffset: partial.endOffset ?? 0,
    startLine: partial.startLine ?? 0,
    endLine: partial.endLine,
    contextBefore: partial.contextBefore || '',
    contextAfter: partial.contextAfter || '',
    createdAt: partial.createdAt ?? Date.now(),
    updatedAt: partial.updatedAt ?? Date.now(),
    // 可选字段
    ...(partial.kind ? { kind: partial.kind } : {}),
    ...(partial.schemaVersion ? { schemaVersion: partial.schemaVersion } : {}),
    ...(partial.groupUuid ? { groupUuid: partial.groupUuid } : {}),
    ...(partial.blockType ? { blockType: partial.blockType } : {}),
    ...(partial.targetLine !== undefined ? { targetLine: partial.targetLine } : {}),
    ...(partial.anchorLine !== undefined ? { anchorLine: partial.anchorLine } : {}),
    ...(partial.spanRanges ? { spanRanges: partial.spanRanges } : {}),
    ...(partial.targetHash ? { targetHash: partial.targetHash } : {}),
    ...(partial.fields ? { fields: partial.fields } : {}),
    ...(partial.format ? { format: partial.format } : {}),
    ...(partial.relations ? { relations: partial.relations } : {}),
    ...(partial.flags ? { flags: partial.flags } : {}),
    ...(partial.groups ? { groups: partial.groups } : {}),
    ...(partial.motivation ? { motivation: partial.motivation } : {}),
  };
}

/** 修复已导入标注中的 relations UUID 引用 */
async function remapRelationUuids(
  store: AnnotationStore,
  annotations: Annotation[],
  uuidRemap: Map<string, string>,
): Promise<void> {
  for (const annotation of annotations) {
    if (!annotation.relations || annotation.relations.length === 0) continue;

    let needsUpdate = false;
    const updatedRelations = annotation.relations.map(rel => {
      const newTargetUuid = uuidRemap.get(rel.targetUuid);
      if (newTargetUuid) {
        needsUpdate = true;
        return { ...rel, targetUuid: newTargetUuid };
      }
      return rel;
    });

    if (needsUpdate) {
      await store.updateAnnotation(annotation.uuid, { relations: updatedRelations });
    }
  }
}
