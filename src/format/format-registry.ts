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

  /** 清空所有已注册的格式（供热重载使用） */
  clear(): void {
    this.formats.clear();
  }

  /**
   * 从 Markdown 内容解析所有格式的标注
   * 每个格式独立 try-catch，单个格式异常不影响其他格式
   *
   * 🔧 BUG-13 修复：parseAll() 加入 UUID 去重逻辑，防止 native 标注被
   * MarkFormat 和 NativeFormat 双重拾取（与回退路径 seen Map 对齐）
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

    // UUID 去重：native 格式优先于 mark 格式（native 的偏移更准确）
    const seen = new Map<string, ParsedAnnotation>();
    for (const ann of results) {
      const existing = seen.get(ann.uuid);
      if (!existing || (ann.format === 'native' && existing.format !== 'native')) {
        seen.set(ann.uuid, ann);
      }
    }
    return [...seen.values()];
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
   *
   * 🔧 Phase H 修复：移除硬编码 'span'（span 由 BlockFormat 统一处理），
   * BlockFormat.strip() 已覆盖 %%markvault-span:...%% 格式。
   */
  stripAll(content: string): string {
    let result = content;
    // 顺序：mark → block（含 span）→ region → native
    // native 的 HTML wrapper 需要先由 mark strip 处理
    const order = ['mark', 'block', 'region', 'native'];
    for (const id of order) {
      const format = this.formats.get(id);
      if (format) {
        result = format.strip(result);
      }
    }
    return result;
  }

  /** 从标注对象推断对应的格式 id
   *
   * 🔧 BUG-14 修复：annotation.format 对 block/span/region 为 undefined，
   * 之前回退到 'mark' 导致 CRUD 操作路由到 MarkFormat（只能处理 <mark> 标签）。
   * 现改为根据 annotation.kind 推断正确的格式 id。
   */
  private resolveFormat(annotation: Annotation): AnnotationFormat {
    // 优先使用显式 format 字段
    if (annotation.format) {
      const format = this.formats.get(annotation.format);
      if (!format) {
        throw new Error(`FormatRegistry: no format registered for id "${annotation.format}"`);
      }
      return format;
    }
    // 根据 kind 推断格式 id
    const id = annotation.kind === 'block' || annotation.kind === 'span' ? 'block'
             : annotation.kind === 'region' ? 'region'
             : 'mark';
    const format = this.formats.get(id);
    if (!format) {
      throw new Error(`FormatRegistry: no format registered for inferred id "${id}" (kind=${annotation.kind})`);
    }
    return format;
  }
}

/** 共享的全局单例 */
export const formatRegistry = new FormatRegistry();
