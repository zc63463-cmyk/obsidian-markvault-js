/**
 * IndexedDB → 分片 JSON 迁移脚本
 *
 * 在插件 onload 时调用：如果检测到 IndexedDB 中有标注数据，
 * 将其迁移到 AnnotationStore，然后清空 IndexedDB。
 */

import type { Annotation } from '../types/annotation';
import { annotationStore } from './annotation-store';

/**
 * 从 IndexedDB (Dexie) 迁移所有标注到 AnnotationStore。
 *
 * @returns 迁移的标注数量
 *
 * 注意：
 * - 如果 IndexedDB 不存在或为空（首次安装），返回 0
 * - 迁移完成后会调用 flushAll() 确保所有数据写入分片
 * - 此函数应在 AnnotationStore.initialize() 之后调用
 */
export async function migrateFromIndexedDB(): Promise<number> {
  let allAnnotations: Array<Annotation & { id?: number }> = [];

  try {
    // 动态导入 Dexie，直接打开旧数据库
    const Dexie = (await import('dexie')).default;

    let dexieDb: InstanceType<typeof Dexie> | null = null;

    try {
      dexieDb = new Dexie('MarkVaultDB');
      // 定义与旧 schema 兼容的表结构
      dexieDb.version(1).stores({
        annotations: '++id, uuid, filePath, type, color, startOffset, createdAt, updatedAt',
      });
    } catch {
      // 数据库不存在或版本不匹配，无需迁移
      console.log('MarkVault migration: IndexedDB not found or incompatible, skipping migration');
      return 0;
    }

    const table = dexieDb.table<Annotation & { id?: number }>('annotations');
    const count = await table.count();

    if (count === 0) {
      dexieDb.close();
      return 0;
    }

    console.log(`MarkVault migration: found ${count} annotations in IndexedDB, starting migration...`);

    allAnnotations = await table.toArray();

    // 逐条添加到 AnnotationStore（去除 id 字段）
    for (const ann of allAnnotations) {
      const { id: _id, ...cleanAnn } = ann;
      // 确保必要字段存在
      const annotation: Annotation = {
        uuid: cleanAnn.uuid,
        filePath: cleanAnn.filePath,
        type: cleanAnn.type,
        color: cleanAnn.color,
        text: cleanAnn.text,
        note: cleanAnn.note || '',
        tags: cleanAnn.tags || [],
        startOffset: cleanAnn.startOffset,
        endOffset: cleanAnn.endOffset,
        startLine: cleanAnn.startLine || 0,
        contextBefore: cleanAnn.contextBefore || '',
        contextAfter: cleanAnn.contextAfter || '',
        createdAt: cleanAnn.createdAt || Date.now(),
        updatedAt: cleanAnn.updatedAt || Date.now(),
        kind: cleanAnn.kind,
        groupUuid: cleanAnn.groupUuid,
        blockType: cleanAnn.blockType,
        targetLine: cleanAnn.targetLine,
        anchorLine: cleanAnn.anchorLine,
        spanRanges: cleanAnn.spanRanges,
        fields: cleanAnn.fields,
      };

      await annotationStore.addAnnotation(annotation);
    }

    // 迁移完成，写回所有数据
    await annotationStore.flushAll();

    // 清空并删除旧 IndexedDB
    try {
      await table.clear();
      dexieDb.delete();
      console.log('MarkVault migration: IndexedDB deleted after successful migration');
    } catch (err) {
      console.warn('MarkVault migration: could not delete IndexedDB, will retry next launch', err);
    }

    return allAnnotations.length;
  } catch (err) {
    console.error('MarkVault migration: failed to migrate from IndexedDB', err);
    return 0;
  }
}
