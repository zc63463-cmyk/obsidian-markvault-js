/**
 * 隐身锚点 + 可见 CSS 包裹标注
 *
 * 格式：
 *   高亮   → %%mv:i:<uuid>:highlight:<color>%%<mark class="markvault-native markvault-highlight markvault-<color>" data-uuid="<uuid>">文本</mark>
 *   粗体   → %%mv:i:<uuid>:bold:<color>%%<b class="markvault-native markvault-bold markvault-<color>" data-uuid="<uuid>">文本</b>
 *   下划线 → %%mv:i:<uuid>:underline:<color>%%<u class="markvault-native markvault-underline markvault-<color>" data-uuid="<uuid>">文本</u>
 *
 * 锚点负责身份标识（uuid / type / color），可见包裹负责阅读模式快速定位（带 data-uuid/class）。
 * 元数据（note / tags / fields）存 Store。
 */

import type { Annotation, AnnotationType } from '../types/annotation';
import { generateId } from '../utils/id';

/** 匹配隐身锚点 */
export const NATIVE_ANCHOR_REGEX = /%%mv:i:([^:%]+):([^:%]+):([^:%]+)%%/g;

/** 生成新版带 class/data 的可见 HTML 包裹开标签 */
function buildNativeWrapper(
  type: AnnotationType,
  color: string,
  uuid: string,
): { open: string; close: string; tag: string } {
  const baseClass = `markvault-native markvault-${type} markvault-${color} markvault-clickable`;
  switch (type) {
    case 'bold':
      return {
        open: `<b class="${baseClass}" data-uuid="${uuid}" data-type="bold" data-color="${color}">`,
        close: '</b>',
        tag: 'b',
      };
    case 'underline':
      return {
        open: `<u class="${baseClass}" data-uuid="${uuid}" data-type="underline" data-color="${color}">`,
        close: '</u>',
        tag: 'u',
      };
    case 'highlight':
    default:
      return {
        open: `<mark class="${baseClass}" data-uuid="${uuid}" data-type="highlight" data-color="${color}">`,
        close: '</mark>',
        tag: 'mark',
      };
  }
}

/** 旧版自然语法包裹，仅用于兼容解析 */
function getLegacyNativeWrapper(type: AnnotationType): { open: string; close: string } | null {
  switch (type) {
    case 'bold':
      return { open: '**', close: '**' };
    case 'underline':
      return { open: '<u>', close: '</u>' };
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

/** 查找新版 <tag class="markvault-native ..." data-uuid="...">...</tag> 包裹
 *
 * 🔧 P0-3 修复：v5.x 的 [^<]* 不包含 < 字符，导致标注文本含 < 时定位失败。
 * 改为两步法：(1) 正则匹配开标签属性 (2) 手动搜索闭标签位置，文本可以包含任意字符。
 */
function findNativeHtmlWrapper(
  doc: string,
  pos: number,
  type: AnnotationType,
  tag: string,
): { wrapperStart: number; contentStart: number; contentEnd: number; wrapperEnd: number; text: string } | null {
  // 第1步：匹配开标签（不含文本内容部分，避免 [^<]* 的限制）
  const openRegex = new RegExp(
    `^<${tag}\\s+class="markvault-native\\s+markvault-${type}\\s+markvault-([^"\\s]+)(?:\\s+markvault-clickable)?"\\s+data-uuid="([^"]+)"\\s+data-type="${type}"\\s+data-color="([^"]+)">`,
  );
  const slice = doc.substring(pos);
  const openMatch = slice.match(openRegex);
  if (!openMatch) return null;

  const wrapperStart = pos;
  const contentStart = wrapperStart + openMatch[0].length;

  // 第2步：从 contentStart 开始手动搜索闭标签 </tag>
  const closeTag = `</${tag}>`;
  const closeIdx = doc.indexOf(closeTag, contentStart);
  if (closeIdx === -1) return null;

  const contentEnd = closeIdx;
  const wrapperEnd = closeIdx + closeTag.length;
  const text = doc.substring(contentStart, contentEnd);

  if (text.length === 0) return null;
  return { wrapperStart, contentStart, contentEnd, wrapperEnd, text };
}

/** 查找旧版 Markdown 符号包裹（==...== / **...** / <u>...</u>） */
function findLegacyNativeWrapper(
  doc: string,
  pos: number,
  type: AnnotationType,
): { wrapperStart: number; contentStart: number; contentEnd: number; wrapperEnd: number; text: string } | null {
  const wrapper = getLegacyNativeWrapper(type);
  if (!wrapper) return null;

  if (!doc.startsWith(wrapper.open, pos)) return null;

  const wrapperStart = pos;
  const contentStart = wrapperStart + wrapper.open.length;

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

/** 在文档中查找锚点后紧跟的可见包裹范围 */
export function findNativeWrapper(
  doc: string,
  anchorEnd: number,
  type: AnnotationType,
): { wrapperStart: number; contentStart: number; contentEnd: number; wrapperEnd: number; text: string } | null {
  // 允许锚点和包裹之间有少量空白（不跨行）
  // 🔧 P0 修复：跳过换行符会导致 Decoration.replace 跨行，
  // CM6 抛出 "Decorations that replace line breaks may not be specified via plugins"
  let pos = anchorEnd;
  while (pos < doc.length && doc[pos] !== '\n' && /[ \t]/.test(doc[pos])) pos++;

  // 优先识别新版 HTML 包裹（带 class/data-uuid）
  const tag = type === 'bold' ? 'b' : type === 'underline' ? 'u' : 'mark';
  const htmlWrapper = findNativeHtmlWrapper(doc, pos, type, tag);
  if (htmlWrapper) return htmlWrapper;

  // 兜底：识别旧版自然语法（==...== / **...** / <u>...</u>）
  return findLegacyNativeWrapper(doc, pos, type);
}

/** 构建隐身锚点字符串 */
export function buildNativeAnchor(uuid: string, type: AnnotationType, color: string): string {
  return `%%mv:i:${uuid}:${type}:${color}%%`;
}

/** 构建完整的自然语法标注文本（锚点 + 包裹） */
export function buildNativeAnnotation(annotation: Pick<Annotation, 'uuid' | 'type' | 'color' | 'text'>): string {
  const anchor = buildNativeAnchor(annotation.uuid, annotation.type, annotation.color);
  const wrapper = buildNativeWrapper(annotation.type, annotation.color, annotation.uuid);
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
  // 🔧 P1-1 修复：不在 content 上预收集偏移再用于修改后的 result，
  // 改为每次处理前在当前的 result 中重新定位锚点。
  let result: string = content;
  let changed = false;
  const reRegex = new RegExp(`%%mv:i:${escapeRegex(uuid)}:([^:%]+):([^:%]+)%%`, 'g');

  while (true) {
    reRegex.lastIndex = 0;
    // 从后往前搜索：找到该 uuid 在 result 中的最后一个锚点位置
    let lastMatch: RegExpExecArray | null = null;
    let rm: RegExpExecArray | null;
    while ((rm = reRegex.exec(result)) !== null) {
      lastMatch = rm;
    }

    if (!lastMatch) break;

    const anchorStart = lastMatch.index;
    const anchorEnd = anchorStart + lastMatch[0].length;
    const type = lastMatch[1] as AnnotationType; // 🔧 group 1 = type, not group 2 = color!

    const wrapper = findNativeWrapper(result, anchorEnd, type);
    if (!wrapper) break;

    result = result.substring(0, anchorStart) + wrapper.text + result.substring(wrapper.wrapperEnd);
    changed = true;
  }

  return changed ? result : null;
}

/**
 * 更新指定 uuid 自然语法标注的颜色（和 type，如果提供）
 */
export function updateNativeAnnotation(
  content: string,
  uuid: string,
  updates: { type?: AnnotationType; color?: string },
): string | null {
  // 🔧 P1-2 修复：不在 content 上预收集偏移再用于修改后的 result，
  // 改为每次处理前在当前的 result 中重新定位锚点。
  let result: string = content;
  let changed = false;
  const reRegex = new RegExp(`%%mv:i:${escapeRegex(uuid)}:([^:%]+):([^:%]+)%%`, 'g');

  while (true) {
    reRegex.lastIndex = 0;
    let lastMatch: RegExpExecArray | null = null;
    let rm: RegExpExecArray | null;
    while ((rm = reRegex.exec(result)) !== null) {
      lastMatch = rm;
    }

    if (!lastMatch) break;

    const anchorStart = lastMatch.index;
    const anchorEnd = anchorStart + lastMatch[0].length;
    const oldType = lastMatch[1] as AnnotationType;
    const oldColor = lastMatch[2];

    const wrapper = findNativeWrapper(result, anchorEnd, oldType);
    if (!wrapper) break;

    const currentType = updates.type || oldType;
    const currentColor = updates.color || oldColor;

    // 🔧 关键：如果 currentType/currentColor 与锚点中已存的值一致，
    // 替换后 result 不变 → while(true) 死循环。必须 break。
    if (currentType === oldType && currentColor === oldColor) break;

    const newTag = buildNativeAnnotation({ uuid, type: currentType, color: currentColor, text: wrapper.text });
    result = result.substring(0, anchorStart) + newTag + result.substring(wrapper.wrapperEnd);
    changed = true;
  }

  return changed ? result : null;
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
