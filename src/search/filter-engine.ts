/**
 * filter-engine.ts — 统一标注过滤引擎（纯函数模块）
 *
 * 消除 AnnotationStore.queryAnnotations() 和 AnnotationSidebar.applySearchFilter()
 * 之间的代码重复，成为所有过滤操作的唯一实现。
 *
 * Phase 4.5 (搜索重构): 新增模块，覆盖全部 12 个过滤维度 + 3 种排序。
 */

import type { Annotation, AnnotationFilter } from '../types/annotation';
import { tokenize, isCJK } from './tokenizer';

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
  if (filter.mastery && filter.mastery !== 'all') return true;
  if (filter.reviewPriority && filter.reviewPriority !== 'all') return true;
  if (filter.group && filter.group !== 'all') return true;
  if (filter.hasRelations === true) return true;
  if (filter.needsCorrection === true) return true;
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

  // —— 字段过滤 ——
  if (filter.fieldFilters && Object.keys(filter.fieldFilters).length > 0) {
    for (const [key, value] of Object.entries(filter.fieldFilters)) {
      results = results.filter(a =>
        a.fields && a.fields[key] !== undefined && a.fields[key] === value,
      );
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
    results = results.filter(a => a.groups?.includes(groupVal) ?? false);
  }

  if (filter.hasRelations === true) {
    results = results.filter(a => a.relations && a.relations.length > 0);
  } else if (filter.hasRelations === false) {
    results = results.filter(a => !a.relations || a.relations.length === 0);
  }

  if (filter.needsCorrection === true) {
    results = results.filter(a => a.flags?.needsCorrection === true);
  }

  // —— 搜索（tokenizer 分词匹配，与 SearchEngine 行为一致） ——
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
        // 收集标注所有可搜索字段的文本
        const searchableText = [
          a.text,
          a.note || '',
          ...a.tags,
          a.filePath,
          ...(a.groups || []),
          ...(a.fields ? Object.entries(a.fields).flat() : []),
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
