/**
 * PDFCreator — PDF 标注创建器
 *
 * 从 PDF 选区构建 Annotation 对象并写入 Store。
 *
 * 流程：
 * 1. 用户在 PDF 中选中文本
 * 2. PDFViewerBridge.getSelection() → { page, rects, text }
 * 3. PDFCreator.createAnnotation() → buildAnnotation → addAnnotation
 * 4. PDFRenderer.update() → SVG overlay 渲染高亮
 *
 * 关键设计：
 * - PDF 标注不写入 MD 文件，数据只在 Store（反向链接存储）
 * - text 字段默认留空（用户自行截图→AI→MD→粘贴填入）
 * - docType='pdf'，selector=PDFSelector
 * - 复用 buildAnnotation 模式但适配 PDF 场景
 */

import { logger } from '../utils/logger';
import { addAnnotation } from '../db/annotation-repo';
import { generateId } from '../utils/id';
import type { Annotation, AnnotationType, PDFSelector, PDFRect, PercentRect } from '../types/annotation';
import type { PDFSelectionResult } from './viewer-bridge';
import { computeTextHash } from './viewer-bridge';

// ─── 类型定义 ──────────────────────────────────────────

/** PDF 标注创建参数 */
export interface PDFAnnotationCreateParams {
  /** PDF 文件路径 */
  filePath: string;
  /** 选区提取结果 */
  selection: PDFSelectionResult;
  /** 标注类型 */
  type?: AnnotationType;
  /** 颜色 (preset id 或 hex) */
  color?: string;
  /** 批注内容（可选） */
  note?: string;
  /** 标签（可选） */
  tags?: string[];
}

// ─── 核心函数 ──────────────────────────────────────────

/**
 * 从 PDF 选区构建 Annotation 对象。
 *
 * 纯数据层，不涉及 IO。调用方负责后续的 addAnnotation + 渲染。
 */
export function buildPDFAnnotation(params: PDFAnnotationCreateParams): Annotation {
  const { filePath, selection, type = 'highlight', color = 'yellow', note = '', tags = [] } = params;
  const now = Date.now();

  const selector: PDFSelector = {
    type: 'pdf',
    page: selection.page,
    rects: selection.rects,
    percentRects: selection.percentRects,
    textHash: computeTextHash(selection.text),
  };

  const annotation: Annotation = {
    schemaVersion: 2,
    uuid: generateId(),
    filePath,
    type,
    color,
    text: '',  // PDF 标注默认留空，用户自行键入
    note,
    tags,
    startOffset: 0,  // PDF 标注无意义但需存在（兼容字段）
    endOffset: 0,
    startLine: 0,
    contextBefore: '',
    contextAfter: '',
    createdAt: now,
    updatedAt: now,
    docType: 'pdf',
    selector,
  };

  return annotation;
}

/**
 * 创建 PDF 标注的完整流程：构建 → 写入 Store。
 *
 * @returns 创建的 Annotation，失败返回 null
 */
export async function createPDFAnnotation(
  params: PDFAnnotationCreateParams,
): Promise<Annotation | null> {
  try {
    const annotation = buildPDFAnnotation(params);
    await addAnnotation(annotation);
    logger.debug(`PDFCreator: annotation ${annotation.uuid} created for ${params.filePath}`);
    return annotation;
  } catch (err) {
    logger.error('PDFCreator: failed to create annotation', err);
    return null;
  }
}

/**
 * 更新 PDF 标注的 selector（例如选区改变后重新定位）。
 */
export function buildUpdatedPDFSelector(
  page: number,
  rects: PDFRect[],
  percentRects?: PercentRect[],
  text?: string,
): PDFSelector {
  return {
    type: 'pdf',
    page,
    rects,
    percentRects,
    textHash: text ? computeTextHash(text) : undefined,
  };
}
