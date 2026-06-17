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
  // ─── 数据协议层（v4.1: P0 元数据架构升级） ────────────
  schemaVersion?: number;   // 数据模型版本号，当前 = 2。缺省时由 addAnnotation() 兜底为 1

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
  endLine?: number;         // 区域标注结束行号（region 等跨行场景）
  contextBefore: string;    // 前文上下文 (50 chars)
  contextAfter: string;     // 后文上下文 (50 chars)
  createdAt: number;        // 创建时间戳
  updatedAt: number;        // 更新时间戳

  // v2.0: 拆分标注 & 块级标注支持
  kind?: 'inline' | 'block' | 'span' | 'region';  // 标注类型（默认 inline，块级为 block，跨特殊内容为 span，区域为 region）
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

  // v4.0: 标注间关联
  relations?: AnnotationRelation[];     // 出边关联（本标注指向其他标注）

  // v4.0: 学习状态标记
  flags?: AnnotationFlag;

  // v4.0: 标注分组（多对多自由标签）
  groups?: string[];                     // 如 ["ch12", "exam_topics", "key_theorems"]

  // v4.1: 标注意图语义（参考 W3C Web Annotation Motivation）
  motivation?: AnnotationMotivation;     // WHY you annotated this（缺失时根据 note 有无推断）

  // v5.3: 图谱显示别名（用户自定义短名称，如"欧拉公式"、"费马定理"）
  alias?: string;                        // 图谱节点显示名称，为空则不显示文字标签
}

/** Span 标注的文本片段范围 */
export interface SpanRange {
  from: number;   // 文本片段起始偏移（文档绝对偏移）
  to: number;     // 文本片段结束偏移
}

// ═══════════════════════════════════════════════════════
// v4.0: Phase 4 元数据扩展类型
// ═══════════════════════════════════════════════════════

/** 标注意图（参考 W3C Web Annotation Motivation） */
export type AnnotationMotivation =
  | 'commenting'     // 评论/笔记（当前 note 字段）
  | 'highlighting'   // 纯高亮（无 note，仅标记重要性）
  | 'questioning'    // 提问/不理解（学习场景高频）
  | 'editing'        // 修正建议（对应 needsCorrection）
  | 'bookmarking'    // 书签/收藏（标记待回看）
  | 'replying'       // v4.2: 回复/回应（对他人标注的回应，W3C 标准补齐）
  | 'classifying';   // v4.2: 分类/归类（给内容打分类标签，W3C 标准补齐）

/** AnnotationMotivation 显示标签 */
export const MOTIVATION_LABELS: Record<AnnotationMotivation, string> = {
  commenting: '💬 评论',
  highlighting: '🖍️ 高亮',
  questioning: '❓ 提问',
  editing: '✏️ 修正',
  bookmarking: '🔖 收藏',
  replying: '↩️ 回复',
  classifying: '🏷️ 分类',
};

/** AnnotationMotivation 列表（用于 UI 下拉） */
export const MOTIVATION_OPTIONS: AnnotationMotivation[] = [
  'highlighting',
  'commenting',
  'questioning',
  'editing',
  'bookmarking',
  'replying',
  'classifying',
];

/**
 * Motivation 自动推断 — 根据创建上下文信号猜测意图，减少用户手动选择
 *
 * 推断规则（优先级从高到低）：
 * 1. 显式 motivation → 直接返回（用户已在 Modal 中选择）
 * 2. note 非空 → commenting（写批注 = 评论意图）
 * 3. needsCorrection === true → editing（纠偏 = 修正意图）
 * 4. kind === 'block'（块级标注，通常是公式/代码/图片）→ bookmarking（标记待回看）
 * 5. 有 fields 但无 note → classifying（填字段 = 分类意图）
 * 6. 默认 → highlighting（纯高亮是最常见操作）
 *
 * @param partial 标注的部分属性（创建时已知的信息）
 */
export function inferMotivation(partial: {
  motivation?: AnnotationMotivation;
  note?: string;
  needsCorrection?: boolean;
  kind?: Annotation['kind'];
  fields?: Record<string, string>;
}): AnnotationMotivation {
  // 1. 用户已显式指定
  if (partial.motivation) return partial.motivation;

  // 2. 有批注 → 评论意图
  if (partial.note && partial.note.trim().length > 0) return 'commenting';

  // 3. 纠偏标记 → 修正意图
  if (partial.needsCorrection) return 'editing';

  // 4. 块级标注（公式/代码/图片等）→ 收藏/待回看
  if (partial.kind === 'block') return 'bookmarking';

  // 5. v4.2: 有自定义字段但无 note → 分类意图
  if (partial.fields && Object.keys(partial.fields).length > 0) return 'classifying';

  // 6. 默认 → 高亮
  return 'highlighting';
}

/** 标注间关联类型 — v4.3: 扩展为 string 以支持用户自定义 */
export type RelationType = string;

/**
 * v4.3: 关系类型配置（Schema-First RelationType）
 *
 * 每个关系类型由配置定义，而非硬编码。内置 8 种主动类型 + 4 种被动类型
 * 作为默认注册项，用户可自定义新类型。
 *
 * 设计决策：
 * - 配置存储在 PluginSettings，运行时动态构建 REVERSE_RELATION_MAP
 * - 内置类型可隐藏但不可删除（保证旧数据兼容）
 * - 自定义类型可随时添加/删除
 * - 对称关系 (isSymmetric=true) 的 reverseId 等于自身
 */
export interface RelationTypeConfig {
  /** 类型标识符，如 'applies', 'myCustomType' — 必须唯一 */
  id: string;
  /** 显示标签，如 '应用', '我的自定义' */
  label: string;
  /** 反向类型 ID，如 'isAppliedBy'；对称关系则等于自身 */
  reverseId: string;
  /** 是否对称关系（对称关系两侧用同类型，如 contrasts） */
  isSymmetric: boolean;
  /** 是否内置类型（内置类型不可删除，保证数据兼容） */
  isBuiltIn?: boolean;
  /** 是否在用户选择器中显示（被动类型如 isAppliedBy 不显示） */
  isActive?: boolean;
  /** 显示颜色（可选，用于图谱可视化） */
  color?: string;
}

/**
 * v4.3: 默认关系类型配置
 * 等同于 v4.2 硬编码的 12 种关系类型，但以配置形式声明。
 */
/**
 * v5.11: 语义化调色板 — 按语义维度分组，同组色系相近
 *
 * 分组顺序（自上而下）:
 *   Taxonomic(分类) → Argumentative(论证) → Expositive(阐释) →
 *   Referential(引用) → Dynamic(因果/时序) → Structural(关联/补充) →
 *   Passive(被动反向)
 *
 * 设计原则:
 *  - 同维度共享 hue-family，以 lightness 区分
 *  - 跨维度之间 hue 有足够对比度 (>60° on color wheel)
 *  - 被动关系统一用灰色系，与主动关系视觉区分
 */
export const DEFAULT_RELATION_TYPE_CONFIGS: RelationTypeConfig[] = [
  // ── 1. Taxonomic 分类 (Blue-Purple family) ──
  // 层级关系: 泛化→特化→部分，色彩由浅入深表示深度
  { id: 'generalizes',  label: '泛化', reverseId: 'specializes',   isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#4F46E5' },
  { id: 'specializes',  label: '特化', reverseId: 'generalizes',   isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#7C3AED' },
  { id: 'part-of',      label: '部分', reverseId: 'contains',      isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#6D28D9' },

  // ── 2. Argumentative 论证 (Green-Red-Amber spectrum) ──
  // 正/反/中立: 绿(+), 红(-), 琥珀(±)
  { id: 'proves',       label: '证明', reverseId: 'isProvedBy',    isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#16A34A' },
  { id: 'refutes',      label: '反驳', reverseId: 'isRefutedBy',   isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#DC2626' },
  { id: 'contrasts',    label: '对比', reverseId: 'contrasts',     isSymmetric: true,  isBuiltIn: true, isActive: true,  color: '#CA8A04' },

  // ── 3. Expositive 阐释 (Warm Amber-Orange family) ──
  // 解释图谱中最常见的详述/举例/图示三连
  { id: 'elaborates',   label: '详述', reverseId: 'isElaboratedBy', isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#A16207' },
  { id: 'exemplifies',  label: '举例', reverseId: 'isExemplifiedBy', isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#EAB308' },
  { id: 'illustrates',  label: '图示', reverseId: 'isIllustratedBy', isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#EA580C' },

  // ── 4. Referential 引用 (Cyan-Blue family) ──
  // 引用链: 浅蓝(cite) → 深蓝(use)
  { id: 'references',   label: '引用', reverseId: 'isReferencedBy', isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#0891B2' },
  { id: 'applies',      label: '应用', reverseId: 'isAppliedBy',   isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#2563EB' },

  // ── 5. Dynamic 动态 (Teal-Rose-Sky: 因果/时序) ──
  // 使能(Teal)→导致(Rose)→先于(Sky)：呼应流程链
  { id: 'enables',      label: '使能', reverseId: 'isEnabledBy',   isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#0D9488' },
  { id: 'causes',       label: '导致', reverseId: 'isCausedBy',    isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#E11D48' },
  { id: 'precedes',     label: '先于', reverseId: 'follows',       isSymmetric: false, isBuiltIn: true, isActive: true,  color: '#0284C7' },

  // ── 6. Structural 结构 (WarmGray + Emerald) ──
  // 松散关联(灰) + 附加补充(绿)
  { id: 'associates',   label: '关联', reverseId: 'associates',    isSymmetric: true,  isBuiltIn: true, isActive: true,  color: '#78716C' },
  { id: 'supplements',  label: '补充', reverseId: 'supplements',   isSymmetric: true,  isBuiltIn: true, isActive: true,  color: '#10B981' },

  // ── 7. Passive 被动 (系统自动维护，用户不直接选择) ──
  { id: 'isAppliedBy',      label: '被应用',   reverseId: 'applies',      isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isReferencedBy',   label: '被引用',   reverseId: 'references',   isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isProvedBy',       label: '被证明',   reverseId: 'proves',       isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isRefutedBy',      label: '被反驳',   reverseId: 'refutes',      isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isElaboratedBy',   label: '被详述',   reverseId: 'elaborates',   isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isExemplifiedBy',  label: '被举例',   reverseId: 'exemplifies',  isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isIllustratedBy',  label: '被图示',   reverseId: 'illustrates',  isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isCausedBy',       label: '被导致',   reverseId: 'causes',       isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'isEnabledBy',      label: '被使能',   reverseId: 'enables',      isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'follows',          label: '承接',     reverseId: 'precedes',     isSymmetric: false, isBuiltIn: true, isActive: false },
  { id: 'contains',         label: '包含',     reverseId: 'part-of',      isSymmetric: false, isBuiltIn: true, isActive: false },
];

/** v5.12: 语义分组 — 关系类型按六维归类，用于 UI 芯片分组渲染 */
export const SEMANTIC_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Taxonomic',     types: ['generalizes', 'specializes', 'part-of'] },
  { label: 'Argumentative', types: ['proves', 'refutes', 'contrasts'] },
  { label: 'Expositive',    types: ['elaborates', 'exemplifies', 'illustrates'] },
  { label: 'Referential',   types: ['references', 'applies'] },
  { label: 'Dynamic',       types: ['enables', 'causes', 'precedes'] },
  { label: 'Structural',    types: ['associates', 'supplements'] },
  { label: 'Passive',       types: ['isAppliedBy', 'isReferencedBy', 'isProvedBy', 'isRefutedBy', 'isElaboratedBy', 'isExemplifiedBy', 'isIllustratedBy', 'isCausedBy', 'isEnabledBy', 'follows', 'contains'] },
];

/**
 * v4.3: 关系类型 Schema — 运行时查询入口
 *
 * 从 RelationTypeConfig[] 配置动态构建映射表。
 * 替代 v4.2 的硬编码常量（REVERSE_RELATION_MAP / ACTIVE_RELATION_TYPES / RELATION_TYPE_LABELS）。
 *
 * 使用方式：
 *   const schema = new RelationSchema(settings.customRelationTypes);
 *   schema.getReverse('applies')  → 'isAppliedBy'
 *   schema.getLabel('applies')    → '应用'
 *   schema.getActiveTypes()       → ['generalizes', ...]
 *
 * 插件启动时创建实例，注入到 Store / UI 等模块。
 */
export class RelationSchema {
  private configs: RelationTypeConfig[];
  private _reverseMap: Map<string, string>;
  private _labelMap: Map<string, string>;
  private _activeTypes: string[];
  private _allTypes: string[];

  constructor(configs: RelationTypeConfig[]) {
    this.configs = configs;
    this._reverseMap = new Map();
    this._labelMap = new Map();
    this._activeTypes = [];
    this._allTypes = [];

    // 🔧 P2: id 唯一性校验 — 防止配置错误导致关系映射异常
    const seenIds = new Set<string>();
    for (const cfg of configs) {
      if (seenIds.has(cfg.id)) {
        console.warn(`MarkVault: duplicate relation type id "${cfg.id}" — ignoring subsequent definition`);
        continue;
      }
      seenIds.add(cfg.id);
      this._reverseMap.set(cfg.id, cfg.reverseId);
      this._labelMap.set(cfg.id, cfg.label);
      this._allTypes.push(cfg.id);
      if (cfg.isActive) {
        this._activeTypes.push(cfg.id);
      }
    }
  }

  /** 获取反向关系类型。找不到则返回 undefined */
  getReverse(type: RelationType): string | undefined {
    return this._reverseMap.get(type);
  }

  /** 获取显示标签。找不到则返回 type 本身 */
  getLabel(type: RelationType): string {
    return this._labelMap.get(type) || type;
  }

  /** 获取用户可主动选择的关系类型列表 */
  getActiveTypes(): string[] {
    return this._activeTypes;
  }

  /** 获取所有已注册的关系类型 ID */
  getAllTypes(): string[] {
    return this._allTypes;
  }

  /** 检查某个关系类型是否已注册 */
  isRegistered(type: RelationType): boolean {
    return this._reverseMap.has(type);
  }

  /** 获取指定类型的完整配置 */
  getConfig(type: RelationType): RelationTypeConfig | undefined {
    return this.configs.find(c => c.id === type);
  }

  /** 构建兼容 v4.2 的 Record<RelationType, RelationType> 格式（用于测试/调试） */
  toReverseMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this._reverseMap) {
      result[k] = v;
    }
    return result;
  }
}

// ── v4.2 兼容常量：从默认配置构建 ──
// 这些常量保留用于向后兼容（测试、过渡期代码），
// 新代码应使用 RelationSchema 实例。
// 注：因为 RelationType 现在是 string，Record<RelationType, string> 等价于 Record<string, string>

/** @deprecated 使用 RelationSchema.getReverse() 替代 */
export const REVERSE_RELATION_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const cfg of DEFAULT_RELATION_TYPE_CONFIGS) {
    map[cfg.id] = cfg.reverseId;
  }
  return map;
})();

/** @deprecated 使用 RelationSchema.getLabel() 替代 */
export const RELATION_TYPE_LABELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const cfg of DEFAULT_RELATION_TYPE_CONFIGS) {
    map[cfg.id] = cfg.label;
  }
  return map;
})();

/** @deprecated 使用 RelationSchema.getActiveTypes() 替代 */
export const ACTIVE_RELATION_TYPES: string[] = DEFAULT_RELATION_TYPE_CONFIGS
  .filter(c => c.isActive)
  .map(c => c.id);

/** 标注间关联 */
export interface AnnotationRelation {
  targetUuid: string;          // 目标标注 UUID
  type: RelationType;          // 关系类型
  createdAt: number;           // 创建时间戳（ms），正向和反向关系共享同一 createdAt
  note?: string;               // 关联说明（可选）
  // v4.2: 时态字段（参考 Graphiti 双时态模型）
  invalidAt?: number;          // 关系失效时间戳（null = 有效，设置值 = 已失效/不再相关）
  source?: RelationSource;     // 关系来源溯源（手动创建/模板/LLM推断/导入）
}

/** Relation 来源类型（参考 Graphiti Episode 溯源） */
export type RelationSource = 'manual' | 'template' | 'inferred' | 'imported';

/** RelationSource 显示标签 */
export const RELATION_SOURCE_LABELS: Record<RelationSource, string> = {
  manual: '✋ 手动',
  template: '📋 模板',
  inferred: '🤖 推断',
  imported: '📦 导入',
};

/** 掌握度级别 */
export type MasteryLevel = 'unknown' | 'learning' | 'familiar' | 'mastered';

/** 复习优先级 */
export type ReviewPriority = 'low' | 'medium' | 'high' | 'urgent';

/** 标注学习状态标记 — 仅存 Store，不写入 Markdown */
export interface AnnotationFlag {
  mastery?: MasteryLevel;                 // 掌握度
  reviewPriority?: ReviewPriority;         // 复习优先级
  confidence?: 1 | 2 | 3 | 4 | 5;         // 自评信心 1-5
  needsCorrection?: boolean;              // 理解有误待纠偏
  lastReviewedAt?: number;                // 最后复习时间戳
  reviewCount?: number;                    // 复习次数
}

/** MasteryLevel 显示标签 */
export const MASTERY_LABELS: Record<MasteryLevel, string> = {
  unknown: '未知',
  learning: '学习中',
  familiar: '熟悉',
  mastered: '已掌握',
};

/** ReviewPriority 显示标签 */
export const REVIEW_PRIORITY_LABELS: Record<ReviewPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};

/** Markdown 中 <mark> 标签的属性接口 */
export interface MarkAttributes {
  uuid: string;
  type: AnnotationType;
  color: string;
  note?: string;
  tags?: string;
  groupUuid?: string;  // 拆分标注组 ID
  fields?: string;     // URL 编码的 fields 字符串，如 "category=定义&importance=高"
  alias?: string;      // v5.3: 图谱显示别名
}

/** 块级标注锚点属性 */
export interface BlockAnchorAttributes {
  uuid: string;
  type: AnnotationType;
  color: string;
  note: string;
  alias?: string;    // v5.3: 图谱别名（锚点格式中存储）
}

/** 字段定义（模板中的单个字段） */
export interface FieldDef {
  key: string;           // 字段键名，如 "category"
  values: string[];      // 预设值列表，如 ["定义", "原理", "应用"]
  allowCustom?: boolean; // 是否允许自由输入（默认 true）
}

// ═══════════════════════════════════════════════════════
// v4.1: 字段命名空间约定（参考 Trilium Notes 属性命名空间）
// ═══════════════════════════════════════════════════════

/**
 * 字段命名空间前缀约定：
 * - 无前缀 / "u:" 前缀：用户自定义字段（如 u:difficulty, u:source）
 * - "_" 下划线前缀：系统内部字段（如 _mastery, _priority）— 已迁移到 flags
 *
 * UI 行为：
 * - 用户在 Modal 中添加字段时，自动添加 "u:" 前缀
 * - 搜索/过滤时，"u:" 前缀字段和裸键字段均可匹配（兼容旧数据）
 * - 导出时，"u:" 前缀保留，用于 W3C 互操作格式中的属性标识
 */
export const USER_FIELD_PREFIX = 'u:';

/** 判断字段 key 是否为用户命名空间 */
export function isUserField(key: string): boolean {
  return key.startsWith(USER_FIELD_PREFIX);
}

/** 确保字段 key 带有 u: 前缀（用于 UI 输入规范化） */
export function normalizeUserFieldKey(key: string): string {
  if (key.startsWith(USER_FIELD_PREFIX) || key.startsWith('_')) return key;
  return USER_FIELD_PREFIX + key;
}

/** 剥离 u: 前缀（用于搜索匹配时兼容裸键） */
export function stripUserFieldPrefix(key: string): string {
  return key.startsWith(USER_FIELD_PREFIX) ? key.slice(USER_FIELD_PREFIX.length) : key;
}

/** 字段模板 */
export interface FieldTemplate {
  id: string;           // 模板唯一 ID（如 "academic", "reading"）
  name: string;         // 模板名称，如 "学术标注"
  fields: FieldDef[];   // 字段定义列表
}

/**
 * 标注模板 — 预设 type + color + motivation + fields 组合
 * 用户可以一键创建常用标注类型，也可绑定快捷键
 *
 * 使用场景：
 * - 学习时快速创建"提问"标注（❓ yellow highlighting questioning）
 * - 复习时快速创建"纠偏"标注（✏️ pink editing）
 * - 阅读时快速创建"收藏"标注（🔖 blue bookmarking）
 */
export interface AnnotationTemplate {
  id: string;                        // 模板唯一 ID（如 "quick-highlight", "question"）
  name: string;                      // 模板名称，如 "快速高亮"、"提问"
  type: AnnotationType;              // 标注类型
  color: PresetColorId | string;      // 颜色
  motivation?: AnnotationMotivation;  // 标注意图（可选，不设则自动推断）
  fields?: Record<string, string>;     // 预填字段
  tags?: string[];                     // 预填标签
  icon?: string;                      // 显示图标（用于右键菜单）
  hotkey?: string;                    // 建议快捷键（仅作显示，实际绑定由 Obsidian 命令面板处理）
  // v5.14: 认知模板 — 自动填充 flags 维度
  flags?: Partial<AnnotationFlag>;    // 预填学习状态（mastery/confidence/reviewPriority/needsCorrection）
}

/** 预设标注模板 */
export const DEFAULT_ANNOTATION_TEMPLATES: AnnotationTemplate[] = [
  {
    id: 'quick-highlight',
    name: '快速高亮',
    type: 'highlight',
    color: 'yellow',
    motivation: 'highlighting',
    icon: '🖍️',
    hotkey: 'Mod+Shift+h',
  },
  {
    id: 'question',
    name: '提问',
    type: 'highlight',
    color: 'pink',
    motivation: 'questioning',
    icon: '❓',
    hotkey: 'Mod+Shift+q',
  },
  {
    id: 'important',
    name: '重点标记',
    type: 'bold',
    color: 'yellow',
    motivation: 'highlighting',
    icon: '🔥',
    hotkey: 'Mod+Shift+i',
  },
  {
    id: 'bookmark',
    name: '收藏待回看',
    type: 'underline',
    color: 'blue',
    motivation: 'bookmarking',
    icon: '🔖',
    hotkey: 'Mod+Shift+b',
  },
  {
    id: 'correction',
    name: '纠偏修正',
    type: 'highlight',
    color: 'purple',
    motivation: 'editing',
    icon: '✏️',
    hotkey: 'Mod+Shift+e',
  },
];

/** 侧边栏过滤条件 */
export interface AnnotationFilter {
  type?: AnnotationType | 'all';
  color?: string | 'all';
  hasNote?: boolean;
  searchQuery?: string;
  fieldFilters?: Record<string, string>;  // v3.0: 字段过滤
  sortBy?: 'position' | 'createdAt' | 'updatedAt';

  // v4.0: 元数据扩展过滤
  mastery?: MasteryLevel | 'all';          // 按掌握度过滤
  reviewPriority?: ReviewPriority | 'all'; // 按复习优先级过滤
  hasRelations?: boolean;                  // 是否有关联
  group?: string | 'all';                  // 按分组过滤
  needsCorrection?: boolean;               // 按纠偏标记过滤

  // v4.1: Motivation 语义过滤
  motivation?: AnnotationMotivation | 'all';  // 按标注意图过滤
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
  // v4.0: 元数据扩展统计
  withRelations: number;
  withGroups: number;
  withFlags: number;
  byMastery: Record<string, number>;
  byReviewPriority: Record<string, number>;
  needsCorrection: number;

  // v4.1: Motivation 语义统计
  byMotivation: Record<string, number>;

  // v5.3: 图谱别名统计
  withAlias: number;

  // v5.14: 孤儿标注统计
  orphanCount: number;
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
  annotationTemplates: AnnotationTemplate[];  // v4.1: 标注模板（预设 type+color+motivation 组合）
  customTemplates: AnnotationTemplate[];      // v5.14: 用户自定义模板（Settings CRUD 管理）
  customRelationTypes: RelationTypeConfig[];  // v4.3: 关系类型配置（Schema-First）
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
  annotationTemplates: DEFAULT_ANNOTATION_TEMPLATES,
  customTemplates: [],                          // v5.14: 用户自定义模板（初始为空）
  customRelationTypes: DEFAULT_RELATION_TYPE_CONFIGS,
};
