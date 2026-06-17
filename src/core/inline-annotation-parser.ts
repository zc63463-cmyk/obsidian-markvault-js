/**
 * 行内标注解析器 — Track A
 * 
 * 处理 <mark> 标签格式的标注：
 * 1. MarkVault 格式：<mark data-uuid="..." data-type="..." data-color="...">text</mark>
 * 2. Highlightr 格式：<mark class="hltr-yellow">text</mark>
 * 3. 纯 <mark> 标签：<mark>text</mark>
 * 
 * 提供 parse/build/remove/update 完整生命周期。
 * 
 * @module inline-annotation-parser
 */

import type { Annotation, MarkAttributes } from '../types/annotation';
import type { AnnotationType } from '../types/annotation';
import { generateId } from '../utils/id';
import { encodeFields, decodeFields } from '../utils/fields';

const MARK_REGEX = /<mark\s+([^>]*)>([\s\S]*?)<\/mark>/g;
const ATTR_REGEX = /\b([\w-]+)="([^"]*)"/g;

/**
 * 从 Markdown 内容解析所有 <mark> 标注
 * 提取 uuid、type、color、note、tags 等属性
 *
 * 兼容模式：
 * 1. MarkVault 格式：<mark data-uuid="..." data-type="..." data-color="...">text</mark>
 * 2. Highlightr 格式：<mark class="hltr-yellow">text</mark> 或 <span class="hltr-yellow">text</span>
 * 3. 纯 <mark> 标签：<mark>text</mark>（无属性）
 *
 * 对于无 uuid 的标注，自动生成 uuid 以便导入到 MarkVault 数据库
 */
export function parseAnnotationsFromMarkdown(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> {
  const results: Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> = [];

  // 1. 解析 MarkVault 格式（带 data-uuid）
  results.push(...parseMarkVaultAnnotations(content, filePath));

  // 2. 解析 Highlightr 格式（<mark class="hltr-*"> 或 <span class="hltr-*">）
  results.push(...parseHighlightrAnnotations(content, filePath));

  // 3. 解析纯 <mark> 标签（无属性）
  results.push(...parsePlainMarkAnnotations(content, filePath));

  return results;
}

/** 解析 MarkVault 格式的 <mark> 标注 */
function parseMarkVaultAnnotations(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown' }> {
  const results: Array<Annotation & { _source: 'markdown' }> = [];
  let match: RegExpExecArray | null;

  MARK_REGEX.lastIndex = 0;
  while ((match = MARK_REGEX.exec(content)) !== null) {
    const attrsRaw = match[1];
    const innerText = match[2];
    const attrs = parseMarkAttributes(attrsRaw);

    // 必须有 uuid 才是 MarkVault 标注
    if (!attrs.uuid) continue;

    const startOffset = match.index;
    const endOffset = match.index + match[0].length;
    const lineCount = content.substring(0, startOffset).split('\n').length;

    results.push({
      uuid: attrs.uuid,
      filePath,
      type: attrs.type || 'highlight',
      color: attrs.color || 'yellow',
      text: innerText,
      note: attrs.note !== undefined ? attrs.note : '',
      tags: attrs.tags ? attrs.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      startOffset,
      endOffset,
      startLine: lineCount - 1,
      contextBefore: '',
      contextAfter: '',
      createdAt: 0,
      updatedAt: 0,
      kind: 'inline', // 🔧 标记为行内标注
      groupUuid: attrs.groupUuid, // 🔧 保留组 ID
      fields: attrs.fields ? decodeFields(attrs.fields) : undefined,
      alias: attrs.alias || undefined, // v5.3: 图谱显示别名
      _source: 'markdown',
    });
  }

  return results;
}

/** Highlightr 颜色 class 到 MarkVault 颜色 id 的映射 */
const HIGHLITR_COLOR_MAP: Record<string, string> = {
  'hltr-yellow': 'yellow',
  'hltr-green': 'green',
  'hltr-blue': 'blue',
  'hltr-pink': 'pink',
  'hltr-purple': 'purple',
  'hltr-red': 'pink',
  'hltr-orange': 'yellow',
  'hltr-cyan': 'blue',
};

/** 解析 Highlightr 格式的标注 */
function parseHighlightrAnnotations(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown'; _needsUpgrade: true }> {
  const results: Array<Annotation & { _source: 'markdown'; _needsUpgrade: true }> = [];

  const hltrRegex = /<(mark|span)\s+class="(hltr-\w+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = hltrRegex.exec(content)) !== null) {
    const className = match[2];
    const innerText = match[3];

    const colorId = HIGHLITR_COLOR_MAP[className] || 'yellow';

    const startOffset = match.index;
    const endOffset = match.index + match[0].length;
    const lineCount = content.substring(0, startOffset).split('\n').length;

    results.push({
      schemaVersion: 1,
      uuid: generateId(),
      filePath,
      type: 'highlight',
      color: colorId,
      text: innerText,
      note: '',
      tags: [],
      startOffset,
      endOffset,
      startLine: lineCount - 1,
      contextBefore: '',
      contextAfter: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _source: 'markdown',
      _needsUpgrade: true,
    });
  }

  return results;
}

/** 解析纯 <mark> 标签（无属性） */
function parsePlainMarkAnnotations(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown'; _needsUpgrade: true }> {
  const results: Array<Annotation & { _source: 'markdown'; _needsUpgrade: true }> = [];

  const plainMarkRegex = /<mark(?![^>]*data-uuid)(?![^>]*class="hltr-)[^>]*>([\s\S]*?)<\/mark>/g;
  let match: RegExpExecArray | null;

  while ((match = plainMarkRegex.exec(content)) !== null) {
    const innerText = match[1];

    const startOffset = match.index;
    const endOffset = match.index + match[0].length;
    const lineCount = content.substring(0, startOffset).split('\n').length;

    results.push({
      schemaVersion: 1,
      uuid: generateId(),
      filePath,
      type: 'highlight',
      color: 'yellow',
      text: innerText,
      note: '',
      tags: [],
      startOffset,
      endOffset,
      startLine: lineCount - 1,
      contextBefore: '',
      contextAfter: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _source: 'markdown',
      _needsUpgrade: true,
    });
  }

  return results;
}

/** 解析 <mark> 标签属性字符串 */
function parseMarkAttributes(raw: string): MarkAttributes {
  const result: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_REGEX.lastIndex = 0;
  while ((m = ATTR_REGEX.exec(raw)) !== null) {
    result[m[1]] = decodeHTMLEntities(m[2]);
  }
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith('data-')) {
      const camelKey = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      mapped[camelKey] = value;
    } else {
      mapped[key] = value;
    }
  }
  return mapped as unknown as MarkAttributes;
}

/**
 * HTML 实体解码 — 与 escapeAttr 互为逆操作
 */
function decodeHTMLEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * 生成 <mark> 标签字符串
 */
export function buildMarkTag(annotation: Annotation, groupUuid?: string): string {
  const attrs = [
    `data-uuid="${annotation.uuid}"`,
    `data-type="${annotation.type}"`,
    `data-color="${annotation.color}"`,
    `class="markvault-${annotation.type} markvault-${annotation.color}"`,
  ];

  attrs.push(`data-note="${escapeAttr(annotation.note || '')}"`);

  if (groupUuid || annotation.groupUuid) {
    attrs.push(`data-group-uuid="${groupUuid || annotation.groupUuid}"`);
  }

  if (annotation.tags.length > 0) {
    attrs.push(`data-tags="${escapeAttr(annotation.tags.join(','))}"`);
  }

  if (annotation.fields && Object.keys(annotation.fields).length > 0) {
    const encodedFields = encodeFields(annotation.fields);
    if (encodedFields) {
      attrs.push(`data-fields="${escapeAttr(encodedFields)}"`);
    }
  }

  if (annotation.alias) {
    attrs.push(`data-alias="${escapeAttr(annotation.alias)}"`);
  }

  return `<mark ${attrs.join(' ')}>${annotation.text}</mark>`;
}

/**
 * 从 Markdown 文本中移除指定 uuid 的 <mark> 标签
 */
export function removeMarkTag(content: string, uuid: string): { content: string; text: string } | null {
  const regex = new RegExp(
    `<mark\\s+[^>]*data-uuid="${escapeRegex(uuid)}"[^>]*>([\\s\\S]*?)<\\/mark>`,
    'g',
  );

  const allTexts: string[] = [];
  const newContent = content.replace(regex, (_match, innerText) => {
    allTexts.push(innerText);
    return innerText;
  });

  if (allTexts.length === 0) return null;
  return { content: newContent, text: allTexts.join('') };
}

/**
 * 更新 Markdown 文本中指定 uuid 的 <mark> 属性
 */
export function updateMarkTag(
  content: string,
  uuid: string,
  updates: Partial<Pick<Annotation, 'note' | 'tags' | 'color' | 'type' | 'alias'>> & { fields?: string },
): string {
  const regex = new RegExp(
    `(<mark\\s+[^>]*data-uuid="${escapeRegex(uuid)}"[^>]*>)([\\s\\S]*?)(<\\/mark>)`,
    'g',
  );

  return content.replace(regex, (fullMatch, openTag, innerText, closeTag) => {
    let newOpenTag = openTag;

    if (updates.color !== undefined) {
      const oldColorMatch = newOpenTag.match(/data-color="([^"]*)"/);
      const oldColor = oldColorMatch ? oldColorMatch[1] : '';
      newOpenTag = newOpenTag.replace(/data-color="[^"]*"/, `data-color="${updates.color}"`);
      if (oldColor) {
        newOpenTag = newOpenTag.replace(
          new RegExp(`markvault-${escapeRegex(oldColor)}(?=\\s|")`, 'g'),
          `markvault-${updates.color}`,
        );
      }
    }

    if (updates.type !== undefined) {
      const oldTypeMatch = newOpenTag.match(/data-type="([^"]*)"/);
      const oldType = oldTypeMatch ? oldTypeMatch[1] : '';
      newOpenTag = newOpenTag.replace(/data-type="[^"]*"/, `data-type="${updates.type}"`);
      if (oldType) {
        newOpenTag = newOpenTag.replace(
          new RegExp(`markvault-${escapeRegex(oldType)}(?=\\s|")`, 'g'),
          `markvault-${updates.type}`,
        );
      }
    }

    if (updates.note !== undefined) {
      if (/data-note="/.test(newOpenTag)) {
        newOpenTag = newOpenTag.replace(/data-note="[^"]*"/, `data-note="${escapeAttr(updates.note)}"`);
      } else {
        newOpenTag = newOpenTag.replace(/>$/, ` data-note="${escapeAttr(updates.note)}">`);
      }
    }

    if (updates.tags !== undefined) {
      if (updates.tags.length > 0) {
        const tagsStr = updates.tags.join(',');
        if (/data-tags="/.test(newOpenTag)) {
          newOpenTag = newOpenTag.replace(/data-tags="[^"]*"/, `data-tags="${tagsStr}"`);
        } else {
          newOpenTag = newOpenTag.replace(/>$/, ` data-tags="${tagsStr}">`);
        }
      } else {
        newOpenTag = newOpenTag.replace(/\s*data-tags="[^"]*"/, '');
      }
    }

    if (updates.fields !== undefined) {
      if (updates.fields) {
        if (/data-fields="/.test(newOpenTag)) {
          newOpenTag = newOpenTag.replace(/data-fields="[^"]*"/, `data-fields="${escapeAttr(updates.fields)}"`);
        } else {
          newOpenTag = newOpenTag.replace(/>$/, ` data-fields="${escapeAttr(updates.fields)}">`);
        }
      } else {
        newOpenTag = newOpenTag.replace(/\s*data-fields="[^"]*"/, '');
      }
    }

    if (updates.alias !== undefined) {
      if (updates.alias) {
        if (/data-alias="/.test(newOpenTag)) {
          newOpenTag = newOpenTag.replace(/data-alias="[^"]*"/, `data-alias="${escapeAttr(updates.alias)}"`);
        } else {
          newOpenTag = newOpenTag.replace(/>$/, ` data-alias="${escapeAttr(updates.alias)}">`);
        }
      } else {
        newOpenTag = newOpenTag.replace(/\s*data-alias="[^"]*"/, '');
      }
    }

    return `${newOpenTag}${innerText}${closeTag}`;
  });
}

/** HTML 属性值转义 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 正则特殊字符转义（Track B 也会使用） */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
