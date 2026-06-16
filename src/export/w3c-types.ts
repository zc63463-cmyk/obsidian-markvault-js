/**
 * W3C Web Annotation Data Model 类型定义
 *
 * 基于 https://www.w3.org/TR/annotation-model/ 规范。
 * 这些类型定义了 MarkVault 与外部 W3C 兼容工具（如 Hypothesis）互操作的接口格式。
 *
 * Phase 3: 双向序列化支持
 * - serializeAnnotation()  → MarkVault Annotation → W3C
 * - deserializeAnnotation() → W3C → MarkVault Annotation
 */

// ═══════════════════════════════════════════════════════
// W3C Annotation 核心结构
// ═══════════════════════════════════════════════════════

/** W3C Web Annotation 完整结构 */
export interface W3CAnnotation {
  '@context': string;
  id: string;
  type: 'Annotation';
  motivation?: string;
  body?: W3CBody | W3CBody[];
  target?: W3CTarget | W3CTarget[];
  created?: string;
  modified?: string;
  creator?: W3CAgent;
  generator?: W3CAgent;
  // ── MarkVault 自定义扩展命名空间 ──
  'markvault:type'?: string;
  'markvault:color'?: string;
  'markvault:kind'?: string;
  'markvault:relations'?: W3CRelationExtension[];
  'markvault:flags'?: W3CFlagsExtension;
  'markvault:groups'?: string[];
  'markvault:fields'?: Record<string, string>;
  'markvault:tags'?: string[];
  'markvault:format'?: string;
  'markvault:schemaVersion'?: number;
  // v2.0: 拆分标注 & 块级标注
  'markvault:groupUuid'?: string;
  'markvault:blockType'?: string;
  'markvault:targetLine'?: number;
  'markvault:anchorLine'?: number;
  // v2.1: Span 标注片段位置
  'markvault:spanRanges'?: W3CSpanRange[];
  // v2.2: 目标内容指纹（锚点漂移恢复）
  'markvault:targetHash'?: string;
  // v5.3: 图谱显示别名
  'markvault:alias'?: string;
  // 行号信息（W3C TextPositionSelector 无行号概念，需扩展保留）
  'markvault:startLine'?: number;
  'markvault:endLine'?: number;
}

/** W3C TextualBody — 标注的内容主体 */
export interface W3CBody {
  type: 'TextualBody';
  value: string;
  format?: string;
  language?: string;
  purpose?: string;
}

/** W3C Target — 标注指向的资源 */
export interface W3CTarget {
  source: string;
  selector?: W3CSelector | W3CSelector[];
  state?: any;           // HTTP 状态表示（可选）
  styleClass?: string;   // CSS 类名（可选）
  format?: string;       // 资源 MIME 类型
  language?: string;     // 资源语言
}

// ═══════════════════════════════════════════════════════
// W3C Selector 类型（联合类型）
// ═══════════════════════════════════════════════════════

export type W3CSelector =
  | W3CTextQuoteSelector
  | W3CTextPositionSelector
  | W3CRangeSelector
  | W3CFragmentSelector;

/** TextQuoteSelector — 通过精确文本 + 前后缀定位 */
export interface W3CTextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** TextPositionSelector — 通过字符偏移量定位 */
export interface W3CTextPositionSelector {
  type: 'TextPositionSelector';
  start: number;
  end: number;
}

/** RangeSelector — 通过起始/结束选择器定义范围（用于 region/block 标注） */
export interface W3CRangeSelector {
  type: 'RangeSelector';
  startSelector: W3CTextPositionSelector;
  endSelector: W3CTextPositionSelector;
}

/** FragmentSelector — URI 片段标识符（用于兼容场景） */
export interface W3CFragmentSelector {
  type: 'FragmentSelector';
  conformsTo: string;
  value: string;
}

// ═══════════════════════════════════════════════════════
// W3C Agent
// ═══════════════════════════════════════════════════════

export interface W3CAgent {
  type: 'Person' | 'Organization' | 'Software';
  name: string;
  email?: string;
  homepage?: string;
}

// ═══════════════════════════════════════════════════════
// MarkVault 自定义扩展类型
// ═══════════════════════════════════════════════════════

/** 关系扩展 — 标注间关联的 W3C 兼容表示 */
export interface W3CRelationExtension {
  targetUuid: string;
  type: string;
  createdAt: string;       // ISO 8601
  note?: string;
  invalidAt?: string;      // ISO 8601，存在则表示软删除
  source?: string;         // 'manual' | 'template' | 'inferred' | 'imported'
}

/** 学习状态标记扩展 */
export interface W3CFlagsExtension {
  mastery?: string;
  reviewPriority?: string;
  confidence?: number;
  needsCorrection?: boolean;
  lastReviewedAt?: string;  // ISO 8601
  reviewCount?: number;
}

/** Span 标注片段范围（对应 Annotation.spanRanges） */
export interface W3CSpanRange {
  from: number;
  to: number;
}

// ═══════════════════════════════════════════════════════
// W3C 容器类型
// ═══════════════════════════════════════════════════════

/** W3C AnnotationCollection — 注解集合容器 */
export interface W3CAnnotationCollection {
  '@context': string[];
  id: string;
  type: 'AnnotationCollection';
  label?: string;
  total: number;
  modified?: string;
  first?: W3CAnnotationPage;
  last?: W3CAnnotationPage;
  items?: W3CAnnotation[];  // 小集合可直接内联
}

/** W3C AnnotationPage — 分页容器 */
export interface W3CAnnotationPage {
  '@context': string[];
  id: string;
  type: 'AnnotationPage';
  partOf?: string;
  startIndex?: number;
  next?: string;
  prev?: string;
  items: W3CAnnotation[];
}

// ═══════════════════════════════════════════════════════
// 导出选项
// ═══════════════════════════════════════════════════════

/** W3C 导出过滤选项 */
export interface W3CExportOptions {
  /** 按文件路径过滤 */
  filePath?: string;
  /** 按标注意图过滤 */
  motivation?: string;
  /** 按关系类型过滤（导出含特定关系的标注） */
  relationType?: string;
  /** 按标注类型过滤 */
  kind?: 'inline' | 'block' | 'span' | 'region';
  /** ID 前缀，默认 "markvault" */
  idPrefix?: string;
  /** 每页条目数，0 表示不分页（直接内联 items） */
  pageSize?: number;
  /** 导出集合标签 */
  label?: string;
  /** 是否包含已失效的关系（默认 false） */
  includeInvalidatedRelations?: boolean;
}
