/**
 * search/types.ts — 搜索系统类型定义
 *
 * 独立于 AnnotationFilter，为 SearchEngine 和 RelationPicker 提供专用接口。
 */

import type { Annotation, AnnotationFilter } from '../types/annotation';

/** 搜索请求参数 */
export interface SearchRequest {
  /** 过滤条件（与 AnnotationFilter 兼容） */
  filter?: AnnotationFilter;

  /** 搜索查询文本 */
  query?: string;

  /** 搜索范围 */
  scope?: 'all' | 'file';

  /** scope=file 时的文件路径 */
  filePath?: string;

  /** 是否按相关性排序（否则按 filter.sortBy 排序） */
  sortByRelevance?: boolean;

  /** 返回结果上限（默认无限制） */
  limit?: number;

  /** 是否附带搜索 Facets（结果分布统计，默认 false） */
  facets?: boolean;

  /** 评分模型（默认 'bm25'） */
  scoringModel?: 'weighted' | 'bm25';

  /**
   * 英文模糊搜索容错度（0~1，0=禁用）。
   *
   * 允许的最大编辑距离 = max(1, floor(token.length × fuzzy))
   * 例如 fuzzy=0.2 时 "transaction"(11) → ed≤2，"acid"(4) → ed≤0（不模糊）
   *
   * 仅对英文/数字 token 生效，CJK bigram 不适用（长度过短无意义）。
   */
  fuzzy?: number;

  /** 每个 token 的模糊扩展上限（默认 5，防性能退化） */
  fuzzyMaxExpansions?: number;

  /**
   * 前缀搜索：对不在索引中的 token，查找所有以它为前缀的 indexed token 并合并命中。
   *
   * 适用场景：用户输入"数据"时也匹配"数据库"、"数据表"等。
   * 对 CJK bigram 和 English token 均生效，但只扩展未精确命中的 token。
   */
  prefix?: boolean;
}

/** 搜索结果（带相关性分数和匹配片段） */
export interface SearchResult {
  /** 匹配的标注对象 */
  annotation: Annotation;

  /** 相关性分数（越高越相关，无搜索词则为 0） */
  score: number;

  /** 各字段的匹配片段（字段名 → 截取片段） */
  matchSnippets: Record<string, string>;
}

/** 搜索建议（用于输入自动补全/Relation Picker） */
export interface Suggestion {
  /** 标注 UUID */
  uuid: string;

  /** 标注原文（截断前 80 字） */
  text: string;

  /** 标注批注（截断前 60 字，可能为空） */
  note?: string;

  /** 所在文件路径 */
  filePath: string;

  /** 命中的字段名（如 "text" / "note" / "tags" ...） */
  matchField: string;

  /** 匹配的文本片段 */
  matchSnippet: string;
}

/** 搜索索引快照（用于持久化，Map/Set 转为 JSON 友好格式） */
export interface IndexSnapshot {
  version: number;
  invertedIndex: Array<[string, string[]]>;   // token → uuid[]
  docLengths: Array<[string, number]>;        // uuid → tokenCount
  indexedCount: number;
  avgDocLength: number;
}

/** 搜索 Facets：结果集按维度的分布统计（参考 Orama facets） */
export interface SearchFacets {
  /** 按标注类型分布 */
  type: Record<string, number>;
  /** 按颜色分布 */
  color: Record<string, number>;
  /** 按掌握度分布 */
  mastery: Record<string, number>;
  /** 有/无批注数量 */
  hasNote: number;
  noNote: number;
}
