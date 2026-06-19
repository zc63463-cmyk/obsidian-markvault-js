/**
 * SVG Connector — 贝塞尔曲线连线
 *
 * 支持两种布局方向的连线：
 *   - tree-right: 父节点右侧中点 → 子节点左侧中点（水平贝塞尔）
 *   - tree-org:   父节点底部中点 → 子节点顶部中点（垂直贝塞尔）
 */

import type { MindNode, LayoutType } from '../types/mind-node';
import type { VisibleEdge } from '../layout/tree-layout';

/** SVG 命名空间 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 连线默认颜色 */
const DEFAULT_STROKE = '#7C8DA0';

/** 连线默认宽度 */
const DEFAULT_STROKE_WIDTH = 2;

/** 标注节点连线颜色（虚线，区分于普通连线） */
const ANNOTATION_STROKE = '#9CA3AF';

/** 关系连线线型配置 — 圆点虚线 (2 6) 从视觉上明确区分树结构 */
const REL_STROKE_WIDTH = 1.5;
const REL_DASH_ARRAY = '2 6';
const REL_OPACITY = 0.55;

/** 自主连线线型配置 — 长划线 (10 4) 与圆点虚线形成对比 */
const CONN_STROKE_WIDTH = 2.5;
const CONN_DASH_ARRAY = '10 4';
const CONN_OPACITY = 0.65;
const CONN_COLOR = '#8B5CF6';

/**
 * 确保 SVG 定义了箭头 marker（幂等）
 *
 * 箭头 marker 自动适配线条颜色（currentColor），调用方设置 stroke 即可。
 */
export function ensureArrowMarkers(svg: SVGSVGElement): string {
  const markerId = 'mf-arrowhead';
  if (svg.querySelector(`#${markerId}`)) return markerId;

  // 先清除已有 defs（来自旧渲染）
  const oldDefs = svg.querySelector('defs');
  if (oldDefs) oldDefs.remove();

  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', markerId);
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  marker.setAttribute('markerUnits', 'userSpaceOnUse');

  const arrowPath = document.createElementNS(SVG_NS, 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 8 3 L 0 6 Z');
  arrowPath.setAttribute('fill', 'currentColor');
  marker.appendChild(arrowPath);

  defs.appendChild(marker);
  svg.insertBefore(defs, svg.firstChild);
  return markerId;
}

/**
 * 计算父→子贝塞尔曲线路径
 *
 * @param parent 父节点（含 layout）
 * @param child 子节点（含 layout）
 * @param layout 布局类型（决定连线方向）
 * @returns SVG path d 属性字符串
 */
export function computePath(
  parent: MindNode,
  child: MindNode,
  layout?: LayoutType,
): string {
  const pLayout = parent.layout;
  const cLayout = child.layout;
  if (!pLayout || !cLayout) return '';

  if (layout === 'org') {
    // tree-org: 父底部中点 → 子顶部中点（垂直）
    const x1 = pLayout.x + pLayout.width / 2;
    const y1 = pLayout.y + pLayout.height;
    const x2 = cLayout.x + cLayout.width / 2;
    const y2 = cLayout.y;
    const dy = Math.max((y2 - y1) * 0.4, 20);
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }

  if (layout === 'tree-left') {
    // tree-left: 父左侧中点 → 子右侧中点（反向水平）
    const x1 = pLayout.x;
    const y1 = pLayout.y + pLayout.height / 2;
    const x2 = cLayout.x + cLayout.width;
    const y2 = cLayout.y + cLayout.height / 2;
    const dx = Math.max((x1 - x2) * 0.5, 20);
    return `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
  }

  if (layout === 'fishbone') {
    // 鱼骨图: 脊线→分支用斜线，分支→子节点按方向连线
    const pCenterX = pLayout.x + pLayout.width / 2;
    const pCenterY = pLayout.y + pLayout.height / 2;
    const cCenterX = cLayout.x + cLayout.width / 2;
    const cCenterY = cLayout.y + cLayout.height / 2;

    const spineInfo = parent._fishboneSpine;
    if (spineInfo) {
      // 一级分支: 从脊线斜向连接到分支节点中心
      const spineX = cCenterX;
      return `M ${spineX} ${spineInfo.y1} L ${cCenterX} ${cCenterY}`;
    }
    // 子节点: 根据相对位置自动选择连线方向
    // 垂直排列时 X 相近 → 垂直线；水平排列时 Y 相近 → 水平线
    const dx = Math.abs(cCenterX - pCenterX);
    const dy = Math.abs(cCenterY - pCenterY);
    if (dx > dy) {
      // 水平连线: 父右侧 → 子左侧
      const x1 = pLayout.x + pLayout.width;
      const y1 = pCenterY;
      const x2 = cLayout.x;
      const y2 = cCenterY;
      const cpx = (x1 + x2) / 2;
      return `M ${x1} ${y1} C ${cpx} ${y1}, ${cpx} ${y2}, ${x2} ${y2}`;
    }
    // 垂直连线
    return `M ${pCenterX} ${pCenterY} L ${cCenterX} ${cCenterY}`;
  }

  if (layout === 'timeline') {
    // 时间轴: 从主轴连接到事件节点（垂直线），事件内子节点垂直连接
    const cCenterX = cLayout.x + cLayout.width / 2;
    const cCenterY = cLayout.y + cLayout.height / 2;
    const pCenterX = pLayout.x + pLayout.width / 2;
    const pCenterY = pLayout.y + pLayout.height / 2;

    const axisInfo = parent._timelineAxis;
    if (axisInfo) {
      // 一级事件: 从主轴垂直连接
      return `M ${cCenterX} ${axisInfo.y1} L ${cCenterX} ${cCenterY}`;
    }
    // 子级: 垂直连线
    return `M ${pCenterX} ${pCenterY} L ${cCenterX} ${cCenterY}`;
  }

  if (layout === 'radial' || layout === 'freeform') {
    // radial / freeform: 父中心 → 子中心（微弯贝塞尔）
    const x1 = pLayout.x + pLayout.width / 2;
    const y1 = pLayout.y + pLayout.height / 2;
    const x2 = cLayout.x + cLayout.width / 2;
    const y2 = cLayout.y + cLayout.height / 2;
    const dx = (x2 - x1) * 0.3;
    const dy = (y2 - y1) * 0.3;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1 + dy}, ${x2 - dx} ${y2 - dy}, ${x2} ${y2}`;
  }

  // tree-right / logic-right / 默认: 父右侧中点 → 子左侧中点（水平）
  const x1 = pLayout.x + pLayout.width;
  const y1 = pLayout.y + pLayout.height / 2;
  const x2 = cLayout.x;
  const y2 = cLayout.y + cLayout.height / 2;
  const dx = Math.max((x2 - x1) * 0.5, 20);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * 创建 SVG 元素容器
 *
 * @param width SVG 宽度
 * @param height SVG 高度
 * @returns SVG 元素
 */
export function createSvgContainer(width: number, height: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.classList.add('mf-connectors');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';
  svg.style.overflow = 'visible';
  return svg;
}

/**
 * 创建单条贝塞尔连线 path 元素
 */
function createPath(d: string, options?: { dashed?: boolean; color?: string }): SVGPathElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', options?.color ?? DEFAULT_STROKE);
  path.setAttribute('stroke-width', String(DEFAULT_STROKE_WIDTH));
  path.setAttribute('stroke-linecap', 'round');
  if (options?.dashed) {
    path.setAttribute('stroke-dasharray', '6 4');
  }
  return path;
}

/**
 * 渲染所有连线到 SVG 容器
 *
 * @param edges 可见连线列表
 * @param svg SVG 容器
 * @param layout 布局类型（决定连线方向）
 */
export function renderConnectors(
  edges: VisibleEdge[],
  svg: SVGSVGElement,
  layout?: LayoutType,
): void {
  // 清空旧连线
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }

  // 鱼骨图: 先画脊线
  if (layout === 'fishbone' && edges.length > 0) {
    const root = edges[0].parent;
    const spine = root._fishboneSpine;
    if (spine) {
      const spinePath = document.createElementNS(SVG_NS, 'path');
      spinePath.setAttribute('d', `M ${spine.x1} ${spine.y1} L ${spine.x2} ${spine.y2}`);
      spinePath.setAttribute('fill', 'none');
      spinePath.setAttribute('stroke', DEFAULT_STROKE);
      spinePath.setAttribute('stroke-width', String(DEFAULT_STROKE_WIDTH));
      spinePath.setAttribute('stroke-linecap', 'round');
      svg.appendChild(spinePath);
    }
  }

  // 时间轴: 先画主轴
  if (layout === 'timeline' && edges.length > 0) {
    const root = edges[0].parent;
    const axis = root._timelineAxis;
    if (axis) {
      const axisPath = document.createElementNS(SVG_NS, 'path');
      axisPath.setAttribute('d', `M ${axis.x1} ${axis.y1} L ${axis.x2} ${axis.y2}`);
      axisPath.setAttribute('fill', 'none');
      axisPath.setAttribute('stroke', DEFAULT_STROKE);
      axisPath.setAttribute('stroke-width', String(DEFAULT_STROKE_WIDTH));
      axisPath.setAttribute('stroke-linecap', 'round');
      svg.appendChild(axisPath);
      // 轴上画节点圆点
      for (const edge of edges) {
        if (edge.parent === root) {
          const cx = edge.child.layout?.x! + edge.child.layout?.width! / 2;
          const dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', String(cx));
          dot.setAttribute('cy', String(axis.y1));
          dot.setAttribute('r', '4');
          dot.setAttribute('fill', DEFAULT_STROKE);
          svg.appendChild(dot);
        }
      }
    }
  }

  for (const edge of edges) {
    const d = computePath(edge.parent, edge.child, layout);
    if (!d) continue;

    // Annotation 连线用虚线
    const dashed = edge.child.type === 'annotation';
    const color = dashed ? ANNOTATION_STROKE : DEFAULT_STROKE;

    const path = createPath(d, { dashed, color });
    svg.appendChild(path);

    // ── 父子连线语义标签 (edgeLabel) ──
    if (edge.child.edgeLabel) {
      const pLayout = edge.parent.layout;
      const cLayout = edge.child.layout;
      if (pLayout && cLayout) {
        const labelX = (pLayout.x + pLayout.width / 2 + cLayout.x + cLayout.width / 2) / 2;
        const labelY = (pLayout.y + pLayout.height / 2 + cLayout.y + cLayout.height / 2) / 2 - 8;
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', String(labelX));
        label.setAttribute('y', String(labelY));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('fill', DEFAULT_STROKE);
        label.setAttribute('font-size', '9');
        label.setAttribute('font-family', 'system-ui, sans-serif');
        label.textContent = edge.child.edgeLabel;
        label.style.pointerEvents = 'none';
        svg.appendChild(label);
      }
    }
  }
}

/**
 * 更新 SVG 容器尺寸
 */
export function resizeSvg(svg: SVGSVGElement, width: number, height: number): void {
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
}

// ═══════════════════════════════════════════════════════
// 标注关系连线 (Phase A5: 跨树边)
// ═══════════════════════════════════════════════════════

/** 标注关系连线数据 */
export interface RelationEdge {
  fromNodeId: string;
  toNodeId: string;
  /** 标注关系端点 UUID（用于删除操作） */
  sourceUuid: string;
  targetUuid: string;
  relationType: string;
  relationNote?: string;
  invalidated: boolean;
}

/** 关系类型颜色映射 — 规范源，其他模块应导入此常量 */
export const RELATION_COLORS: Record<string, string> = {
  'relatedTo': '#9CA3AF',
  'supports': '#43A047',
  'contradicts': '#E53935',
  'extends': '#378ADD',
  'refines': '#8E24AA',
  'explains': '#FB8C00',
  'exemplifies': '#00ACC1',
  'derives': '#5C6BC0',
};

/**
 * 获取节点矩形区域
 *
 * 优先 DOM → 回退 layout 数据 → 回退 null
 */
export function getNodeRect(
  nodeId: string,
  nodeElements: Map<string, HTMLElement>,
  rootNode: { id: string; children: any[]; layout?: { x: number; y: number; width: number; height: number } } | null,
): { x: number; y: number; width: number; height: number } | null {
  const el = nodeElements.get(nodeId);
  if (el) {
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    if (!isNaN(left) && !isNaN(top)) {
      const width = parseFloat(el.style.width) || el.offsetWidth || 0;
      const height = parseFloat(el.style.height)
        || parseFloat(el.style.minHeight)
        || el.offsetHeight
        || 0;
      return { x: left, y: top, width, height };
    }
  }

  if (!rootNode) return null;

  function findById(node: any, targetId: string): any {
    if (node.id === targetId) return node;
    for (const child of (node.children || [])) {
      const found = findById(child, targetId);
      if (found) return found;
    }
    return null;
  }

  const node = findById(rootNode, nodeId);
  if (!node) return null;

  if (node.layout && node.layout.x !== undefined) {
    return {
      x: node.layout.x,
      y: node.layout.y,
      width: node.layout.width || 0,
      height: node.layout.height || 0,
    };
  }

  return null;
}

/**
 * 计算矩形边界与从中心到目标点的射线交点
 *
 * 连线从中心出发，在矩形边界处停止，不再穿越文字区域。
 */
export function rectBoundaryIntersection(
  rect: { x: number; y: number; width: number; height: number },
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const hw = rect.width / 2;
  const hh = rect.height / 2;

  const dx = targetX - cx;
  const dy = targetY - cy;

  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { x: cx, y: cy };

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // 与四条边求交，取最近的交点
  const t = (absDx * hh > absDy * hw) ? (hw / absDx) : (hh / absDy);

  return {
    x: cx + dx * t,
    y: cy + dy * t,
  };
}

/**
 * 健壮获取节点 DOM 元素的中心坐标
 *
 * 布局代码设置 style.minHeight 而非 style.height，
 * 同时 renderedWidth 可能也存在偏差，因此综合多种来源取值。
 */
export function getNodeCenter(el: HTMLElement): { x: number; y: number } | null {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (isNaN(left) || isNaN(top)) return null;

  // width: 优先 style.width，回退 offsetWidth
  const width = parseFloat(el.style.width) || el.offsetWidth || 0;
  // height: 优先 style.height，回退 style.minHeight，再回退 offsetHeight
  const height = parseFloat(el.style.height)
    || parseFloat(el.style.minHeight)
    || el.offsetHeight
    || 0;

  return {
    x: left + width / 2,
    y: top + height / 2,
  };
}

/**
 * 查找节点在树中的位置（含折叠节点回退）
 *
 * 策略:
 *  1. nodeElements (DOM) → getNodeCenter (最精确)
 *  2. 全树搜索 node.layout — 折叠节点有 layout 数据
 *  3. 最近祖先的 layout — 在折叠子树内部的节点无 layout
 *  4. null
 *
 * @param nodeId 目标节点 ID
 * @param nodeElements 可见节点的 DOM 映射
 * @param rootNode 导图根节点（全树搜索用）
 * @returns 中心坐标，查找失败返回 null
 */
export function findNodePosition(
  nodeId: string,
  nodeElements: Map<string, HTMLElement>,
  rootNode: { id: string; children: any[]; layout?: { x: number; y: number; width: number; height: number } } | null,
): { x: number; y: number } | null {
  // 1. 优先 DOM
  const el = nodeElements.get(nodeId);
  if (el) {
    const center = getNodeCenter(el);
    if (center) return center;
  }

  // 2. 全树搜索
  if (!rootNode) return null;

  function findById(node: any, targetId: string): any {
    if (node.id === targetId) return node;
    for (const child of (node.children || [])) {
      const found = findById(child, targetId);
      if (found) return found;
    }
    return null;
  }

  const node = findById(rootNode, nodeId);
  if (!node) return null;

  // 3. 节点自身有 layout → 使用
  if (node.layout && node.layout.x !== undefined) {
    return {
      x: node.layout.x + (node.layout.width || 0) / 2,
      y: node.layout.y + (node.layout.height || 0) / 2,
    };
  }

  // 4. 节点在折叠子树内无 layout → 向上找最近祖先的 layout
  function findNearestLayout(n: any): any {
    if (!n || !n.parentId) return null;
    // 在全树中查找父节点
    const parent = findById(rootNode!, n.parentId);
    if (!parent) return null;
    if (parent.layout && parent.layout.x !== undefined) return parent.layout;
    return findNearestLayout(parent);
  }

  const ancestorLayout = findNearestLayout(node);
  if (ancestorLayout) {
    return {
      x: ancestorLayout.x + (ancestorLayout.width || 0) / 2,
      y: ancestorLayout.y + (ancestorLayout.height || 0) / 2,
    };
  }

  return null;
}

/**
 * 渲染关系连线到 SVG 容器
 *
 * 视觉区分策略:
 *   - 树结构连线: 灰色实线 (svgEl), 低视觉权重
 *   - 标注关系连线: 彩色虚线细淡 (_relSvgEl), 方向箭头, 可右键 invalidate
 *   - 自主连线: 紫色粗虚线 (_relSvgEl), 方向箭头, 可删除/编辑
 *
 * 支持折叠节点：通过 findNodePosition 回退到 tree layout 数据。
 *
 * @param relEdges 标注关系连线列表
 * @param svg SVG 容器 (_relSvgEl)
 * @param nodeElements 节点 DOM 元素映射
 * @param rootNode 导图根节点（折叠节点回退到 tree layout）
 * @param onContextMenu 右键回调 (edge, event) => void, 用于删除/管理关系
 * @param onClick 左键回调 (edge, event) => void, 用于查看关系详情
 */
export function renderRelationEdges(
  relEdges: RelationEdge[],
  svg: SVGSVGElement,
  nodeElements: Map<string, HTMLElement>,
  rootNode?: { id: string; children: any[]; layout?: { x: number; y: number; width: number; height: number } } | null,
  onContextMenu?: (edge: RelationEdge, event: MouseEvent) => void,
  onClick?: (edge: RelationEdge, event: MouseEvent) => void,
): void {
  // 清除旧关系连线
  svg.querySelectorAll('.mf-rel-edge').forEach(el => el.remove());

  // 确保箭头 marker 就绪
  const arrowMarkerId = relEdges.length > 0 ? ensureArrowMarkers(svg) : null;

  for (const edge of relEdges) {
    // 获取节点中心 + 矩形
    const fromCenter = findNodePosition(edge.fromNodeId, nodeElements, rootNode ?? null);
    const toCenter = findNodePosition(edge.toNodeId, nodeElements, rootNode ?? null);
    const fromRect = getNodeRect(edge.fromNodeId, nodeElements, rootNode ?? null);
    const toRect = getNodeRect(edge.toNodeId, nodeElements, rootNode ?? null);

    if (!fromCenter || !toCenter) continue;

    // 连线端点落在节点边界上，不穿越文字
    const p1 = fromRect ? rectBoundaryIntersection(fromRect, toCenter.x, toCenter.y) : fromCenter;
    const p2 = toRect ? rectBoundaryIntersection(toRect, fromCenter.x, fromCenter.y) : toCenter;

    const x1 = p1.x;
    const y1 = p1.y;
    const x2 = p2.x;
    const y2 = p2.y;

    // 贝塞尔曲线 — 终点留出箭头空间 (refX=8)
    const dx = Math.abs(x2 - x1) * 0.4;
    const dy = Math.abs(y2 - y1) * 0.4;
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1 + dy / 2}, ${x2 - dx} ${y2 - dy / 2}, ${x2} ${y2}`;

    const color = edge.invalidated ? '#D0D0D0' : (RELATION_COLORS[edge.relationType] ?? '#9CA3AF');

    // ── 隐形点击面 — 宽描边提高命中率 ──
    const hitArea = document.createElementNS(SVG_NS, 'path');
    hitArea.setAttribute('d', d);
    hitArea.setAttribute('fill', 'none');
    hitArea.setAttribute('stroke', 'transparent');
    hitArea.setAttribute('stroke-width', '14');
    hitArea.setAttribute('stroke-linecap', 'round');
    hitArea.style.pointerEvents = 'stroke';
    hitArea.style.cursor = 'pointer';
    hitArea.classList.add('mf-rel-edge');
    if (edge.relationNote) hitArea.setAttribute('data-relation-note', edge.relationNote);

    // hover tooltip
    const titleParts = [edge.relationType];
    if (edge.relationNote) titleParts.push(`: ${edge.relationNote}`);
    if (edge.invalidated) titleParts.push('(invalidated)');
    hitArea.setAttribute('title', titleParts.join(' '));

    // 右键 → 删除/恢复标注关系
    if (onContextMenu) {
      hitArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(edge, e);
      });
    }

    // 左键点击 → 查看关系详情
    hitArea.addEventListener('click', (e) => {
      e.stopPropagation();
      // 视觉反馈：短暂高亮可见路径
      const origOpacity = path.getAttribute('opacity');
      path.setAttribute('opacity', '1.0');
      path.setAttribute('stroke-width', '3');
      setTimeout(() => {
        path.setAttribute('opacity', origOpacity ?? String(REL_OPACITY));
        path.setAttribute('stroke-width', String(REL_STROKE_WIDTH));
      }, 300);
      // 回调
      if (onClick) onClick(edge, e);
    });

    svg.appendChild(hitArea);

    // ── 可见路径 — 纯装饰，不拦截事件 ──
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', String(REL_STROKE_WIDTH));
    path.setAttribute('stroke-dasharray', REL_DASH_ARRAY);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('opacity', String(REL_OPACITY));
    path.setAttribute('marker-end', `url(#${arrowMarkerId})`);
    path.classList.add('mf-rel-edge');
    path.style.pointerEvents = 'none';  // 事件由 hitArea 处理
    path.setAttribute('data-relation-type', edge.relationType);
    path.setAttribute('data-source-id', edge.fromNodeId);
    path.setAttribute('data-target-id', edge.toNodeId);

    svg.appendChild(path);

    // ── 关系类型标签 — 显示在连线中点 ──
    const labelX = (x1 + x2) / 2;
    const labelY = (y1 + y2) / 2 - 8;
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(labelX));
    label.setAttribute('y', String(labelY));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', color);
    label.setAttribute('font-size', edge.invalidated ? '9' : '10');
    label.setAttribute('font-family', 'system-ui, sans-serif');
    label.setAttribute('opacity', edge.invalidated ? '0.4' : '0.7');
    label.setAttribute('font-weight', '600');
    label.textContent = edge.relationType;
    label.classList.add('mf-rel-edge');
    label.style.pointerEvents = 'none';
    svg.appendChild(label);
  }
}
