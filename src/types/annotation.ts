/** 标注类型 */
export type AnnotationType = 'highlight' | 'bold' | 'underline';

/** 预设颜色 */
export const PRESET_COLORS = [
  { id: 'yellow', hex: '#FACC15', label: '黄色', emoji: '🟡' },
  { id: 'green', hex: '#4ADE80', label: '绿色', emoji: '🟢' },
  { id: 'blue', hex: '#60A5FA', label: '蓝色', emoji: '🔵' },
  { id: 'pink', hex: '#F472B6', label: '粉色', emoji: '🔴' },
  { id: 'purple', hex: '#C084FC', label: '紫色', emoji: '🟣' },
] as const;

export type PresetColorId = (typeof PRESET_COLORS)[number]['id'];

/** 标注数据模型 — 分片 JSON 主存储 */
export interface Annotation {
  uuid: string;             // 业务 ID，Markdown ↔ Store 桥梁字段
  filePath: string;         // 笔记路径
  type: AnnotationType;     // 标注类型
  color: string;            // 颜色 preset id 或 hex
  text: string;             // 标注原文
  note: string;             // 批注内容
  tags: string[];           // 标签
  startOffset: number;      // 字符偏移起始
  endOffset: number;        // 字符偏移结束
  startLine: number;        // 行号（冗余但方便跳转）
  contextBefore: string;    // 前文上下文 (50 chars)
  contextAfter: string;     // 后文上下文 (50 chars)
  createdAt: number;        // 创建时间戳
  updatedAt: number;        // 更新时间戳

  // v2.0: 拆分标注 & 块级标注支持
  kind?: 'inline' | 'block' | 'span';  // 标注类型（默认 inline，块级为 block，跨特殊内容为 span）
  groupUuid?: string;          // Track A: 拆分标注的组 ID，同组标注共享（旧格式兼容）
  blockType?: string;          // Track B: 块级标注的目标类型（math-block/code-block/image/embed/callout/table/paragraph）
  targetLine?: number;         // Track B: 目标块起始行号
  anchorLine?: number;         // Track B: 块级/span 标注的锚点所在行号

  // v2.1: Span 标注（方案C）
  spanRanges?: SpanRange[];    // Span 标注的文本片段位置范围

  // v2.2: Block/Span 目标内容指纹，用于锚点漂移后找回目标
  targetHash?: string;

  // v3.0: 自定义字段
  fields?: Record<string, string>;  // 自定义键值对

  // v3.0: 自然 Markdown 语法标注格式
  format?: 'mark' | 'native';  // 'native' = 隐身锚点 + 原生 Markdown 包裹
}

/** Span 标注的文本片段范围 */
export interface SpanRange {
  from: number;   // 文本片段起始偏移（文档绝对偏移）
  to: number;     // 文本片段结束偏移
}

/** Markdown 中 <mark> 标签的属性接口 */
export interface MarkAttributes {
  uuid: string;
  type: AnnotationType;
  color: string;
  note?: string;
  tags?: string;
  groupUuid?: string;  // 拆分标注组 ID
  fields?: string;     // URL 编码的 fields 字符串，如 "category=定义&importance=高"
}

/** 块级标注锚点属性 */
export interface BlockAnchorAttributes {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
}

/** 字段定义（模板中的单个字段） */
export interface FieldDef {
  key: string;           // 字段键名，如 "category"
  values: string[];      // 预设值列表，如 ["定义", "原理", "应用"]
  allowCustom?: boolean; // 是否允许自由输入（默认 true）
}

/** 字段模板 */
export interface FieldTemplate {
  id: string;           // 模板唯一 ID（如 "academic", "reading"）
  name: string;         // 模板名称，如 "学术标注"
  fields: FieldDef[];   // 字段定义列表
}

/** 侧边栏过滤条件 */
export interface AnnotationFilter {
  type?: AnnotationType | 'all';
  color?: string | 'all';
  hasNote?: boolean;
  searchQuery?: string;
  fieldFilters?: Record<string, string>;  // v3.0: 字段过滤
  sortBy?: 'position' | 'createdAt' | 'updatedAt';
}

/** 偏移恢复结果 */
export interface RecoveryResult {
  startOffset: number;
  endOffset: number;
  drifted: boolean;
}

/** Store 元数据 */
export interface StoreMeta {
  schemaVersion: number;
  createdAt: number;
  lastSyncAt: number;
}

/** 索引条目 */
export interface IndexEntry {
  filePath: string;
  count: number;
  lastModified?: number;
}

/** 索引数据 */
export interface IndexData {
  version: number;
  entries: Record<string, IndexEntry>;  // key = Base64URL(filePath)
}

/** 标注统计 */
export interface AnnotationStats {
  total: number;
  byType: Record<string, number>;
  byColor: Record<string, number>;
  withNotes: number;
  withTags: number;
  withFields: number;
}

/** 批量更新偏移项 */
export interface BatchUpdateItem {
  uuid: string;
  startOffset: number;
  endOffset: number;
  spanRanges?: SpanRange[];
}

/** 插件设置 */
export interface MarkVaultSettings {
  presetColors: typeof PRESET_COLORS;
  defaultHighlightColor: PresetColorId;
  defaultAnnotationType: AnnotationType;
  showContextMenu: boolean;
  sidebarDefaultSort: 'position' | 'createdAt' | 'updatedAt';
  contextWindowSize: number;
  enableAutoSync: boolean;
  fieldTemplates: FieldTemplate[];         // 字段模板列表
  defaultTemplateId: string;              // 默认模板 ID（空字符串表示无默认模板）
  useNativeSyntax: boolean;               // 使用自然 Markdown 语法（隐身锚点 + 原生包裹）
}

export const DEFAULT_SETTINGS: MarkVaultSettings = {
  presetColors: PRESET_COLORS,
  defaultHighlightColor: 'yellow',
  defaultAnnotationType: 'highlight',
  showContextMenu: true,
  sidebarDefaultSort: 'position',
  contextWindowSize: 50,
  enableAutoSync: true,
  useNativeSyntax: false,
  fieldTemplates: [
    {
      id: 'academic',
      name: '学术标注',
      fields: [
        { key: 'category', values: ['定义', '定理', '证明', '推论', '应用'], allowCustom: true },
        { key: 'importance', values: ['高', '中', '低'], allowCustom: false },
        { key: 'understanding', values: ['已掌握', '部分理解', '未理解'], allowCustom: false },
      ],
    },
    {
      id: 'reading',
      name: '阅读笔记',
      fields: [
        { key: 'type', values: ['核心论点', '支撑论据', '反驳', '疑问', '灵感'], allowCustom: true },
        { key: 'action', values: ['待复查', '待实践', '待讨论'], allowCustom: true },
      ],
    },
  ],
  defaultTemplateId: '',
};
