/**
 * GraphDataBuilder — 从 AnnotationStore 构建力导向图数据
 *
 * 将标注和关系转换为 force-graph 兼容的 { nodes, links } 格式。
 * 支持过滤、双向边 curvature 计算、孤立体节点控制。
 */

import type { Annotation, RelationSchema } from '../../types/annotation';
import { PRESET_COLORS } from '../../types/annotation';
import type { GraphFilter } from './graph-types';

// ── 图谱数据类型 ──────────────────────────

export interface GraphNode {
  /** 标注 UUID（作为节点 ID） */
  id: string;
  /** 显示标签（标注文本截断） */
  label: string;
  /** 标签原始长度（未截断前），用于力导向 linkDistance 自适应计算 */
  labelLength: number;
  /** 节点颜色（按标注类型/用户颜色） */
  color: string;
  /** 节点大小权重（关联数 + 1） */
  val: number;
  /** 标注类型（inline/block/span/region） */
  annotationKind: string;
  /** 所属文件路径 */
  filePath: string;
  /** 标注 UUID（原始，用于定位） */
  uuid: string;
  /** 关联数量（出+入） */
  degree: number;
}

export interface GraphLink {
  /** 源节点 ID（UUID） */
  source: string;
  /** 目标节点 ID（UUID） */
  target: string;
  /** 关系类型（如 'applies', 'references'） */
  relationType: string;
  /** 关系标签（人类可读） */
  relationLabel: string;
  /** 关系唯一标识（用于高亮） */
  relationId: string;
  /** 边颜色（按关系类型配色） */
  color: string;
  /** 曲率（双向边 > 0，单向 = 0） */
  curvature: number;
  /** 是否已失效 */
  isInvalidated: boolean;
  /** v5.5: 该连接线的推荐距离（基于两端节点标签长度动态计算） */
  _distance: number;
}

export interface GraphDataResult {
  nodes: GraphNode[];
  links: GraphLink[];
}

// ── 标注类型默认颜色 ──────────────────────────

const KIND_COLORS: Record<string, string> = {
  inline: '#f59e0b',  // 琥珀色
  block: '#3b82f6',   // 蓝色
  span: '#8b5cf6',    // 紫色
  region: '#10b981',  // 绿色
};

const DEFAULT_NODE_COLOR = '#6b7280';

/** 预设颜色 ID → hex 映射（Annotation.color 可以是 preset ID 或 hex） */
const PRESET_COLOR_MAP: Record<string, string> = Object.fromEntries(
  PRESET_COLORS.map(c => [c.id, c.hex])
);

/** 解析颜色值：preset ID → hex，已为 hex 则直接返回，否则 fallback 到 kind 颜色 */
function resolveColor(color: string | undefined, kind: string): string {
  if (!color) return getKindColor(kind);
  if (color.startsWith('#')) return color;
  return PRESET_COLOR_MAP[color] || getKindColor(kind);
}

/** 获取标注类型对应的颜色 */
function getKindColor(kind: string): string {
  return KIND_COLORS[kind] || DEFAULT_NODE_COLOR;
}

// ── 关系类型颜色调色板 ──────────────────────────

/** v5.11: 被动关系的统一灰色边颜色（语义化调色板伴生常量） */
const PASSIVE_COLOR = '#9CA3AF';

/** v5.11: 语义化调色板 — 与 DEFAULT_RELATION_TYPE_CONFIGS.color 保持同步 */
const RELATION_PALETTE: Record<string, string> = {
  // Taxonomic 分类 (Blue-Purple)
  generalizes: '#4F46E5',
  specializes: '#7C3AED',
  'part-of': '#6D28D9',
  // Argumentative 论证 (Green-Red-Amber)
  proves: '#16A34A',
  refutes: '#DC2626',
  contrasts: '#CA8A04',
  // Expositive 阐释 (Warm Amber-Orange)
  elaborates: '#A16207',
  exemplifies: '#EAB308',
  illustrates: '#EA580C',
  // Referential 引用 (Cyan-Blue)
  references: '#0891B2',
  applies: '#2563EB',
  // Dynamic 动态 (Teal-Rose-Sky)
  enables: '#0D9488',
  causes: '#E11D48',
  precedes: '#0284C7',
  // Structural 结构 (WarmGray + Emerald)
  associates: '#78716C',
  supplements: '#10B981',
  // Passive 被动 — 统一灰色
  isAppliedBy: PASSIVE_COLOR,
  isReferencedBy: PASSIVE_COLOR,
  isProvedBy: PASSIVE_COLOR,
  isRefutedBy: PASSIVE_COLOR,
  isElaboratedBy: PASSIVE_COLOR,
  isExemplifiedBy: PASSIVE_COLOR,
  isIllustratedBy: PASSIVE_COLOR,
  isCausedBy: PASSIVE_COLOR,
  isEnabledBy: PASSIVE_COLOR,
  follows: PASSIVE_COLOR,
  contains: PASSIVE_COLOR,
};

const DEFAULT_RELATION_COLOR = '#78716C';

// ── 主构建函数 ──────────────────────────

/**
 * 从标注数组构建图谱数据
 *
 * @param annotations 所有标注
 * @param schema 关系类型 Schema（用于获取标签和颜色）
 * @param filter 过滤条件
 * @returns force-graph 兼容的 { nodes, links }
 */
export function buildGraphData(
  annotations: Annotation[],
  schema: RelationSchema,
  filter: GraphFilter,
): GraphDataResult {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const nodeMap = new Map<string, GraphNode>();

  // P3-2: 预建 uuid → Annotation 映射，替代 O(n) 的 some()/find() 查询
  const uuidMap = new Map<string, Annotation>();
  const uuidSet = new Set<string>();
  for (const ann of annotations) {
    uuidMap.set(ann.uuid, ann);
    uuidSet.add(ann.uuid);
  }

  // 1. 预计算每个标注的关联度
  const degreeMap = computeDegreeMap(annotations);

  // 2. 遍历标注，构建节点和边
  for (const ann of annotations) {
    // 过滤：文件路径
    if (filter.filePaths.length > 0 && !filter.filePaths.includes(ann.filePath)) {
      continue;
    }

    // 过滤：标注类型
    const annKind = ann.kind || 'inline';
    if (filter.annotationKinds.length > 0 && !filter.annotationKinds.includes(annKind)) {
      continue;
    }

    // 🔧 P1-2: 区分两种 hasRelations 语义
    // hasAnyRelations: 包含失效关系，用于孤立节点过滤（有失效关系的节点不是孤立的）
    const hasAnyRelations = !!(ann.relations && ann.relations.length > 0);
    // hasActiveRelations: 仅有效关系，用于关系类型过滤和边构建
    const hasActiveRelations = ann.relations
      ? ann.relations.some(r => !r.invalidAt)
      : false;

    // 过滤：孤立节点
    if (!filter.showIsolated && !hasAnyRelations) {
      continue;
    }

    // 过滤：关系类型（节点至少有一条符合过滤条件的有效关系）
    if (filter.relationTypes.length > 0 && hasActiveRelations) {
      const hasMatchingRel = ann.relations!.some(
        r => !r.invalidAt && filter.relationTypes.includes(r.type)
      );
      if (!hasMatchingRel) continue;
    }

    // 构建节点
    const annColor = resolveColor(ann.color, annKind);
    // v5.3: 优先使用用户设置的别名，无别名则不显示文字标签（保持图谱简洁）
    const rawLabel = (ann.alias && ann.alias.trim()) ? ann.alias.trim() : '';
    // v5.5: 标签存储原始值（不截断），截断逻辑移到渲染层 drawNode()
    // 这样缩放时可以根据 globalScale 动态决定显示多少字符
    const node: GraphNode = {
      id: ann.uuid,
      label: rawLabel,
      labelLength: rawLabel.length,
      color: annColor,
      val: Math.max(1, (degreeMap.get(ann.uuid) || 0)) + 1,
      annotationKind: annKind,
      filePath: ann.filePath,
      uuid: ann.uuid,
      degree: degreeMap.get(ann.uuid) || 0,
    };

    if (!nodeMap.has(ann.uuid)) {
      nodeMap.set(ann.uuid, node);
      nodes.push(node);
    } else {
      // 节点已作为目标被添加过（在处理其他标注的关系时），更新属性保留最新值
      Object.assign(nodeMap.get(ann.uuid)!, node);
    }

    // 构建边（包含失效关系，但标记为 dashed）
    if (hasAnyRelations) {
      for (const rel of ann.relations!) {
        // 过滤：关系类型
        if (filter.relationTypes.length > 0 && !filter.relationTypes.includes(rel.type)) {
          continue;
        }

        // v5.7: 过滤已失效关系（showInvalidated=false 时跳过 invalidAt 的边）
        if (!filter.showInvalidated && rel.invalidAt) {
          continue;
        }

        // 跳过目标不存在的边（P3-2: 使用预建 uuidSet 避免 O(n) some() 查询）
        if (!uuidSet.has(rel.targetUuid)) {
          continue;
        }

        // 确保目标节点存在（去重：只添加未在 nodeMap 中的节点）
        if (!nodeMap.has(rel.targetUuid)) {
          const targetAnn = uuidMap.get(rel.targetUuid);
          if (targetAnn) {
            const targetKind = targetAnn.kind || 'inline';
            const targetRawLabel = (targetAnn.alias && targetAnn.alias.trim()) ? targetAnn.alias.trim() : '';
            const targetNode: GraphNode = {
              id: targetAnn.uuid,
              label: targetRawLabel,
              labelLength: targetRawLabel.length,
              color: resolveColor(targetAnn.color, targetKind),
              val: Math.max(1, (degreeMap.get(targetAnn.uuid) || 0)) + 1,
              annotationKind: targetKind,
              filePath: targetAnn.filePath,
              uuid: targetAnn.uuid,
              degree: degreeMap.get(targetAnn.uuid) || 0,
            };
            nodeMap.set(targetAnn.uuid, targetNode);
            nodes.push(targetNode);
          }
        }

        const relationLabel = schema.getLabel(rel.type) || rel.type;
        const relationColor = getRelationColor(rel.type, schema);

        // v5.6: per-link distance — 基于两端节点的标签长度动态计算
        // 算法：基础距离 35 + 两端标签宽度和 × 每字符宽度（约 6px），上限 160
        // 短标签（如"测试1号"3字）→ 35 + 36 = 71px，长标签 → 最大 195px
        const sourceLabelLen = node.labelLength || 0;
        const targetAnn = uuidMap.get(rel.targetUuid);
        const targetLabelLen = targetAnn
          ? ((targetAnn.alias && targetAnn.alias.trim()) ? targetAnn.alias.trim().length : 0)
          : 0;
        const labelWidth = (sourceLabelLen + targetLabelLen) * 6;
        const linkDistance = 35 + Math.min(labelWidth, 160);

        const link: GraphLink = {
          source: ann.uuid,
          target: rel.targetUuid,
          relationType: rel.type,
          relationLabel,
          relationId: `${ann.uuid}->${rel.targetUuid}:${rel.type}`,
          color: relationColor,
          curvature: 0, // 稍后计算
          isInvalidated: !!rel.invalidAt,
          _distance: linkDistance,
        };

        links.push(link);
      }
    }
  }

  // 3. 去重：同方向同类型只保留一条（优先保留非失效的）
  deduplicateLinks(links);

  // 4. 计算双向边的 curvature
  computeCurvature(links);

  // 5. v5.7: 邻居深度筛选（从 focalNode 出发 BFS 扩展 N 跳）
  if (filter.neighborDepth > 0 && filter.focalNodeId) {
    const visibleIds = bfsReachable(filter.focalNodeId, links, filter.neighborDepth);
    // 过滤节点
    const filteredNodes = nodes.filter(n => visibleIds.has(n.id as string));
    // 过滤边
    const filteredLinks = links.filter(l => {
      const sId = typeof l.source === 'string' ? l.source : (l.source as unknown as GraphNode).id as string;
      const tId = typeof l.target === 'string' ? l.target : (l.target as unknown as GraphNode).id as string;
      return visibleIds.has(sId) && visibleIds.has(tId);
    });
    return { nodes: filteredNodes, links: filteredLinks };
  }

  return { nodes, links };
}

// ── 辅助函数 ──────────────────────────

/** v5.7: BFS 从 focalNode 出发，收集 maxDepth 跳内可达的所有节点 ID */
function bfsReachable(focalNodeId: string, links: GraphLink[], maxDepth: number): Set<string> {
  // 建邻接表
  const adj = new Map<string, Set<string>>();
  for (const link of links) {
    const sId = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id as string;
    const tId = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id as string;
    if (!adj.has(sId)) adj.set(sId, new Set());
    if (!adj.has(tId)) adj.set(tId, new Set());
    adj.get(sId)!.add(tId);
    adj.get(tId)!.add(sId); // 无向图（双向可达）
  }

  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: focalNodeId, depth: 0 }];
  visited.add(focalNodeId);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const neighbors = adj.get(id);
    if (!neighbors) continue;
    for (const nId of neighbors) {
      if (!visited.has(nId)) {
        visited.add(nId);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }

  return visited;
}

/** 预计算每个标注的关联度（出边+入边） */
function computeDegreeMap(annotations: Annotation[]): Map<string, number> {
  const degreeMap = new Map<string, number>();

  // 出度
  for (const ann of annotations) {
    if (ann.relations) {
      for (const rel of ann.relations) {
        if (!rel.invalidAt) {
          degreeMap.set(ann.uuid, (degreeMap.get(ann.uuid) || 0) + 1);
          degreeMap.set(rel.targetUuid, (degreeMap.get(rel.targetUuid) || 0) + 1);
        }
      }
    }
  }

  return degreeMap;
}

/** 截断标签文本 */
function truncateLabel(text: string, maxLen: number): string {
  if (!text) return '(untitled)';
  const clean = text.replace(/\n/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
}

/** 获取关系类型颜色 */
function getRelationColor(type: string, schema: RelationSchema): string {
  const config = schema.getConfig(type);
  if (config?.color) return config.color;
  return RELATION_PALETTE[type] || DEFAULT_RELATION_COLOR;
}

/** 去重：同源同目标同类型只保留一条（优先非失效） */
function deduplicateLinks(links: GraphLink[]): void {
  const seen = new Map<string, GraphLink>();

  for (const link of links) {
    const key = `${link.source}->${link.target}:${link.relationType}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, link);
    } else if (!link.isInvalidated && existing.isInvalidated) {
      // 非失效优先
      seen.set(key, link);
    }
  }

  links.length = 0;
  for (const link of seen.values()) {
    links.push(link);
  }
}

/**
 * 计算双向边的 curvature，避免重叠。
 *
 * 如果 A→B 和 B→A 同时存在，两条边都需要弯曲以避免视觉重叠：
 * - A→B curvature = 0.2（向上弯）
 * - B→A curvature = 0.2（向上弯，与 A→B 形成对称弧）
 *
 * 如果只有单向边，curvature = 0（直线）。
 */
function computeCurvature(links: GraphLink[]): void {
  // 构建 (source, target) → [links] 映射
  const pairMap = new Map<string, GraphLink[]>();

  for (const link of links) {
    const pairKey = [link.source, link.target].sort().join('::');
    let pairLinks = pairMap.get(pairKey);
    if (!pairLinks) {
      pairLinks = [];
      pairMap.set(pairKey, pairLinks);
    }
    pairLinks.push(link);
  }

  // 对双向边对设置 curvature
  for (const [, pairLinks] of pairMap) {
    if (pairLinks.length <= 1) continue;

    // 按方向分组
    const forward: GraphLink[] = [];
    const reverse: GraphLink[] = [];

    // 以第一对的 source 为基准
    const baseSource = pairLinks[0].source;

    for (const link of pairLinks) {
      if (link.source === baseSource) {
        forward.push(link);
      } else {
        reverse.push(link);
      }
    }

    // 如果存在双向边，给所有边设置 curvature
    if (forward.length > 0 && reverse.length > 0) {
      const curvatureStep = 0.15;
      for (let i = 0; i < forward.length; i++) {
        forward[i].curvature = curvatureStep + i * 0.1;
      }
      for (let i = 0; i < reverse.length; i++) {
        reverse[i].curvature = curvatureStep + i * 0.1;
      }
    }
  }
}
