/**
 * RelationGraphView — Force-directed 关系图谱视图
 *
 * 基于 vasturiano/force-graph (HTML5 Canvas + d3-force) 实现，
 * 将 AnnotationStore 中的标注关系可视化为力导向图。
 *
 * 功能：
 * - 节点 = 标注（按类型着色，大小反映关联数）
 * - 边 = 关系（方向箭头 + 类型着色 + 标签）
 * - 交互：hover 详情 / click 定位 / drag 固定 / zoom/pan
 * - 过滤：按关系类型 / 文件路径 / 标注类型
 * - 主题：自动适配 Obsidian 暗/亮主题
 * - 响应式：ResizeObserver 跟随窗口缩放
 */

import { ItemView, WorkspaceLeaf, TFile, Modal, App, Menu } from 'obsidian';
import ForceGraph from 'force-graph';
import type { NodeObject, LinkObject } from 'force-graph';
import { annotationStore } from '../../db/annotation-store';
import { updateAnnotation, addRelation } from '../../db/annotation-repo';
import { updateMarkTag, updateBlockAnchor, updateSpanAnchor } from '../../core/annotation-parser';
import type MarkVaultPlugin from '../../main';
import { RelationSchema } from '../../types/annotation';
import type { Annotation, AnnotationRelation } from '../../types/annotation';
import { buildGraphData, type GraphNode, type GraphLink } from './graph-data-builder';
import type { GraphFilter } from './graph-types';
import { RelationPickerModal } from '../editor/relation-picker-modal';
export type { GraphFilter } from './graph-types';

export const MARKVAULT_GRAPH_VIEW_TYPE = 'markvault-relation-graph';

const DEFAULT_FILTER: GraphFilter = {
  relationTypes: [],
  filePaths: [],
  annotationKinds: [],
  showIsolated: false,
  showInvalidated: false,
  searchQuery: '',
  neighborDepth: 0,
  focalNodeId: null,
};

/** v5.11: 被动关系 chip 的灰色（语义化调色板伴生，与 PASSIVE_COLOR 同色系） */
const PASSIVE_CHIP_COLOR = '#9CA3AF';

/** v5.11: 语义分组 — 芯片按维度归类，组间分隔 */
const SEMANTIC_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Taxonomic',   types: ['generalizes', 'specializes', 'part-of'] },
  { label: 'Argumentative', types: ['proves', 'refutes', 'contrasts'] },
  { label: 'Expositive',  types: ['elaborates', 'exemplifies', 'illustrates'] },
  { label: 'Referential', types: ['references', 'applies'] },
  { label: 'Dynamic',     types: ['enables', 'causes', 'precedes'] },
  { label: 'Structural',  types: ['associates', 'supplements'] },
  { label: 'Passive',     types: ['isAppliedBy', 'isReferencedBy', 'isProvedBy', 'isRefutedBy', 'isElaboratedBy', 'isExemplifiedBy', 'isIllustratedBy', 'isCausedBy', 'isEnabledBy', 'follows', 'contains'] },
];

/** force-graph 实例类型 — ReturnType<typeof ForceGraph> 会返回一个函数类型 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FGInstance = any;

export class RelationGraphView extends ItemView {
  private plugin: MarkVaultPlugin | null = null;
  private fg: FGInstance | null = null;
  private filter: GraphFilter = { ...DEFAULT_FILTER };
  private container_: HTMLElement | null = null;
  private graphContainer: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private highlightedNodes: Set<string> = new Set();
  private highlightedLinks: Set<string> = new Set();

  // P2-1: ResizeObserver
  private resizeObserver: ResizeObserver | null = null;

  // P2-2: 邻接表（refresh 时重建，hover 时 O(1) 查询邻居）
  private adjacencyMap = new Map<string, { nodes: Set<string>; links: Set<string> }>();

  // P2-5: 主题缓存
  private themeValues = {
    isDark: true,
    highlightStroke: '#fff',
    normalStroke: '#555',
    labelBg: 'rgba(0, 0, 0, 0.6)',
    labelTextBright: '#fff',
    labelTextDim: '#aaa',
    iconText: '#fff',
  };

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  setPluginInstance(plugin: MarkVaultPlugin) {
    this.plugin = plugin;
  }

  getViewType(): string {
    return MARKVAULT_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Relation Graph';
  }

  getIcon(): string {
    return 'git-branch';
  }

  async onOpen() {
    this.container_ = this.containerEl.children[1] as HTMLElement;
    this.container_.empty();
    this.container_.style.padding = '0';

    this.detectTheme();
    this.renderLayout();
    this.initForceGraph();
    this.setupResizeObserver();
    this.refresh(true); // 首次加载 → zoomToFit
  }

  async onClose() {
    // P2-1: 清理 ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    // P3-1: 安全销毁 force-graph（封装 _destructor 为 try-catch）
    this.destroyForceGraph();
  }

  // ── 布局渲染 ──────────────────────────

  private renderLayout() {
    if (!this.container_) return;

    // 工具栏
    this.toolbarEl = this.container_.createDiv({ cls: 'markvault-graph-toolbar' });
    this.renderToolbar();

    // 图谱容器
    this.graphContainer = this.container_.createDiv({ cls: 'markvault-graph-canvas' });
    this.graphContainer.style.flex = '1';
    this.graphContainer.style.minHeight = '0';
  }

  private renderToolbar() {
    if (!this.toolbarEl) return;
    this.toolbarEl.empty();

    const schema = this.plugin?.getRelationSchema() ?? new RelationSchema([]);

    // ── 第一行：标题 + 搜索 + 操作按钮 ──
    const row1 = this.toolbarEl.createDiv({ cls: 'markvault-graph-filter-row' });

    row1.createSpan({ text: '🔗 Relation Graph', cls: 'markvault-graph-title' });

    // 搜索框
    const searchWrap = row1.createDiv({ cls: 'markvault-graph-search-wrap' });
    const searchInput = searchWrap.createEl('input', {
      type: 'text',
      cls: 'markvault-graph-search-input',
      attr: { placeholder: 'Search label/alias...', value: this.filter.searchQuery },
    });
    // 搜索框 — 300ms debounce 防止每次按键都遍历所有节点
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        this.filter.searchQuery = searchInput.value.trim();
        this.applySearchHighlight();
        searchDebounceTimer = null;
      }, 300);
    });

    // 操作按钮
    const refreshBtn = row1.createEl('button', { text: '↻', cls: 'mod-cta markvault-graph-btn-icon', attr: { title: 'Refresh' } });
    refreshBtn.addEventListener('click', () => this.refresh(true));

    const fitBtn = row1.createEl('button', { text: '⊞', cls: 'mod-cta markvault-graph-btn-icon', attr: { title: 'Fit to view' } });
    fitBtn.addEventListener('click', () => {
      this.fg?.zoomToFit(400, 50);
    });

    const resetBtn = row1.createEl('button', { text: '⟲', cls: 'mod-cta markvault-graph-btn-icon', attr: { title: 'Reset all filters' } });
    resetBtn.addEventListener('click', () => {
      this.filter = { ...DEFAULT_FILTER };
      this.refresh(true); // 重置后 → zoomToFit
      this.renderToolbar();
    });

    // ── 第二行：Relation tag chips（独立一行，支持换行） ──
    const row2 = this.toolbarEl.createDiv({ cls: 'markvault-graph-filter-row markvault-graph-row-chips' });
    const relTypes = schema.getAllTypes();
    if (relTypes.length > 0) {
      // v5.11: 语义分组渲染 — 每组有 header + chips，组间薄分隔线
      let isFirstGroup = true;
      for (const group of SEMANTIC_GROUPS) {
        const groupTypes = group.types.filter(rt => relTypes.includes(rt));
        if (groupTypes.length === 0) continue;

        // 组间分隔线（第一个组前面不加）
        if (!isFirstGroup) {
          row2.createSpan({ cls: 'markvault-graph-chip-divider' });
        }
        isFirstGroup = false;

        // 组标题 (compact)
        row2.createSpan({ text: group.label, cls: 'markvault-graph-chip-group-header' });

        // 组内芯片
        for (const rt of groupTypes) {
          const isActive = this.filter.relationTypes.length === 0 || this.filter.relationTypes.includes(rt);
          const cfg = schema.getConfig(rt);
          const isPassive = cfg ? !cfg.isActive : false;
          const chipCls = [
            'markvault-graph-chip',
            isActive ? 'markvault-graph-chip-active' : 'markvault-graph-chip-dim',
            isPassive ? 'markvault-graph-chip-passive' : '',
          ].filter(Boolean).join(' ');
          const chip = row2.createEl('span', {
            cls: chipCls,
            attr: { 'data-type': rt },
          });
          chip.createSpan({
            cls: 'markvault-graph-chip-dot',
            attr: { style: `background: ${isPassive ? PASSIVE_CHIP_COLOR : (cfg?.color || '#78716C')}` },
          });
          chip.createSpan({
            text: schema.getLabel(rt) || rt,
            cls: 'markvault-graph-chip-label',
          });
          chip.addEventListener('click', () => {
            this.toggleFilterArray('relationTypes', rt);
            this.refresh();
            this.renderToolbar();
          });
        }
      }
    }

    // ── 第三行：Kind tag chips（独立一行，干净清爽） ──
    const row3 = this.toolbarEl.createDiv({ cls: 'markvault-graph-filter-row markvault-graph-row-chips' });
    const kindOptions = ['inline', 'block', 'span', 'region'];
    row3.createSpan({ text: 'Kind:', cls: 'markvault-graph-filter-label' });
    for (const kind of kindOptions) {
      const isActive = this.filter.annotationKinds.length === 0 || this.filter.annotationKinds.includes(kind);
      const chip = row3.createEl('span', {
        cls: `markvault-graph-chip markvault-graph-chip-kind-${kind} ${isActive ? 'markvault-graph-chip-active' : 'markvault-graph-chip-dim'}`,
        text: kind,
      });
      chip.addEventListener('click', () => {
        this.toggleFilterArray('annotationKinds', kind);
        this.refresh();
        this.renderToolbar();
      });
    }

    // ── 第四行：显示开关 + 邻居深度 + 文件路径 + 统计 ──
    const row4 = this.toolbarEl.createDiv({ cls: 'markvault-graph-filter-row' });

    // 显示开关：孤立 / 无效
    const showIsolated = row4.createEl('label', { cls: 'markvault-graph-toggle' });
    const isolatedCb = showIsolated.createEl('input', { type: 'checkbox' });
    isolatedCb.checked = this.filter.showIsolated;
    showIsolated.createSpan({ text: ' Isolated' });
    isolatedCb.addEventListener('change', () => {
      this.filter.showIsolated = isolatedCb.checked;
      this.refresh();
    });

    const showInvalid = row4.createEl('label', { cls: 'markvault-graph-toggle' });
    const invalidCb = showInvalid.createEl('input', { type: 'checkbox' });
    invalidCb.checked = this.filter.showInvalidated;
    showInvalid.createSpan({ text: ' Invalid' });
    invalidCb.addEventListener('change', () => {
      this.filter.showInvalidated = invalidCb.checked;
      this.refresh();
    });

    row4.createSpan({ cls: 'markvault-graph-sep' });

    // 邻居深度滑块
    row4.createSpan({ text: 'Depth:', cls: 'markvault-graph-filter-label' });
    const depthSlider = row4.createEl('input', {
      type: 'range',
      cls: 'markvault-graph-slider',
      attr: { min: '0', max: '5', step: '1', value: String(this.filter.neighborDepth) },
    });
    const depthValue = row4.createSpan({ text: this.filter.neighborDepth === 0 ? '∞' : String(this.filter.neighborDepth), cls: 'markvault-graph-slider-value' });
    depthSlider.addEventListener('input', () => {
      const v = parseInt(depthSlider.value);
      this.filter.neighborDepth = v;
      depthValue.setText(v === 0 ? '∞' : String(v));
      // 如果有 focalNode 则重新筛选
      if (this.filter.focalNodeId) {
        this.refresh();
      }
    });
    depthSlider.addEventListener('change', () => {
      if (this.filter.focalNodeId && this.filter.neighborDepth > 0) {
        this.refresh();
      }
    });

    // 分隔
    row4.createSpan({ cls: 'markvault-graph-sep' });

    // 文件路径下拉（只显示有标注的文件）
    const allAnns = annotationStore.getAllAnnotations();
    const filePaths = [...new Set(allAnns.map(a => a.filePath).filter(Boolean))].sort();
    if (filePaths.length > 1) {
      row4.createSpan({ text: 'File:', cls: 'markvault-graph-filter-label' });
      const fileSelect = row4.createEl('select', { cls: 'markvault-graph-select' });
      fileSelect.createEl('option', { text: 'All files', value: '' });
      for (const fp of filePaths) {
        const shortName = fp.split('/').pop() || fp;
        fileSelect.createEl('option', { text: shortName, value: fp, attr: { title: fp } });
      }
      fileSelect.value = this.filter.filePaths.length > 0 ? this.filter.filePaths[0] : '';
      fileSelect.addEventListener('change', () => {
        this.filter.filePaths = fileSelect.value ? [fileSelect.value] : [];
        this.refresh();
      });
    }

    // 统计信息（右对齐）
    const statsEl = row4.createDiv({ cls: 'markvault-graph-stats' });
    const withRels = allAnns.filter(a => a.relations && a.relations.length > 0);
    statsEl.setText(`${withRels.length} nodes / ${allAnns.length} total`);
  }

  /** 切换 filter 数组字段中的某项（toggle） */
  private toggleFilterArray(field: 'relationTypes' | 'annotationKinds' | 'filePaths', value: string) {
    const arr = this.filter[field];
    const idx = arr.indexOf(value);
    if (idx >= 0) {
      arr.splice(idx, 1);
    } else {
      arr.push(value);
    }
  }

  /** v5.7: 搜索高亮 — 模糊匹配标签/别名，匹配节点高亮，非匹配变暗 */
  private applySearchHighlight() {
    if (!this.fg) return;

    const query = this.filter.searchQuery.toLowerCase();

    if (!query) {
      // 清空搜索高亮，恢复全量数据
      this.clearHighlight();
      return;
    }

    // 在当前图谱数据中查找匹配节点
    const graphData = this.fg.graphData();
    const matchedNodeIds = new Set<string>();

    for (const node of graphData.nodes) {
      const n = node as unknown as GraphNode;
      if (n.label && n.label.toLowerCase().includes(query)) {
        matchedNodeIds.add(n.id as string);
      }
    }

    // 设置高亮（匹配的节点 + 其邻居）
    this.highlightedNodes.clear();
    this.highlightedLinks.clear();

    for (const nId of matchedNodeIds) {
      this.highlightedNodes.add(nId);
      const neighbors = this.adjacencyMap.get(nId);
      if (neighbors) {
        for (const neighborId of neighbors.nodes) {
          this.highlightedNodes.add(neighborId);
        }
        for (const linkId of neighbors.links) {
          this.highlightedLinks.add(linkId);
        }
      }
    }
  }

  // ── P2-1: ResizeObserver ──────────────────────────

  private setupResizeObserver() {
    if (!this.graphContainer) return;

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (this.fg && width > 0 && height > 0) {
          this.fg.width(width);
          this.fg.height(height);
        }
      }
    });
    this.resizeObserver.observe(this.graphContainer);
  }

  // ── P2-5: 主题检测 ──────────────────────────

  private detectTheme() {
    // Obsidian 在 body 上添加 .theme-dark 或 .theme-light
    const body = document.body;
    const isDark = body.classList.contains('theme-dark') ||
      (!body.classList.contains('theme-light') && window.matchMedia('(prefers-color-scheme: dark)').matches);

    this.themeValues.isDark = isDark;

    if (isDark) {
      this.themeValues.highlightStroke = '#fff';
      this.themeValues.normalStroke = '#555';
      this.themeValues.labelBg = 'rgba(0, 0, 0, 0.6)';
      this.themeValues.labelTextBright = '#fff';
      this.themeValues.labelTextDim = '#aaa';
      this.themeValues.iconText = '#fff';
    } else {
      this.themeValues.highlightStroke = '#1e293b';
      this.themeValues.normalStroke = '#94a3b8';
      this.themeValues.labelBg = 'rgba(255, 255, 255, 0.85)';
      this.themeValues.labelTextBright = '#0f172a';
      this.themeValues.labelTextDim = '#64748b';
      this.themeValues.iconText = '#fff';
    }
  }

  // ── P3-1: 安全销毁 ──────────────────────────

  private destroyForceGraph() {
    if (!this.fg) return;
    try {
      // force-graph 的公开销毁方法可能名为 _destructor（私有 API）
      // 用 try-catch 包裹，防止库升级后 API 变更导致崩溃
      if (typeof this.fg._destructor === 'function') {
        this.fg._destructor();
      }
    } catch (err) {
      console.warn('MarkVault: force-graph destroy error (non-critical):', err);
    }
    this.fg = null;
  }

  // ── Force Graph 初始化 ──────────────────────────

  private initForceGraph() {
    if (!this.graphContainer) return;

    const width = this.graphContainer.clientWidth || 800;
    const height = this.graphContainer.clientHeight || 600;

    // ForceGraph is a factory function: ForceGraph()(element)
    // Type assertion needed because d.ts declares it as a class
    const createGraph = ForceGraph as unknown as () => (el: HTMLElement) => FGInstance;
    this.fg = createGraph()(this.graphContainer)
      .width(width)
      .height(height)
      .backgroundColor('transparent')
      .nodeId('id')
      .nodeLabel((node: NodeObject) => {
        const n = node as unknown as GraphNode;
        // v5.3: hover 提示显示别名或文本摘要 + 文件信息
        const displayName = n.label || '(no alias)';
        const fileInfo = n.filePath ? n.filePath.split('/').pop() : '';
        return `${displayName}\n[${n.annotationKind}] ${fileInfo}\n${n.degree} connections`;
      })
      .nodeVal((node: NodeObject) => {
        const n = node as unknown as GraphNode;
        return n.val;
      })
      .nodeColor((node: NodeObject) => {
        const n = node as unknown as GraphNode;
        if (this.highlightedNodes.size > 0 && !this.highlightedNodes.has(n.id as string)) {
          return this.dimColor(n.color);
        }
        return n.color;
      })
      .nodeCanvasObject((node: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
        this.drawNode(node as unknown as GraphNode, ctx, globalScale);
      })
      .nodeCanvasObjectMode(() => 'replace')
      .linkSource('source')
      .linkTarget('target')
      .linkLabel((link: LinkObject) => {
        const l = link as unknown as GraphLink;
        return l.relationLabel;
      })
      .linkColor((link: LinkObject) => {
        const l = link as unknown as GraphLink;
        if (this.highlightedLinks.size > 0 && !this.highlightedLinks.has(l.relationId)) {
          return this.dimColor(l.color, 0.15);
        }
        return l.color;
      })
      .linkWidth(1.5)
      .linkLineDash((link: LinkObject) => {
        const l = link as unknown as GraphLink;
        return l.isInvalidated ? [5, 5] : null;
      })
      .linkDirectionalArrowLength(6)
      .linkDirectionalArrowRelPos(0.9)
      .linkDirectionalArrowColor((link: LinkObject) => {
        const l = link as unknown as GraphLink;
        return l.color;
      })
      .linkCurvature((link: LinkObject) => {
        const l = link as unknown as GraphLink;
        return l.curvature || 0;
      })
      .linkVisibility(true)
      .onNodeClick((node: NodeObject) => {
        this.handleNodeClick(node as unknown as GraphNode);
      })
      .onNodeRightClick((node: NodeObject, event: MouseEvent) => {
        this.handleNodeRightClick(node as unknown as GraphNode, event);
      })
      .onNodeHover((node: NodeObject | null) => {
        this.handleNodeHover(node as unknown as GraphNode | null);
      })
      .onLinkClick((link: LinkObject) => {
        this.handleLinkClick(link as unknown as GraphLink);
      })
      .onBackgroundClick(() => {
        this.clearHighlight();
      })
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .cooldownTime(8000)
      .warmupTicks(30)
      .autoPauseRedraw(true);

    // v5.4: 设置初始力导向参数（会在 refresh() 中根据标签长度动态覆盖）
    this.fg.d3Force('charge')?.strength(-120);
    this.fg.d3Force('center')?.strength(0.05);
  }

  // ── 自定义节点渲染 ──────────────────────────

  private drawNode(node: GraphNode & { x?: number; y?: number }, ctx: CanvasRenderingContext2D, globalScale: number) {
    const isHighlighted = this.highlightedNodes.size === 0 || this.highlightedNodes.has(node.id as string);
    const baseRadius = Math.max(4, Math.sqrt(node.val) * 3);
    const radius = baseRadius;
    const nx = node.x ?? 0;
    const ny = node.y ?? 0;

    // 外圈光晕（高亮时）
    if (isHighlighted && this.highlightedNodes.size > 0) {
      ctx.beginPath();
      ctx.arc(nx, ny, radius + 4, 0, 2 * Math.PI);
      ctx.fillStyle = node.color + '30';
      ctx.fill();
    }

    // 节点圆
    ctx.beginPath();
    ctx.arc(nx, ny, radius, 0, 2 * Math.PI);
    ctx.fillStyle = isHighlighted ? node.color : this.dimColor(node.color);
    ctx.fill();

    // 边框（P2-5: 使用主题适配颜色）
    ctx.strokeStyle = isHighlighted ? this.themeValues.highlightStroke : this.themeValues.normalStroke;
    ctx.lineWidth = isHighlighted ? 1.5 : 0.5;
    ctx.stroke();

    // 标注类型图标（小标记）— 始终显示
    const kindIcon = this.getKindIcon(node.annotationKind);
    if (kindIcon && globalScale > 0.5) {
      ctx.font = `${Math.max(8, radius)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.themeValues.iconText;
      ctx.fillText(kindIcon, nx, ny);
    }

    // v5.5: 三档缩放自适应标签渲染策略（参考 force-graph 社区最佳实践）
    // 策略：缩小时隐藏 → 中等时截断 → 放大时完整显示
    // - globalScale < 0.6: 不显示标签（鸟瞰模式，只看节点分布）
    // - 0.6 ~ 1.5: 截断到 12 字符（中等缩放，避免重叠）
    // - > 1.5: 截断到 24 字符（近距离查看，展示更多信息）
    if (node.label && globalScale > 0.6) {
      const maxChars = globalScale > 1.5 ? 24 : 12;
      const displayLabel = node.label.length > maxChars
        ? node.label.slice(0, maxChars - 1) + '…'
        : node.label;

      // 字体大小随缩放自适应：放大多字小、缩小少字大，但限制在 6~12px
      // 核心公式：fontSize = clamp(6, 10 / sqrt(globalScale), 12)
      // 使用 sqrt 而非线性除法，让缩放曲线更平滑（参考 d3-zoom 的 scale 启发）
      const adaptiveFontSize = Math.min(12, Math.max(6, 10 / Math.sqrt(globalScale)));
      ctx.font = `${adaptiveFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // 标签背景（P2-5: 主题适配）— 圆角矩形风格
      const textWidth = ctx.measureText(displayLabel).width;
      const bgX = nx - textWidth / 2 - 5;
      const bgY = ny + radius + 4;
      const bgW = textWidth + 10;
      const bgH = adaptiveFontSize + 6;
      const bgR = 3; // 圆角半径

      ctx.fillStyle = this.themeValues.labelBg;
      ctx.beginPath();
      ctx.moveTo(bgX + bgR, bgY);
      ctx.lineTo(bgX + bgW - bgR, bgY);
      ctx.quadraticCurveTo(bgX + bgW, bgY, bgX + bgW, bgY + bgR);
      ctx.lineTo(bgX + bgW, bgY + bgH - bgR);
      ctx.quadraticCurveTo(bgX + bgW, bgY + bgH, bgX + bgW - bgR, bgY + bgH);
      ctx.lineTo(bgX + bgR, bgY + bgH);
      ctx.quadraticCurveTo(bgX, bgY + bgH, bgX, bgY + bgH - bgR);
      ctx.lineTo(bgX, bgY + bgR);
      ctx.quadraticCurveTo(bgX, bgY, bgX + bgR, bgY);
      ctx.closePath();
      ctx.fill();

      // 标签文字
      ctx.fillStyle = isHighlighted ? this.themeValues.labelTextBright : this.themeValues.labelTextDim;
      ctx.fillText(displayLabel, nx, ny + radius + 6);
    }
  }

  private getKindIcon(kind: string): string {
    switch (kind) {
      case 'inline': return '✦';
      case 'block': return '■';
      case 'span': return '▬';
      case 'region': return '▭';
      default: return '●';
    }
  }

  // ── 交互处理 ──────────────────────────

  /** 左键点击节点 → 弹出 NodeDetailModal + 设为 focalNode */
  private handleNodeClick(node: GraphNode) {
    // v5.7: 设置 focalNodeId（邻居深度筛选的起点）
    this.filter.focalNodeId = node.uuid;

    // F6: 使用 getAnnotationByUuid 替代 O(n) 的 find
    const annotation = annotationStore.getAnnotationByUuid(node.uuid);
    if (!annotation) return;
    const modal = new NodeDetailModal(
      this.app,
      this.plugin,
      annotation,
      node,
      () => this.refresh(),
    );
    modal.open();
  }

  /** 右键点击节点 → 弹出上下文菜单（跳转文本 / 发展关联） */
  private handleNodeRightClick(node: GraphNode, event: MouseEvent) {
    const menu = new Menu();

    // ① 跳转到文本
    menu.addItem((item) => {
      item
        .setTitle('📍 Jump to text')
        .setIcon('arrow-right')
        .onClick(() => {
          this.jumpToAnnotation(node);
        });
    });

    // ② 发展关联（打开 RelationPickerModal）
    menu.addItem((item) => {
      item
        .setTitle('🔗 Develop relation')
        .setIcon('link')
        .onClick(() => {
          this.openRelationPicker(node);
        });
    });

    menu.showAtMouseEvent(event);
  }

  /** 跳转到标注所在文件位置 */
  private jumpToAnnotation(node: GraphNode) {
    // F6: 从 annotationStore 获取最新的 filePath（比 node.filePath 更可靠）
    const annotation = annotationStore.getAnnotationByUuid(node.uuid);
    const filePath = annotation?.filePath || node.filePath;
    if (!filePath) return;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      leaf.openFile(file);
    }
  }

  /** 打开关联选择器，创建从当前节点出发的新关联 */
  private openRelationPicker(node: GraphNode) {
    const schema = this.plugin?.getRelationSchema() ?? new RelationSchema([]);
    const engine = this.plugin?.getSearchEngine();
    if (!engine) return;

    // F4: 从 annotation 获取 filePath（更可靠），而非 node
    const annotation = annotationStore.getAnnotationByUuid(node.uuid);
    const sourceFilePath = annotation?.filePath || node.filePath;

    const modal = new RelationPickerModal(
      this.app,
      engine,
      schema,
      node.uuid,
      sourceFilePath,
      async (result) => {
        // 创建关联
        try {
          await addRelation(node.uuid, {
            targetUuid: result.targetUuid,
            type: result.type,
            note: result.note,
            createdAt: Date.now(),
            source: 'manual',
          });
          this.refresh();
        } catch (err) {
          console.error('MarkVault: failed to add relation from graph', err);
        }
      },
    );
    modal.open();
  }

  private handleNodeHover(node: GraphNode | null) {
    if (!node) {
      this.clearHighlight();
      return;
    }

    // P2-2: 使用预建邻接表 O(1) 查询邻居，替代 O(n) 遍历全量 links
    this.highlightedNodes.clear();
    this.highlightedLinks.clear();
    this.highlightedNodes.add(node.id as string);

    const neighbors = this.adjacencyMap.get(node.id as string);
    if (neighbors) {
      for (const nId of neighbors.nodes) {
        this.highlightedNodes.add(nId);
      }
      for (const lId of neighbors.links) {
        this.highlightedLinks.add(lId);
      }
    }
  }

  private handleLinkClick(link: GraphLink) {
    // 高亮相连的两个节点
    this.highlightedNodes.clear();
    this.highlightedLinks.clear();
    this.highlightedLinks.add(link.relationId);

    const sourceId = typeof link.source === 'object' ? (link.source as unknown as GraphNode).id as string : link.source as string;
    const targetId = typeof link.target === 'object' ? (link.target as unknown as GraphNode).id as string : link.target as string;
    this.highlightedNodes.add(sourceId);
    this.highlightedNodes.add(targetId);
  }

  private clearHighlight() {
    this.highlightedNodes.clear();
    this.highlightedLinks.clear();
  }

  // ── 数据刷新 ──────────────────────────

  /**
   * @param shouldZoomToFit 是否在刷新后重置视口到全局适配
   *   - true: 首次加载、点击 Refresh/Reset 按钮
   *   - false (默认): 切换 filter chip、数据变化等，保持用户当前视口
   */
  refresh(shouldZoomToFit = false) {
    if (!this.fg) return;

    // P2-5: 每次刷新时检测主题变化
    this.detectTheme();

    const schema = this.plugin?.getRelationSchema() ?? new RelationSchema([]);
    const graphData = buildGraphData(
      annotationStore.getAllAnnotations(),
      schema,
      this.filter,
    );

    this.fg.graphData(graphData);

    // v5.5: 基于 per-link distance 的力导向配置
    this.applyAdaptiveForces();

    // P2-2: 重建邻接表
    this.rebuildAdjacencyMap(graphData.links);

    // v5.7: 如果有搜索关键词，重新应用搜索高亮
    if (this.filter.searchQuery) {
      this.applySearchHighlight();
    } else {
      this.clearHighlight();
    }

    // 更新统计信息
    if (this.toolbarEl) {
      const statsEl = this.toolbarEl.querySelector('.markvault-graph-stats');
      if (statsEl) {
        statsEl.setText(
          `${graphData.nodes.length} nodes / ${graphData.links.length} edges`
        );
      }
    }

    // v5.6: 仅在首次加载或用户主动请求时重置视口
    // 🔧 BUG-10 修复：filter 切换不再覆盖用户的缩放/平移
    if (shouldZoomToFit && graphData.nodes.length > 0) {
      setTimeout(() => {
        this.fg?.zoomToFit(400, 50);
      }, 500);
    }
  }

  /**
   * v5.5: 力导向参数自适应配置（参考 d3-force / force-graph 社区最佳实践）
   *
   * 核心改进：
   * 1. Per-link distance：forceLink.distance() 接受函数，每条边根据两端标签长度独立计算距离
   * 2. Per-node charge：forceManyBody.strength() 接受函数，高连接度节点斥力更大
   * 3. 碰撞力：forceCollide 防止节点重叠（特别是有标签的节点）
   * 4. 中心力保持图谱居中
   */
  private applyAdaptiveForces() {
    if (!this.fg) return;

    const fg = this.fg;

    // 1. 连接力：per-link distance — 关键改进！
    // forceLink.distance() 可以接受函数，对每条边独立计算距离
    // 这样"短标签↔短标签"的边距离短，"长标签↔长标签"的边距离长
    fg.d3Force('link')?.distance((link: { _distance?: number }) => {
      // 使用 buildGraphData 预计算的 _distance（基于两端标签长度）
      return link._distance ?? 80;
    });

    // 2. 电荷力：per-node strength — 高度节点斥力更大，推开邻居防止拥挤
    fg.d3Force('charge')?.strength((node: GraphNode) => {
      const degree = node.degree || 0;
      // 基础 -80，每多一个关联减 -15（最大 -250）
      // degree=0 → -80, degree=3 → -125, degree=10 → -230
      return Math.max(-250, -80 - degree * 15);
    });

    // 3. 碰撞检测：防止节点（含标签区域）重叠
    // force-graph 内部使用 d3-force-3d，其中包含 forceCollide
    // 通过 import 获取（d3-force-3d 是 force-graph 的依赖，已安装）
    if (!fg.d3Force('collide')) {
      try {
        // d3-force-3d 是 force-graph 的内部依赖，包含 forceCollide
        const { forceCollide } = require('d3-force-3d');
        fg.d3Force('collide', forceCollide()
          .radius((node: GraphNode) => {
            const baseR = Math.max(4, Math.sqrt(node.val) * 3);
            // 有标签的节点需要更大的碰撞半径（每字符约 3.5px 半宽）
            const labelR = node.label ? Math.min(node.labelLength * 3.5, 80) : 0;
            return baseR + labelR + 8; // 额外 8px 间距
          })
          .strength(0.6)
        );
      } catch {
        // d3-force-3d 不可用时跳过碰撞检测（功能降级，不影响基本布局）
        console.warn('MarkVault: forceCollide not available, collision detection disabled');
      }
    }

    // 4. 中心力：保持图谱居中
    fg.d3Force('center')?.strength(0.05);
  }

  // ── P2-2: 邻接表构建 ──────────────────────────

  private rebuildAdjacencyMap(links: GraphLink[]) {
    this.adjacencyMap.clear();

    for (const link of links) {
      // 🔧 BUG-9 修复：force-graph 运行时将 source/target 从 string 替换为 GraphNode 对象引用
      // 直接 `as string` 会得到 "[object Object]"，导致邻接表完全失效
      const sourceId = typeof link.source === 'string' ? link.source : (link.source as any).id;
      const targetId = typeof link.target === 'string' ? link.target : (link.target as any).id;

      // source → { nodes, links }
      let sourceEntry = this.adjacencyMap.get(sourceId);
      if (!sourceEntry) {
        sourceEntry = { nodes: new Set(), links: new Set() };
        this.adjacencyMap.set(sourceId, sourceEntry);
      }
      sourceEntry.nodes.add(targetId);
      sourceEntry.links.add(link.relationId);

      // target → { nodes, links }
      let targetEntry = this.adjacencyMap.get(targetId);
      if (!targetEntry) {
        targetEntry = { nodes: new Set(), links: new Set() };
        this.adjacencyMap.set(targetId, targetEntry);
      }
      targetEntry.nodes.add(sourceId);
      targetEntry.links.add(link.relationId);
    }
  }

  // ── 工具方法 ──────────────────────────

  private dimColor(hex: string, alpha = 0.2): string {
    // 将 hex 颜色变暗/透明化
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

// ═══════════════════════════════════════════════════════════════
// NodeDetailModal — 节点详情弹窗（左键点击触发）
// ═══════════════════════════════════════════════════════════════

class NodeDetailModal extends Modal {
  private annotation: Annotation;
  private node: GraphNode;
  private plugin: MarkVaultPlugin | null;
  private onRefresh: () => void;

  constructor(
    app: App,
    plugin: MarkVaultPlugin | null,
    annotation: Annotation,
    node: GraphNode,
    onRefresh: () => void,
  ) {
    super(app);
    this.annotation = annotation;
    this.node = node;
    this.plugin = plugin;
    this.onRefresh = onRefresh;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('markvault-node-modal');

    // ── 头部：别名 + 类型徽章 + 文件 ──
    const headerEl = contentEl.createDiv({ cls: 'markvault-node-modal-header' });

    // 别名行（可内联编辑）
    const aliasRow = headerEl.createDiv({ cls: 'markvault-node-modal-alias-row' });
    const aliasInput = aliasRow.createEl('input', {
      type: 'text',
      value: this.annotation.alias || '',
      cls: 'markvault-node-modal-alias-input',
      attr: { placeholder: 'Set graph alias...', maxlength: '50' },
    });
    const saveAliasBtn = aliasRow.createEl('button', {
      text: '💾',
      cls: 'markvault-node-modal-alias-save',
      attr: { title: 'Save alias' },
    });
    saveAliasBtn.addEventListener('click', async () => {
      // F7: 先 trim + replace，再 slice — 避免先截断再过滤导致长度不一致
      const raw = aliasInput.value.trim().replace(/[<>]/g, '').slice(0, 50);
      // 🔧 F5 审计修复：DB 层用 undefined 表示"删除 alias"
      // MD 层用空字符串 "" 表示"删除 data-alias/锚点 alias 段"
      const aliasForDB = raw || undefined;     // DB: undefined → 删除字段
      const aliasForMD = raw || '';            // MD: "" → 触发删除属性/写 _ 占位
      try {
        await updateAnnotation(this.annotation.uuid, { alias: aliasForDB });
        this.annotation.alias = aliasForDB;
        // F1: 同步 input 显示值（保存后用户看到确认）
        aliasInput.value = aliasForDB || '';
        // F4: 同步更新 Markdown 文件中的 alias（inline→data-alias, block/span→锚点格式）
        await this.syncAliasToMarkdown(aliasForMD);
        // F2: 按钮临时反馈
        const originalText = saveAliasBtn.textContent;
        saveAliasBtn.textContent = '✅';
        saveAliasBtn.style.opacity = '0.7';
        setTimeout(() => {
          saveAliasBtn.textContent = originalText;
          saveAliasBtn.style.opacity = '';
        }, 1200);
        this.onRefresh();
      } catch (err) {
        console.error('MarkVault: failed to save alias', err);
        // F2: 失败反馈
        saveAliasBtn.textContent = '❌';
        setTimeout(() => { saveAliasBtn.textContent = '💾'; }, 1200);
      }
    });
    // Enter 键保存别名
    aliasInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAliasBtn.click();
      }
    });

    // 元信息行
    const metaRow = headerEl.createDiv({ cls: 'markvault-node-modal-meta' });
    metaRow.createSpan({
      text: this.node.annotationKind,
      cls: `markvault-node-modal-kind markvault-kind-${this.node.annotationKind}`,
    });
    // F6: 使用 annotation.filePath（更可靠）
    const displayFilePath = this.annotation.filePath;
    if (displayFilePath) {
      const fileName = displayFilePath.split('/').pop() || displayFilePath;
      metaRow.createSpan({ text: `📄 ${fileName}`, cls: 'markvault-node-modal-file' });
    }
    metaRow.createSpan({ text: `🔗 ${this.node.degree} connections`, cls: 'markvault-node-modal-degree' });

    // ── 标注原文预览 ──
    if (this.annotation.text) {
      const previewEl = contentEl.createDiv({ cls: 'markvault-node-modal-preview' });
      previewEl.createEl('strong', { text: '📝 Text', cls: 'markvault-node-modal-section-title' });
      const textEl = previewEl.createDiv({ cls: 'markvault-node-modal-text' });
      const displayText = this.annotation.text.length > 300
        ? this.annotation.text.slice(0, 300) + '...'
        : this.annotation.text;
      textEl.textContent = displayText.replace(/\n/g, ' ');
    }

    // ── 批注内容 ──
    if (this.annotation.note) {
      const noteEl = contentEl.createDiv({ cls: 'markvault-node-modal-note' });
      noteEl.createEl('strong', { text: '💬 Note', cls: 'markvault-node-modal-section-title' });
      const noteText = noteEl.createDiv({ cls: 'markvault-node-modal-note-text' });
      const displayNote = this.annotation.note.length > 500
        ? this.annotation.note.slice(0, 500) + '...'
        : this.annotation.note;
      noteText.textContent = displayNote;
    }

    // ── Relations 列表 ──
    const rels = this.buildRelationList();
    if (rels.outgoing.length > 0 || rels.incoming.length > 0) {
      const relSection = contentEl.createDiv({ cls: 'markvault-node-modal-relations' });
      relSection.createEl('strong', { text: `🔗 Relations (${rels.outgoing.length + rels.incoming.length})`, cls: 'markvault-node-modal-section-title' });

      // 出边
      for (const rel of rels.outgoing) {
        this.renderRelationRow(relSection, rel, 'outgoing');
      }
      // 入边
      for (const { sourceUuid, relation } of rels.incoming) {
        this.renderRelationRow(relSection, { ...relation, _sourceUuid: sourceUuid }, 'incoming');
      }
    } else {
      const noRelEl = contentEl.createDiv({ cls: 'markvault-node-modal-no-rel' });
      noRelEl.textContent = 'No relations yet. Right-click the node → "Develop relation" to create one.';
    }

    // ── 操作按钮区 ──
    const actionRow = contentEl.createDiv({ cls: 'markvault-node-modal-actions' });

    const openBtn = actionRow.createEl('button', { text: '📂 Open File', cls: 'mod-cta' });
    openBtn.addEventListener('click', () => {
      // F6: 使用 annotation.filePath（Store 中更可靠），而非 node.filePath
      const filePath = this.annotation.filePath;
      if (filePath) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      }
    });

    const addRelBtn = actionRow.createEl('button', { text: '🔗 Add Relation' });
    addRelBtn.addEventListener('click', () => {
      const schema = this.plugin?.getRelationSchema() ?? new RelationSchema([]);
      const engine = this.plugin?.getSearchEngine();
      if (!engine) return;

      const pickerModal = new RelationPickerModal(
        this.app,
        engine,
        schema,
        this.annotation.uuid,
        this.annotation.filePath,
        async (result) => {
          try {
            await addRelation(this.annotation.uuid, {
              targetUuid: result.targetUuid,
              type: result.type,
              note: result.note,
              createdAt: Date.now(),
              source: 'manual',
            });
            this.onRefresh();
          } catch (err) {
            console.error('MarkVault: failed to add relation', err);
          }
        },
      );
      pickerModal.open();
    });

    const closeBtn = actionRow.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }

  // ─── Private helpers ──────────────────────────

  /**
   * F4 审计修复：alias 保存后同步写入 Markdown 文件
   * inline → data-alias 属性, block/span → 锚点格式, region/native → 仅 DB
   */
  private async syncAliasToMarkdown(aliasValue: string | undefined): Promise<void> {
    const ann = this.annotation;
    const file = this.app.vault.getAbstractFileByPath(ann.filePath);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.app.vault.read(file);
      let newContent = content;

      if (ann.kind === 'span') {
        newContent = updateSpanAnchor(content, ann.uuid, { alias: aliasValue });
      } else if (ann.kind === 'block') {
        newContent = updateBlockAnchor(content, ann.uuid, { alias: aliasValue });
      } else if (!ann.kind || ann.kind === 'inline') {
        // inline 标注：native 格式不写 data-alias（锚点只存 uuid/type/color），仅 mark 格式写
        if (ann.format !== 'native') {
          newContent = updateMarkTag(content, ann.uuid, { alias: aliasValue });
        }
      }
      // region 和 native 标注：alias 仅存 DB，不写 Markdown

      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
        console.log(`MarkVault: synced alias to markdown for ${ann.uuid}`);
      }
    } catch (err) {
      // Markdown 同步失败不影响 DB 已保存的 alias（下次 sync 时 DB-first 策略会保留）
      console.warn(`MarkVault: failed to sync alias to markdown for ${ann.uuid}`, err);
    }
  }

  private buildRelationList() {
    return annotationStore.getRelations(this.annotation.uuid, { includeInvalidated: false });
  }

  private renderRelationRow(
    container: HTMLElement,
    rel: AnnotationRelation & { _sourceUuid?: string },
    direction: 'outgoing' | 'incoming',
  ) {
    const row = container.createDiv({ cls: `markvault-node-modal-rel-row markvault-rel-${direction}` });

    // 方向图标
    const icon = direction === 'outgoing' ? '→' : '←';
    row.createSpan({ text: icon, cls: 'markvault-node-modal-rel-icon' });

    // 关系类型标签
    const schema = this.plugin?.getRelationSchema();
    const label = schema?.getLabel(rel.type) || rel.type;
    row.createSpan({ text: label, cls: 'markvault-node-modal-rel-type' });

    // 目标/源标注文本
    const targetUuid = direction === 'outgoing' ? rel.targetUuid : rel._sourceUuid!;
    const targetAnn = annotationStore.getAnnotationByUuid(targetUuid);
    const displayText = targetAnn
      ? (targetAnn.alias || (targetAnn.text.length > 40 ? targetAnn.text.slice(0, 37) + '...' : targetAnn.text))
      : '(unknown)';
    const textEl = row.createSpan({ cls: 'markvault-node-modal-rel-target' });
    textEl.textContent = displayText.replace(/\n/g, ' ');

    // 点击跳转目标节点
    row.addEventListener('click', () => {
      if (targetAnn) {
        const targetNode: GraphNode = {
          id: targetAnn.uuid,
          label: targetAnn.alias || '',
          labelLength: (targetAnn.alias || '').length,
          color: targetAnn.color || '#6b7280',
          val: 1,
          annotationKind: targetAnn.kind || 'inline',
          filePath: targetAnn.filePath,
          uuid: targetAnn.uuid,
          degree: 0,
        };
        // F3: 跳转前刷新图谱（确保边数据最新）
        this.onRefresh();
        this.close();
        const modal = new NodeDetailModal(
          this.app,
          this.plugin,
          targetAnn,
          targetNode,
          this.onRefresh,
        );
        modal.open();
      }
    });
  }
}
