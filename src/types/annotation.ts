/** 标注类型 */
export type AnnotationType = 'highlight' | 'bold' | 'underline';

/** 预设颜色 */
export const PRESET_COLORS = [
  { id: 'yellow', hex: '#FACC15', label: '黄色' },
  { id: 'green', hex: '#4ADE80', label: '绿色' },
  { id: 'blue', hex: '#60A5FA', label: '蓝色' },
  { id: 'pink', hex: '#F472B6', label: '粉色' },
  { id: 'purple', hex: '#C084FC', label: '紫色' },
] as const;

export type PresetColorId = (typeof PRESET_COLORS)[number]['id'];

/** 标注数据模型 — IndexedDB 主存储 */
export interface Annotation {
  id?: number;              // 自增主键 (Dexie)
  uuid: string;             // 业务 ID，Markdown ↔ DB 桥梁字段
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

  // 🆕 v2.0: 拆分标注 & 块级标注支持
  kind?: 'inline' | 'block' | 'span';  // 标注类型（默认 inline，块级为 block，跨特殊内容为 span）
  groupUuid?: string;          // Track A: 拆分标注的组 ID，同组标注共享（旧格式兼容）
  blockType?: string;          // Track B: 块级标注的目标类型（math-block/code-block/image/embed/callout/table/paragraph）
  targetLine?: number;         // Track B: 目标块起始行号
  anchorLine?: number;         // Track B: 块级/span 标注的锚点所在行号

  // 🆕 v2.1: Span 标注（方案C）
  spanRanges?: SpanRange[];    // Span 标注的文本片段位置范围
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
  groupUuid?: string;  // 🆕 拆分标注组 ID
}

/** 块级标注锚点属性 */
export interface BlockAnchorAttributes {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
}

/** 侧边栏过滤条件 */
export interface AnnotationFilter {
  type?: AnnotationType | 'all';
  color?: string | 'all';
  hasNote?: boolean;
  searchQuery?: string;
  sortBy?: 'position' | 'createdAt' | 'updatedAt';
}

/** 偏移恢复结果 */
export interface RecoveryResult {
  startOffset: number;
  endOffset: number;
  drifted: boolean;
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
}

export const DEFAULT_SETTINGS: MarkVaultSettings = {
  presetColors: PRESET_COLORS,
  defaultHighlightColor: 'yellow',
  defaultAnnotationType: 'highlight',
  showContextMenu: true,
  sidebarDefaultSort: 'position',
  contextWindowSize: 50,
  enableAutoSync: true,
};
