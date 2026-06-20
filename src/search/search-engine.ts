/**
 * search-engine.ts — 标注全文搜索引擎
 *
 * 架构：
 * - 基于内存倒排索引 (token → Set<uuid>)，搜索 O(k)（k=命中 token 数）
 * - 惰性构建：首次 search/suggest 时自动构建，标注变更后标记 dirty
 * - 搜索结果按相关性排序（字段加权 + bigram 加权 + BM25 评分）
 *
 * 依赖：
 * - tokenizer.ts（CJK+English 分词）
 * - filter-engine.ts（统一过滤 + 排序）
 * - AnnotationStore（标注数据源）
 *
 * # 与纯 Filter 路径的关系
 *
 * SearchEngine 是 "快速索引" 路径，filter-engine.ts 的 applyUnifiedFilter
 * 是 "ground truth" 路径（O(n) 全量扫描）。两者的 tokenization 完全一致
 * （共享 tokenize），搜索字段集合相同。差异在于：
 * - engine 通过倒排索引做 token→uuid 召回 → O(k) 而非 O(n)
 * - engine 通过 BM25/Weighted 做评分排序，filter 仅做过滤
 * - engine 依赖索引新鲜度（markDirty），可能在标注刚变更时漏检
 *
 * **一致性保证**：engine 结果 ⊆ applyUnifiedFilter 结果（子集关系）。
 * 若发现差异（engine 漏检），说明索引需要标记 dirty 并重建。
 * 侧边栏 UI 建议：engine.search 返回结果后，用 filter 路径做一次轻量
 * 校验（count 对比），若差异 > N 则自动 markDirty + 重新索引。
 *
 * 参考项目：
 * - MiniSearch: BM25 变体评分、自动建议、JSON 序列化
 * - FlexSearch: CJK Charset 内置支持、上下文评分
 * - Orama: 基于 BM25 + 多语言 tokenizer
 */

import type { Annotation } from '../types/annotation';
import type { AnnotationStore } from '../db/annotation-store';
import type { SearchRequest, SearchResult, Suggestion, IndexSnapshot, SearchFacets } from './types';
import { tokenize, isCJK } from './tokenizer';
import { applyUnifiedFilter } from './filter-engine';

/** 字段搜索权重（text 最高，fields 最低） */
const FIELD_WEIGHTS: Record<string, number> = {
  uuid: 8,
  text: 10,
  note: 7,
  tags: 5,
  alias: 6,    // v5.3: 图谱别名，权重高于 groups（用户有意命名的短名称）
  filePath: 4,
  groups: 3,
  fields: 2,
  motivation: 2, // v6.1: 标注意图可搜索
};

/** CJK bigram 命中额外系数 */
const BIGRAM_BONUS = 1.5;

/** BM25 参数 */
const BM25_K1 = 1.5;  // TF 饱和参数
const BM25_B  = 0.75; // 长度归一化参数

/** 字段乘数映射 */
const FIELD_MULTIPLIER_SCALE = 100;    // 权重归一化分母
const FIELD_MULTIPLIER_FACTOR = 5;     // 字段差异放大因子

/** 模糊搜索参数 */
const FUZZY_DEFAULT_MAX_EXPANSIONS = 5;   // 每 token 最多扩展数
const FUZZY_MIN_TOKEN_LENGTH     = 3;     // token 最短长度才做模糊
const FUZZY_PENALTY_FACTOR       = 0.85;  // 模糊命中分数折扣

/** 前缀搜索参数 */
const PREFIX_MAX_EXPANSIONS = 20;         // 前缀扩展上限（防性能退化）
const PREFIX_MIN_TOKEN_LENGTH = 1;        // token 最短长度才做前缀
const PREFIX_PENALTY_FACTOR = 0.9;        // 前缀命中分数折扣

export class AnnotationSearchEngine {
  /** token → 包含该 token 的标注 uuid 集合 */
  private _invertedIndex: Map<string, Set<string>> = new Map();

  /** 索引是否已过期（标注变更后标记为 true） */
  private _dirty = true;

  /** 已索引的标注总数（上次构建时） */
  private _indexedCount = 0;

  /** BM25: uuid → 标注的 token 总数（所有搜索字段合计） */
  private _docLengths: Map<string, number> = new Map();

  /** BM25: 平均文档 token 长度 */
  private _avgDocLength: number = 0;

  /** 最近一次搜索的 Facets（facets=true 时填充） */
  private _lastFacets: SearchFacets | undefined;

  /** 获取最近一次搜索的 Facets（需先调用 search({..., facets: true})） */
  public get lastFacets(): SearchFacets | undefined {
    return this._lastFacets;
  }

  constructor(private store: AnnotationStore) {}

  // ─── Public API ───────────────────────────────────────

  /**
   * 搜索标注。
   *
   * 流程：
   * 1. 确保索引有效
   * 2. 通过倒排索引按 token 快速召回候选 uuid（含模糊扩展）
   * 3. 汇总评分（BM25 或加权）
   * 4. 应用 AnnotationFilter 后过滤
   * 5. 按相关性排序（或 filter.sortBy）
   * 6. 截取 limit
   */
  search(req: SearchRequest): SearchResult[] {
    const { filter, query, scope, filePath, sortByRelevance, limit, scoringModel } = req;

    // 输入校验（参考 MiniSearch 的防御式编程）
    if (limit !== undefined && (limit < 0 || !Number.isFinite(limit))) {
      throw new Error(`SearchRequest.limit must be a non-negative number, got ${limit}`);
    }
    if (req.fuzzy !== undefined && (req.fuzzy < 0 || req.fuzzy > 1)) {
      throw new Error(`SearchRequest.fuzzy must be 0~1, got ${req.fuzzy}`);
    }

    this._ensureIndex();

    let finalResults: SearchResult[];

    if (query && query.trim()) {
      const tokens = tokenize(query);
      const scoredUuids = this._searchByTokens(tokens, {
        scoringModel: scoringModel || 'bm25',
        fuzzy: req.fuzzy,
        fuzzyMaxExpansions: req.fuzzyMaxExpansions,
        prefix: req.prefix,
      });

      // 构建候选标注列表（scope 过滤 + 自修复）
      const candidates: Annotation[] = [];
      let staleCount = 0;
      for (const [uuid] of scoredUuids) {
        const ann = this.store.getAnnotationByUuid(uuid);
        if (!ann) {
          // 自修复：倒排索引中有已删除标注的残留 UUID（参考 MiniSearch 的搜索时自清理模式）
          staleCount++;
          this._dirty = true; // 触发下次 search 前重建索引
          continue;
        }

        // scope 检查
        if (scope === 'file' && filePath && ann.filePath !== filePath) continue;

        candidates.push(ann);
      }

      // 检测到残留 UUID 时记录警告（优雅降级：不抛异常，本次用剩余结果）
      if (staleCount > 0) {
        console.warn(
          `MarkVault SearchEngine: found ${staleCount} stale UUIDs in inverted index — ` +
          `index will be rebuilt on next search. (This can happen when annotations are deleted outside the plugin.)`
        );
      }

      // 批量后过滤（一次调用，包含所有 filter 条件）
      const filteredCandidates = filter
        ? applyUnifiedFilter(candidates, filter, undefined)
        : candidates;

      // 构建结果，恢复评分
      const results: SearchResult[] = filteredCandidates.map(ann => ({
        annotation: ann,
        score: scoredUuids.get(ann.uuid) ?? 0,
        matchSnippets: this._extractSnippets(ann, tokens),
      }));

      // 排序
      if (sortByRelevance !== false) {
        results.sort((a, b) => b.score - a.score);
      }

      // 截取
      finalResults = (limit && limit > 0 && results.length > limit)
        ? results.slice(0, limit)
        : results;
    } else {
      // 无搜索词：走纯 filter 路径
      let candidates: Annotation[];
      if (filter) {
        candidates = this.store.queryAnnotations(filter);
      } else {
        candidates = this.store.getAllAnnotations();
      }

      // scope 过滤
      if (scope === 'file' && filePath) {
        candidates = candidates.filter(a => a.filePath === filePath);
      }

      // 排序
      if (!filter || scope === 'file') {
        const sortBy = filter?.sortBy || 'position';
        switch (sortBy) {
          case 'position':
            candidates.sort((a, b) => a.startOffset - b.startOffset);
            break;
          case 'createdAt':
            candidates.sort((a, b) => b.createdAt - a.createdAt);
            break;
          case 'updatedAt':
            candidates.sort((a, b) => b.updatedAt - a.updatedAt);
            break;
        }
      }

      if (limit && limit > 0 && candidates.length > limit) {
        candidates = candidates.slice(0, limit);
      }

      finalResults = candidates.map(ann => ({
        annotation: ann,
        score: 0,
        matchSnippets: {},
      }));
    }

    // Facets 计算（O(n)，仅在请求时执行）
    if (req.facets) {
      this._computeFacets(finalResults);
    } else {
      this._lastFacets = undefined;
    }

    return finalResults;
  }

  /**
   * 获取搜索建议（用于输入自动补全 / Relation Picker）。
   *
   * @param query 搜索查询
   * @param scoringModel 评分模型（默认 'weighted' 强调精确匹配，'bm25' 强调稀有词）
   */
  suggest(query: string, limit: number = 10, scoringModel: 'weighted' | 'bm25' = 'weighted'): Suggestion[] {
    if (!query || !query.trim()) return [];

    const tokens = tokenize(query);
    this._ensureIndex();

    const scoredUuids = this._searchByTokens(tokens, { scoringModel });
    const suggestions: Suggestion[] = [];

    // 按分数降序排序，确保前 limit 条是最高分结果
    const sortedEntries = [...scoredUuids.entries()].sort((a, b) => b[1] - a[1]);

    for (const [uuid] of sortedEntries) {
      if (suggestions.length >= limit) break;

      const ann = this.store.getAnnotationByUuid(uuid);
      if (!ann) continue;

      const matchField = this._determineMatchField(ann, tokens);
      const matchSnippet = this._findBestSnippet(ann, tokens);

      suggestions.push({
        uuid: ann.uuid,
        text: ann.text.length > 80 ? ann.text.slice(0, 77) + '…' : ann.text,
        note: ann.note ? (ann.note.length > 60 ? ann.note.slice(0, 57) + '…' : ann.note) : undefined,
        filePath: ann.filePath,
        matchField,
        matchSnippet,
      });
    }

    return suggestions;
  }

  /**
   * 强制重建倒排索引（标注变更后通常不需要手动调用，_ensureIndex 会自动处理）。
   */
  rebuildIndex(): void {
    this._rebuildIndex();
  }

  /**
   * 标记索引为过期（标注变更时由外部调用）。
   */
  markDirty(): void {
    this._dirty = true;
  }

  /**
   * 导出索引为可序列化快照（用于持久化到磁盘）。
   *
   * 调用方（main.ts）用此方法获取 JSON 兼容对象，自行写入文件。
   */
  exportIndex(): IndexSnapshot {
    this._ensureIndex();

    const indexEntries: Array<[string, string[]]> = [];
    for (const [token, uuidSet] of this._invertedIndex) {
      indexEntries.push([token, [...uuidSet]]);
    }

    const docLengthEntries: Array<[string, number]> = [];
    for (const [uuid, len] of this._docLengths) {
      docLengthEntries.push([uuid, len]);
    }

    return {
      version: 1,
      invertedIndex: indexEntries,
      docLengths: docLengthEntries,
      indexedCount: this._indexedCount,
      avgDocLength: this._avgDocLength,
    };
  }

  /**
   * 从快照恢复索引（避免插件启动时全量重建）。
   *
   * 调用方（main.ts）在 plugin onload 时先尝试从磁盘读取快照，
   * 再调用此方法。如果快照不可用或版本不匹配，则走普通 _ensureIndex 路径。
   */
  importIndex(snapshot: IndexSnapshot): void {
    this._invertedIndex.clear();
    for (const [token, uuids] of snapshot.invertedIndex) {
      this._invertedIndex.set(token, new Set(uuids));
    }

    this._docLengths.clear();
    for (const [uuid, len] of snapshot.docLengths) {
      this._docLengths.set(uuid, len);
    }

    this._indexedCount = snapshot.indexedCount;
    this._avgDocLength = snapshot.avgDocLength;
    this._dirty = false;
  }

  // ─── Private: 索引管理 ─────────────────────────────────

  private _ensureIndex(): void {
    if (this._dirty) {
      this._rebuildIndex();
      return;
    }
    const currentCount = this.store.getAnnotationCount();
    if (currentCount !== this._indexedCount) {
      this._rebuildIndex();
    }
  }

  private _rebuildIndex(): void {
    this._invertedIndex.clear();
    this._docLengths.clear();
    const all = this.store.getAllAnnotations();

    let totalDocLen = 0;
    for (const ann of all) {
      const docLen = this._indexAnnotation(ann);
      this._docLengths.set(ann.uuid, docLen);
      totalDocLen += docLen;
    }

    this._dirty = false;
    this._indexedCount = all.length;
    this._avgDocLength = all.length > 0 ? totalDocLen / all.length : 0;
  }

  /** 索引单个标注，返回该标注的 token 总数（用于 BM25 长度计算） */
  private _indexAnnotation(ann: Annotation): number {
    const fieldTexts: Record<string, string> = {
      uuid: ann.uuid,
      text: ann.text,
      note: ann.note || '',
      tags: ann.tags.join(' '),
      alias: ann.alias || '',    // v5.3: 图谱别名纳入搜索索引
      filePath: ann.filePath,
      groups: (ann.groups || []).join(' '),
      fields: ann.fields ? Object.values(ann.fields).join(' ') : '',
      motivation: ann.motivation || '',
    };

    let totalTokens = 0;
    for (const [, fieldText] of Object.entries(fieldTexts)) {
      if (!fieldText) continue;
      const tokens = tokenize(fieldText);
      totalTokens += tokens.length;
      for (const token of tokens) {
        let uuidSet = this._invertedIndex.get(token);
        if (!uuidSet) {
          uuidSet = new Set();
          this._invertedIndex.set(token, uuidSet);
        }
        uuidSet.add(ann.uuid);
      }
    }
    return totalTokens;
  }

  // ─── Private: 搜索核心 ─────────────────────────────────

  /**
   * 基于倒排索引的 token 召回 + 评分（快速路径，非 O(n) 扫描）。
   *
   * 与 filter-engine.ts 的纯搜索路径相比：
   * - 相同：tokenize 分词、bigram/other 分类、搜索字段集合
   * - 不同：使用倒排索引召回（而非全量 includes 扫描）
   * - 子集关系：本方法结果 ⊆ applyUnifiedFilter 结果（依赖索引新鲜度）
   *
   * 若结果缺失（如刚添加的标注搜索不到），说明索引需要 markDirty + 重建。
   */
  private _searchByTokens(
    tokens: string[],
    opts: { scoringModel?: 'weighted' | 'bm25'; fuzzy?: number; fuzzyMaxExpansions?: number; prefix?: boolean } = {},
  ): Map<string, number> {
    const scores = new Map<string, number>();
    if (tokens.length === 0) return scores;

    const {
      scoringModel = 'weighted',
      fuzzy = 0,
      fuzzyMaxExpansions = FUZZY_DEFAULT_MAX_EXPANSIONS,
      prefix = false,
    } = opts;

    // 1. 模糊扩展：对不在索引中的 English token 找近似 token
    let effectiveTokens = tokens;
    if (fuzzy > 0) {
      effectiveTokens = this._fuzzyExpand(tokens, fuzzy, fuzzyMaxExpansions);
    }

    // 2. 前缀扩展：对不在索引中的 token，找以它为前缀的 indexed token
    const isPrefixToken = new Set<string>();
    if (prefix) {
      effectiveTokens = this._prefixExpand(effectiveTokens, isPrefixToken);
    }

    // 2. 分类 bigram / other
    const bigramTokens: string[] = [];
    const otherTokens: string[] = [];
    for (const token of effectiveTokens) {
      const isBigramToken = token.length >= 2 && [...token].some(ch => isCJK(ch.codePointAt(0) ?? 0));
      if (isBigramToken) {
        bigramTokens.push(token);
      } else {
        otherTokens.push(token);
      }
    }

    // 3. 召回：bigram OR + other OR
    let bigramHitUuids: Set<string> | null = null;
    if (bigramTokens.length > 0) {
      bigramHitUuids = new Set<string>();
      for (const token of bigramTokens) {
        const uuidSet = this._invertedIndex.get(token);
        if (uuidSet) {
          for (const uuid of uuidSet) bigramHitUuids.add(uuid);
        }
      }
    }

    let otherHitUuids: Set<string> | null = null;
    if (otherTokens.length > 0) {
      otherHitUuids = new Set<string>();
      for (const token of otherTokens) {
        const uuidSet = this._invertedIndex.get(token);
        if (uuidSet) {
          for (const uuid of uuidSet) otherHitUuids.add(uuid);
        }
      }
    }

    let finalCandidateUuids: Set<string>;
    if (bigramHitUuids !== null && otherHitUuids !== null) {
      finalCandidateUuids = new Set<string>();
      for (const uuid of bigramHitUuids) {
        if (otherHitUuids.has(uuid)) finalCandidateUuids.add(uuid);
      }
    } else if (bigramHitUuids !== null) {
      finalCandidateUuids = bigramHitUuids;
    } else if (otherHitUuids !== null) {
      finalCandidateUuids = otherHitUuids;
    } else {
      return scores;
    }

    // 4. 评分
    for (const uuid of finalCandidateUuids) {
      const ann = this.store.getAnnotationByUuid(uuid);
      if (!ann) continue;

      let totalScore: number;
      if (scoringModel === 'bm25') {
        totalScore = this._computeBm25Score(ann, effectiveTokens, tokens, isPrefixToken);
      } else {
        totalScore = this._computeWeightedScore(ann, effectiveTokens, tokens, isPrefixToken);
      }

      scores.set(uuid, totalScore);
    }

    return scores;
  }

  // ─── Private: Facets 计算 ──────────────────────────────

  /** 计算搜索结果按维度分布（O(n)，参考 Orama facets） */
  private _computeFacets(results: SearchResult[]): void {
    const facets: SearchFacets = {
      type: {},
      color: {},
      mastery: {},
      hasNote: 0,
      noNote: 0,
      motivation: {},
    };

    for (const r of results) {
      const ann = r.annotation;

      // 类型分布
      const t = ann.type || 'unknown';
      facets.type[t] = (facets.type[t] || 0) + 1;

      // 颜色分布
      const c = ann.color || 'unknown';
      facets.color[c] = (facets.color[c] || 0) + 1;

      // 掌握度分布
      const m = ann.flags?.mastery || 'unknown';
      facets.mastery[m] = (facets.mastery[m] || 0) + 1;

      // 标注意图分布
      if (ann.motivation) {
        facets.motivation[ann.motivation] = (facets.motivation[ann.motivation] || 0) + 1;
      }

      // 批注分布
      if (ann.note && ann.note.trim()) {
        facets.hasNote++;
      } else {
        facets.noNote++;
      }
    }

    this._lastFacets = facets;
  }

  // ─── Private: 加权评分（旧模型，suggest 默认用） ─────

  private _computeWeightedScore(
    ann: Annotation,
    effectiveTokens: string[],
    originalTokens: string[],
    isPrefixToken: Set<string> = new Set(),
  ): number {
    let totalScore = 0;
    const isFuzzyToken = new Set(
      effectiveTokens.filter(t => !originalTokens.includes(t) && !isPrefixToken.has(t))
    );

    for (const token of effectiveTokens) {
      const fieldHits = this._countFieldHits(ann, token);
      let tokenScore = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        if (fieldHits[field]) {
          const isBigramToken = token.length >= 2 && [...token].some(ch => isCJK(ch.codePointAt(0) ?? 0));
          const bonus = isBigramToken ? BIGRAM_BONUS : 1;
          tokenScore += weight * bonus * Math.min(fieldHits[field], 3);
        }
      }

      // 模糊扩展的 token 打折扣
      if (isFuzzyToken.has(token)) {
        tokenScore *= FUZZY_PENALTY_FACTOR;
      }

      // 前缀扩展的 token 打折扣
      if (isPrefixToken.has(token)) {
        tokenScore *= PREFIX_PENALTY_FACTOR;
      }

      totalScore += tokenScore;
    }

    return totalScore;
  }

  // ─── Private: BM25 评分 ────────────────────────────────

  /**
   * BM25 评分（参考 MiniSearch / Orama）。
   *
   * 公式：
   *   score = Σ IDF(qi) × TF_sat(qi, D) × fieldMultiplier × bigramBonus
   *
   *   IDF(qi)   = ln((N - df(qi) + 0.5) / (df(qi) + 0.5) + 1)
   *   TF_sat    = (f × (k1+1)) / (f + k1 × (1-b + b × |D|/avgDL))
   *
   * 其中 N=总标注数, df=包含该 token 的标注数, f=该标注中 token 出现次数,
   * |D|=该标注的总 token 数, avgDL=平均 token 数
   */
  private _computeBm25Score(
    ann: Annotation,
    effectiveTokens: string[],
    originalTokens: string[],
    isPrefixToken: Set<string> = new Set(),
  ): number {
    const docLen = this._docLengths.get(ann.uuid) ?? (this._avgDocLength || 1);
    const N = this._indexedCount;
    const avgDL = this._avgDocLength || 1;
    const isFuzzyToken = new Set(
      effectiveTokens.filter(t => !originalTokens.includes(t) && !isPrefixToken.has(t))
    );

    let totalScore = 0;

    for (const token of effectiveTokens) {
      const uuidSet = this._invertedIndex.get(token);
      const df = uuidSet ? uuidSet.size : 0;
      if (df === 0) continue;

      // IDF: 稀有 token 权重高
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      // 统计该 token 在该标注所有字段中的总命中次数 + 最高命名字段权重
      const fieldHits = this._countFieldHits(ann, token);
      let freq = 0;
      let maxFieldWeight = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        if (fieldHits[field]) {
          freq += fieldHits[field];
          if (weight > maxFieldWeight) maxFieldWeight = weight;
        }
      }
      if (freq === 0) continue;

      // BM25 TF 组件：饱和度防止高频词主导
      // 防御：docLen 可能为 0（空标注），avgDL 也可能为 0（空索引）
      const safeDocLen = Math.max(docLen, 1);
      const safeAvgDL = Math.max(avgDL, 1);
      const tfComponent =
        (freq * (BM25_K1 + 1)) /
        (freq + BM25_K1 * (1 - BM25_B + BM25_B * (safeDocLen / safeAvgDL)));

      const bm25Base = idf * tfComponent;

      // 字段权重：作为中等 multiplier（text:10 → 1.5x, fields:2 → 1.1x）
      const fieldMultiplier = 1 + (maxFieldWeight / FIELD_MULTIPLIER_SCALE) * FIELD_MULTIPLIER_FACTOR;

      // CJK bigram 额外加成
      const isBigram = token.length >= 2 && [...token].some(ch => isCJK(ch.codePointAt(0) ?? 0));
      const bigramMultiplier = isBigram ? BIGRAM_BONUS : 1;

      let tokenScore = bm25Base * fieldMultiplier * bigramMultiplier;

      // 模糊扩展 token 打折
      if (isFuzzyToken.has(token)) {
        tokenScore *= FUZZY_PENALTY_FACTOR;
      }

      // 前缀扩展 token 打折
      if (isPrefixToken.has(token)) {
        tokenScore *= PREFIX_PENALTY_FACTOR;
      }

      totalScore += tokenScore;
    }

    return totalScore;
  }

  // ─── Private: 前缀搜索 ─────────────────────────────────

  /**
   * 对不在索引中的 token 做前缀扩展。
   *
   * 策略：
   * 1. 跳过已在索引中的 token（精确匹配优先，不需要扩展）
   * 2. 跳过长度 < PREFIX_MIN_TOKEN_LENGTH 的 token
   * 3. 遍历全部 indexed token，收集以 prefix token 开头的
   * 4. 上限 PREFIX_MAX_EXPANSIONS 个（防性能退化）
   *
   * @param tokens     当前 token 列表
   * @param outPrefixes 输出参数：收集被标记为"前缀扩展产生"的 token
   * @returns 扩展后的 token 数组
   */
  private _prefixExpand(tokens: string[], outPrefixes: Set<string>): string[] {
    const result = [...tokens];
    const seen = new Set(tokens);

    for (const token of tokens) {
      // 跳过长段过短 / 已在索引中 → 不需要扩展
      if (token.length < PREFIX_MIN_TOKEN_LENGTH) continue;
      if (this._invertedIndex.has(token)) continue;

      let expansions = 0;
      for (const [indexedToken] of this._invertedIndex) {
        if (!indexedToken.startsWith(token)) continue;
        if (seen.has(indexedToken)) continue;

        seen.add(indexedToken);
        result.push(indexedToken);
        outPrefixes.add(indexedToken);
        expansions++;

        if (expansions >= PREFIX_MAX_EXPANSIONS) break;
      }
    }

    return result;
  }

  // ─── Private: 模糊搜索 ─────────────────────────────────

  /**
   * 对不在索引中的 English token 做模糊扩展。
   *
   * 策略（参考 MiniSearch fuzzy + FlexSearch suggest）：
   * 1. 只对长度 ≥ FUZZY_MIN_TOKEN_LENGTH 的非 CJK token 做模糊
   * 2. maxDistance = max(1, floor(token.length × fuzzy))
   * 3. 性能：按长度 ±maxDistance 过滤 + 首字符匹配缩小搜索空间
   * 4. 结果并入 effectiveTokens，原 token 也保留（精确匹配优先）
   *
   * @returns 扩展后的 token 数组（含原始 tokens）
   */
  private _fuzzyExpand(tokens: string[], fuzzy: number, maxExpansions: number): string[] {
    const result = [...tokens];
    const seen = new Set(tokens);

    for (const token of tokens) {
      // 跳过 CJK bigram（长度过短，模糊无意义）
      if (!this._isEnglishToken(token)) continue;
      if (token.length < FUZZY_MIN_TOKEN_LENGTH) continue;

      // 如果精确 token 已在索引中，不需要模糊扩展
      if (this._invertedIndex.has(token)) continue;

      const maxDistance = Math.max(1, Math.floor(token.length * fuzzy));

      // 收集候选：长度在 [token.length - maxDistance, token.length + maxDistance]
      // 且首字符匹配的 indexed token
      const candidates: Array<{ token: string; distance: number }> = [];
      const firstChar = token[0];

      for (const [indexedToken] of this._invertedIndex) {
        // 快速过滤：长度差异
        if (Math.abs(indexedToken.length - token.length) > maxDistance) continue;
        // 快速过滤：首字符（约 70% 剪枝率）
        if (indexedToken[0] !== firstChar) continue;
        // 跳过 CJK token（精确匹配已有 bigram，不需要模糊）
        if ([...indexedToken].some(ch => isCJK(ch.codePointAt(0) ?? 0))) continue;

        const dist = this._levenshtein(token, indexedToken, maxDistance);
        if (dist <= maxDistance) {
          candidates.push({ token: indexedToken, distance: dist });
        }
      }

      // 按编辑距离升序排列，取最近的 maxExpansions 个
      candidates.sort((a, b) => a.distance - b.distance);
      for (let i = 0; i < Math.min(candidates.length, maxExpansions); i++) {
        const match = candidates[i].token;
        if (!seen.has(match)) {
          seen.add(match);
          result.push(match);
        }
      }
    }

    return result;
  }

  /** 判断 token 是否为纯英文/数字 token（非 CJK） */
  private _isEnglishToken(token: string): boolean {
    if (!token || token.length === 0) return false;
    return ![...token].some(ch => isCJK(ch.codePointAt(0) ?? 0));
  }

  /**
   * Levenshtein 编辑距离（带提前终止优化）。
   *
   * 参考 flexsearch 的位运算实现思路，这里用经典 DP，
   * 对短 token 足够快（O(m×n)，m,n 为 token 长度，通常 ≤ 20）。
   *
   * @param maxDistance 超过此值后提前返回（剪枝优化）
   */
  private _levenshtein(a: string, b: string, maxDistance?: number): number {
    const m = a.length;
    const n = b.length;

    // 提前判断：长度差异已超 maxDistance
    if (maxDistance !== undefined && Math.abs(m - n) > maxDistance) {
      return maxDistance + 1;
    }

    // 用两行滚动数组节约内存
    let prev: number[] = new Array(n + 1);
    let curr: number[] = new Array(n + 1);

    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = i;

      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,       // 删除
          curr[j - 1] + 1,   // 插入
          prev[j - 1] + cost // 替换
        );
        if (curr[j] < rowMin) rowMin = curr[j];
      }

      // 提前终止：当前行的最小值已超 maxDistance
      if (maxDistance !== undefined && rowMin > maxDistance) {
        return maxDistance + 1;
      }

      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }

  // ─── Private: 字段命中统计 ─────────────────────────────

  private _countFieldHits(ann: Annotation, token: string): Record<string, number> {
    const hits: Record<string, number> = {};

    const check = (field: string, text: string) => {
      if (!text) return;
      const lower = text.toLowerCase();
      let count = 0;
      let idx = lower.indexOf(token);
      while (idx !== -1) {
        count++;
        idx = lower.indexOf(token, idx + token.length);
      }
      if (count > 0) hits[field] = count;
    };

    check('uuid', ann.uuid);
    check('text', ann.text);
    check('note', ann.note || '');
    check('alias', ann.alias || '');    // v5.3: 图谱别名命中检测
    for (const t of ann.tags) { if (t) check('tags', t); }
    check('filePath', ann.filePath);
    for (const g of (ann.groups || [])) { if (g) check('groups', g); }
    if (ann.fields) {
      for (const v of Object.values(ann.fields)) { if (v) check('fields', v); }
    }

    return hits;
  }

  // ─── Private: 片段提取 ─────────────────────────────────

  private _extractSnippets(ann: Annotation, tokens: string[]): Record<string, string> {
    const snippets: Record<string, string> = {};
    for (const token of tokens) {
      if (ann.text.toLowerCase().includes(token)) {
        snippets.text = this._snippetAround(ann.text, token);
        break;
      }
    }
    return snippets;
  }

  private _snippetAround(text: string, token: string, context: number = 30): string {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(token);
    if (idx === -1) return text.slice(0, 60);

    const start = Math.max(0, idx - context);
    const end = Math.min(text.length, idx + token.length + context);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return snippet;
  }

  private _determineMatchField(ann: Annotation, tokens: string[]): string {
    const order: Array<keyof typeof FIELD_WEIGHTS> = ['text', 'note', 'tags', 'alias', 'filePath', 'groups', 'fields', 'uuid'];
    for (const field of order) {
      const texts: string[] = [];
      if (field === 'text') texts.push(ann.text);
      else if (field === 'note') texts.push(ann.note || '');
      else if (field === 'tags') texts.push(...ann.tags);
      else if (field === 'alias') texts.push(ann.alias || '');    // v5.3: 图谱别名匹配
      else if (field === 'filePath') texts.push(ann.filePath);
      else if (field === 'groups') texts.push(...(ann.groups || []));
      else if (field === 'uuid') texts.push(ann.uuid);
      else if (field === 'fields' && ann.fields) texts.push(...Object.values(ann.fields));

      for (const text of texts) {
        if (!text) continue;
        const lower = text.toLowerCase();
        if (tokens.some(t => lower.includes(t))) {
          return field;
        }
      }
    }
    return 'text';
  }

  private _findBestSnippet(ann: Annotation, tokens: string[]): string {
    const lowerText = ann.text.toLowerCase();
    for (const token of tokens) {
      if (lowerText.includes(token)) {
        return this._snippetAround(ann.text, token);
      }
    }
    return ann.text.slice(0, 60) + (ann.text.length > 60 ? '…' : '');
  }
}
