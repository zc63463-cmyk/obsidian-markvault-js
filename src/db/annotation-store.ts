import type { Vault } from 'obsidian';
import type {
  Annotation,
  AnnotationFilter,
  AnnotationFlag,
  AnnotationMotivation,
  AnnotationRelation,
  AnnotationStats,
  BatchUpdateItem,
  RelationType,
} from '../types/annotation';
import { RelationSchema } from '../types/annotation';
import { FileEncoder } from './file-encoder';
import { IndexLayer } from './index-layer';
import { PersistLayer } from './persist-layer';
import { RelationEngine } from './relation-engine';
import { QueryEngine } from './query-engine';
import { stripExtraFields } from './strip-fields';

/**
 * AnnotationStore — 分片 JSON + 内存索引 标注存储
 *
 * v6.0 重构：拆分为 4 个子模块，本文件为组合层：
 * - IndexLayer: 12 个内存索引 Map + 索引变更方法
 * - PersistLayer: init/shutdown/flush + 分片读写
 * - RelationEngine: 关系 CRUD + 级联操作
 * - QueryEngine: queryAnnotations + getAnnotationStats
 *
 * 公共 API 保持不变，外部代码无需修改。
 */
export class AnnotationStore {
  // ─── 子模块 ────────────────────────────────────────────
  readonly indexLayer: IndexLayer;
  readonly persistLayer: PersistLayer;
  readonly relationEngine: RelationEngine;
  readonly queryEngine: QueryEngine;

  constructor() {
    this.indexLayer = new IndexLayer();
    this.persistLayer = new PersistLayer(this.indexLayer);
    this.relationEngine = new RelationEngine(this.indexLayer);
    this.queryEngine = new QueryEngine(this.indexLayer);

    // 注入回调：RelationEngine → PersistLayer（通过 AnnotationStore 协调）
    this.relationEngine.setMarkDirtyCallback((filePath: string) => {
      this.persistLayer._markDirty(filePath);
    });

    // 注入回调：PersistLayer debounce flush → AnnotationStore.flushFile
    this.persistLayer.setFlushFileCallback(async (filePath: string) => {
      await this.flushFile(filePath);
    });

    // 注入回调：PersistLayer deleteAnnotationsForFile → RelationEngine.cascadeDeleteRelations
    this.persistLayer.setCascadeDeleteCallback((ann: Annotation) => {
      this.relationEngine.cascadeDeleteRelations(ann);
    });
  }

  // ═══════════════════════════════════════════════════════
  // 初始化 / 关闭
  // ═══════════════════════════════════════════════════════

  /**
   * 初始化 AnnotationStore，设置 vault 引用。
   * 必须在插件 onload 时调用，且只调用一次。
   */
  init(vault: Vault): void {
    this.persistLayer.init(vault);
  }

  /**
   * 启动初始化：读取元数据和索引文件，不加载分片。
   */
  async initialize(): Promise<void> {
    await this.persistLayer.initialize();
  }

  /**
   * 关闭存储（等同 flushAll）。
   */
  async shutdown(): Promise<void> {
    await this.persistLayer.shutdown();
  }

  // ═══════════════════════════════════════════════════════
  // 简单查询（委托 IndexLayer）
  // ═══════════════════════════════════════════════════════

  /** O(1) 按 UUID 精确查找标注 */
  getAnnotationByUuid(uuid: string): Annotation | undefined {
    return this.indexLayer.getAnnotationByUuid(uuid);
  }

  /** 获取标注总数 */
  getAnnotationCount(): number {
    return this.indexLayer.getAnnotationCount();
  }

  /** 获取指定文件的所有标注，按 startOffset 排序 */
  getAnnotationsForFile(filePath: string): Annotation[] {
    return this.indexLayer.getAnnotationsForFile(filePath);
  }

  /** 获取所有已加载的标注 */
  getAllAnnotations(): Annotation[] {
    return this.indexLayer.getAllAnnotations();
  }

  /** 获取所有字段键名 */
  getFieldKeys(): string[] {
    return this.indexLayer.getFieldKeys();
  }

  /** 获取指定字段键的值列表 */
  getFieldValues(key: string): string[] {
    return this.indexLayer.getFieldValues(key);
  }

  /** 获取所有分组名 */
  getGroupNames(): string[] {
    return this.indexLayer.getGroupNames();
  }

  // ═══════════════════════════════════════════════════════
  // 查询引擎（委托 QueryEngine）
  // ═══════════════════════════════════════════════════════

  /** 基于内存索引的查询，支持多维度过滤 */
  queryAnnotations(filter?: AnnotationFilter): Annotation[] {
    return this.queryEngine.queryAnnotations(filter);
  }

  /** 获取标注统计 */
  getAnnotationStats(filePath?: string): AnnotationStats {
    return this.queryEngine.getAnnotationStats(filePath);
  }

  // ═══════════════════════════════════════════════════════
  // 持久化层（委托 PersistLayer）
  // ═══════════════════════════════════════════════════════

  /** 标记指定文件为 dirty */
  markFileDirty(filePath: string): void {
    this.persistLayer.markFileDirty(filePath);
  }

  /** 懒加载：确保指定文件的分片已加载到内存 */
  async ensureFileLoaded(filePath: string): Promise<void> {
    await this.persistLayer.ensureFileLoaded(filePath);
  }

  /** 通过 UUID 查找标注时，确保标注所在文件已加载 */
  async ensureFileLoadedForUuid(uuid: string): Promise<void> {
    await this.persistLayer.ensureFileLoadedForUuid(uuid);
  }

  /** 强制写回单个文件的脏数据 */
  async flushFile(filePath: string): Promise<void> {
    await this.persistLayer.flushFile(filePath);
  }

  /** 写回所有脏数据 */
  async flushAll(): Promise<void> {
    await this.persistLayer.flushAll();
  }

  /** 重建索引 */
  async rebuildIndex(): Promise<void> {
    await this.persistLayer.rebuildIndex();
  }

  /** 删除指定文件的所有标注 */
  async deleteAnnotationsForFile(filePath: string): Promise<number> {
    return await this.persistLayer.deleteAnnotationsForFile(filePath);
  }

  /** 文件重命名时同步更新所有相关标注的 filePath */
  async renameAnnotationsForFile(oldPath: string, newPath: string): Promise<void> {
    await this.persistLayer.renameAnnotationsForFile(oldPath, newPath);
  }

  // ═══════════════════════════════════════════════════════
  // 关系引擎（委托 RelationEngine）
  // ═══════════════════════════════════════════════════════

  /** 注入关系类型 Schema */
  setRelationSchema(schema: RelationSchema): void {
    this.relationEngine.setRelationSchema(schema);
  }

  /** 添加标注间关联 */
  async addRelation(sourceUuid: string, relation: AnnotationRelation): Promise<void> {
    this._assertInitialized();
    await this.relationEngine.addRelation(sourceUuid, relation);
  }

  /** 移除标注间关联（物理删除） */
  async removeRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
    this._assertInitialized();
    await this.relationEngine.removeRelation(sourceUuid, targetUuid, type);
  }

  /** 使关系失效（软删除） */
  async invalidateRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
    this._assertInitialized();
    await this.relationEngine.invalidateRelation(sourceUuid, targetUuid, type);
  }

  /** 批量失效指定关系类型的所有关系 */
  async invalidateRelationsByType(type: RelationType): Promise<number> {
    this._assertInitialized();
    return await this.relationEngine.invalidateRelationsByType(type);
  }

  /** 恢复已失效的关系 */
  async restoreRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
    this._assertInitialized();
    await this.relationEngine.restoreRelation(sourceUuid, targetUuid, type);
  }

  /** 获取标注的所有关联（出边 + 入边） */
  getRelations(uuid: string, options?: { includeInvalidated?: boolean }): { outgoing: AnnotationRelation[]; incoming: Array<{ sourceUuid: string; relation: AnnotationRelation }> } {
    return this.relationEngine.getRelations(uuid, options);
  }

  // ═══════════════════════════════════════════════════════
  // 跨层方法（保留在 AnnotationStore，协调多个子模块）
  // ═══════════════════════════════════════════════════════

  /**
   * 添加标注，更新索引并标记 dirty。
   */
  async addAnnotation(annotation: Annotation): Promise<void> {
    this._assertInitialized();

    if (!annotation.schemaVersion) {
      annotation.schemaVersion = 1;
    }

    await this.ensureFileLoaded(annotation.filePath);

    const clean = stripExtraFields(annotation);

    this.indexLayer.byUuid.set(clean.uuid, clean);
    this.indexLayer.addToIndex(clean);

    this.persistLayer._updateIndexEntry(clean.filePath);
    this.persistLayer._markDirty(clean.filePath);
  }

  /**
   * 更新标注。
   */
  async updateAnnotation(uuid: string, changes: Partial<Annotation>): Promise<void> {
    this._assertInitialized();

    const oldAnn = this.indexLayer.byUuid.get(uuid);
    if (!oldAnn) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    // 防御 changes.relations 路径
    if (changes.relations !== undefined && oldAnn.relations) {
      this.relationEngine.cascadeUpdateRelations(uuid, oldAnn.relations, changes.relations);
    }

    // 移除旧索引
    this.indexLayer.removeFromIndex(uuid);

    // 🔧 P1-5 修复：过滤 changes 中的 undefined 值，防止展开后覆盖已有字段
    const filteredChanges: Partial<Annotation> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) {
        (filteredChanges as Record<string, unknown>)[k] = v;
      }
    }

    // 🔧 P0-9 修复：自动更新 updatedAt（除非调用方显式传入）
    if ((filteredChanges as Record<string, unknown>)['updatedAt'] === undefined) {
      (filteredChanges as Record<string, unknown>)['updatedAt'] = Date.now();
    }

    // 合并变更
    const newAnn: Annotation = stripExtraFields({ ...oldAnn, ...filteredChanges });
    this.indexLayer.byUuid.set(uuid, newAnn);

    // 处理 filePath 变更
    if (changes.filePath && changes.filePath !== oldAnn.filePath) {
      const oldFileSet = this.indexLayer.byFile.get(oldAnn.filePath);
      if (oldFileSet) {
        oldFileSet.delete(uuid);
        if (oldFileSet.size === 0) {
          this.indexLayer.byFile.delete(oldAnn.filePath);
          this.persistLayer._loadedFiles.delete(oldAnn.filePath);
          const oldKey = FileEncoder.encodeFilePath(oldAnn.filePath);
          delete this.persistLayer.indexData.entries[oldKey];
          this.persistLayer.indexDirty = true;
          const oldShardPath = FileEncoder.getShardPath(this.persistLayer.baseDir, oldAnn.filePath);
          try {
            await this.persistLayer.adapter.remove(oldShardPath);
          } catch {
            // 文件可能不存在，忽略
          }
        } else {
          this.persistLayer._updateIndexEntry(oldAnn.filePath);
        }
      }

      await this.ensureFileLoaded(newAnn.filePath);

      let newFileSet = this.indexLayer.byFile.get(newAnn.filePath);
      if (!newFileSet) {
        newFileSet = new Set();
        this.indexLayer.byFile.set(newAnn.filePath, newFileSet);
      }
      newFileSet.add(uuid);

      this.persistLayer._updateIndexEntry(newAnn.filePath);
      this.persistLayer._markDirty(newAnn.filePath);
    }

    // 重建索引
    this.indexLayer.addToIndex(newAnn);

    // 标记 dirty
    if (!changes.filePath || changes.filePath === oldAnn.filePath) {
      this.persistLayer._updateIndexEntry(newAnn.filePath);
      this.persistLayer._markDirty(newAnn.filePath);
    } else {
      this.persistLayer._markDirty(newAnn.filePath);
    }
  }

  /**
   * 删除标注，移除索引并标记 dirty。
   */
  async deleteAnnotation(uuid: string): Promise<void> {
    this._assertInitialized();

    const ann = this.indexLayer.byUuid.get(uuid);
    if (!ann) return;

    const filePath = ann.filePath;

    // 级联清理伙伴标注上的反向关系数据
    this.relationEngine.cascadeDeleteRelations(ann);

    // 移除索引
    this.indexLayer.removeFromIndex(uuid);
    this.indexLayer.byUuid.delete(uuid);

    if (!this.indexLayer.byFile.has(filePath)) {
      // 文件没有标注了
      const shardPath = FileEncoder.getShardPath(this.persistLayer.baseDir, filePath);
      try {
        await this.persistLayer.adapter.remove(shardPath);
      } catch {
        // 文件可能不存在，忽略
      }

      this.persistLayer._loadedFiles.delete(filePath);
      const key = FileEncoder.encodeFilePath(filePath);
      delete this.persistLayer.indexData.entries[key];

      this.persistLayer.dirtyFiles.delete(filePath);
      const timer = this.persistLayer.debounceTimers.get(filePath);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.persistLayer.debounceTimers.delete(filePath);
      }

      await this.persistLayer._writeIndexFile();

      console.log(`MarkVault: deleted last annotation for file "${filePath}" — shard removed, index updated`);
    } else {
      this.persistLayer._updateIndexEntry(filePath);
      this.persistLayer._markDirty(filePath);
    }
  }

  /**
   * 批量更新偏移量。
   *
   * 🔧 P1-4 修复：使用不可变对象模式，不再原地修改 Map 中的对象引用。
   * 改为创建新对象替换 byUuid 中的条目，避免 async 间隙读到部分更新状态。
   */
  async batchUpdateOffsets(updates: BatchUpdateItem[]): Promise<void> {
    this._assertInitialized();

    const filesAffected = new Set<string>();

    for (const item of updates) {
      const ann = this.indexLayer.byUuid.get(item.uuid);
      if (!ann) continue;

      this.indexLayer.removeFromIndex(item.uuid);

      // 创建新对象，替换 byUuid 中的引用
      const newAnn: Annotation = {
        ...ann,
        startOffset: item.startOffset,
        endOffset: item.endOffset,
        ...(item.spanRanges !== undefined ? { spanRanges: item.spanRanges } : {}),
      };
      this.indexLayer.byUuid.set(item.uuid, newAnn);

      this.indexLayer.addToIndex(newAnn);

      filesAffected.add(newAnn.filePath);
    }

    for (const filePath of filesAffected) {
      this.persistLayer._updateIndexEntry(filePath);
      this.persistLayer._markDirty(filePath);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 跨层辅助方法（Tag / Group / Flag — 读注解+写索引+写持久化）
  // ═══════════════════════════════════════════════════════

  /** 给标注添加标签 */
  async addTagToAnnotation(uuid: string, tag: string): Promise<void> {
    this._assertInitialized();

    const ann = this.indexLayer.byUuid.get(uuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    if (ann.tags.includes(tag)) return;

    this.indexLayer.removeFromIndex(uuid);
    ann.updatedAt = Date.now(); // P0-9: 自动更新 updatedAt
    ann.tags.push(tag);
    this.indexLayer.addToIndex(ann);
    this.persistLayer._markDirty(ann.filePath);
  }

  /** 从标注移除标签 */
  async removeTagFromAnnotation(uuid: string, tag: string): Promise<void> {
    this._assertInitialized();

    const ann = this.indexLayer.byUuid.get(uuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    const idx = ann.tags.indexOf(tag);
    if (idx === -1) return;

    this.indexLayer.removeFromIndex(uuid);
    ann.updatedAt = Date.now(); // P0-9: 自动更新 updatedAt
    ann.tags.splice(idx, 1);
    this.indexLayer.addToIndex(ann);
    this.persistLayer._markDirty(ann.filePath);
  }

  /** 更新标注的学习状态标记 */
  async updateFlags(uuid: string, flagChanges: Partial<AnnotationFlag>): Promise<void> {
    this._assertInitialized();

    const ann = this.indexLayer.byUuid.get(uuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    this.indexLayer.removeFromIndex(uuid);
    ann.updatedAt = Date.now(); // P0-9: 自动更新 updatedAt
    ann.flags = { ...ann.flags, ...flagChanges };
    this.indexLayer.addToIndex(ann);
    this.persistLayer._markDirty(ann.filePath);
  }

  /** 给标注添加分组 */
  async addGroupToAnnotation(uuid: string, group: string): Promise<void> {
    this._assertInitialized();

    const ann = this.indexLayer.byUuid.get(uuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    if (ann.groups?.includes(group)) return;

    this.indexLayer.removeFromIndex(uuid);
    ann.updatedAt = Date.now(); // P0-9: 自动更新 updatedAt
    if (!ann.groups) {
      ann.groups = [];
    }
    ann.groups.push(group);
    this.indexLayer.addToIndex(ann);
    this.persistLayer._markDirty(ann.filePath);
  }

  /** 从标注移除分组 */
  async removeGroupFromAnnotation(uuid: string, group: string): Promise<void> {
    this._assertInitialized();

    const ann = this.indexLayer.byUuid.get(uuid);
    if (!ann?.groups) return;

    const idx = ann.groups.indexOf(group);
    if (idx === -1) return;

    this.indexLayer.removeFromIndex(uuid);
    ann.updatedAt = Date.now(); // P0-9: 自动更新 updatedAt
    ann.groups.splice(idx, 1);
    if (ann.groups.length === 0) {
      delete ann.groups;
    }
    this.indexLayer.addToIndex(ann);
    this.persistLayer._markDirty(ann.filePath);
  }

  // ═══════════════════════════════════════════════════════
  // 私有工具方法
  // ═══════════════════════════════════════════════════════

  /** 断言已初始化 */
  private _assertInitialized(): void {
    this.persistLayer.assertInitialized();
  }
}

// ═══════════════════════════════════════════════════════
// 单例导出
// ═══════════════════════════════════════════════════════

/** 全局 AnnotationStore 单例，在插件 onload 时通过 initAnnotationStore(vault) 初始化 */
export const annotationStore = new AnnotationStore();

/**
 * 初始化全局 AnnotationStore 单例。
 * 必须在插件 onload 时调用，且只调用一次。
 */
export function initAnnotationStore(vault: import('obsidian').Vault): AnnotationStore {
  annotationStore.init(vault);
  return annotationStore;
}
