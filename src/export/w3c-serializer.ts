/**
 * W3C Web Annotation 序列化器
 *
 * Phase 3: 双向序列化 — MarkVault Annotation ↔ W3C Web Annotation Data Model
 *
 * 核心原则：
 * 1. 完全符合 W3C Web Annotation Model 规范
 * 2. MarkVault 特有字段使用自定义命名空间 `markvault:*` 扩展
 * 3. 往返保证：MarkVault → W3C → MarkVault 数据不丢失
 * 4. 关系完整性：AnnotationRelation 完整序列化/反序列化
 *
 * 参考：
 * - https://www.w3.org/TR/annotation-model/
 * - https://www.w3.org/TR/annotation-vocab/
 */

import type { Annotation, AnnotationRelation, AnnotationMotivation, RelationSource, MasteryLevel, ReviewPriority } from '../types/annotation';
import type {
  W3CAnnotation,
  W3CBody,
  W3CTarget,
  W3CSelector,
  W3CTextQuoteSelector,
  W3CTextPositionSelector,
  W3CRangeSelector,
  W3CRelationExtension,
  W3CFlagsExtension,
  W3CAnnotationCollection,
  W3CAnnotationPage,
  W3CExportOptions,
  W3CAgent,
} from './w3c-types';

// ═══════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════

const W3C_CONTEXT = 'http://www.w3.org/ns/anno.jsonld';
const LDP_CONTEXT = 'http://www.w3.org/ns/ldp.jsonld';

/** MarkVault → W3C motivation 映射（已经是 1:1 对齐，保留映射表用于未来扩展） */
const MOTIVATION_MAP: Record<string, string> = {
  commenting: 'commenting',
  highlighting: 'highlighting',
  questioning: 'questioning',
  editing: 'editing',
  bookmarking: 'bookmarking',
  replying: 'replying',
  classifying: 'classifying',
};

/** W3C → MarkVault motivation 反向映射 */
const REVERSE_MOTIVATION_MAP: Record<string, AnnotationMotivation> = {
  commenting: 'commenting',
  highlighting: 'highlighting',
  questioning: 'questioning',
  editing: 'editing',
  bookmarking: 'bookmarking',
  replying: 'replying',
  classifying: 'classifying',
};

const DEFAULT_ID_PREFIX = 'markvault';
const GENERATOR_INFO: W3CAgent = {
  type: 'Software',
  name: 'MarkVault (Obsidian Plugin)',
};

// ═══════════════════════════════════════════════════════
// 序列化：MarkVault → W3C
// ═══════════════════════════════════════════════════════

/**
 * 将单条 MarkVault Annotation 序列化为 W3C Web Annotation。
 *
 * 映射策略：
 * - uuid → id（加 idPrefix 前缀）
 * - motivation → motivation（直接映射，已是 W3C 标准值）
 * - note → body (TextualBody, purpose=commenting)
 * - tags → body (TextualBody, purpose=tagging)
 * - text/contextBefore/contextAfter → target.selector (TextQuoteSelector)
 * - startOffset/endOffset → target.selector (TextPositionSelector)
 * - region/block → target.selector (RangeSelector)
 * - 自定义字段 → markvault:* 扩展
 * - flags → markvault:flags 扩展
 * - relations → markvault:relations 扩展
 * - groups → markvault:groups 扩展
 */
export function serializeAnnotation(
  annotation: Annotation,
  idPrefix: string = DEFAULT_ID_PREFIX,
): W3CAnnotation {
  const w3c: W3CAnnotation = {
    '@context': W3C_CONTEXT,
    id: `${idPrefix}:${annotation.uuid}`,
    type: 'Annotation',
    created: timestampToISO(annotation.createdAt),
    modified: timestampToISO(annotation.updatedAt),
    generator: GENERATOR_INFO,
  };

  // ── motivation（已对齐 W3C） ──
  if (annotation.motivation) {
    w3c.motivation = MOTIVATION_MAP[annotation.motivation] || annotation.motivation;
  }

  // ── body 构建 ──
  const bodies = buildBodies(annotation);
  if (bodies.length > 0) {
    w3c.body = bodies;
  }

  // ── target 构建 ──
  w3c.target = buildTarget(annotation);

  // ── MarkVault 自定义扩展 ──
  w3c['markvault:type'] = annotation.type;
  w3c['markvault:color'] = annotation.color;
  w3c['markvault:kind'] = annotation.kind || 'inline';
  w3c['markvault:schemaVersion'] = annotation.schemaVersion || 1;

  if (annotation.tags && annotation.tags.length > 0) {
    w3c['markvault:tags'] = annotation.tags;
  }

  if (annotation.fields && Object.keys(annotation.fields).length > 0) {
    w3c['markvault:fields'] = annotation.fields;
  }

  if (annotation.groups && annotation.groups.length > 0) {
    w3c['markvault:groups'] = annotation.groups;
  }

  if (annotation.format) {
    w3c['markvault:format'] = annotation.format;
  }

  // v5.3: 图谱显示别名
  if (annotation.alias) {
    w3c['markvault:alias'] = annotation.alias;
  }

  // ── v2.0: 拆分标注 & 块级标注定位信息 ──
  if (annotation.groupUuid) {
    w3c['markvault:groupUuid'] = annotation.groupUuid;
  }
  if (annotation.blockType) {
    w3c['markvault:blockType'] = annotation.blockType;
  }
  if (annotation.targetLine !== undefined) {
    w3c['markvault:targetLine'] = annotation.targetLine;
  }
  if (annotation.anchorLine !== undefined) {
    w3c['markvault:anchorLine'] = annotation.anchorLine;
  }

  // ── v2.1: Span 标注片段位置 ──
  if (annotation.spanRanges && annotation.spanRanges.length > 0) {
    w3c['markvault:spanRanges'] = annotation.spanRanges;
  }

  // ── v2.2: 目标内容指纹（锚点漂移恢复） ──
  if (annotation.targetHash) {
    w3c['markvault:targetHash'] = annotation.targetHash;
  }

  // ── 行号信息（W3C TextPositionSelector 无行号概念，需扩展保留） ──
  if (annotation.startLine !== undefined) {
    w3c['markvault:startLine'] = annotation.startLine;
  }
  if (annotation.endLine !== undefined) {
    w3c['markvault:endLine'] = annotation.endLine;
  }

  // ── relations 序列化 ──
  if (annotation.relations && annotation.relations.length > 0) {
    w3c['markvault:relations'] = serializeRelations(annotation.relations);
  }

  // ── flags 序列化 ──
  if (annotation.flags && Object.keys(annotation.flags).length > 0) {
    w3c['markvault:flags'] = serializeFlags(annotation.flags);
  }

  // ── v6.0: 多文档类型支持 ──
  if (annotation.docType) {
    w3c['markvault:docType'] = annotation.docType;
  }
  if (annotation.selector) {
    w3c['markvault:selector'] = annotation.selector;
  }
  if (annotation.nodeId) {
    w3c['markvault:nodeId'] = annotation.nodeId;
  }
  if (annotation.annotationRef) {
    w3c['markvault:annotationRef'] = annotation.annotationRef;
  }

  return w3c;
}

/** 构建 W3C body 列表 */
function buildBodies(annotation: Annotation): W3CBody[] {
  const bodies: W3CBody[] = [];

  // 注释内容 → TextualBody (commenting)
  if (annotation.note && annotation.note.trim().length > 0) {
    bodies.push({
      type: 'TextualBody',
      value: annotation.note,
      format: 'text/plain',
      purpose: 'commenting',
    });
  }

  // 标签 → TextualBody (tagging) — 作为 W3C 标准语义
  for (const tag of annotation.tags) {
    bodies.push({
      type: 'TextualBody',
      value: tag,
      purpose: 'tagging',
    });
  }

  return bodies;
}

/** 构建 W3C target 及 selector */
function buildTarget(annotation: Annotation): W3CTarget {
  const target: W3CTarget = {
    source: annotation.filePath,
  };

  const selectors: W3CSelector[] = [];

  // ── TextQuoteSelector（基于 text + context） ──
  if (annotation.text && annotation.text.trim().length > 0) {
    const quoteSelector: W3CTextQuoteSelector = {
      type: 'TextQuoteSelector',
      exact: annotation.text,
    };
    if (annotation.contextBefore) {
      quoteSelector.prefix = annotation.contextBefore;
    }
    if (annotation.contextAfter) {
      quoteSelector.suffix = annotation.contextAfter;
    }
    selectors.push(quoteSelector);
  }

  // ── RangeSelector（region 标注） ──
  if (annotation.kind === 'region' && annotation.endLine) {
    const rangeSelector: W3CRangeSelector = {
      type: 'RangeSelector',
      startSelector: {
        type: 'TextPositionSelector',
        start: annotation.startOffset,
        end: annotation.startOffset + 1,  // 起始点：至少包含1个字符
      },
      endSelector: {
        type: 'TextPositionSelector',
        start: annotation.endOffset - 1,
        end: annotation.endOffset,
      },
    };
    selectors.push(rangeSelector);
  } else {
    // ── TextPositionSelector（字符偏移） ──
    selectors.push({
      type: 'TextPositionSelector',
      start: annotation.startOffset,
      end: annotation.endOffset,
    });
  }

  target.selector = selectors;
  return target;
}

/** 序列化关系数组 */
function serializeRelations(relations: AnnotationRelation[]): W3CRelationExtension[] {
  return relations.map(r => ({
    targetUuid: r.targetUuid,
    type: r.type,
    createdAt: timestampToISO(r.createdAt),
    ...(r.note ? { note: r.note } : {}),
    ...(r.invalidAt ? { invalidAt: timestampToISO(r.invalidAt) } : {}),
    ...(r.source ? { source: r.source } : {}),
  }));
}

/** 序列化学习状态标记 */
function serializeFlags(flags: Annotation['flags']): W3CFlagsExtension {
  const ext: W3CFlagsExtension = {};
  if (flags?.mastery) ext.mastery = flags.mastery;
  if (flags?.reviewPriority) ext.reviewPriority = flags.reviewPriority;
  if (flags?.confidence !== undefined) ext.confidence = flags.confidence;
  if (flags?.needsCorrection !== undefined) ext.needsCorrection = flags.needsCorrection;
  if (flags?.lastReviewedAt) ext.lastReviewedAt = timestampToISO(flags.lastReviewedAt);
  if (flags?.reviewCount !== undefined) ext.reviewCount = flags.reviewCount;
  return ext;
}

// ═══════════════════════════════════════════════════════
// 反序列化：W3C → MarkVault
// ═══════════════════════════════════════════════════════

/**
 * 从 W3C Web Annotation 反序列化为 MarkVault Annotation。
 *
 * 这是往返测试的关键函数：MarkVault → W3C → MarkVault 必须数据无损。
 *
 * @param w3c W3C 格式的标注
 * @param filePath 笔记文件路径（W3C target.source 可能不是完整路径，作为后备）
 * @returns MarkVault Annotation（部分字段可能缺失，由调用方补全）
 */
export function deserializeAnnotation(
  w3c: W3CAnnotation,
  filePath?: string,
): Partial<Annotation> {
  // 提取 uuid（去掉前缀）
  const uuid = extractUuid(w3c.id);

  // 提取 filePath
  const extractedFilePath = extractFilePath(w3c.target, filePath);

  // 提取 text, contextBefore, contextAfter
  const textParts = extractTextParts(w3c.target);

  // 提取 offsets
  const offsets = extractOffsets(w3c.target);

  const annotation: Partial<Annotation> = {
    uuid,
    filePath: extractedFilePath || filePath || '',
    type: w3c['markvault:type'] as Annotation['type'] || 'highlight',
    color: w3c['markvault:color'] || 'yellow',
    text: textParts.text || '',
    note: extractNote(w3c.body),
    tags: extractTags(w3c),
    startOffset: offsets.startOffset,
    endOffset: offsets.endOffset,
    startLine: w3c['markvault:startLine'] ?? offsets.startLine,
    endLine: w3c['markvault:endLine'] ?? offsets.endLine,
    contextBefore: textParts.contextBefore || '',
    contextAfter: textParts.contextAfter || '',
    createdAt: w3c.created ? ISOParse(w3c.created) : Date.now(),
    updatedAt: w3c.modified ? ISOParse(w3c.modified) : Date.now(),
    kind: (w3c['markvault:kind'] as Annotation['kind']) ?? 'inline',
    motivation: w3c.motivation
      ? (REVERSE_MOTIVATION_MAP[w3c.motivation] || w3c.motivation as AnnotationMotivation)
      : undefined,
    schemaVersion: w3c['markvault:schemaVersion'] || 2,
    format: w3c['markvault:format'] as Annotation['format'],
    fields: w3c['markvault:fields'],
    groups: w3c['markvault:groups'],
    // v2.0: 拆分标注 & 块级标注定位
    groupUuid: w3c['markvault:groupUuid'],
    blockType: w3c['markvault:blockType'],
    targetLine: w3c['markvault:targetLine'],
    anchorLine: w3c['markvault:anchorLine'],
    // v2.1: Span 标注片段
    spanRanges: w3c['markvault:spanRanges'],
    // v2.2: 目标内容指纹
    targetHash: w3c['markvault:targetHash'],
    // v5.3: 图谱显示别名
    alias: w3c['markvault:alias'],
    relations: w3c['markvault:relations']
      ? deserializeRelations(w3c['markvault:relations'])
      : undefined,
    flags: w3c['markvault:flags']
      ? deserializeFlags(w3c['markvault:flags'])
      : undefined,
    // v6.0: 多文档类型支持
    docType: w3c['markvault:docType'] as Annotation['docType'],
    selector: w3c['markvault:selector'] as Annotation['selector'],
    nodeId: w3c['markvault:nodeId'] as string | undefined,
    annotationRef: w3c['markvault:annotationRef'] as string | undefined,
  };

  // 清理 undefined 字段
  Object.keys(annotation).forEach(key => {
    if (annotation[key as keyof typeof annotation] === undefined) {
      delete annotation[key as keyof typeof annotation];
    }
  });

  return annotation;
}

/** 从 W3C id 提取 uuid（去掉 idPrefix: 前缀） */
function extractUuid(w3cId: string): string {
  const colonIdx = w3cId.lastIndexOf(':');
  if (colonIdx >= 0) {
    return w3cId.substring(colonIdx + 1);
  }
  return w3cId;
}

/** 从 W3C target 提取 filePath */
function extractFilePath(
  target: W3CTarget | W3CTarget[] | undefined,
  fallback?: string,
): string | undefined {
  if (!target) return fallback;
  const t = Array.isArray(target) ? target[0] : target;
  return t.source || fallback;
}

/** 从 W3C target.selector 提取文本和上下文 */
function extractTextParts(target: W3CTarget | W3CTarget[] | undefined): {
  text?: string;
  contextBefore?: string;
  contextAfter?: string;
} {
  if (!target) return {};
  const t = Array.isArray(target) ? target[0] : target;
  if (!t.selector) return {};

  const selectors = Array.isArray(t.selector) ? t.selector : [t.selector];

  for (const sel of selectors) {
    if (sel.type === 'TextQuoteSelector') {
      return {
        text: sel.exact,
        contextBefore: sel.prefix,
        contextAfter: sel.suffix,
      };
    }
  }
  return {};
}

/** 从 W3C target.selector 提取偏移量 */
function extractOffsets(target: W3CTarget | W3CTarget[] | undefined): {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
} {
  if (!target) return { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 };
  const t = Array.isArray(target) ? target[0] : target;
  if (!t.selector) return { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 };

  const selectors = Array.isArray(t.selector) ? t.selector : [t.selector];

  // 优先使用 TextPositionSelector
  for (const sel of selectors) {
    if (sel.type === 'TextPositionSelector') {
      return {
        startOffset: sel.start,
        endOffset: sel.end,
        startLine: 0,  // W3C TextPosition 无行号信息
        endLine: 0,
      };
    }
  }

  // 其次使用 RangeSelector 的 startSelector
  for (const sel of selectors) {
    if (sel.type === 'RangeSelector') {
      return {
        startOffset: sel.startSelector.start,
        endOffset: sel.endSelector.end,
        startLine: 0,
        endLine: 0,
      };
    }
  }

  return { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 };
}

/** 从 W3C body 提取 note */
function extractNote(body: W3CBody | W3CBody[] | undefined): string {
  if (!body) return '';
  const bodies = Array.isArray(body) ? body : [body];
  for (const b of bodies) {
    if (b.purpose === 'commenting' && b.value) {
      return b.value;
    }
  }
  // 如果没有 commenting purpose，取第一个 TextualBody
  for (const b of bodies) {
    if (b.value) return b.value;
  }
  return '';
}

/** 从 W3C 提取 tags（优先用 markvault:tags 扩展，其次从 body tagging 提取） */
function extractTags(w3c: W3CAnnotation): string[] {
  if (w3c['markvault:tags'] && w3c['markvault:tags'].length > 0) {
    return w3c['markvault:tags'];
  }
  if (!w3c.body) return [];
  const bodies = Array.isArray(w3c.body) ? w3c.body : [w3c.body];
  return bodies
    .filter(b => b.purpose === 'tagging' && b.value)
    .map(b => b.value);
}

/** 合法的 RelationSource 值集合 */
const VALID_RELATION_SOURCES = new Set<string>(['manual', 'template', 'inferred', 'imported']);

/** 合法的 MasteryLevel 值集合 */
const VALID_MASTERY_LEVELS = new Set<string>(['unknown', 'learning', 'familiar', 'mastered']);

/** 合法的 ReviewPriority 值集合 */
const VALID_REVIEW_PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);

/** 合法的 confidence 值范围 */
const VALID_CONFIDENCE_RANGE = { min: 1, max: 5 } as const;

/** 反序列化关系数组 */
function deserializeRelations(extensions: W3CRelationExtension[]): AnnotationRelation[] {
  return extensions.map(r => ({
    targetUuid: r.targetUuid,
    type: r.type,
    createdAt: r.createdAt ? ISOParse(r.createdAt) : Date.now(),
    ...(r.note ? { note: r.note } : {}),
    ...(r.invalidAt ? { invalidAt: ISOParse(r.invalidAt) } : {}),
    ...(r.source && VALID_RELATION_SOURCES.has(r.source)
      ? { source: r.source as RelationSource }
      : {}),
  }));
}

/** 反序列化学习状态标记 — 显式校验类型，非法值 fallback 到默认值而非静默存入 */
function deserializeFlags(ext: W3CFlagsExtension): Annotation['flags'] {
  const flags: Annotation['flags'] = {};

  // mastery: 必须是 MasteryLevel 合法值
  if (ext.mastery) {
    if (VALID_MASTERY_LEVELS.has(ext.mastery)) {
      flags.mastery = ext.mastery as MasteryLevel;
    }
    // 非法值静默忽略（不存入 Store）
  }

  // reviewPriority: 必须是 ReviewPriority 合法值
  if (ext.reviewPriority) {
    if (VALID_REVIEW_PRIORITIES.has(ext.reviewPriority)) {
      flags.reviewPriority = ext.reviewPriority as ReviewPriority;
    }
    // 非法值静默忽略
  }

  // confidence: 必须是 1-5 整数
  if (ext.confidence !== undefined) {
    const c = typeof ext.confidence === 'number'
      ? ext.confidence
      : Number(ext.confidence);
    if (Number.isInteger(c) && c >= VALID_CONFIDENCE_RANGE.min && c <= VALID_CONFIDENCE_RANGE.max) {
      flags.confidence = c as 1 | 2 | 3 | 4 | 5;
    }
    // 非法值（非整数、超出范围）静默忽略
  }

  if (ext.needsCorrection !== undefined) flags.needsCorrection = ext.needsCorrection;
  if (ext.lastReviewedAt) flags.lastReviewedAt = ISOParse(ext.lastReviewedAt);
  if (ext.reviewCount !== undefined) flags.reviewCount = ext.reviewCount;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

// ═══════════════════════════════════════════════════════
// 导出 API：集合/分页
// ═══════════════════════════════════════════════════════

/**
 * 将标注数组序列化为 W3C AnnotationCollection。
 * 支持分页（AnnotationPage）或直接内联 items。
 *
 * @param annotations 标注数组
 * @param options 选项
 */
export function serializeCollection(
  annotations: Annotation[],
  options: W3CExportOptions = {},
): W3CAnnotationCollection {
  const {
    idPrefix = DEFAULT_ID_PREFIX,
    pageSize = 0,
    label,
  } = options;

  const collectionId = `${idPrefix}:collection`;
  const w3cAnnotations = annotations.map(a => serializeAnnotation(a, idPrefix));

  const collection: W3CAnnotationCollection = {
    '@context': [W3C_CONTEXT, LDP_CONTEXT],
    id: collectionId,
    type: 'AnnotationCollection',
    total: w3cAnnotations.length,
    modified: timestampToISO(Date.now()),
  };

  if (label) {
    collection.label = label;
  }

  if (pageSize > 0 && w3cAnnotations.length > pageSize) {
    // 分页模式：生成完整分页链
    const totalPages = Math.ceil(w3cAnnotations.length / pageSize);

    const pages: W3CAnnotationPage[] = [];
    for (let i = 0; i < totalPages; i++) {
      const page: W3CAnnotationPage = {
        '@context': [W3C_CONTEXT],
        id: `${collectionId}/page${i + 1}`,
        type: 'AnnotationPage',
        partOf: collectionId,
        startIndex: i * pageSize,
        items: w3cAnnotations.slice(i * pageSize, (i + 1) * pageSize),
      };
      // 链接下一页
      if (i + 1 < totalPages) {
        page.next = `${collectionId}/page${i + 2}`;
      }
      // 链接上一页
      if (i > 0) {
        page.prev = `${collectionId}/page${i}`;
      }
      pages.push(page);
    }

    collection.first = pages[0];
    collection.last = pages[pages.length - 1];
  } else {
    // 内联模式：直接包含所有 items
    collection.items = w3cAnnotations;
  }

  return collection;
}

// ═══════════════════════════════════════════════════════
// 过滤 & 查询
// ═══════════════════════════════════════════════════════

/**
 * 根据导出选项过滤标注列表。
 * 此函数独立于 AnnotationStore，接受已加载的标注数组。
 */
export function filterAnnotationsForExport(
  annotations: Annotation[],
  options: W3CExportOptions,
): Annotation[] {
  let results = annotations;

  if (options.filePath) {
    results = results.filter(a => a.filePath === options.filePath);
  }

  if (options.motivation) {
    results = results.filter(a => a.motivation === options.motivation);
  }

  if (options.kind) {
    results = results.filter(a => (a.kind || 'inline') === options.kind);
  }

  if (options.relationType) {
    results = results.filter(a =>
      a.relations?.some(r => r.type === options.relationType && !r.invalidAt)
    );
  }

  return results;
}

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

/** 将毫秒时间戳转为 ISO 8601 字符串 */
function timestampToISO(ts: number): string {
  return new Date(ts).toISOString();
}

/** 将 ISO 8601 字符串解析为毫秒时间戳 */
function ISOParse(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? Date.now() : ts;
}
