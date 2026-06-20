/**
 * filter-engine.ts — 统一标注过滤引擎（纯函数模块）
 *
 * 消除 AnnotationStore.queryAnnotations() 和 AnnotationSidebar.applySearchFilter()
 * 之间的代码重复，成为所有过滤操作的唯一实现。
 *
 * Phase 4.5 (搜索重构): 新增模块，覆盖全部 12 个过滤维度 + 3 种排序。
 *
 * # 双搜索路径一致性边界
 *
 * 项目中存在两条搜索路径，它们的差异与共存关系如下：
 *
 * | 维度 | 纯 Filter 路径 (本模块) | SearchEngine 路径 |
 * |------|------------------------|-------------------|
 * | 入口 | applyUnifiedFilter(anns, filter, query) | engine.search(query, filter) |
 * | 召回方式 | O(n) 全量扫描 includes(token) | O(1) 倒排索引 token→uuid |
 * | 分词 | tokenize() — 与 engine 完全一致 | tokenize() — 与 filter 完全一致 |
 * | 搜索字段 | text/note/tags/filePath/groups/fields/motivation | 同左（FIELD_WEIGHTS 加权） |
 * | bigram 语义 | bigram OR + other OR | bigram ALL + other OR + BM25 排序 |
 * | 性能 | 标注数 < 1000 时够用 | 大标注量下显著更快 |
 * | 新鲜度 | 实时（直接读 Store 引用） | 依赖 markDirty() 触发索引重建 |
 * | 评分 | 无（仅过滤） | BM25 / Weighted 评分 |
 *
 * **子集关系保证**：SearchEngine 的结果是纯 Filter 路径的子集（理论保证）。
 * 如果 SearchEngine 结果 ⊕ 纯 Filter 结果有差异，说明索引需要重建（markDirty）。
 *
 * **调用方选择指南**：
 * - 侧边栏过滤/排序 → applyUnifiedFilter（已有 Store 候选集，纯后过滤）
 * - RelationPicker 目标搜索 → engine.suggest()（需要 BM25 排序 + 模糊/前缀）
 * - 全量标注搜索 + Facets → engine.search()（需要评分 + 分布统计）
 * - 无 searchQuery 的纯属性过滤 → 两条路径等价（走 Store 索引更快）
 */

import type { Annotation, AnnotationFilter } from '../types/annotation';
import { tokenize, isCJK } from './tokenizer';
import { stripUserFieldPrefix } from '../types/annotation';

// ─── 活跃判断 ──────────────────────────────────────────

/**
 * 判断过滤条件中是否有任何活跃条件（不含 searchQuery）。
 * 用于：决定是否走 Store 索引路径 vs 全量加载 + 后过滤。
 */
export function hasActiveFilters(filter: AnnotationFilter): boolean {
  if (filter.type && filter.type !== 'all') return true;
  if (filter.color && filter.color !== 'all') return true;
  if (filter.hasNote) return true;
  if (filter.fieldFilters && Object.keys(filter.fieldFilters).length > 0) return true;
  if (filter.fieldFiltersMulti && Object.keys(filter.fieldFiltersMulti).length > 0) return true;
  if (filter.mastery && filter.mastery !== 'all') return true;
  if (filter.reviewPriority && filter.reviewPriority !== 'all') return true;
  if (filter.group && filter.group !== 'all') return true;
  if (filter.hasRelations === true) return true;
  if (filter.needsCorrection === true) return true;
  if (filter.motivation && filter.motivation !== 'all') return true;
  if (filter.tag && filter.tag !== 'all') return true;
  if (filter.tags && filter.tags.length > 0) return true;
  return false;
}

// ─── 统一过滤 ──────────────────────────────────────────

/**
 * 对标注数组应用 AnnotationFilter 的 **全部** 条件（含 Phase 4 扩展 + 搜索 + 排序）。
 *
 * 调用方职责：
 * - 通过索引（type/color/field/mastery/priority/group）预筛选候选集
 * - 然后把候选集 + filter + searchQuery 传入此函数做统一后过滤和排序
 *
 * 也可直接传入全部标注（All Notes tab 场景），此函数会自动完成全量后过滤。
 *
 * @param annotations 候选标注数组（可能已由索引预筛选）
 * @param filter      过滤条件（不含 searchQuery）
 * @param searchQuery 搜索框原始查询文本（独立参数，方便同时传空字符串）
 * @returns 过滤并排序后的标注数组（不修改原数组）
 */
export function applyUnifiedFilter(
  annotations: Annotation[],
  filter: AnnotationFilter,
  searchQuery?: string,
): Annotation[] {
  // 始终拷贝输入数组，避免 sort() 变异调用方数据
  let results = [...annotations];

  // —— 类型过滤 ——
  if (filter.type && filter.type !== 'all') {
    results = results.filter(a => a.type === filter.type);
  }

  // —— 颜色过滤 ——
  if (filter.color && filter.color !== 'all') {
    results = results.filter(a => a.color === filter.color);
  }

  // —— 批注过滤 ——
  if (filter.hasNote) {
    results = results.filter(a => a.note && a.note.trim().length > 0);
  }

  // —— 字段过滤（v4.1: u: 命名空间兼容匹配） ——
  if (filter.fieldFilters && Object.keys(filter.fieldFilters).length > 0) {
    for (const [key, value] of Object.entries(filter.fieldFilters)) {
      results = results.filter(a => {
        if (!a.fields) return false;
        if (a.fields[key] !== undefined && a.fields[key] === value) return true;
        const strippedKey = stripUserFieldPrefix(key);
        if (strippedKey !== key && a.fields[strippedKey] !== undefined && a.fields[strippedKey] === value) return true;
        const prefixedKey = 'u:' + key;
        if (a.fields[prefixedKey] !== undefined && a.fields[prefixedKey] === value) return true;
        return false;
      });
    }
  }

  // v6.1: 分面多值过滤（同 key 内 OR，跨 key AND）
  if (filter.fieldFiltersMulti && Object.keys(filter.fieldFiltersMulti).length > 0) {
    for (const [key, values] of Object.entries(filter.fieldFiltersMulti)) {
      results = results.filter(a => {
        if (!a.fields) return false;
        const match = (v: string) => a.fields![key] === v
          || a.fields![stripUserFieldPrefix(key)] === v
          || a.fields!['u:' + key] === v;
        return values.some(v => match(v));
      });
    }
  }

  // —— v4.0 元数据过滤 ——

  if (filter.mastery && filter.mastery !== 'all') {
    results = results.filter(a => a.flags?.mastery === filter.mastery);
  }

  if (filter.reviewPriority && filter.reviewPriority !== 'all') {
    results = results.filter(a => a.flags?.reviewPriority === filter.reviewPriority);
  }

  if (filter.group && filter.group !== 'all') {
    const groupVal = filter.group as string;
    // v6.0 双读：groups 字段 + tags 中 group: 前缀
    results = results.filter(a =>
      (a.groups?.includes(groupVal) ?? false) ||
      a.tags.some(t => t === `group:${groupVal}`)
    );
  }

  // v5.x: tag 过滤（v6.0 层级支持：筛选父级自动包含所有子标签）
  if (filter.tag && filter.tag !== 'all') {
    const tagVal = filter.tag as string;
    results = results.filter(a =>
      a.tags.some(t => t === tagVal || t.startsWith(tagVal + '/'))
    );
  }

  // v6.1: 多选 tag (AND 逻辑 + 层级 prefix)
  if (filter.tags && filter.tags.length > 0) {
    results = results.filter(a =>
      filter.tags!.every(requested =>
        a.tags.some(t => t === requested || t.startsWith(requested + '/'))
      )
    );
  }

  // v4.2: hasRelations 只计算有效关系（invalidAt == null）
  if (filter.hasRelations === true) {
    results = results.filter(a => a.relations?.some(r => !r.invalidAt) ?? false);
  } else if (filter.hasRelations === false) {
    results = results.filter(a => !a.relations || !a.relations.some(r => !r.invalidAt));
  }

  if (filter.needsCorrection === true) {
    results = results.filter(a => a.flags?.needsCorrection === true);
  }

  // —— v4.1: Motivation 语义过滤 ——
  if (filter.motivation && filter.motivation !== 'all') {
    results = results.filter(a => a.motivation === filter.motivation);
  }

  // —— 搜索（纯 filter 路径：O(n) 全量扫描，tokenize 分词 + includes 匹配） ——
  // 这是搜索的 "ground truth" 路径。SearchEngine 的倒排索引结果应为此路径的子集。
  // 如果两者不一致（engine 结果 ⊄ filter 结果），说明索引需要重建。
  if (searchQuery && searchQuery.trim()) {
    const queryTokens = tokenize(searchQuery);
    if (queryTokens.length > 0) {
      // 区分 bigram token（长度 >= 2 且含 CJK）和 单字/英文 token
      const bigramTokens: string[] = [];
      const otherTokens: string[] = [];
      for (const token of queryTokens) {
        const hasCJKChar = [...token].some(ch => {
          const cp = ch.codePointAt(0) ?? 0;
          return isCJK(cp);
        });
        if (token.length >= 2 && hasCJKChar) {
          bigramTokens.push(token);
        } else {
          otherTokens.push(token);
        }
      }

      results = results.filter(a => {
        // 收集标注所有可搜索字段的文本（v4.1: 增加 motivation、u: 字段 key 兼容搜索）
        const searchableText = [
          a.text,
          a.note || '',
          ...a.tags,
          a.filePath,
          ...(a.groups || []),
          ...(a.fields ? Object.entries(a.fields).flatMap(([k, v]) => [stripUserFieldPrefix(k), v]) : []),
          a.motivation || '',
        ].join(' ').toLowerCase();

        // 语义：至少一个 bigram 命中（OR）+ 任一 other token 命中（OR）
        // - bigram OR：解决跨词边界 bigram（如 "库范"）的匹配问题
        // - bigram 存在性要求：避免纯单字误匹配（如 "批注" 匹配 "标注"）
        // - 如果没有 bigram，则走 other token OR 语义
        const bigramsOk = bigramTokens.length === 0 || bigramTokens.some(t => searchableText.includes(t));
        const othersOk = otherTokens.length === 0 || otherTokens.some(t => searchableText.includes(t));
        return bigramsOk && othersOk;
      });
    }
  }

  // —— 排序（在拷贝数组上排序，不影响原数组） ——
  const sortBy = filter.sortBy || 'position';
  switch (sortBy) {
    case 'position':
      results.sort((a, b) => a.startOffset - b.startOffset);
      break;
    case 'createdAt':
      results.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'updatedAt':
      results.sort((a, b) => b.updatedAt - a.updatedAt);
      break;
  }

  return results;
}
