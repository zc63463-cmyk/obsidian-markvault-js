/**
 * 标注渲染缓存层
 * 
 * 为 CM6 ViewPlugin 和 Region Layer 提供三组内存缓存：
 * - Span 缓存：按文件路径索引的 span 标注（含 spanRanges）
 * - Region 缓存：按文件路径索引的 region 标注（含 startOffset/endOffset）
 * - Block 缓存：按文件路径索引的 block 标注（含 targetLine）
 * 
 * 从 AnnotationStore 加载，在 cache-manager.ts 中更新，
 * 供 highlight-applier.ts 中的 ViewPlugin 和 region layer 消费。
 */

import type { AnnotationType, SpanRange } from '../types/annotation';

// ─── Span Annotation Cache ──────────────────────────────────

/** Span 标注缓存数据（从 DB 加载） */
export interface SpanAnnotationData {
  uuid: string;
  type: AnnotationType;
  color: string;
  anchorLine: number;
  spanRanges: SpanRange[];
  note: string;
}

/**
 * 全局 span 标注缓存，按文件路径索引
 * 在 main.ts 的 updateSpanCache() 中更新
 * MarkVaultDecorator 构建装饰时从此缓存读取
 */
const spanCache = new Map<string, SpanAnnotationData[]>();

/** 更新指定文件的 span 标注缓存 */
export function updateSpanCacheForFile(filePath: string, annotations: SpanAnnotationData[]): void {
  if (annotations.length > 0) {
    spanCache.set(filePath, annotations);
  } else {
    spanCache.delete(filePath);
  }
}

/** 获取指定文件的 span 标注缓存 */
export function getSpanCacheForFile(filePath: string): SpanAnnotationData[] {
  return spanCache.get(filePath) || [];
}

/** 清除指定文件的 span 标注缓存 */
export function clearSpanCacheForFile(filePath: string): void {
  spanCache.delete(filePath);
}

/** 清除所有 span 缓存 */
export function clearSpanCache(): void {
  spanCache.clear();
}

// ─── Region Annotation Cache ──────────────────────────────────

/** Region 标注缓存数据（从 DB 加载） */
export interface RegionAnnotationData {
  uuid: string;
  type: AnnotationType;
  color: string;
  startOffset: number;
  endOffset: number;
  note: string;
}

const regionCache = new Map<string, RegionAnnotationData[]>();

export function updateRegionCacheForFile(filePath: string, annotations: RegionAnnotationData[]): void {
  if (annotations.length > 0) {
    regionCache.set(filePath, annotations);
  } else {
    regionCache.delete(filePath);
  }
}

export function getRegionCacheForFile(filePath: string): RegionAnnotationData[] {
  return regionCache.get(filePath) || [];
}

export function clearRegionCacheForFile(filePath: string): void {
  regionCache.delete(filePath);
}

export function clearRegionCache(): void {
  regionCache.clear();
}

// ─── Block Annotation Cache ──────────────────────────────────

/** Block 标注缓存数据（从 DB 加载） */
export interface BlockAnnotationData {
  uuid: string;
  type: AnnotationType;
  color: string;
  targetLine: number;
  note: string;
}

const blockCache = new Map<string, BlockAnnotationData[]>();

export function updateBlockCacheForFile(filePath: string, annotations: BlockAnnotationData[]): void {
  if (annotations.length > 0) {
    blockCache.set(filePath, annotations);
  } else {
    blockCache.delete(filePath);
  }
}

export function getBlockCacheForFile(filePath: string): BlockAnnotationData[] {
  return blockCache.get(filePath) || [];
}

export function clearBlockCacheForFile(filePath: string): void {
  blockCache.delete(filePath);
}

export function clearBlockCache(): void {
  blockCache.clear();
}
