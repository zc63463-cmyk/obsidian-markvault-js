/**
 * AnnotationFormat — 标注格式统一抽象接口
 *
 * 所有 Markdown 标注格式（<mark>、%%mv:i%%、%%markvault%%、%%markvault-region%%）
 * 均实现此接口，提供统一的 parse/build/update/remove/strip 能力。
 *
 * 设计目标：
 * - 消除 annotation-parser.ts 中 ~40% 的 CRUD 模式代码重复
 * - 新增标注格式只需实现此接口并注册到 FormatRegistry
 * - 让 sync/offset-recovery/stream 等上层模块与具体格式解耦
 */

import type { Annotation, AnnotationType } from '../types/annotation';

/**
 * 格式解析返回的标注对象（含临时标记）
 */
export interface ParsedAnnotation extends Annotation {
  _source: 'markdown';
  _needsUpgrade?: boolean;
}

/**
 * 格式更新操作的变更描述
 *
 * fields 联合类型：mark 格式使用 encodeFields() 生成的 base64 字符串，
 * 其他格式使用原始 Record<string, string>。
 */
export interface FormatUpdates {
  type?: AnnotationType;
  color?: string;
  note?: string;
  tags?: string[];
  fields?: string | Record<string, string>;
  alias?: string;
}

/**
 * 标注格式抽象接口
 *
 * 每个实现类对应一种 Markdown 存储格式。生命周期：
 *   parse() → 从 MD 提取标注
 *   build() → 生成 MD 字符串
 *   update() → 更新 MD 中的已有标注
 *   remove() → 从 MD 中移除标注
 *   strip() → 剥离标记，保留纯文本
 */
export interface AnnotationFormat {
  /** 格式唯一标识 */
  readonly id: 'mark' | 'native' | 'block' | 'span' | 'region' | 'pdf';

  /**
   * 从 Markdown 内容解析所有该格式的标注
   * @returns 即使没有匹配项也应返回空数组，不抛异常
   */
  parse(content: string, filePath: string): ParsedAnnotation[];

  /**
   * 将标注对象构建为 Markdown 字符串
   */
  build(annotation: Annotation): string;

  /**
   * 在 Markdown 内容中更新指定 uuid 的标注
   * @returns 更新后的完整 MD 内容；未找到目标返回 null
   */
  update(content: string, uuid: string, changes: FormatUpdates): string | null;

  /**
   * 从 Markdown 内容中移除指定 uuid 的标注
   * @returns 移除后的完整 MD 内容；未找到目标返回 null
   */
  remove(content: string, uuid: string): string | null;

  /**
   * 从 Markdown 内容中剥离此格式的所有标记，保留内部文本
   * 用于偏移恢复/纯文本计算
   */
  strip(content: string): string;
}
