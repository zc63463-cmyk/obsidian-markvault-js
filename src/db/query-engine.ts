import type {
  Annotation,
  AnnotationFilter,
  AnnotationStats,
} from '../types/annotation';
import { applyUnifiedFilter } from '../search/filter-engine';
import type { IndexLayer } from './index-layer';

/**
 * QueryEngine — 查询引擎
 *
 * 负责：
 * - queryAnnotations（基于内存索引的多维过滤查询）
 * - getAnnotationStats（标注统计）
 */
export class QueryEngine {
  // ─── 依赖 ──────────────────────────────────────────────
  private _indexLayer: IndexLayer;

  constructor(indexLayer: IndexLayer) {
    this._indexLayer = indexLayer;
  }

  /**
   * 基于内存索引的查询，支持多维度过滤。
   */
  queryAnnotations(filter?: AnnotationFilter): Annotation[] {
    if (!filter) {
      return this._indexLayer.getAllAnnotations();
    }

    // 收集候选 uuid 集合（取交集）
    let candidateUuids: Set<string> | null = null;

    // 按样式类型过滤
    if (filter.type && filter.type !== 'all') {
      const typeSet = this._indexLayer.byType.get(filter.type);
      if (!typeSet) return [];
      candidateUuids = new Set(typeSet);
    }

    // 按颜色过滤
    if (filter.color && filter.color !== 'all') {
      const colorSet = this._indexLayer.byColor.get(filter.color);
      if (!colorSet) return [];
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, colorSet);
      } else {
        candidateUuids = new Set(colorSet);
      }
    }

    // 按自定义字段过滤 (单值)
    if (filter.fieldFilters && Object.keys(filter.fieldFilters).length > 0) {
      for (const [fieldKey, fieldValue] of Object.entries(filter.fieldFilters)) {
        const fieldMap = resolveFieldMap(this._indexLayer.byField, fieldKey);
        if (!fieldMap) return [];
        const valueSet = fieldMap.get(fieldValue);
        if (!valueSet) return [];
        if (candidateUuids) {
          candidateUuids = intersection(candidateUuids, valueSet);
        } else {
          candidateUuids = new Set(valueSet);
        }
      }
    }

    // P3 fix: 按自定义字段过滤 (分面多值, 同 key OR 跨 key AND)
    if (filter.fieldFiltersMulti && Object.keys(filter.fieldFiltersMulti).length > 0) {
      for (const [fieldKey, fieldValues] of Object.entries(filter.fieldFiltersMulti)) {
        const fieldMap = resolveFieldMap(this._indexLayer.byField, fieldKey);
        if (!fieldMap) return [];
        // 同 key 内 OR：union 所有值的 UUID 集合
        let keyUuids: Set<string> | null = null;
        for (const v of fieldValues) {
          const valueSet = fieldMap.get(v);
          if (!valueSet) continue;
          if (keyUuids) {
            for (const uuid of valueSet) keyUuids.add(uuid);
          } else {
            keyUuids = new Set(valueSet);
          }
        }
        if (!keyUuids) return [];
        // 跨 key AND：intersect
        if (candidateUuids) {
          candidateUuids = intersection(candidateUuids, keyUuids);
        } else {
          candidateUuids = keyUuids;
        }
      }
    }

    // 按掌握度过滤
    if (filter.mastery && filter.mastery !== 'all') {
      const masterySet = this._indexLayer.byMastery.get(filter.mastery);
      if (!masterySet) return [];
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, masterySet);
      } else {
        candidateUuids = new Set(masterySet);
      }
    }

    // 按复习优先级过滤
    if (filter.reviewPriority && filter.reviewPriority !== 'all') {
      const prioritySet = this._indexLayer.byReviewPriority.get(filter.reviewPriority);
      if (!prioritySet) return [];
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, prioritySet);
      } else {
        candidateUuids = new Set(prioritySet);
      }
    }

    // 按分组过滤
    if (filter.group && filter.group !== 'all') {
      const groupSet = this._indexLayer.byGroup.get(filter.group);
      if (!groupSet) return [];
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, groupSet);
      } else {
        candidateUuids = new Set(groupSet);
      }
    }

    // 按动机过滤
    if (filter.motivation && filter.motivation !== 'all') {
      const motSet = this._indexLayer.byMotivation.get(filter.motivation);
      if (!motSet) return [];
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, motSet);
      } else {
        candidateUuids = new Set(motSet);
      }
    }

    // 按标签过滤 (AND 语义 + 层级前缀匹配)
    if (filter.tags && filter.tags.length > 0) {
      let tagCandidates: Set<string> | null = null;
      for (const requested of filter.tags) {
        // 收集该标签及所有子标签的 UUID
        let tagUuids: Set<string> | null = null;
        for (const [tagName, uuidSet] of this._indexLayer.byTag.entries()) {
          if (tagName === requested || tagName.startsWith(requested + '/')) {
            if (tagUuids) {
              for (const uuid of uuidSet) tagUuids.add(uuid);
            } else {
              tagUuids = new Set(uuidSet);
            }
          }
        }
        if (!tagUuids) return []; // 有标签完全无匹配
        if (tagCandidates) {
          tagCandidates = intersection(tagCandidates, tagUuids);
        } else {
          tagCandidates = tagUuids;
        }
      }
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, tagCandidates!);
      } else {
        candidateUuids = tagCandidates!;
      }
    }

    // 如果没有任何索引过滤，使用全部标注
    let results: Annotation[];
    if (candidateUuids) {
      results = [];
      for (const uuid of candidateUuids) {
        const ann = this._indexLayer.byUuid.get(uuid);
        if (ann) results.push(ann);
      }
    } else {
      results = this._indexLayer.getAllAnnotations();
    }

    // 统一后过滤 + 排序
    return applyUnifiedFilter(results, filter, filter.searchQuery);
  }

  /**
   * 获取标注统计。
   */
  getAnnotationStats(filePath?: string): AnnotationStats {
    const annotations = filePath
      ? this._indexLayer.getAnnotationsForFile(filePath)
      : this._indexLayer.getAllAnnotations();

    const byType: Record<string, number> = {};
    const byColor: Record<string, number> = {};
    let withNotes = 0;
    let withTags = 0;
    let withFields = 0;
    let withRelations = 0;
    let withGroups = 0;
    let withFlags = 0;
    let needsCorrection = 0;
    const byMastery: Record<string, number> = {};
    const byReviewPriority: Record<string, number> = {};
    const byMotivation: Record<string, number> = {};
    let withAlias = 0;

    for (const a of annotations) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      byColor[a.color] = (byColor[a.color] || 0) + 1;
      if (a.note && a.note.trim()) withNotes++;
      if (a.tags.length > 0) withTags++;
      if (a.fields && Object.keys(a.fields).length > 0) withFields++;
      if (a.relations && a.relations.some(r => !r.invalidAt)) withRelations++;
      if (a.groups && a.groups.length > 0) withGroups++;
      if (a.motivation) byMotivation[a.motivation] = (byMotivation[a.motivation] || 0) + 1;
      if (a.alias && a.alias.trim()) withAlias++;
      if (a.flags) {
        withFlags++;
        if (a.flags.mastery) byMastery[a.flags.mastery] = (byMastery[a.flags.mastery] || 0) + 1;
        if (a.flags.reviewPriority) byReviewPriority[a.flags.reviewPriority] = (byReviewPriority[a.flags.reviewPriority] || 0) + 1;
        if (a.flags.needsCorrection) needsCorrection++;
      }
    }

    return {
      total: annotations.length, byType, byColor, withNotes, withTags, withFields,
      withRelations, withGroups, withFlags, byMastery, byReviewPriority, needsCorrection,
      byMotivation, withAlias,
      orphanCount: 0,  // 孤儿标注需要异步检测，此处默认 0，由 OrphanPanel 单独扫描
    };
  }
}

// ─── 工具函数 ─────────────────────────────────────────

/**
 * 按 field key 查找 byField 索引，做 u: 前缀规范化
 * 与 filter-engine.applyUnifiedFilter 的字段匹配逻辑保持一致。
 */
function resolveFieldMap(
  byField: Map<string, Map<string, Set<string>>>,
  key: string,
): Map<string, Set<string>> | null {
  // 1. 精确匹配
  let m = byField.get(key);
  if (m) return m;
  // 2. 尝试添加 u: 前缀
  m = byField.get('u:' + key);
  if (m) return m;
  // 3. 如果本身以 u: 开头，尝试去掉前缀
  if (key.startsWith('u:')) {
    m = byField.get(key.slice(2));
    if (m) return m;
  }
  return null;
}

/** 计算两个 Set 的交集 */
function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) {
      result.add(item);
    }
  }
  return result;
}
