/**
 * PdfFormat — PDF 标注格式（空壳实现）
 *
 * PDF 标注不写入 Markdown 文件，数据只存在 MarkVault Store（分片 JSON）。
 * 这与 Markdown 标注的"双写"模式不同：
 * - Markdown 标注：锚点写入 .md 文件 + Store 存储元数据
 * - PDF 标注：只存 Store，PDF 文件保持干净
 *
 * 实现 AnnotationFormat 接口是为了让 FormatRegistry 能统一路由，
 * 但所有方法都是 no-op：
 * - parse: 返回空数组（PDF 不从文件解析标注）
 * - build: 返回空字符串（不生成文件内容）
 * - update/remove/strip: 原样返回内容（不修改文件）
 */

import type { Annotation } from '../types/annotation';
import type { AnnotationFormat, ParsedAnnotation, FormatUpdates } from '../format/format-interface';

export class PdfFormat implements AnnotationFormat {
  readonly id = 'pdf' as const;

  /**
   * PDF 标注不从文件解析。
   * 标注数据来自 Store，文件内容不包含标注锚点。
   */
  parse(_content: string, _filePath: string): ParsedAnnotation[] {
    return [];
  }

  /**
   * PDF 标注不生成文件内容。
   */
  build(_annotation: Annotation): string {
    return '';
  }

  /**
   * PDF 标注不在文件中更新。
   * 返回 null 表示"未找到目标"，调用方应理解为"无需修改文件"。
   */
  update(content: string, _uuid: string, _changes: FormatUpdates): string | null {
    return null;
  }

  /**
   * PDF 标注不从文件移除。
   * 返回 null 表示"未找到目标"。
   */
  remove(content: string, _uuid: string): string | null {
    return null;
  }

  /**
   * PDF 标注不嵌入文件内容，无需剥离。
   */
  strip(content: string): string {
    return content;
  }
}
