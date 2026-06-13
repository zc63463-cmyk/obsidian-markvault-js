/**
 * 隐身锚点 + 可见 CSS 包裹标注
 *
 * 格式：
 *   高亮  → %%mv:i:<uuid>:highlight:<color>%%==文本==
 *   粗体  → %%mv:i:<uuid>:bold:<color>%%<b class="markvault-native markvault-bold markvault-<color>" data-uuid="<uuid>">文本</b>
 *   下划线 → %%mv:i:<uuid>:underline:<color>%%<u>文本</u>
 *
 * 锚点负责身份标识（uuid / type / color），可见包裹负责阅读模式快速定位（带 data-uuid/class）。
 * 元数据（note / tags / fields）存 Store。
 */

import type { Annotation, AnnotationType } from '../types/annotation';
import { generateId } from '../utils/id';

/** 匹配隐身锚点 */
export const NATIVE_ANCHOR_REGEX = /%%mv:i:([^:%]+):([^:%]+):([^:%]+)%%/g;

/** 根据 type 获取自然语法包裹符号 */
export function getNativeWrapper(type: AnnotationType): { open: string; close: string; tag?: string; html?: boolean } {
  switch (type) {
    case 'bold':
      // 粗体试验田：用 <b class="..."> 包裹，便于阅读模式直接命中
      return { open: `<b class="markvault-native markvault-bold">`, close: '</b>', tag: 'b', html: true };
    case 'underline':
      return { open: '<u>', close: '</u>', tag: 'u' };
    case 'highlight':
    default:
      return { open: '==', close: '==' };
  }
}

/** 判断某个闭合符号是否可能是 Markdown 语法的一部分，避免误判 */
function isEscaped(doc: string, pos: number): boolean {
  let backslashes = 0;
  let p = pos - 1;
  while (p >= 0 && doc[p] === '\\') {
    backslashes++;
    p--;
  }
  return backslashes % 2 === 1;
}

/**
 * 查找粗体试验田的 <b class="markvault-native ..." data-uuid="...">...</b> 包裹
 */
function findNativeBoldWrapper(
  doc: string,
  pos: number,
): { wrapperStart: number; contentStart: number; contentEnd: number; wrapperEnd: number; text: string } | null {
  const boldRegex = /^<b\s+class="markvault-native\s+markvault-bold\s+markvault-([^"\s]+)(?:\s+markvault-clickable)?"\s+data-uuid="([^"]+)"\s+data-type="bold"\s+data-color="([^"]+)">([^<]*)<\/b>/;
  const slice = doc.substring(pos);
  const match = slice.match(boldRegex);
  if (!match) return null;

  const wrapperStart = pos;
  const contentStart = wrapperStart + match[0].indexOf('>') + 1;
  const contentEnd = contentStart + match[4].length;
  const wrapperEnd = wrapperStart + match[0].length;
  const text = match[4];

  if (text.length === 0) return null;
  return { wrapperStart, contentStart, contentEnd, wrapperEnd, text };
}

/** 在文档中查找锚点后紧跟的可见包裹范围 */
export function findNativeWrapper(
  doc: string,
  anchorEnd: number,
  type: AnnotationType,
): { wrapperStart: number; contentStart: number; contentEnd: number; wrapperEnd: number; text: string } | null {
  // 允许锚点和包裹之间有少量空白/换行
  let pos = anchorEnd;
  while (pos < doc.length && /\s/.test(doc[pos])) pos++;

  // 粗体试验田：可见包裹是 <b class="markvault-native ...">...</b>
  if (type === 'bold') {
    return findNativeBoldWrapper(doc, pos);
  }

  const wrapper = getNativeWrapper(type);

  if (!doc.startsWith(wrapper.open, pos)) return null;

  const wrapperStart = pos;
  const contentStart = wrapperStart + wrapper.open.length;

  // 查找闭合符号，跳过转义
  let searchFrom = contentStart;
  while (true) {
    const closeIdx = doc.indexOf(wrapper.close, searchFrom);
    if (closeIdx === -1) return null;
    if (isEscaped(doc, closeIdx)) {
      searchFrom = closeIdx + 1;
      continue;
    }
    const contentEnd = closeIdx;
    const wrapperEnd = closeIdx + wrapper.close.length;
    const text = doc.substring(contentStart, contentEnd);
    if (text.length === 0) return null;
    return { wrapperStart, contentStart, contentEnd, wrapperEnd, text };
  }
}

/** 构建隐身锚点字符串 */
export function buildNativeAnchor(uuid: string, type: AnnotationType, color: string): string {
  return `%%mv:i:${uuid}:${type}:${color}%%`;
}

/** 构建完整的自然语法标注文本（锚点 + 包裹） */
export function buildNativeAnnotation(annotation: Pick<Annotation, 'uuid' | 'type' | 'color' | 'text'>): string {
  const anchor = buildNativeAnchor(annotation.uuid, annotation.type, annotation.color);
  const wrapper = getNativeWrapper(annotation.type);
  if (annotation.type === 'bold') {
    // 粗体可见包裹带 class / data-uuid，便于阅读模式快速定位
    return `${anchor}<b class="markvault-native markvault-bold markvault-${annotation.color} markvault-clickable" data-uuid="${annotation.uuid}" data-type="bold" data-color="${annotation.color}">${annotation.text}</b>`;
  }
  return `${anchor}${wrapper.open}${annotation.text}${wrapper.close}`;
}

/**
 * 从 Markdown 内容解析所有自然语法标注
 */
export function parseNativeAnnotations(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown' }> {
  const results: Array<Annotation & { _source: 'markdown' }> = [];

  NATIVE_ANCHOR_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = NATIVE_ANCHOR_REGEX.exec(content)) !== null) {
    try {
      const anchorStart = match.index;
      const anchorEnd = anchorStart + match[0].length;
      const uuid = match[1];
      const type = match[2] as AnnotationType;
      const color = match[3];

      const wrapper = findNativeWrapper(content, anchorEnd, type);
      if (!wrapper) continue;

      results.push({
        uuid,
        filePath,
        type,
        color,
        text: wrapper.text,
        note: '',
        tags: [],
        startOffset: anchorStart,
        endOffset: wrapper.wrapperEnd,
        startLine: content.substring(0, anchorStart).split('\n').length - 1,
        contextBefore: '',
        contextAfter: '',
        createdAt: 0,
        updatedAt: 0,
        kind: 'inline',
        format: 'native',
        _source: 'markdown' as const,
      });

      // 跳过已处理的包裹部分，避免重复解析
      NATIVE_ANCHOR_REGEX.lastIndex = wrapper.wrapperEnd;
    } catch (err) {
      console.error('MarkVault: parseNativeAnnotations error', err);
    }
  }

  return results;
}

/**
 * 从 Markdown 内容中移除指定 uuid 的自然语法标注
 * 返回新内容；未找到返回 null
 */
export function removeNativeAnnotation(content: string, uuid: string): string | null {
  const regex = new RegExp(`%%mv:i:${escapeRegex(uuid)}:([^:%]+):([^:%]+)%%`, 'g');

  const matches: { index: number; length: number; type: AnnotationType }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    matches.push({ index: m.index, length: m[0].length, type: m[1] as AnnotationType });
  }

  if (matches.length === 0) return null;

  // 从后往前处理，避免前面删除后偏移变化
  let result = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, length, type } = matches[i];
    const wrapper = findNativeWrapper(result, index + length, type);
    if (!wrapper) continue;
    result = result.substring(0, index) + wrapper.text + result.substring(wrapper.wrapperEnd);
  }

  return result;
}

/**
 * 更新指定 uuid 自然语法标注的颜色（和 type，如果提供）
 */
export function updateNativeAnnotation(
  content: string,
  uuid: string,
  updates: { type?: AnnotationType; color?: string },
): string | null {
  const regex = new RegExp(`%%mv:i:${escapeRegex(uuid)}:([^:%]+):([^:%]+)%%`, 'g');

  const matches: { index: number; length: number; oldType: AnnotationType; oldColor: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    matches.push({ index: m.index, length: m[0].length, oldType: m[1] as AnnotationType, oldColor: m[2] });
  }

  if (matches.length === 0) return null;

  let result = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, length, oldType, oldColor } = matches[i];
    const wrapper = findNativeWrapper(result, index + length, oldType);
    if (!wrapper) continue;

    const currentType = updates.type || oldType;
    const currentColor = updates.color || oldColor;
    const newTag = buildNativeAnnotation({ uuid, type: currentType, color: currentColor, text: wrapper.text });
    result = result.substring(0, index) + newTag + result.substring(wrapper.wrapperEnd);
  }

  return result;
}

/**
 * 从 Markdown 内容中移除所有自然语法标注的锚点和包裹符号，保留内部文本
 * 用于偏移恢复/纯文本计算
 */
export function stripNativeAnnotations(content: string): string {
  const matches: { index: number; length: number; type: AnnotationType }[] = [];
  let m: RegExpExecArray | null;
  NATIVE_ANCHOR_REGEX.lastIndex = 0;
  while ((m = NATIVE_ANCHOR_REGEX.exec(content)) !== null) {
    matches.push({ index: m.index, length: m[0].length, type: m[2] as AnnotationType });
  }

  let result = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, length, type } = matches[i];
    const wrapper = findNativeWrapper(result, index + length, type);
    if (!wrapper) continue;
    result = result.substring(0, index) + wrapper.text + result.substring(wrapper.wrapperEnd);
  }

  return result;
}

/** 正则特殊字符转义 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
