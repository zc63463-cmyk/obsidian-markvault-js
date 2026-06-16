import type {
  Annotation,
} from '../types/annotation';

/**
 * IndexLayer — 内存索引层
 *
 * 持有 12 个倒排索引 Map/Set，提供：
 * - addToIndex / removeFromIndex — 核心索引变更
 * - rebuildIncomingIndexFor — 入边索引重建
 * - 简单查询辅助方法（byUuid / byFile / count / all / fieldKeys 等）
 * - clearAll — 清空所有索引
 */
export class IndexLayer {
  // ─── 12 个索引 Map ────────────────────────────────────
  /** uuid → Annotation，O(1) 精确查找 */
  private _byUuid: Map<string, Annotation> = new Map();

  /** filePath → Set<uuid>，按文件索引 */
  private _byFile: Map<string, Set<string>> = new Map();

  /** kind → Set<uuid>，按标注类型索引（inline/block/span） */
  private _byKind: Map<string, Set<string>> = new Map();

  /** type → Set<uuid>，按标注样式索引（highlight/bold/underline） */
  private _byType: Map<string, Set<string>> = new Map();

  /** color → Set<uuid>，按颜色索引 */
  private _byColor: Map<string, Set<string>> = new Map();

  /** tag → Set<uuid>，按标签索引 */
  private _byTag: Map<string, Set<string>> = new Map();

  /** fieldKey → (fieldValue → Set<uuid>)，按自定义字段索引 */
  private _byField: Map<string, Map<string, Set<string>>> = new Map();

  /** sourceUuid → Set<targetUuid:relationType>，出边索引 */
  private _byRelationOut: Map<string, Set<string>> = new Map();

  /** targetUuid → Set<sourceUuid:relationType>，入边索引 */
  private _byRelationIn: Map<string, Set<string>> = new Map();

  /** group → Set<uuid>，按分组索引 */
  private _byGroup: Map<string, Set<string>> = new Map();

  /** mastery → Set<uuid>，按掌握度索引 */
  private _byMastery: Map<string, Set<string>> = new Map();

  /** reviewPriority → Set<uuid>，按复习优先级索引 */
  private _byReviewPriority: Map<string, Set<string>> = new Map();

  /** motivation → Set<uuid>，按标注意图索引 */
  private _byMotivation: Map<string, Set<string>> = new Map();

  // ─── 公共只读访问器 ───────────────────────────────────
  get byUuid() { return this._byUuid; }
  get byFile() { return this._byFile; }
  get byKind() { return this._byKind; }
  get byType() { return this._byType; }
  get byColor() { return this._byColor; }
  get byTag() { return this._byTag; }
  get byField() { return this._byField; }
  get byRelationOut() { return this._byRelationOut; }
  get byRelationIn() { return this._byRelationIn; }
  get byGroup() { return this._byGroup; }
  get byMastery() { return this._byMastery; }
  get byReviewPriority() { return this._byReviewPriority; }
  get byMotivation() { return this._byMotivation; }

  // ─── 简单查询 ─────────────────────────────────────────

  /** O(1) 按 UUID 精确查找标注 */
  getAnnotationByUuid(uuid: string): Annotation | undefined {
    return this._byUuid.get(uuid);
  }

  /** 获取标注总数（O(1)） */
  getAnnotationCount(): number {
    return this._byUuid.size;
  }

  /** 获取指定文件的所有标注，按 startOffset 排序 */
  getAnnotationsForFile(filePath: string): Annotation[] {
    const uuidSet = this._byFile.get(filePath);
    if (!uuidSet) return [];

    const annotations: Annotation[] = [];
    for (const uuid of uuidSet) {
      const ann = this._byUuid.get(uuid);
      if (ann) annotations.push(ann);
    }

    return annotations.sort((a, b) => a.startOffset - b.startOffset);
  }

  /** 获取所有已加载的标注 */
  getAllAnnotations(): Annotation[] {
    const result: Annotation[] = [];
    for (const ann of this._byUuid.values()) {
      result.push(ann);
    }
    return result;
  }

  /** 获取所有已加载标注中出现过的字段键名列表 */
  getFieldKeys(): string[] {
    return Array.from(this._byField.keys()).sort();
  }

  /** 获取指定字段键的所有已出现值列表 */
  getFieldValues(key: string): string[] {
    const fieldMap = this._byField.get(key);
    if (!fieldMap) return [];
    return Array.from(fieldMap.keys()).sort();
  }

  /** 获取所有已加载标注中出现过的分组列表 */
  getGroupNames(): string[] {
    return Array.from(this._byGroup.keys()).sort();
  }

  // ─── 核心索引变更 ─────────────────────────────────────

  /**
   * 将标注添加到所有倒排索引。
   */
  addToIndex(annotation: Annotation): void {
    const { uuid } = annotation;

    // _byFile
    let fileSet = this._byFile.get(annotation.filePath);
    if (!fileSet) {
      fileSet = new Set();
      this._byFile.set(annotation.filePath, fileSet);
    }
    fileSet.add(uuid);

    // _byKind（kind 可选，默认 inline）
    const kind = annotation.kind || 'inline';
    let kindSet = this._byKind.get(kind);
    if (!kindSet) {
      kindSet = new Set();
      this._byKind.set(kind, kindSet);
    }
    kindSet.add(uuid);

    // _byType（highlight/bold/underline）
    let typeSet = this._byType.get(annotation.type);
    if (!typeSet) {
      typeSet = new Set();
      this._byType.set(annotation.type, typeSet);
    }
    typeSet.add(uuid);

    // _byColor
    let colorSet = this._byColor.get(annotation.color);
    if (!colorSet) {
      colorSet = new Set();
      this._byColor.set(annotation.color, colorSet);
    }
    colorSet.add(uuid);

    // _byTag
    for (const tag of annotation.tags) {
      let tagSet = this._byTag.get(tag);
      if (!tagSet) {
        tagSet = new Set();
        this._byTag.set(tag, tagSet);
      }
      tagSet.add(uuid);
    }

    // _byField
    if (annotation.fields) {
      for (const [key, value] of Object.entries(annotation.fields)) {
        let fieldMap = this._byField.get(key);
        if (!fieldMap) {
          fieldMap = new Map();
          this._byField.set(key, fieldMap);
        }
        let valueSet = fieldMap.get(value);
        if (!valueSet) {
          valueSet = new Set();
          fieldMap.set(value, valueSet);
        }
        valueSet.add(uuid);
      }
    }

    // v4.0: _byRelationOut（出边索引）
    if (annotation.relations) {
      const outSet = new Set<string>();
      for (const rel of annotation.relations) {
        outSet.add(`${rel.targetUuid}:${rel.type}`);
      }
      this._byRelationOut.set(uuid, outSet);

      // 同时维护入边索引
      for (const rel of annotation.relations) {
        let inSet = this._byRelationIn.get(rel.targetUuid);
        if (!inSet) {
          inSet = new Set();
          this._byRelationIn.set(rel.targetUuid, inSet);
        }
        inSet.add(`${uuid}:${rel.type}`);
      }
    }

    // v4.0: _byGroup
    if (annotation.groups) {
      for (const group of annotation.groups) {
        let groupSet = this._byGroup.get(group);
        if (!groupSet) {
          groupSet = new Set();
          this._byGroup.set(group, groupSet);
        }
        groupSet.add(uuid);
      }
    }

    // v4.0: _byMastery
    if (annotation.flags?.mastery) {
      let masterySet = this._byMastery.get(annotation.flags.mastery);
      if (!masterySet) {
        masterySet = new Set();
        this._byMastery.set(annotation.flags.mastery, masterySet);
      }
      masterySet.add(uuid);
    }

    // v4.0: _byReviewPriority
    if (annotation.flags?.reviewPriority) {
      let prioritySet = this._byReviewPriority.get(annotation.flags.reviewPriority);
      if (!prioritySet) {
        prioritySet = new Set();
        this._byReviewPriority.set(annotation.flags.reviewPriority, prioritySet);
      }
      prioritySet.add(uuid);
    }

    // v4.1: _byMotivation
    if (annotation.motivation) {
      let motivationSet = this._byMotivation.get(annotation.motivation);
      if (!motivationSet) {
        motivationSet = new Set();
        this._byMotivation.set(annotation.motivation, motivationSet);
      }
      motivationSet.add(uuid);
    }

    // 增量重建本标注被其他标注指向的反向入边索引
    this.rebuildIncomingIndexFor(uuid);
  }

  /**
   * 从所有倒排索引中移除标注。
   */
  removeFromIndex(uuid: string): void {
    const ann = this._byUuid.get(uuid);
    if (!ann) return;

    // _byFile
    const fileSet = this._byFile.get(ann.filePath);
    if (fileSet) {
      fileSet.delete(uuid);
      if (fileSet.size === 0) {
        this._byFile.delete(ann.filePath);
      }
    }

    // _byKind
    const kind = ann.kind || 'inline';
    const kindSet = this._byKind.get(kind);
    if (kindSet) {
      kindSet.delete(uuid);
      if (kindSet.size === 0) {
        this._byKind.delete(kind);
      }
    }

    // _byType
    const typeSet = this._byType.get(ann.type);
    if (typeSet) {
      typeSet.delete(uuid);
      if (typeSet.size === 0) {
        this._byType.delete(ann.type);
      }
    }

    // _byColor
    const colorSet = this._byColor.get(ann.color);
    if (colorSet) {
      colorSet.delete(uuid);
      if (colorSet.size === 0) {
        this._byColor.delete(ann.color);
      }
    }

    // _byTag
    for (const tag of ann.tags) {
      const tagSet = this._byTag.get(tag);
      if (tagSet) {
        tagSet.delete(uuid);
        if (tagSet.size === 0) {
          this._byTag.delete(tag);
        }
      }
    }

    // _byField
    if (ann.fields) {
      for (const [key, value] of Object.entries(ann.fields)) {
        const fieldMap = this._byField.get(key);
        if (fieldMap) {
          const valueSet = fieldMap.get(value);
          if (valueSet) {
            valueSet.delete(uuid);
            if (valueSet.size === 0) {
              fieldMap.delete(value);
            }
          }
          if (fieldMap.size === 0) {
            this._byField.delete(key);
          }
        }
      }
    }

    // v4.0: _byRelationOut（出边索引移除）
    // 只删除本标注自身的出边索引，不做交叉清理
    this._byRelationOut.delete(uuid);

    // v4.0: _byRelationIn（入边索引移除 — 本标注被其他标注指向的条目）
    // 只删除本标注自身的入边索引，不做交叉清理
    this._byRelationIn.delete(uuid);

    // v4.0: _byGroup
    if (ann.groups) {
      for (const group of ann.groups) {
        const groupSet = this._byGroup.get(group);
        if (groupSet) {
          groupSet.delete(uuid);
          if (groupSet.size === 0) {
            this._byGroup.delete(group);
          }
        }
      }
    }

    // v4.0: _byMastery
    if (ann.flags?.mastery) {
      const masterySet = this._byMastery.get(ann.flags.mastery);
      if (masterySet) {
        masterySet.delete(uuid);
        if (masterySet.size === 0) {
          this._byMastery.delete(ann.flags.mastery);
        }
      }
    }

    // v4.0: _byReviewPriority
    if (ann.flags?.reviewPriority) {
      const prioritySet = this._byReviewPriority.get(ann.flags.reviewPriority);
      if (prioritySet) {
        prioritySet.delete(uuid);
        if (prioritySet.size === 0) {
          this._byReviewPriority.delete(ann.flags.reviewPriority);
        }
      }
    }

    // v4.1: _byMotivation
    if (ann.motivation) {
      const motivationSet = this._byMotivation.get(ann.motivation);
      if (motivationSet) {
        motivationSet.delete(uuid);
        if (motivationSet.size === 0) {
          this._byMotivation.delete(ann.motivation);
        }
      }
    }
  }

  /**
   * 重建指定标注的入边索引 _byRelationIn[uuid]。
   *
   * 扫描所有其他标注的出边索引，将指向本 uuid 的入边重建。
   * 作为 addToIndex 的标准后置步骤。
   */
  rebuildIncomingIndexFor(uuid: string): void {
    for (const [sourceUuid, outSet] of this._byRelationOut) {
      if (sourceUuid === uuid) continue;
      for (const entry of outSet) {
        const colonIdx = entry.indexOf(':');
        const targetUuid = entry.slice(0, colonIdx);
        if (targetUuid === uuid) {
          let inSet = this._byRelationIn.get(uuid);
          if (!inSet) {
            inSet = new Set();
            this._byRelationIn.set(uuid, inSet);
          }
          inSet.add(`${sourceUuid}:${entry.slice(colonIdx + 1)}`);
        }
      }
    }
  }

  /** 清空所有索引 */
  clearAll(): void {
    this._byUuid.clear();
    this._byFile.clear();
    this._byKind.clear();
    this._byType.clear();
    this._byColor.clear();
    this._byTag.clear();
    this._byField.clear();
    this._byRelationOut.clear();
    this._byRelationIn.clear();
    this._byGroup.clear();
    this._byMastery.clear();
    this._byReviewPriority.clear();
    this._byMotivation.clear();
  }
}
