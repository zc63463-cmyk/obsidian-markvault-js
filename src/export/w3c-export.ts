/**
 * W3C 导出 API
 *
 * 连接 AnnotationStore 与 W3C 序列化器，提供高层导出接口。
 * 插件通过此模块的命令注册，将标注数据导出为 W3C 格式文件。
 *
 * Phase 3: 导出 + 可选导入
 */

import type { AnnotationStore } from '../db/annotation-store';
import type { Annotation } from '../types/annotation';
import type {
  W3CAnnotation,
  W3CAnnotationCollection,
  W3CExportOptions,
} from './w3c-types';
import { serializeAnnotation, serializeCollection, filterAnnotationsForExport } from './w3c-serializer';

// ═══════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════

/**
 * 将存储中的标注导出为 W3C AnnotationCollection。
 *
 * 使用方式（插件 command）：
 * ```ts
 * const w3cJson = exportToW3C(store, { filePath: 'note.md' });
 * const content = JSON.stringify(w3cJson, null, 2);
 * // 写入文件或复制到剪贴板
 * ```
 *
 * @param store AnnotationStore 实例
 * @param options 导出选项
 * @returns W3C AnnotationCollection
 */
export function exportToW3C(
  store: AnnotationStore,
  options: W3CExportOptions = {},
): W3CAnnotationCollection {
  const allAnnotations = store.getAllAnnotations();
  const filtered = filterAnnotationsForExport(allAnnotations, options);

  return serializeCollection(filtered, options);
}

/**
 * 导出单条标注为 W3C 格式。
 * 用于右键菜单"导出此标注"等场景。
 */
export function exportSingleToW3C(
  annotation: Annotation,
  idPrefix?: string,
): W3CAnnotation {
  return serializeAnnotation(annotation, idPrefix);
}

/**
 * 导出指定文件的所有标注为 W3C Collection。
 *
 * @param store AnnotationStore 实例
 * @param filePath 笔记文件路径
 * @param options 额外选项
 */
export function exportFileToW3C(
  store: AnnotationStore,
  filePath: string,
  options: Omit<W3CExportOptions, 'filePath'> = {},
): W3CAnnotationCollection {
  return exportToW3C(store, { ...options, filePath });
}

/**
 * 生成 W3C 导出 JSON 字符串。
 * 便捷方法：一次性完成过滤、序列化、格式化。
 */
export function exportToW3CString(
  store: AnnotationStore,
  options: W3CExportOptions = {},
  pretty: boolean = true,
): string {
  const collection = exportToW3C(store, options);
  return JSON.stringify(collection, null, pretty ? 2 : 0);
}

// ═══════════════════════════════════════════════════════
// 批量导出（多文件）
// ═══════════════════════════════════════════════════════

/**
 * 按文件分别导出：返回 Map<filePath, W3CCollection>。
 * 适用于"导出所有文件"的批量操作。
 */
export function exportByFile(
  store: AnnotationStore,
  options: Omit<W3CExportOptions, 'filePath'> = {},
): Map<string, W3CAnnotationCollection> {
  const results = new Map<string, W3CAnnotationCollection>();
  const allAnnotations = store.getAllAnnotations();

  // 按 filePath 分组
  const byFile = new Map<string, Annotation[]>();
  for (const ann of allAnnotations) {
    const list = byFile.get(ann.filePath);
    if (list) {
      list.push(ann);
    } else {
      byFile.set(ann.filePath, [ann]);
    }
  }

  for (const [filePath, annotations] of byFile) {
    const filtered = filterAnnotationsForExport(annotations, options);
    if (filtered.length > 0) {
      results.set(filePath, serializeCollection(filtered, options));
    }
  }

  return results;
}
