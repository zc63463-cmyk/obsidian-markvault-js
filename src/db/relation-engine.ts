import type {
  Annotation,
  AnnotationRelation,
  RelationType,
} from '../types/annotation';
import { RelationSchema, DEFAULT_RELATION_TYPE_CONFIGS } from '../types/annotation';
import type { IndexLayer } from './index-layer';

/**
 * 关系变更回调类型 — RelationEngine 不直接依赖 PersistLayer，
 * 通过回调通知 AnnotationStore 层标记 dirty。
 */
export type MarkDirtyCallback = (filePath: string) => void;

/**
 * 构建反向关系对象 — 统一入口，确保所有反向关系字段一致。
 *
 * 这是创建反向关系的唯一入口。禁止在构建器之外手动 push 反向关系对象。
 * 新增字段时只需修改此函数，所有调用点自动继承。
 *
 * 字段规则：
 * - targetUuid = 原关系的 sourceUuid（反向指向源）
 * - type = schema.getReverse(正向 type)
 * - source = 'inferred'（反向关系总是推断创建的）
 * - createdAt / note / invalidAt 从正向关系继承
 *
 * 对称关系（reverseType === forwardType）无需特殊处理——构建器只负责构建对象，
 * 去重由调用方的 alreadyHas 检查处理。自环关系已被入口拦截。
 */
function buildReverseRelation(
  sourceUuid: string,
  forward: AnnotationRelation,
  reverseType: string,
): AnnotationRelation {
  return {
    targetUuid: sourceUuid,
    type: reverseType as RelationType,
    createdAt: forward.createdAt,
    source: 'inferred',
    ...(forward.note ? { note: forward.note } : {}),
    ...(forward.invalidAt ? { invalidAt: forward.invalidAt } : {}),
  };
}

/**
 * RelationEngine — 关系引擎
 *
 * 负责：
 * - addRelation / removeRelation / invalidateRelation / restoreRelation
 * - invalidateRelationsByType（批量失效）
 * - getRelations（查询入边 + 出边）
 * - _cascadeDeleteRelations / _cascadeUpdateRelations（级联清理/补建）
 * - setRelationSchema / getRelationSchema
 */
export class RelationEngine {
  // ─── 依赖 ──────────────────────────────────────────────
  private _indexLayer: IndexLayer;

  /** 关系类型 Schema */
  private _relationSchema: RelationSchema = new RelationSchema(DEFAULT_RELATION_TYPE_CONFIGS);

  /** dirty 标记回调 */
  private _markDirtyCallback: MarkDirtyCallback | null = null;

  constructor(indexLayer: IndexLayer) {
    this._indexLayer = indexLayer;
  }

  /** 注入 dirty 标记回调 */
  setMarkDirtyCallback(cb: MarkDirtyCallback): void {
    this._markDirtyCallback = cb;
  }

  /** 注入关系类型 Schema */
  setRelationSchema(schema: RelationSchema): void {
    this._relationSchema = schema;
  }

  /** 获取当前 Schema */
  get relationSchema(): RelationSchema {
    return this._relationSchema;
  }

  // ─── 公共 API ─────────────────────────────────────────

  /**
   * 添加标注间关联。
   * v4.2: 双向自动维护 — 同时在目标标注上创建反向关系。
   */
  async addRelation(sourceUuid: string, relation: AnnotationRelation): Promise<void> {
    // 拦截自关系
    if (sourceUuid === relation.targetUuid) {
      throw new Error(`Self-relation is not allowed: ${sourceUuid}`);
    }

    const ann = this._indexLayer.byUuid.get(sourceUuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${sourceUuid}`);
    }

    const targetAnn = this._indexLayer.byUuid.get(relation.targetUuid);
    if (!targetAnn) {
      throw new Error(`Target annotation not found: ${relation.targetUuid}`);
    }

    // 初始化 relations 数组
    if (!ann.relations) ann.relations = [];

    // 去重增强：复用已失效条目
    const existingActive = ann.relations.find(
      r => r.targetUuid === relation.targetUuid
        && r.type === relation.type
        && !r.invalidAt
    );
    if (existingActive) {
      // 允许 source 升级
      if (relation.source && relation.source !== existingActive.source) {
        const sourcePriority: Record<string, number> = { manual: 4, template: 3, imported: 2, inferred: 1 };
        const newPriority = sourcePriority[relation.source] ?? 0;
        const oldPriority = sourcePriority[existingActive.source ?? ''] ?? 0;
        if (newPriority > oldPriority) {
          existingActive.source = relation.source;
          if (relation.note) existingActive.note = relation.note;
          this._markDirty(ann.filePath);
        }
      }
      return;
    }

    const existingInvalidated = ann.relations.find(
      r => r.targetUuid === relation.targetUuid
        && r.type === relation.type
        && r.invalidAt
    );

    if (existingInvalidated) {
      existingInvalidated.invalidAt = undefined;
      if (relation.note) existingInvalidated.note = relation.note;
      if (relation.source) existingInvalidated.source = relation.source;
    } else {
      // 正向关系 push — 这是唯一允许在构建器外直接 push 的场景
      // （正向关系由用户/API 传入，构建器只负责反向关系）
      ann.relations.push(relation);
      let fwdOutSet = this._indexLayer.byRelationOut.get(sourceUuid);
      if (!fwdOutSet) {
        fwdOutSet = new Set();
        this._indexLayer.byRelationOut.set(sourceUuid, fwdOutSet);
      }
      fwdOutSet.add(`${relation.targetUuid}:${relation.type}`);
      let fwdInSet = this._indexLayer.byRelationIn.get(relation.targetUuid);
      if (!fwdInSet) {
        fwdInSet = new Set();
        this._indexLayer.byRelationIn.set(relation.targetUuid, fwdInSet);
      }
      fwdInSet.add(`${sourceUuid}:${relation.type}`);
    }
    this._markDirty(ann.filePath);

    // 自动创建/恢复反向关系
    const reverseType = this._relationSchema.getReverse(relation.type);
    if (!reverseType) {
      this._markDirty(ann.filePath);
      return;
    }

    if (!targetAnn.relations) targetAnn.relations = [];

    const existingReverseInvalidated = targetAnn.relations.find(
      r => r.targetUuid === sourceUuid
        && r.type === reverseType
        && r.invalidAt
    );

    if (existingReverseInvalidated) {
      existingReverseInvalidated.invalidAt = undefined;
      this._markDirty(targetAnn.filePath);
      return;
    }

    const reverseActive = targetAnn.relations.some(
      r => r.targetUuid === sourceUuid && r.type === reverseType && !r.invalidAt
    );
    if (reverseActive) {
      return;
    }

    // 新建反向关系 — 使用统一构建器
    targetAnn.relations.push(buildReverseRelation(sourceUuid, relation, reverseType));
    let outSet = this._indexLayer.byRelationOut.get(relation.targetUuid);
    if (!outSet) {
      outSet = new Set();
      this._indexLayer.byRelationOut.set(relation.targetUuid, outSet);
    }
    outSet.add(`${sourceUuid}:${reverseType}`);
    let inSet = this._indexLayer.byRelationIn.get(sourceUuid);
    if (!inSet) {
      inSet = new Set();
      this._indexLayer.byRelationIn.set(sourceUuid, inSet);
    }
    inSet.add(`${relation.targetUuid}:${reverseType}`);
    this._markDirty(targetAnn.filePath);
  }

  /**
   * 移除标注间关联（物理删除）。
   * v4.2: 同时删除反向关系。
   */
  async removeRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
    const ann = this._indexLayer.byUuid.get(sourceUuid);
    if (!ann || !ann.relations) return;

    const idx = ann.relations.findIndex(r => r.targetUuid === targetUuid && r.type === type);
    if (idx === -1) return;

    // 增量删除正向关系 + 索引清理
    ann.relations.splice(idx, 1);
    if (ann.relations.length === 0) {
      delete ann.relations;
    }

    const fwdOutSet = this._indexLayer.byRelationOut.get(sourceUuid);
    if (fwdOutSet) {
      fwdOutSet.delete(`${targetUuid}:${type}`);
      if (fwdOutSet.size === 0) this._indexLayer.byRelationOut.delete(sourceUuid);
    }
    const fwdInSet = this._indexLayer.byRelationIn.get(targetUuid);
    if (fwdInSet) {
      fwdInSet.delete(`${sourceUuid}:${type}`);
      if (fwdInSet.size === 0) this._indexLayer.byRelationIn.delete(targetUuid);
    }
    this._markDirty(ann.filePath);

    // 同步删除反向关系
    const reverseType = this._relationSchema.getReverse(type);
    const targetAnn = this._indexLayer.byUuid.get(targetUuid);
    if (reverseType && targetAnn?.relations) {
      const reverseIdx = targetAnn.relations.findIndex(
        r => r.targetUuid === sourceUuid && r.type === reverseType
      );
      if (reverseIdx !== -1) {
        targetAnn.relations.splice(reverseIdx, 1);
        if (targetAnn.relations.length === 0) {
          delete targetAnn.relations;
        }
        const outSet = this._indexLayer.byRelationOut.get(targetUuid);
        if (outSet) {
          outSet.delete(`${sourceUuid}:${reverseType}`);
          if (outSet.size === 0) this._indexLayer.byRelationOut.delete(targetUuid);
        }
        const inSet = this._indexLayer.byRelationIn.get(sourceUuid);
        if (inSet) {
          inSet.delete(`${targetUuid}:${reverseType}`);
          if (inSet.size === 0) this._indexLayer.byRelationIn.delete(sourceUuid);
        }
        this._markDirty(targetAnn.filePath);
      }
    }
  }

  /**
   * 使关系失效（软删除）。
   */
  async invalidateRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
    const ann = this._indexLayer.byUuid.get(sourceUuid);
    if (!ann || !ann.relations) return;

    const rel = ann.relations.find(
      r => r.targetUuid === targetUuid && r.type === type && !r.invalidAt
    );
    if (!rel) return;

    const now = Date.now();
    rel.invalidAt = now;
    this._markDirty(ann.filePath);

    // 同步使反向关系失效
    const reverseType = this._relationSchema.getReverse(type);
    const targetAnn = this._indexLayer.byUuid.get(targetUuid);
    if (reverseType && targetAnn?.relations) {
      const reverseRel = targetAnn.relations.find(
        r => r.targetUuid === sourceUuid && r.type === reverseType && !r.invalidAt
      );
      if (reverseRel) {
        reverseRel.invalidAt = now;
        this._markDirty(targetAnn.filePath);
      }
    }
  }

  /**
   * 批量失效指定关系类型的所有关系。
   */
  async invalidateRelationsByType(type: RelationType): Promise<number> {
    const reverseType = this._relationSchema.getReverse(type);
    const now = Date.now();
    let count = 0;

    for (const ann of this._indexLayer.byUuid.values()) {
      if (!ann.relations) continue;

      for (const rel of ann.relations) {
        if (rel.type === type && !rel.invalidAt) {
          rel.invalidAt = now;
          count++;
          this._markDirty(ann.filePath);
        }
        if (reverseType && reverseType !== type && rel.type === reverseType && !rel.invalidAt) {
          rel.invalidAt = now;
          count++;
          this._markDirty(ann.filePath);
        }
      }
    }

    return count;
  }

  /**
   * 恢复已失效的关系（双向级联）。
   */
  async restoreRelation(sourceUuid: string, targetUuid: string, type: RelationType): Promise<void> {
    const ann = this._indexLayer.byUuid.get(sourceUuid);
    if (!ann?.relations) return;

    const rel = ann.relations.find(
      r => r.targetUuid === targetUuid && r.type === type && r.invalidAt
    );
    if (!rel) return;

    rel.invalidAt = undefined;
    this._markDirty(ann.filePath);

    // 级联恢复反向关系
    const reverseType = this._relationSchema.getReverse(type);
    const targetAnn = this._indexLayer.byUuid.get(targetUuid);
    if (reverseType && targetAnn?.relations) {
      const reverseRel = targetAnn.relations.find(
        r => r.targetUuid === sourceUuid && r.type === reverseType && r.invalidAt
      );
      if (reverseRel) {
        reverseRel.invalidAt = undefined;
        this._markDirty(targetAnn.filePath);
      }
    }
  }

  /**
   * 获取标注的所有关联（出边 + 入边）。
   */
  getRelations(uuid: string, options?: { includeInvalidated?: boolean }): { outgoing: AnnotationRelation[]; incoming: Array<{ sourceUuid: string; relation: AnnotationRelation }> } {
    const includeInvalidated = options?.includeInvalidated ?? false;
    const result: { outgoing: AnnotationRelation[]; incoming: Array<{ sourceUuid: string; relation: AnnotationRelation }> } = {
      outgoing: [],
      incoming: [],
    };

    // 出边
    const ann = this._indexLayer.byUuid.get(uuid);
    if (ann?.relations) {
      result.outgoing = includeInvalidated
        ? [...ann.relations]
        : ann.relations.filter(r => !r.invalidAt);
    }

    // 入边
    const inSet = this._indexLayer.byRelationIn.get(uuid);
    if (inSet) {
      for (const entry of inSet) {
        const colonIdx = entry.indexOf(':');
        const sourceUuid = entry.substring(0, colonIdx);
        const relType = entry.substring(colonIdx + 1) as RelationType;
        const sourceAnn = this._indexLayer.byUuid.get(sourceUuid);
        if (sourceAnn?.relations) {
          const rel = sourceAnn.relations.find(r => r.targetUuid === uuid && r.type === relType);
          if (rel && (includeInvalidated || !rel.invalidAt)) {
            result.incoming.push({ sourceUuid, relation: rel });
          }
        }
      }
    }

    return result;
  }

  // ─── 级联操作（内部使用，由 AnnotationStore 调用） ──────

  /**
   * 删除标注前级联清理伙伴标注上的反向关系数据。
   */
  cascadeDeleteRelations(ann: Annotation): void {
    if (!ann.relations || ann.relations.length === 0) return;

    for (const rel of ann.relations) {
      const partnerAnn = this._indexLayer.byUuid.get(rel.targetUuid);
      if (!partnerAnn?.relations) continue;

      const reverseType = this._relationSchema.getReverse(rel.type);
      if (!reverseType) continue;

      const reverseIdx = partnerAnn.relations.findIndex(
        r => r.targetUuid === ann.uuid && r.type === reverseType
      );
      if (reverseIdx !== -1) {
        partnerAnn.relations.splice(reverseIdx, 1);
        if (partnerAnn.relations.length === 0) {
          delete partnerAnn.relations;
        }

        // 增量清理伙伴的出边索引 (partner → ann 的反向关系)
        const partnerOutSet = this._indexLayer.byRelationOut.get(rel.targetUuid);
        if (partnerOutSet) {
          partnerOutSet.delete(`${ann.uuid}:${reverseType}`);
          if (partnerOutSet.size === 0) this._indexLayer.byRelationOut.delete(rel.targetUuid);
        }
        // 增量清理被删标注的入边索引 (ann ← partner 的反向关系)
        const annInSet = this._indexLayer.byRelationIn.get(ann.uuid);
        if (annInSet) {
          annInSet.delete(`${rel.targetUuid}:${reverseType}`);
          if (annInSet.size === 0) this._indexLayer.byRelationIn.delete(ann.uuid);
        }

        // P3 修复: 同时清理伙伴的入边索引 (partner ← ann 的正向关系)
        // 原遗漏: 伙伴 B 的 byRelationIn 中残留 "ann:正向type" 孤儿条目
        const partnerInSet = this._indexLayer.byRelationIn.get(rel.targetUuid);
        if (partnerInSet) {
          partnerInSet.delete(`${ann.uuid}:${rel.type}`);
          if (partnerInSet.size === 0) this._indexLayer.byRelationIn.delete(rel.targetUuid);
        }
        // 同时清理被删标注的出边索引 (ann → partner 的正向关系)
        const annOutSet = this._indexLayer.byRelationOut.get(ann.uuid);
        if (annOutSet) {
          annOutSet.delete(`${rel.targetUuid}:${rel.type}`);
          if (annOutSet.size === 0) this._indexLayer.byRelationOut.delete(ann.uuid);
        }

        this._markDirty(partnerAnn.filePath);
      }
    }
  }

  /**
   * updateAnnotation 中 changes.relations 的级联处理。
   */
  cascadeUpdateRelations(
    sourceUuid: string,
    oldRelations: AnnotationRelation[],
    newRelations: AnnotationRelation[]
  ): void {
    // S3 关系审查修复: 自环防御 — addRelation 有校验，updateAnnotation 路径也需要
    for (const r of newRelations) {
      if (r.targetUuid === sourceUuid) {
        throw new Error(`Self-relation is not allowed: ${sourceUuid}`);
      }
    }

    const relKey = (r: AnnotationRelation) => `${r.targetUuid}::${r.type}::${r.invalidAt ? 'inv' : 'act'}`;

    const oldKeys = new Map<string, AnnotationRelation>();
    for (const r of oldRelations) oldKeys.set(relKey(r), r);

    const newKeys = new Map<string, AnnotationRelation>();
    for (const r of newRelations) newKeys.set(relKey(r), r);

    // 1. 清理被移除关系的伙伴反向数据
    for (const [key, oldRel] of oldKeys) {
      if (newKeys.has(key)) continue;

      const partnerAnn = this._indexLayer.byUuid.get(oldRel.targetUuid);
      if (!partnerAnn?.relations) continue;

      const reverseType = this._relationSchema.getReverse(oldRel.type);
      if (!reverseType) continue;

      const reverseIdx = partnerAnn.relations.findIndex(
        r => r.targetUuid === sourceUuid && r.type === reverseType
      );
      if (reverseIdx !== -1) {
        partnerAnn.relations.splice(reverseIdx, 1);
        if (partnerAnn.relations.length === 0) {
          delete partnerAnn.relations;
        }

        const partnerOutSet = this._indexLayer.byRelationOut.get(oldRel.targetUuid);
        if (partnerOutSet) {
          partnerOutSet.delete(`${sourceUuid}:${reverseType}`);
          if (partnerOutSet.size === 0) this._indexLayer.byRelationOut.delete(oldRel.targetUuid);
        }
        const sourceInSet = this._indexLayer.byRelationIn.get(sourceUuid);
        if (sourceInSet) {
          sourceInSet.delete(`${oldRel.targetUuid}:${reverseType}`);
          if (sourceInSet.size === 0) this._indexLayer.byRelationIn.delete(sourceUuid);
        }

        // P3 修复: 同时清理伙伴入边 + 源出边的正向关系孤儿条目
        const partnerInSet = this._indexLayer.byRelationIn.get(oldRel.targetUuid);
        if (partnerInSet) {
          partnerInSet.delete(`${sourceUuid}:${oldRel.type}`);
          if (partnerInSet.size === 0) this._indexLayer.byRelationIn.delete(oldRel.targetUuid);
        }
        const sourceOutSet = this._indexLayer.byRelationOut.get(sourceUuid);
        if (sourceOutSet) {
          sourceOutSet.delete(`${oldRel.targetUuid}:${oldRel.type}`);
          if (sourceOutSet.size === 0) this._indexLayer.byRelationOut.delete(sourceUuid);
        }
      }
      this._markDirty(partnerAnn.filePath);
    }

    // 2. 为新增关系补建伙伴的反向关系
    for (const [key, newRel] of newKeys) {
      if (oldKeys.has(key)) continue;

      const partnerAnn = this._indexLayer.byUuid.get(newRel.targetUuid);
      if (!partnerAnn) continue;

      const reverseType = this._relationSchema.getReverse(newRel.type);
      if (!reverseType) continue;

      const alreadyHas = partnerAnn.relations?.some(
        r => r.targetUuid === sourceUuid && r.type === reverseType && !r.invalidAt
      );
      if (alreadyHas) continue;

      const existingReverseInvalidated = partnerAnn.relations?.find(
        r => r.targetUuid === sourceUuid && r.type === reverseType && r.invalidAt
      );

      if (existingReverseInvalidated) {
        existingReverseInvalidated.invalidAt = undefined;
        existingReverseInvalidated.createdAt = newRel.createdAt;
      } else {
        if (!partnerAnn.relations) partnerAnn.relations = [];
        // 使用统一构建器创建反向关系
        partnerAnn.relations.push(buildReverseRelation(sourceUuid, newRel, reverseType));

        let partnerOutSet = this._indexLayer.byRelationOut.get(newRel.targetUuid);
        if (!partnerOutSet) {
          partnerOutSet = new Set();
          this._indexLayer.byRelationOut.set(newRel.targetUuid, partnerOutSet);
        }
        partnerOutSet.add(`${sourceUuid}:${reverseType}`);

        let sourceInSet = this._indexLayer.byRelationIn.get(sourceUuid);
        if (!sourceInSet) {
          sourceInSet = new Set();
          this._indexLayer.byRelationIn.set(sourceUuid, sourceInSet);
        }
        sourceInSet.add(`${newRel.targetUuid}:${reverseType}`);
      }

      this._markDirty(partnerAnn.filePath);
    }
  }

  // ─── 内部方法 ─────────────────────────────────────────

  private _markDirty(filePath: string): void {
    if (this._markDirtyCallback) {
      this._markDirtyCallback(filePath);
    }
  }
}
