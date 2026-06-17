/**
 * AnnotationCreator — 统一标注创建服务
 *
 * 解决 v4.1 之前分散在 context-menu.ts / main.ts / native-annotation.ts
 * 共 7 个创建路径中的以下技术债：
 *
 * 1. Annotation 对象构建逻辑重复（schemaVersion/motivation 易漏设）
 * 2. 创建后缓存更新不一致（有的忘了 updateSpanCache/updateRegionCache）
 * 3. MD 写入与 Store 写入耦合，难以复用
 *
 * 设计原则：
 * - 构建（build）与持久化（finalize）分离
 * - finalize 统一处理 Store 写入 + 缓存更新 + 侧边栏刷新
 * - MD 写入由各调用方自行处理（编辑模式用 Editor API，阅读模式用 vault.modify）
 */

import type { Annotation, AnnotationType, SpanRange } from '../types/annotation';
import { inferMotivation } from '../types/annotation';
import { addAnnotation } from '../db/annotation-repo';

/** 创建 Annotation 对象所需的公共参数 */
export interface AnnotationCreateParams {
  uuid: string;
  filePath: string;
  type: AnnotationType;
  color: string;
  text: string;
  note?: string;
  tags?: string[];
  kind: Annotation['kind'];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine?: number;
  contextBefore: string;
  contextAfter: string;
  // kind-specific
  blockType?: string;
  targetLine?: number;
  anchorLine?: number;
  targetHash?: string;
  spanRanges?: SpanRange[];
  format?: 'mark' | 'native';
  // v3.0: 自定义字段（模板创建时传入）
  fields?: Record<string, string>;
  // v4.1: 显式指定 motivation（覆盖自动推断）
  motivation?: Annotation['motivation'];
}

/** finalize 回调接口 — 由调用方注入依赖 */
export interface AnnotationCreatorDeps {
  /** Store 写入后的缓存刷新 */
  updateSpanCache: (filePath: string) => Promise<void>;
  updateRegionCache: (filePath: string) => Promise<void>;
  /** 标记文件同步状态 */
  markFileSynced: (filePath: string) => void;
  /** 刷新侧边栏 */
  refreshSidebar: () => Promise<void>;
}

/**
 * 构建 Annotation 对象（纯数据层，不涉及 IO）
 *
 * 集中处理 schemaVersion、motivation 推断、kind 特定字段等，
 * 确保所有创建路径产出一致的 Annotation 对象。
 */
export function buildAnnotation(params: AnnotationCreateParams): Annotation {
  const now = Date.now();

  const annotation: Annotation = {
    schemaVersion: 2,
    uuid: params.uuid,
    filePath: params.filePath,
    type: params.type,
    color: params.color,
    text: params.text,
    note: params.note ?? '',
    tags: params.tags ?? [],
    startOffset: params.startOffset,
    endOffset: params.endOffset,
    startLine: params.startLine,
    endLine: params.endLine,
    contextBefore: params.contextBefore,
    contextAfter: params.contextAfter,
    createdAt: now,
    updatedAt: now,
    kind: params.kind,
    motivation: params.motivation ?? inferMotivation({
      note: params.note,
      kind: params.kind,
    }),
    // kind-specific
    format: params.format,
    blockType: params.blockType,
    targetLine: params.targetLine,
    anchorLine: params.anchorLine,
    targetHash: params.targetHash,
    spanRanges: params.spanRanges,
    // v3.0: 自定义字段
    fields: params.fields,
  };

  return annotation;
}

/**
 * 持久化标注：写入 Store + 刷新缓存 + 刷新侧边栏
 *
 * 所有创建路径（编辑模式和阅读模式）在完成 MD 写入后都应调用此函数。
 * 这是缓存更新和侧边栏刷新的唯一入口，确保不会再出现"忘了调 updateSpanCache"的问题。
 */
export async function finalizeAnnotation(
  annotation: Annotation,
  deps: AnnotationCreatorDeps,
): Promise<void> {
  // 1. 写入 Store
  await addAnnotation(annotation);

  // 2. 标记文件同步（避免后续自动 sync 重复处理）
  deps.markFileSynced(annotation.filePath);

  // 3. 刷新所有缓存 — span/block/region 缓存 + CM6 重绘
  await deps.updateSpanCache(annotation.filePath);
  await deps.updateRegionCache(annotation.filePath);

  // 4. 刷新侧边栏
  await deps.refreshSidebar();
}
