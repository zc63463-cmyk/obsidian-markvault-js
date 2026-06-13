import type { Annotation, MarkAttributes, SpanRange } from '../types/annotation';
import type { AnnotationType } from '../types/annotation';
import { generateId } from '../utils/id';
import { encodeFields, decodeFields } from '../utils/fields';
import { scanMarkdownContexts } from './md-context';
import { computeBlockSignature, computeSpanSignature } from './block-fingerprint';

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

  // 匹配 <mark class="hltr-*">...</mark> 或 <span class="hltr-*">...</span>
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

  // 匹配没有 data-uuid 且没有 class="hltr-*" 的 <mark> 标签
  // 排除已经处理过的 MarkVault 和 Highlightr 格式
  const plainMarkRegex = /<mark(?![^>]*data-uuid)(?![^>]*class="hltr-)[^>]*>([\s\S]*?)<\/mark>/g;
  let match: RegExpExecArray | null;

  while ((match = plainMarkRegex.exec(content)) !== null) {
    const innerText = match[1];

    const startOffset = match.index;
    const endOffset = match.index + match[0].length;
    const lineCount = content.substring(0, startOffset).split('\n').length;

    results.push({
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
    // 🔧 P2 修复：对属性值进行 HTML 实体解码
    // 因为 escapeAttr() 会在写入时编码特殊字符（& " < >），
    // 解析时需要解码，否则 round-trip 会导致双重编码
    result[m[1]] = decodeHTMLEntities(m[2]);
  }
  // 🔧 将 data- 前缀属性名转换为驼峰式
  // data-uuid → uuid, data-type → type, data-color → color,
  // data-note → note, data-tags → tags, data-group-uuid → groupUuid
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
 * 将 &amp; &quot; &lt; &gt; 解码回原字符
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
 * 将标注写入 Markdown 时使用
 *
 * @param annotation 标注数据
 * @param groupUuid 可选的组 ID，用于拆分标注（Track A）
 *                  当选区包含公式/代码时，标注会被拆分为多个 mark 标签，
 *                  它们通过 data-group-uuid 关联为同一组
 */
export function buildMarkTag(annotation: Annotation, groupUuid?: string): string {
  const attrs = [
    `data-uuid="${annotation.uuid}"`,
    `data-type="${annotation.type}"`,
    `data-color="${annotation.color}"`,
    `class="markvault-${annotation.type} markvault-${annotation.color}"`,
  ];

  // 始终写入 data-note，即使是空字符串，这样解析时不会得到 undefined
  // 空字符串会被 parseMarkAttributes 正确解析为空字符串
  attrs.push(`data-note="${escapeAttr(annotation.note || '')}"`);

  // 🆕 拆分标注组 ID
  if (groupUuid || annotation.groupUuid) {
    attrs.push(`data-group-uuid="${groupUuid || annotation.groupUuid}"`);
  }

  if (annotation.tags.length > 0) {
    attrs.push(`data-tags="${escapeAttr(annotation.tags.join(','))}"`);
  }

  // 🆕 Phase 3: 写入 data-fields 属性
  if (annotation.fields && Object.keys(annotation.fields).length > 0) {
    const encodedFields = encodeFields(annotation.fields);
    if (encodedFields) {
      attrs.push(`data-fields="${escapeAttr(encodedFields)}"`);
    }
  }

  return `<mark ${attrs.join(' ')}>${annotation.text}</mark>`;
}

/**
 * 从 Markdown 文本中移除指定 uuid 的 <mark> 标签
 * 返回清理后的文本和被移除标注的原文
 */
export function removeMarkTag(content: string, uuid: string): { content: string; text: string } | null {
  const regex = new RegExp(
    `<mark\\s+[^>]*data-uuid="${escapeRegex(uuid)}"[^>]*>([\\s\\S]*?)<\\/mark>`,
    'g',
  );

  let text = '';
  const newContent = content.replace(regex, (_match, innerText) => {
    text = innerText;
    return innerText;
  });

  if (text === '' && content === newContent) return null;
  return { content: newContent, text };
}

/**
 * 更新 Markdown 文本中指定 uuid 的 <mark> 属性
 */
export function updateMarkTag(
  content: string,
  uuid: string,
  updates: Partial<Pick<Annotation, 'note' | 'tags' | 'color' | 'type'>> & { fields?: string },
): string {
  const regex = new RegExp(
    `(<mark\\s+[^>]*data-uuid="${escapeRegex(uuid)}"[^>]*>)([\\s\\S]*?)(<\\/mark>)`,
    'g',
  );

  return content.replace(regex, (fullMatch, openTag, innerText, closeTag) => {
    let newOpenTag = openTag;

    // 更新 color
    if (updates.color !== undefined) {
      const oldColorMatch = newOpenTag.match(/data-color="([^"]*)"/);
      const oldColor = oldColorMatch ? oldColorMatch[1] : '';
      newOpenTag = newOpenTag.replace(
        /data-color="[^"]*"/,
        `data-color="${updates.color}"`,
      );
      // 更新 class 中的颜色部分：精确替换旧颜色 class
      if (oldColor) {
        newOpenTag = newOpenTag.replace(
          new RegExp(`markvault-${escapeRegex(oldColor)}(?=\\s|")`, 'g'),
          `markvault-${updates.color}`,
        );
      }
    }

    // 更新 type
    if (updates.type !== undefined) {
      const oldTypeMatch = newOpenTag.match(/data-type="([^"]*)"/);
      const oldType = oldTypeMatch ? oldTypeMatch[1] : '';
      newOpenTag = newOpenTag.replace(
        /data-type="[^"]*"/,
        `data-type="${updates.type}"`,
      );
      // 更新 class 中的类型部分
      if (oldType) {
        newOpenTag = newOpenTag.replace(
          new RegExp(`markvault-${escapeRegex(oldType)}(?=\\s|")`, 'g'),
          `markvault-${updates.type}`,
        );
      }
    }

    // 更新 note
    // 关键修复：使用 `!== undefined` 判断，而非 truthy 检查
    // 否则空字符串 "" 会被当作 falsy，错误地删除 data-note 属性
    if (updates.note !== undefined) {
      if (/data-note="/.test(newOpenTag)) {
        // 已有 data-note 属性 → 直接替换值（包括替换为空字符串）
        newOpenTag = newOpenTag.replace(/data-note="[^"]*"/, `data-note="${escapeAttr(updates.note)}"`);
      } else {
        // 无 data-note 属性 → 插入新属性（在闭合 > 之前）
        newOpenTag = newOpenTag.replace(/>$/, ` data-note="${escapeAttr(updates.note)}">`);
      }
    }

    // 更新 tags
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

    // 🆕 Phase 3: 更新 fields
    if (updates.fields !== undefined) {
      if (updates.fields) {
        // 有 fields 值 → 写入/替换 data-fields 属性
        if (/data-fields="/.test(newOpenTag)) {
          newOpenTag = newOpenTag.replace(/data-fields="[^"]*"/, `data-fields="${escapeAttr(updates.fields)}"`);
        } else {
          newOpenTag = newOpenTag.replace(/>$/, ` data-fields="${escapeAttr(updates.fields)}">`);
        }
      } else {
        // fields 为空字符串 → 移除 data-fields 属性
        newOpenTag = newOpenTag.replace(/\s*data-fields="[^"]*"/, '');
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

/** 正则特殊字符转义 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Track B: 块级锚点标注 ──────────────────────────────

/**
 * 块级标注锚点格式：%%markvault:uuid:type:color:note%%
 *
 * 使用 Obsidian 原生注释语法 %%...%%，阅读模式下不可见。
 * 锚点紧贴在目标块上方，CM6/PostProcessor 检测锚点后
 * 给下方内容块添加装饰效果。
 *
 * 示例：
 * ```markdown
 * %%markvault:abc-123:highlight:yellow:重要公式%%
 * $$
 * \int_0^1 f(x)dx
 * $$
 * ```
 */

/** 锚点字段中的冒号转义（因为冒号是分隔符） */
function escapeAnchorField(s: string): string {
  return s.replace(/:/g, '\\c');
}

/** 锚点字段中的冒号反转义 */
function decodeAnchorField(s: string): string {
  return s.replace(/\\c/g, ':');
}

/**
 * 生成块级标注锚点字符串
 */
export function buildBlockAnchor(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
}): string {
  return `%%markvault:${annotation.uuid}:${annotation.type}:${annotation.color}:${escapeAnchorField(annotation.note || '')}%%`;
}

/**
 * 生成 span 标注锚点字符串（方案C）
 * 使用 markvault-span: 前缀区分于 block 标注的 markvault: 前缀
 */
export function buildSpanAnchor(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
}): string {
  return `%%markvault-span:${annotation.uuid}:${annotation.type}:${annotation.color}:${escapeAnchorField(annotation.note || '')}%%`;
}

/** 块级锚点解析结果 */
export interface ParsedBlockAnchor {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  /** 锚点在全文中的字符偏移 */
  anchorOffset: number;
  /** 锚点所在行号（0-based） */
  anchorLine: number;
  /** 锚点类型标记：block 或 span */
  anchorKind: 'block' | 'span';
}

/**
 * 从 Markdown 内容中解析所有块级标注锚点
 * 支持 %%markvault:...%% (block) 和 %%markvault-span:...%% (span) 两种格式
 */
export function parseBlockAnchors(content: string): ParsedBlockAnchor[] {
  const results: ParsedBlockAnchor[] = [];

  // 1. 解析 block 格式：%%markvault:uuid:type:color:note%%
  // 🔧 修复：note 段可选，支持 %%markvault:uuid:type:color%% (无冒号) 和 %%markvault:uuid:type:color:%% (空note)
  const blockRegex = /%%markvault:([^:%]+):([^:%]+):([^:%]+)(?::([^%]*))?%%/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const anchorOffset = match.index;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note: match[4] ? decodeAnchorField(match[4]) : '',
      anchorOffset,
      anchorLine: lineCount - 1,
      anchorKind: 'block',
    });
  }

  // 2. 解析 span 格式：%%markvault-span:uuid:type:color:note%%
  // 🔧 修复：note 段可选，同上
  const spanRegex = /%%markvault-span:([^:%]+):([^:%]+):([^:%]+)(?::([^%]*))?%%/g;
  while ((match = spanRegex.exec(content)) !== null) {
    const anchorOffset = match.index;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note: match[4] ? decodeAnchorField(match[4]) : '',
      anchorOffset,
      anchorLine: lineCount - 1,
      anchorKind: 'span',
    });
  }

  return results;
}

/**
 * 从 Markdown 内容中移除指定 uuid 的块级锚点
 */
export function removeBlockAnchor(content: string, uuid: string): string {
  // 🔧 P1 修复：使用非贪婪匹配，避免 note 中包含 % 时截断
  const regex = new RegExp(`%%markvault:${escapeRegex(uuid)}:[\\s\\S]*?%%\\n?`, 'g');
  return content.replace(regex, '');
}

/**
 * 从 Markdown 内容中移除指定 uuid 的 span 锚点
 */
export function removeSpanAnchor(content: string, uuid: string): string {
  // 🔧 P1 修复：使用非贪婪匹配，避免 note 中包含 % 时截断
  const regex = new RegExp(`%%markvault-span:${escapeRegex(uuid)}:[\\s\\S]*?%%\\n?`, 'g');
  return content.replace(regex, '');
}

/**
 * 移除任意类型的锚点（block 或 span），根据 kind 自动选择
 */
export function removeAnyAnchor(content: string, uuid: string, kind?: string): string {
  if (kind === 'span') {
    return removeSpanAnchor(content, uuid);
  }
  // 先尝试 block，再尝试 span（兼容不确定 kind 的情况）
  let result = removeBlockAnchor(content, uuid);
  if (result === content) {
    result = removeSpanAnchor(content, uuid);
  }
  return result;
}

/**
 * 更新 Markdown 内容中指定 uuid 的块级锚点属性
 */
export function updateBlockAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
  }>,
): string {
  // 🔧 修复：支持无 note 段的格式 %%markvault:uuid:type:color%%
  const regex = new RegExp(`%%markvault:${escapeRegex(uuid)}:([^:%]*):([^:%]*)(?::([^%]*))?%%`);

  return content.replace(regex, (_full, oldType: string, oldColor: string, oldNote: string | undefined) => {
    const type = updates.type || oldType;
    const color = updates.color || oldColor;
    const note = updates.note !== undefined ? escapeAnchorField(updates.note) : (oldNote || '');
    // 始终写入 note 段（即使为空），保持格式一致性
    return `%%markvault:${uuid}:${type}:${color}:${note}%%`;
  });
}

/**
 * 更新 Markdown 内容中指定 uuid 的 span 锚点属性
 */
export function updateSpanAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
  }>,
): string {
  // 🔧 修复：支持无 note 段的格式 %%markvault-span:uuid:type:color%%
  const regex = new RegExp(`%%markvault-span:${escapeRegex(uuid)}:([^:%]*):([^:%]*)(?::([^%]*))?%%`);

  return content.replace(regex, (_full, oldType: string, oldColor: string, oldNote: string | undefined) => {
    const type = updates.type || oldType;
    const color = updates.color || oldColor;
    const note = updates.note !== undefined ? escapeAnchorField(updates.note) : (oldNote || '');
    return `%%markvault-span:${uuid}:${type}:${color}:${note}%%`;
  });
}

/**
 * 更新任意类型的锚点（block 或 span），根据 kind 自动选择
 */
export function updateAnyAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
  }>,
  kind?: string,
): string {
  if (kind === 'span') {
    return updateSpanAnchor(content, uuid, updates);
  }
  // 先尝试 block，如果没匹配到再尝试 span
  const result = updateBlockAnchor(content, uuid, updates);
  if (result === content) {
    return updateSpanAnchor(content, uuid, updates);
  }
  return result;
}

/**
 * 从 Markdown 内容解析所有标注（包括行内 <mark> 和块级/span 锚点）
 * 统一入口，供 markdown-sync.ts 使用
 */
export function parseAllAnnotationsFromMarkdown(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> {
  // 1. 行内 <mark> 标注
  const inlineAnnotations = parseAnnotationsFromMarkdown(content, filePath);

  // 2. 块级/span 锚点标注
  const blockAnchors = parseBlockAnchors(content);
  const blockAnnotations: Array<Annotation & { _source: 'markdown' }> = blockAnchors.map(anchor => {
    // 🔧 修复：跳过锚点行、公式分隔符、代码围栏，找到有意义的内容行
    const lines = content.split('\n');
    const targetLine = anchor.anchorLine + 1; // 锚点下一行是目标块的起始
    let blockContent = '';
    let actualTargetLine = targetLine;

    // 向前扫描，跳过非内容行
    for (let i = targetLine; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('%%markvault') || trimmed === '$$' || trimmed === '$$$' || trimmed.startsWith('```')) {
        actualTargetLine = i + 1;
        continue;
      }
      // 跳过空行（但记录，因为后面可能需要空行分隔）
      if (trimmed === '') {
        actualTargetLine = i + 1;
        continue;
      }
      // 找到第一个有意义的内容行
      blockContent = trimmed;
      actualTargetLine = i;
      break;
    }

    const isSpan = anchor.anchorKind === 'span';

    // 对 span 标注，计算 spanRanges（文本片段的偏移范围）
    let spanRanges: SpanRange[] | undefined;
    let text = blockContent;

    // 计算 block/span 目标内容指纹
    const targetHash = isSpan
      ? computeSpanSignature(text)
      : computeBlockSignature(lines, actualTargetLine, isSpan ? undefined : 'paragraph');

    if (isSpan && actualTargetLine < lines.length) {
      // span 标注：收集 actualTargetLine 到下一个空行或下一个锚点行之间的所有内容
      const endLine = findSpanEndLine(lines, actualTargetLine);
      const fullSpanText = lines.slice(actualTargetLine, endLine + 1).join('\n');
      // 过滤掉锚点行本身（以防 targetLine 回退到锚点行）
      text = fullSpanText.replace(/^%%markvault(-span)?:[^%]+%%\n?/g, '').trim() || fullSpanText;

      // 计算文本片段在文档中的偏移
      spanRanges = computeSpanRanges(content, actualTargetLine, fullSpanText);
    }

    return {
      uuid: anchor.uuid,
      filePath,
      type: anchor.type,
      color: anchor.color,
      text,
      note: anchor.note,
      tags: [],
      startOffset: anchor.anchorOffset,
      endOffset: anchor.anchorOffset,
      startLine: actualTargetLine,
      contextBefore: '',
      contextAfter: '',
      createdAt: 0,
      updatedAt: 0,
      kind: isSpan ? 'span' as const : 'block' as const,
      blockType: isSpan ? undefined : 'paragraph',
      targetLine: actualTargetLine,
      anchorLine: anchor.anchorLine,
      spanRanges,
      targetHash,
      _source: 'markdown' as const,
    };
  });

  return [...inlineAnnotations, ...blockAnnotations];
}

/**
 * 查找 span 标注覆盖的结束行
 * 从 targetLine 开始，到空行或下一个锚点行为止
 */
export function findSpanEndLine(lines: string[], startLine: number): number {
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    // 🔧 修复：如果是锚点行且 i === startLine，也跳过（因为 span 锚点可能落在 targetLine 上）
    if (/^%%markvault(-span)?:/.test(line)) {
      if (i === startLine) {
        // targetLine 本身就是锚点行，跳到下一个有效行
        continue;
      }
      if (i > startLine) {
        endLine = i - 1;
      }
      break;
    }
    // 空行 → 结束
    if (line === '') {
      if (i > startLine) {
        endLine = i - 1;
      }
      break;
    }
    endLine = i;
  }
  return endLine;
}

/**
 * 计算 span 标注的文本片段偏移范围
 * 扫描目标内容中的特殊区域，返回纯文本片段的文档偏移
 */
export function computeSpanRanges(content: string, targetLine: number, targetText: string): SpanRange[] {
  // 计算目标行在文档中的偏移
  const lines = content.split('\n');
  let lineOffset = 0;
  for (let i = 0; i < targetLine; i++) {
    lineOffset += lines[i].length + 1; // +1 for \n
  }

  // 扫描目标文本的特殊内容
  const scanResult = scanMarkdownContexts(targetText);
  const ranges: SpanRange[] = [];

  for (const seg of scanResult.segments) {
    if (seg.type === 'text' && seg.content.trim().length > 0) {
      ranges.push({
        from: lineOffset + seg.startOffset,
        to: lineOffset + seg.endOffset,
      });
    }
  }

  return ranges;
}
