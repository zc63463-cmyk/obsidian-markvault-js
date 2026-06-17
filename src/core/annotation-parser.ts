import type { Annotation, MarkAttributes, SpanRange } from '../types/annotation';
import type { AnnotationType } from '../types/annotation';
import { generateId } from '../utils/id';
import { encodeFields, decodeFields } from '../utils/fields';
import { scanMarkdownContexts } from './md-context';
import { computeBlockSignature, computeSpanSignature, detectBlockTypeAtLine } from './block-fingerprint';
import { parseNativeAnnotations } from './native-annotation';
import { parseRegionAnnotations } from './region-annotation';

// 🔧 Phase G-2: 延迟导入 FormatRegistry 避免循环依赖
let _formatRegistry: import('../format/format-registry').FormatRegistry | null = null; /** 注入 FormatRegistry（由 plugin 初始化时调用） */
export function injectFormatRegistry(registry: import('../format/format-registry').FormatRegistry): void {
  _formatRegistry = registry;
}
/** 获取已注入的 FormatRegistry（用于解析器内部） */
export function getFormatRegistry(): import('../format/format-registry').FormatRegistry | null {
  return _formatRegistry;
}

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

  // v5.3: 写入 data-alias 属性（图谱显示别名）
  if (annotation.alias) {
    attrs.push(`data-alias="${escapeAttr(annotation.alias)}"`);
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

  // 🔧 P1-6 修复：收集所有匹配文本（拆分标注场景），而非只保留最后一个
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

    // v5.3: 更新 alias
    if (updates.alias !== undefined) {
      if (updates.alias) {
        // 有 alias 值 → 写入/替换 data-alias 属性
        if (/data-alias="/.test(newOpenTag)) {
          newOpenTag = newOpenTag.replace(/data-alias="[^"]*"/, `data-alias="${escapeAttr(updates.alias)}"`);
        } else {
          newOpenTag = newOpenTag.replace(/>$/, ` data-alias="${escapeAttr(updates.alias)}">`);
        }
      } else {
        // alias 为空字符串 → 移除 data-alias 属性
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

/** 正则特殊字符转义 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Track B: 块级锚点标注 ──────────────────────────────

/**
 * 块级标注锚点格式：%%markvault:uuid:type:color:alias:note%%
 *
 * 使用 Obsidian 原生注释语法 %%...%%，阅读模式下不可见。
 * 锚点紧贴在目标块上方，CM6/PostProcessor 检测锚点后
 * 给下方内容块添加装饰效果。
 *
 * v5.3: 新增 alias 段（在 color 和 note 之间），用 _ 表示空值
 *
 * 示例：
 * ```markdown
 * %%markvault:abc-123:highlight:yellow:欧拉公式:重要公式%%
 * $$
 * \int_0^1 f(x)dx
 * $$
 * ```
 *
 * 向后兼容：旧格式 %%markvault:uuid:type:color:note%% 仍可解析（alias 默认为空）
 */

/**
 * 锚点字段转义 — 在 block/span 单锚点和 span 锚点中使用
 *
 * 转义规则：
 * - `\` → `\0`（先转义转义符，防止后续 \1/\2 与原文混淆）
 * - `\n` → ` `（锚点不跨行，换行符替换为空格）
 * - `%` → `\1`（百分号是锚点 %% 终止符）
 * - `:` → `\2`（冒号是段分隔符）
 *
 * 🔧 P0-1 修复：v5.x 版本中此函数不转义 %。
 * 🔧 P2-4 修复：新增 \n 安全替换。
 * 🔧 解码安全修复：使用数字后缀 (\0/\1/\2) 替代助记后缀 (\p/\c)，
 *   避免原文中的字面量 \p/\c 被误解码。
 */
function escapeAnchorField(s: string): string {
  return s.replace(/\\/g, '\\0').replace(/\n/g, ' ').replace(/%/g, '\\1').replace(/:/g, '\\2');
}

/** 锚点字段反转义（解码顺序必须与编码相反） */
function decodeAnchorField(s: string): string {
  return s.replace(/\\2/g, ':').replace(/\\1/g, '%').replace(/\\0/g, '\\');
}

/**
 * 生成块级标注锚点字符串
 * v5.3: 新增 alias 段，格式 %%markvault:uuid:type:color:alias:note%%
 * alias 为空时写入 _ 占位符，保持冒号对齐和向后兼容
 */
export function buildBlockAnchor(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const aliasField = annotation.alias ? escapeAnchorField(annotation.alias) : '_';
  return `%%markvault:${annotation.uuid}:${annotation.type}:${annotation.color}:${aliasField}:${escapeAnchorField(annotation.note || '')}%%`;
}

/**
 * 生成 span 标注锚点字符串（方案C）
 * 使用 markvault-span: 前缀区分于 block 标注的 markvault: 前缀
 * v5.3: 新增 alias 段，格式 %%markvault-span:uuid:type:color:alias:note%%
 */
export function buildSpanAnchor(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const aliasField = annotation.alias ? escapeAnchorField(annotation.alias) : '_';
  return `%%markvault-span:${annotation.uuid}:${annotation.type}:${annotation.color}:${aliasField}:${escapeAnchorField(annotation.note || '')}%%`;
}

// ─── Track B-v2: Block 双锚点标注 ─────────────────────────

/** Block 双锚点正则：%%markvault-block:<uuid>:<type>:<color>:<start|end>:<note>[:<alias>]%% */
export const BLOCK_DOUBLE_ANCHOR_REGEX = /%%markvault-block:([^:%]+):([^:%]+):([^:%]+):(start|end):([^%]*?)(?::([^%]*))?%%/g;

/** 双锚点 note 字段转义（数字后缀 \0=\ \1=% \2=:）
 *
 * 🔧 P2-4 修复：新增 \n → 空格替换。
 * 🔧 解码安全修复：使用数字后缀避免原文 \p/\c 误解码。
 */
function escapeBlockAnchorField(s: string): string {
  return s.replace(/\\/g, '\\0').replace(/\n/g, ' ').replace(/%/g, '\\1').replace(/:/g, '\\2');
}

/** 双锚点 note 字段反转义 */
function decodeBlockAnchorField(s: string): string {
  return s.replace(/\\2/g, ':').replace(/\\1/g, '%').replace(/\\0/g, '\\');
}

/** 生成 Block 双锚点的 start 锚点 */
export function buildBlockAnchorStart(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const escapedAlias = annotation.alias ? `:${escapeBlockAnchorField(annotation.alias)}` : '';
  return `%%markvault-block:${annotation.uuid}:${annotation.type}:${annotation.color}:start:${escapeBlockAnchorField(annotation.note || '')}${escapedAlias}%%`;
}

/** 生成 Block 双锚点的 end 锚点 */
export function buildBlockAnchorEnd(annotation: {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
}): string {
  const escapedAlias = annotation.alias ? `:${escapeBlockAnchorField(annotation.alias)}` : '';
  return `%%markvault-block:${annotation.uuid}:${annotation.type}:${annotation.color}:end:${escapeBlockAnchorField(annotation.note || '')}${escapedAlias}%%`;
}

/** Block 双锚点解析结果 */
export interface ParsedBlockDoubleAnchor {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
  /** start / end */
  position: 'start' | 'end';
  /** 锚点在全文中的字符偏移 */
  anchorOffset: number;
  /** 锚点字符串长度 */
  anchorLength: number;
  /** 锚点所在行号（0-based） */
  anchorLine: number;
}

/**
 * 解析 Block 双锚点标注
 * 格式（新）：%%markvault-block:<uuid>:<type>:<color>:start:<note>:<alias>%% ... %%markvault-block:<uuid>:...:end:<note>:<alias>%%
 * 格式（旧）：%%markvault-block:<uuid>:<type>:<color>:start:<note>%% ... %%markvault-block:<uuid>:...:end:<note>%%
 */
export function parseBlockDoubleAnchors(content: string): ParsedBlockDoubleAnchor[] {
  const results: ParsedBlockDoubleAnchor[] = [];
  let match: RegExpExecArray | null;

  BLOCK_DOUBLE_ANCHOR_REGEX.lastIndex = 0;
  while ((match = BLOCK_DOUBLE_ANCHOR_REGEX.exec(content)) !== null) {
    const anchorOffset = match.index;
    const anchorLength = match[0].length;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    const alias = match[6] ? decodeBlockAnchorField(match[6]) : undefined;
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note: decodeBlockAnchorField(match[5]),
      ...(alias ? { alias } : {}),
      position: match[4] as 'start' | 'end',
      anchorOffset,
      anchorLength,
      anchorLine: lineCount - 1,
    });
  }

  return results;
}

/** Block 双锚点范围定位结果 */
export interface BlockDoubleAnchorRange {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;
  startAnchorOffset: number;
  startAnchorEnd: number;
  endAnchorOffset: number;
  endAnchorEnd: number;
  contentStart: number;
  contentEnd: number;
  text: string;
  startLine: number;
  endLine: number;
  targetLine: number;
  anchorLine: number;
}

/**
 * 在文档中查找指定 uuid 的 Block 双锚点范围
 */
export function findBlockDoubleAnchorRange(content: string, uuid: string): BlockDoubleAnchorRange | null {
  const matches = parseBlockDoubleAnchors(content);
  const startMatch = matches.find(m => m.uuid === uuid && m.position === 'start');
  if (!startMatch) return null;

  const endMatch = matches.find(m => m.uuid === uuid && m.position === 'end' && m.anchorOffset > startMatch.anchorOffset);
  if (!endMatch) return null;

  const lines = content.split('\n');
  const targetLine = findBlockTargetLine(content, startMatch.anchorLine);
  const endLine = findBlockContentEndLine(content, endMatch.anchorLine);

  return {
    uuid,
    type: startMatch.type,
    color: startMatch.color,
    note: startMatch.note,
    ...(startMatch.alias ? { alias: startMatch.alias } : {}),
    startAnchorOffset: startMatch.anchorOffset,
    startAnchorEnd: startMatch.anchorOffset + startMatch.anchorLength,
    endAnchorOffset: endMatch.anchorOffset,
    endAnchorEnd: endMatch.anchorOffset + endMatch.anchorLength,
    contentStart: startMatch.anchorOffset + startMatch.anchorLength,
    contentEnd: endMatch.anchorOffset,
    text: lines.slice(targetLine, endLine + 1).join('\n'),
    startLine: targetLine,
    endLine,
    targetLine,
    anchorLine: startMatch.anchorLine,
  };
}

/**
 * 给定 end 锚点所在行号，向前扫描找到目标块内容的真实结束行号。
 * 跳过：空行、其它锚点行、代码/公式围栏分隔符。
 */
export function findBlockContentEndLine(content: string, endLine: number): number {
  const lines = content.split('\n');
  let actualEndLine = endLine - 1;

  for (let i = endLine - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (
      trimmed.startsWith('%%markvault') ||
      trimmed === '$$' ||
      trimmed.startsWith('```') ||
      trimmed === ''
    ) {
      actualEndLine = i - 1;
      continue;
    }
    actualEndLine = i;
    break;
  }

  return Math.max(0, actualEndLine);
}

/** 块级锚点解析结果 */
export interface ParsedBlockAnchor {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;    // v5.3: 图谱别名（从锚点解析）
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
 *
 * v5.3: 新格式含 alias 段 %%markvault:uuid:type:color:alias:note%%
 *       旧格式无 alias 段 %%markvault:uuid:type:color:note%% 仍可解析（alias 默认为空）
 */
export function parseBlockAnchors(content: string): ParsedBlockAnchor[] {
  const results: ParsedBlockAnchor[] = [];

  // 1. 解析 block 格式
  // v5.3 新格式: %%markvault:uuid:type:color:alias:note%% (6段)
  // 旧格式: %%markvault:uuid:type:color:note%% (4-5段, 无 alias)
  // 使用统一正则匹配，根据段数区分
  const blockRegex = /%%markvault:([^:%]+):([^:%]+):([^:%]+)(?::([^:%]*))?(?::([^%]*))?%%/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const anchorOffset = match.index;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    // match[4] 和 match[5] 的存在取决于段数
    // 旧格式 (4段): match[1]=uuid, match[2]=type, match[3]=color, match[4]=note, match[5]=undefined
    // 新格式 (6段): match[1]=uuid, match[2]=type, match[3]=color, match[4]=alias, match[5]=note
    const hasAliasSegment = match[5] !== undefined;
    let alias: string | undefined;
    let note: string;
    if (hasAliasSegment) {
      // 新格式: match[4]=alias, match[5]=note
      const rawAlias = match[4];
      alias = (rawAlias && rawAlias !== '_') ? decodeAnchorField(rawAlias) : undefined;
      note = match[5] ? decodeAnchorField(match[5]) : '';
    } else {
      // 旧格式: match[4]=note, 无 alias
      note = match[4] ? decodeAnchorField(match[4]) : '';
    }
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note,
      alias,
      anchorOffset,
      anchorLine: lineCount - 1,
      anchorKind: 'block',
    });
  }

  // 2. 解析 span 格式
  // 同样支持新格式（含 alias）和旧格式
  const spanRegex = /%%markvault-span:([^:%]+):([^:%]+):([^:%]+)(?::([^:%]*))?(?::([^%]*))?%%/g;
  while ((match = spanRegex.exec(content)) !== null) {
    const anchorOffset = match.index;
    const lineCount = content.substring(0, anchorOffset).split('\n').length;
    const hasAliasSegment = match[5] !== undefined;
    let alias: string | undefined;
    let note: string;
    if (hasAliasSegment) {
      const rawAlias = match[4];
      alias = (rawAlias && rawAlias !== '_') ? decodeAnchorField(rawAlias) : undefined;
      note = match[5] ? decodeAnchorField(match[5]) : '';
    } else {
      note = match[4] ? decodeAnchorField(match[4]) : '';
    }
    results.push({
      uuid: match[1],
      type: match[2] as AnnotationType,
      color: match[3],
      note,
      alias,
      anchorOffset,
      anchorLine: lineCount - 1,
      anchorKind: 'span',
    });
  }

  return results;
}

/**
 * 从 Markdown 内容中移除指定 uuid 的块级锚点
 * 优先尝试新的双锚点格式，找不到则回退到旧单锚点格式。
 */
export function removeBlockAnchor(content: string, uuid: string): string {
  const doubleRange = findBlockDoubleAnchorRange(content, uuid);
  if (doubleRange) {
    return (
      content.substring(0, doubleRange.startAnchorOffset) +
      content.substring(doubleRange.startAnchorEnd, doubleRange.endAnchorOffset) +
      content.substring(doubleRange.endAnchorEnd)
    );
  }

  // 🔧 P2-7 修复：使用非全局正则 + 手动 match，仅删除第一个匹配项。
  // 防御数据损坏场景下 uuid 多次出现导致误删所有匹配。
  const regex = new RegExp(`%%markvault:${escapeRegex(uuid)}:[\\s\\S]*?%%\\n?`);
  const match = content.match(regex);
  if (!match) return content;
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
 * 优先尝试新的双锚点格式，找不到则回退到旧单锚点格式。
 * v5.3: 支持 alias 字段的更新
 */
export function updateBlockAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
    alias?: string;
  }>,
): string {
  const range = findBlockDoubleAnchorRange(content, uuid);
  if (range) {
    const type = updates.type ?? range.type;
    const color = updates.color ?? range.color;
    const note = updates.note !== undefined ? updates.note : range.note;
    const alias = updates.alias !== undefined ? updates.alias : range.alias;
    const startAnchor = buildBlockAnchorStart({ uuid, type, color, note, alias });
    const endAnchor = buildBlockAnchorEnd({ uuid, type, color, note, alias });
    return (
      content.substring(0, range.startAnchorOffset) +
      startAnchor +
      content.substring(range.startAnchorEnd, range.endAnchorOffset) +
      endAnchor +
      content.substring(range.endAnchorEnd)
    );
  }

  // v5.3: 匹配新格式（含 alias 段）或旧格式（无 alias 段），统一更新为新格式
  // 新格式: %%markvault:uuid:type:color:alias:note%%
  // 旧格式: %%markvault:uuid:type:color:note%%
  const regex = new RegExp(`%%markvault:${escapeRegex(uuid)}:([^:%]*):([^:%]*)(?::([^:%]*))?(?::([^%]*))?%%`);

  return content.replace(regex, (_full, oldType: string, oldColor: string, g3: string | undefined, g4: string | undefined) => {
    const type = updates.type ?? oldType;
    const color = updates.color ?? oldColor;

    // 判断匹配到的是新格式还是旧格式
    const isNewFormat = g4 !== undefined;
    let oldAlias: string | undefined;
    let oldNote: string;
    if (isNewFormat) {
      // 新格式: g3=alias, g4=note
      oldAlias = (g3 && g3 !== '_') ? decodeAnchorField(g3) : undefined;
      oldNote = g4 ? decodeAnchorField(g4) : '';
    } else {
      // 旧格式: g3=note, 无 alias
      oldNote = g3 ? decodeAnchorField(g3) : '';
    }

    const note = updates.note !== undefined ? updates.note : oldNote;
    const alias = updates.alias !== undefined ? updates.alias : oldAlias;
    const aliasField = alias ? escapeAnchorField(alias) : '_';

    // 始终输出新格式（含 alias 段）
    return `%%markvault:${uuid}:${type}:${color}:${aliasField}:${escapeAnchorField(note)}%%`;
  });
}

/**
 * 更新 Markdown 内容中指定 uuid 的 span 锚点属性
 * v5.3: 支持 alias 字段的更新
 */
export function updateSpanAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
    alias?: string;
  }>,
): string {
  // v5.3: 匹配新格式或旧格式，统一更新为新格式
  const regex = new RegExp(`%%markvault-span:${escapeRegex(uuid)}:([^:%]*):([^:%]*)(?::([^:%]*))?(?::([^%]*))?%%`);

  return content.replace(regex, (_full, oldType: string, oldColor: string, g3: string | undefined, g4: string | undefined) => {
    const type = updates.type ?? oldType;
    const color = updates.color ?? oldColor;

    const isNewFormat = g4 !== undefined;
    let oldAlias: string | undefined;
    let oldNote: string;
    if (isNewFormat) {
      oldAlias = (g3 && g3 !== '_') ? decodeAnchorField(g3) : undefined;
      oldNote = g4 ? decodeAnchorField(g4) : '';
    } else {
      oldNote = g3 ? decodeAnchorField(g3) : '';
    }

    const note = updates.note !== undefined ? updates.note : oldNote;
    const alias = updates.alias !== undefined ? updates.alias : oldAlias;
    const aliasField = alias ? escapeAnchorField(alias) : '_';

    return `%%markvault-span:${uuid}:${type}:${color}:${aliasField}:${escapeAnchorField(note)}%%`;
  });
}

/**
 * 更新任意类型的锚点（block 或 span），根据 kind 自动选择
 * v5.3: 支持 alias 字段更新
 */
export function updateAnyAnchor(
  content: string,
  uuid: string,
  updates: Partial<{
    type: AnnotationType;
    color: string;
    note: string;
    alias?: string;
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
 * 给定锚点所在行号，向前扫描找到目标块的实际起始行号。
 * 跳过：空行、其它锚点行、代码/公式围栏分隔符。
 * 用于创建/渲染时动态定位目标块，避免依赖可能过期的 targetLine。
 */
export function findBlockTargetLine(content: string, anchorLine: number): number {
  const lines = content.split('\n');
  const targetLine = anchorLine + 1;
  let actualTargetLine = targetLine;

  for (let i = targetLine; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('%%markvault') || trimmed === '$$' || trimmed.startsWith('```')) {
      actualTargetLine = i + 1;
      continue;
    }
    if (trimmed === '') {
      actualTargetLine = i + 1;
      continue;
    }
    actualTargetLine = i;
    break;
  }

  return actualTargetLine;
}

/**
 * 从 Markdown 内容解析所有标注（包括行内 <mark> 和块级/span 锚点）
 * 统一入口，供 markdown-sync.ts 使用
 */
export function parseAllAnnotationsFromMarkdown(
  content: string,
  filePath: string,
): Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> {
  // 🔧 Phase G-2: FormatRegistry 注入后使用统一解析入口
  if (_formatRegistry) {
    return _formatRegistry.parseAll(content, filePath);
  }

  // 🔧 P2-6 修复：回退路径 — 每个子解析器独立 try-catch
  // 1. 行内 <mark> 标注
  let inlineAnnotations: Array<Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }> = [];
  try {
    inlineAnnotations = parseAnnotationsFromMarkdown(content, filePath);
  } catch (err) {
    console.error('MarkVault: inline <mark> parse error', err);
  }

  // 2. 块级/span 锚点标注
  const blockAnchors = parseBlockAnchors(content);
  // 🔧 BUG-16 修复：map 抛异常后整个 blockAnnotations 变空数组，
  // 所有有效锚点都丢失。改为逐条 try-catch，跳过出错项。
  let blockAnnotations: Array<Annotation & { _source: 'markdown' }> = [];
  for (const anchor of blockAnchors) {
    try {
    // 🔧 修复：跳过锚点行、公式分隔符、代码围栏，找到有意义的内容行
    const lines = content.split('\n');
    const actualTargetLine = findBlockTargetLine(content, anchor.anchorLine);
    const blockContent = lines[actualTargetLine]?.trim() || '';

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

    blockAnnotations.push({
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
      alias: anchor.alias,  // v5.3: 从锚点解析的 alias
      _source: 'markdown' as const,
    });
    } catch (err) {
      console.error(`MarkVault: block/span anchor parse error for uuid=${anchor.uuid}`, err);
    }
  }

  // 3. Block 双锚点标注
  try {
  const doubleBlockAnchors = parseBlockDoubleAnchors(content);
  const doubleByUuid = new Map<string, { start?: ParsedBlockDoubleAnchor; end?: ParsedBlockDoubleAnchor }>();
  for (const anchor of doubleBlockAnchors) {
    const entry = doubleByUuid.get(anchor.uuid) || {};
    if (anchor.position === 'start') {
      if (!entry.start) entry.start = anchor;
    } else {
      if (!entry.end) entry.end = anchor;
    }
    doubleByUuid.set(anchor.uuid, entry);
  }

  for (const [uuid, entry] of doubleByUuid.entries()) {
    if (!entry.start || !entry.end) {
      if (entry.start) console.warn(`MarkVault: orphaned block double-anchor start (uuid=${uuid}, no matching end)`);
      if (entry.end) console.warn(`MarkVault: orphaned block double-anchor end (uuid=${uuid}, no matching start)`);
      continue;
    }
    // 🔧 BUG-1 修复：校验 end 在 start 之后
    if (entry.end.anchorOffset < entry.start.anchorOffset) {
      console.warn(`MarkVault: block double-anchor end before start (uuid=${uuid}), skipping`);
      continue;
    }

    const lines = content.split('\n');
    const targetLine = findBlockTargetLine(content, entry.start.anchorLine);
    const endLine = findBlockContentEndLine(content, entry.end.anchorLine);
    const blockType = detectBlockTypeAtLine(lines, targetLine);
    const blockContent = lines.slice(targetLine, endLine + 1).join('\n');
    const targetHash = computeBlockSignature(lines, targetLine, blockType) || computeSpanSignature(blockContent);

    blockAnnotations.push({
      uuid,
      filePath,
      type: entry.start.type,
      color: entry.start.color,
      text: blockContent,
      note: entry.start.note,
      tags: [],
      startOffset: entry.start.anchorOffset,
      endOffset: entry.end.anchorOffset + entry.end.anchorLength,
      startLine: targetLine,
      endLine,
      contextBefore: '',
      contextAfter: '',
      createdAt: 0,
      updatedAt: 0,
      kind: 'block' as const,
      blockType,
      targetLine,
      anchorLine: entry.start.anchorLine,
      targetHash,
      ...(entry.start.alias ? { alias: entry.start.alias } : {}),
      _source: 'markdown' as const,
    });
  }
  } catch (err) {
    console.error('MarkVault: block double-anchor parse error', err);
  }

  // 4. 区域标注（双锚点包围）
  let regionAnnotations: Array<Annotation & { _source: 'markdown' }> = [];
  try {
    regionAnnotations = parseRegionAnnotations(content, filePath);
  } catch (err) {
    console.error('MarkVault: region annotation parse error', err);
  }

  // 5. 自然语法标注（隐身锚点 + 原生包裹）
  let nativeAnnotations: Array<Annotation & { _source: 'markdown' }> = [];
  try {
    nativeAnnotations = parseNativeAnnotations(content, filePath);
  } catch (err) {
    console.error('MarkVault: native annotation parse error', err);
  }

  // 🔧 A-2 修复：native 标注的 <mark> wrapper 同时被 inline parser 和 native parser 双重拾取。
  // native parser 的结果 offset 更准确（从 %%mv:i%% 锚点计算），inline parser 的 offset 从 <mark> 标签计算。
  // 冲突时优先保留 native parser 的结果。
  const allAnnotations = [...inlineAnnotations, ...blockAnnotations, ...regionAnnotations, ...nativeAnnotations];
  const seen = new Map<string, Annotation & { _source: 'markdown'; _needsUpgrade?: boolean }>();
  for (const ann of allAnnotations) {
    const existing = seen.get(ann.uuid);
    if (!existing || (ann.format === 'native' && existing.format !== 'native')) {
      seen.set(ann.uuid, ann);
    }
  }
  return [...seen.values()];
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
