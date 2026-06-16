/**
 * FormatRegistry — 格式注册与路由
 *
 * 管理所有注册的 AnnotationFormat 实现，提供按 id 查找和批量操作。
 */

import type { AnnotationFormat, ParsedAnnotation, FormatUpdates } from './format-interface';
import type { Annotation } from '../types/annotation';

export class FormatRegistry {
  private formats = new Map<string, AnnotationFormat>();

  /** 注册一个格式实现 */
  register(format: AnnotationFormat): void {
    if (this.formats.has(format.id)) {
      throw new Error(`FormatRegistry: duplicate format id "${format.id}"`);
    }
    this.formats.set(format.id, format);
  }

  /** 按 id 获取格式实现 */
  get(id: string): AnnotationFormat | undefined {
    return this.formats.get(id);
  }

  /** 获取所有已注册的格式 */
  getAll(): AnnotationFormat[] {
    return [...this.formats.values()];
  }

  /**
   * 从 Markdown 内容解析所有格式的标注
   * 每个格式独立 try-catch，单个格式异常不影响其他格式
   */
  parseAll(content: string, filePath: string): ParsedAnnotation[] {
    const results: ParsedAnnotation[] = [];
    for (const format of this.formats.values()) {
      try {
        results.push(...format.parse(content, filePath));
      } catch (err) {
        console.error(`MarkVault: format "${format.id}" parse error`, err);
      }
    }
    return results;
  }

  /**
   * 根据 format id 调用对应的 build 方法
   */
  build(annotation: Annotation): string {
    const format = this.resolveFormat(annotation);
    return format.build(annotation);
  }

  /**
   * 根据 format id 调用对应的 update 方法
   */
  update(content: string, annotation: Annotation, changes: FormatUpdates): string | null {
    const format = this.resolveFormat(annotation);
    return format.update(content, annotation.uuid, changes);
  }

  /**
   * 根据 format id 调用对应的 remove 方法
   */
  remove(content: string, annotation: Annotation): string | null {
    const format = this.resolveFormat(annotation);
    return format.remove(content, annotation.uuid);
  }

  /**
   * 剥离所有已注册格式的标记，保留纯文本
   */
  stripAll(content: string): string {
    let result = content;
    // 先剥离行内格式（<mark> 标签），再剥离块级格式，最后处理 native
    // 排序：mark → block → region → native（避免 native 的 HTML wrapper 被 mark strip 提前处理）
    const order = ['mark', 'block', 'span', 'region', 'native'];
    for (const id of order) {
      const format = this.formats.get(id);
      if (format) {
        result = format.strip(result);
      }
    }
    return result;
  }

  /** 从标注对象推断对应的格式 id */
  private resolveFormat(annotation: Annotation): AnnotationFormat {
    // 优先使用显式字段
    const id = annotation.format || 'mark';
    const format = this.formats.get(id);
    if (!format) {
      throw new Error(`FormatRegistry: no format registered for id "${id}"`);
    }
    return format;
  }
}

/** 共享的全局单例 */
export const formatRegistry = new FormatRegistry();
