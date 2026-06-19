/**
 * MindNode — 导图节点数据结构
 *
 * Phase 1 支持三种节点类型：
 *   - md-seed:   从 .md 标题/列表解析（只读种子）
 *   - free:      用户手动创建（存 frontmatter）
 *   - annotation: MarkVault 批注引用（Phase 3+，预留类型）
 *
 * 树结构通过 parentId + children 双向关联，
 * 布局结果写入 layout 字段供渲染层读取。
 */

/** 导图节点类型 */
export type MindNodeType = 'md-seed' | 'free' | 'annotation';

/** 认知结构类型 — 标记用户当时的认知意图 */
export type StructureType = 'flow' | 'skeleton' | 'hierarchy' | 'process' | 'fishbone' | 'freeform';

/** 视觉布局类型 */
export type LayoutType = 'tree-right' | 'tree-left' | 'org' | 'logic-right' | 'fishbone' | 'timeline' | 'radial' | 'freeform';

/** 布局计算结果 */
export interface NodeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 导图节点 */
export interface MindNode {
  /** 唯一 ID（MD-Seed 用 md-前缀+行号，Free 用 uuid，Annotation 用 ann-前缀+uuid） */
  id: string;
  /** 父节点 ID（根节点为 null） */
  parentId: string | null;
  /** 节点类型 */
  type: MindNodeType;
  /** 显示文本 */
  text: string;
  /** 备注（Free 节点有，MD-Seed 从 .md 提取或留空） */
  note?: string;
  /** 子节点（布局计算后填充） */
  children: MindNode[];
  /** 布局计算结果（渲染层读取） */
  layout?: NodeLayout;
  /** 折叠状态 */
  collapsed?: boolean;

  // ── Phase 2: 渲染测量缓存 ────────────
  /** 渲染后的实际高度（缓存，避免重复测量） */
  renderedHeight?: number;
  /** 渲染后的实际宽度（缓存） */
  renderedWidth?: number;

  // ── MD-Seed 专用字段 ──────────────────
  /** 来源行号（0-based） */
  sourceLine?: number;
  /** 标题级别（1-6）或列表层级 */
  sourceLevel?: number;
  /** 详情内容（从 MD 正文中 <!-- mf:detail --> 块提取，可双向编辑） */
  detail?: string;

  // ── Annotation 专用字段（Phase 3+ 预留） ──
  /** 批注引用 UUID */
  annotationRef?: string;
  /** 批注摘要缓存 */
  annotationSummary?: string;

  // ── 父子连线语义标注 ──
  /** 与父节点的关系标签（显示在子连接线上） */
  edgeLabel?: string;
  /** 与父节点的关系备注（hover tooltip） */
  edgeNote?: string;

  // ── 布局计算临时字段 (布局引擎写入，渲染层读取，不持久化) ──
  /** 子树高度缓存 (tree-layout) */
  _subtreeHeight?: number;
  /** 子树宽度缓存 (org-layout) */
  _subtreeWidth?: number;
  /** 叶子节点数缓存 (radial/freeform-layout) */
  _leafCount?: number;
  /** Logic 布局子树高度缓存 (tree-layout logic-right) */
  _logicSubtreeHeight?: number;
  /** 鱼骨图脊线信息 (fishbone-layout 写入, svg-connector 读取) */
  _fishboneSpine?: { x1: number; y1: number; x2: number; y2: number };
  /** 时间轴主轴信息 (timeline-layout 写入, svg-connector 读取) */
  _timelineAxis?: { x1: number; y1: number; x2: number; y2: number };
}

/** 导图元数据 — 存储在 frontmatter mindmap 字段 */
export interface MindmapMeta {
  /** 认知结构类型 */
  structureType: StructureType;
  /** 视觉布局（默认 tree-right） */
  layout?: LayoutType;
  /** M2: 外框列表（持久化到 frontmatter） */
  boundaries?: BoundaryRecord[];
  /** Phase A: 自主连线列表（持久化到 frontmatter） */
  connections?: ConnectionRecord[];
}

/** M2: 外框持久化记录 */
export interface BoundaryRecord {
  id: string;
  nodeIds: string[];
  label: string;
  note?: string;
}

/** Phase A: 导图自主连线持久化记录 */
export interface ConnectionRecord {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  note?: string;
}

/**
 * frontmatter 中存储的用户节点精简结构（Phase 3: 泛化为 free + annotation）
 *
 * 替代旧的 FreeNodeRecord，同时保持向后兼容（无 type 字段时默认为 'free'）。
 */
export interface MindmapNodeRecord {
  id: string;
  parentId: string | null;
  text: string;
  /** 节点类型：'free'（默认）或 'annotation' */
  type?: 'free' | 'annotation';
  note?: string;
  collapsed?: boolean;
  /** Annotation 专用：引用的批注 UUID */
  annotationRef?: string;
  /** Annotation 专用：批注摘要缓存 */
  annotationSummary?: string;
  /** 与父节点的关系标签（显示在子连接线上） */
  edgeLabel?: string;
  /** 与父节点的关系备注（hover tooltip） */
  edgeNote?: string;
}

/** 向后兼容别名 */
/** L7: 向后兼容别名 — 实际包含 free + annotation 两种类型 */
export type FreeNodeRecord = MindmapNodeRecord;

/** frontmatter mindmap 字段完整结构 */
export interface MindmapFrontmatter {
  structureType?: StructureType;
  layout?: LayoutType;
  nodes?: MindmapNodeRecord[];
  /** M2: 外框列表 */
  boundaries?: BoundaryRecord[];
  /** Phase A: 自主连线列表 */
  connections?: ConnectionRecord[];
}

/** 默认认知结构类型 */
export const DEFAULT_STRUCTURE_TYPE: StructureType = 'skeleton';

/** 默认布局类型 */
export const DEFAULT_LAYOUT_TYPE: LayoutType = 'tree-right';

/** 工厂函数 — 创建 MindNode */
export function createMindNode(partial: Partial<MindNode> & Pick<MindNode, 'id' | 'type' | 'text'>): MindNode {
  return {
    parentId: null,
    children: [],
    ...partial,
  };
}

/**
 * 工厂函数 — 创建用户节点记录（存 frontmatter）
 *
 * Phase 3: 泛化为支持 free + annotation 两种类型。
 * 旧调用方无需修改（无 type 时默认 'free'）。
 */
export function toFreeNodeRecord(node: MindNode): MindmapNodeRecord {
  const record: MindmapNodeRecord = {
    id: node.id,
    parentId: node.parentId,
    text: node.text,
  };
  // Phase 3: 只有非 free 类型才写入 type 字段（向后兼容）
  if (node.type === 'annotation') {
    record.type = 'annotation';
  }
  if (node.note) record.note = node.note;
  if (node.collapsed) record.collapsed = node.collapsed;
  // Phase 3: annotation 专用字段
  if (node.annotationRef) record.annotationRef = node.annotationRef;
  if (node.annotationSummary) record.annotationSummary = node.annotationSummary;
  // 父子连线语义标注
  if (node.edgeLabel) record.edgeLabel = node.edgeLabel;
  if (node.edgeNote) record.edgeNote = node.edgeNote;
  return record;
}

/**
 * 工厂函数 — 从用户节点记录还原 MindNode
 *
 * Phase 3: 根据 record.type 决定节点类型，默认 'free'。
 */
export function fromFreeNodeRecord(record: MindmapNodeRecord): MindNode {
  const nodeType = record.type ?? 'free';
  return createMindNode({
    id: record.id,
    type: nodeType,
    parentId: record.parentId,
    text: record.text,
    note: record.note,
    collapsed: record.collapsed,
    annotationRef: record.annotationRef,
    annotationSummary: record.annotationSummary,
    edgeLabel: record.edgeLabel,
    edgeNote: record.edgeNote,
    children: [],
  });
}
