/**
 * MindFlowView — 思维导图主视图
 *
 * Obsidian ItemView 子类，注册为 `mindflow:view`。
 *
 * 功能（Phase 1.5 增强版，参考 markmap + mind-elixir）：
 *   - 从当前 .md 文件加载导图（MD-Seed + Free 节点）
 *   - 右侧树形布局 + SVG 贝塞尔连线
 *   - Pan/Zoom（拖拽平移 + 滚轮缩放 + 平滑过渡）
 *   - fitView() 自动适配所有节点（参考 markmap fit()）
 *   - initialExpandLevel 默认折叠深层节点（参考 markmap initialExpandLevel）
 *   - 节点选中态视觉反馈（参考 mind-elixir selectNode）
 *   - 键盘快捷键（Tab/Enter/F2/Delete/F1/Ctrl±/Ctrl+Z）— IME 安全
 *   - 事件总线解耦操作（参考 mind-elixir bus）
 *   - Undo/Redo 撤销栈（参考 mind-elixir undo/redo）
 *   - 兄弟节点插入 + 节点删除（参考 mind-elixir insertSibling/removeNode）
 *   - 文件修改时自动重新同步
 *   - 保存 Free 节点到 frontmatter
 */

import { ItemView, WorkspaceLeaf, TFile, Notice, finishRenderMath, loadMathJax, Menu, Component } from 'obsidian';
import { logger } from '../../utils/logger';
import { generateId } from '../../utils/id';
import {
  syncFromMarkdown,
  findNode,
  findParent,
  insertSibling,
  removeNode,
  moveNode,
} from '../data/seed-sync';
import { writeMindmapConfig } from '../data/frontmatter-sync';
import {
  layoutTree,
  relayoutWithMeasured,
} from '../layout/layout-engine';
import {
  subtreeNeedsRelayout,
  applyInitialExpandLevel,
  getVisibleNodes,
  getVisibleEdges,
  getLayoutBounds,
} from '../layout/tree-layout';
import {
  renderNodes,
  renderNodesContent,
  clearNodes,
  setSelectedNode,
  enterEditMode,
  exitEditMode,
  RenderGenerationCounter,
} from '../render/node-renderer';
import { RenderCache } from '../render/render-cache';
import { createSvgContainer, renderConnectors, resizeSvg, type RelationEdge } from '../render/svg-connector';
import { MindflowEventBus } from '../core/event-bus';
import { UndoRedoManager, applyCollapsedStates, collectCollapsedStates } from '../core/undo-redo';
import { KeyboardShortcuts, type ShortcutAction } from '../core/keyboard-shortcuts';
import type { MindNode, MindmapMeta, LayoutType, StructureType, ConnectionRecord, BoundaryRecord } from '../types/mind-node';
import { showOutline, hideOutline, scheduleOutlineRefresh, type OutlineContext } from './mindflow-outline';
import {
  NodeNoteModal,
  NodeDetailModal,
  StructurePickerModal,
} from './mindflow-modals';
import { toggleMinimap, showMinimap as showMinimapImpl, hideMinimap as hideMinimapImpl, scheduleMinimapUpdate, updateMinimap as updateMinimapImpl, minimapNavigate, type MinimapContext } from './mindflow-minimap';
import { addBoundary as addBoundaryFn, removeBoundary as removeBoundaryFn, cleanupStaleBoundaries, editBoundaryLabel, renderBoundaries as renderBoundariesFn, type BoundaryContext } from './mindflow-boundary';
import {
  renderRelationEdgesFn, handleRelEdgeClick, handleRelEdgeContextMenu,
  addConnection as addConnectionFn, renderConnectionEdgesFn, removeConnection as removeConnectionFn, editConnection as editConnectionFn,
  openAnnotationPicker as openAnnotationPickerFn, jumpToAnnotation as jumpToAnnotationFn, showAnnotationDetail as showAnnotationDetailFn,
  openEdgeLabelEditor,
  type ConnectionsContext,
} from './mindflow-connections';
import { openAnnotationSearch, clearSearchHighlights, type SearchContext } from './mindflow-search';
import {
  DEFAULT_STRUCTURE_TYPE,
  DEFAULT_LAYOUT_TYPE,
  createMindNode,
} from '../types/mind-node';

export const MINDFLOW_VIEW_TYPE = 'mindflow:view';

/** 默认初始展开层级（2 = 根+两层，参考 markmap；大文件自动降级） */
const DEFAULT_EXPAND_LEVEL = 2;

/** 结构类型 → 推荐默认布局 */
const STRUCTURE_DEFAULT_LAYOUT: Record<string, LayoutType> = {
  flow: 'tree-right',
  skeleton: 'tree-right',
  hierarchy: 'org',
  process: 'logic-right',
  fishbone: 'fishbone',
  freeform: 'freeform',
};

/** Pan/Zoom 状态 */
interface ViewState {
  panX: number;
  panY: number;
  scale: number;
}

/** 默认视图状态 */
const DEFAULT_VIEW_STATE: ViewState = {
  panX: 0,
  panY: 0,
  scale: 1,
};

export class MindFlowView extends ItemView {
  private currentFile: TFile | null = null;
  private rootNode: MindNode | null = null;
  private meta: MindmapMeta = {
    structureType: DEFAULT_STRUCTURE_TYPE,
    layout: DEFAULT_LAYOUT_TYPE,
  };

  /** DOM 元素引用 */
  private viewportEl: HTMLElement | null = null;
  private canvasEl: HTMLElement | null = null;
  private svgEl: SVGSVGElement | null = null;

  /** 关系/自主连线专用 SVG 层（在节点层之上） */
  private _relSvgEl: SVGSVGElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private nodeLayerEl: HTMLElement | null = null;

  /** 节点 ID → DOM 元素映射 */
  private nodeElements = new Map<string, HTMLElement>();

  /** 渲染缓存（Phase 2） */
  private renderCache = new RenderCache();

  /** M1: 渲染专用 Component，每次清空前 unload 避免子组件泄漏 */
  private _renderComponent: Component | null = null;

  /** R2-2: 实例级渲染代次计数器，避免多视图竞态 */
  private _renderGen = new RenderGenerationCounter();

  /** P2: 大纲模式面板 */
  private outlineEl: HTMLElement | null = null;
  private _isOutlineMode = false;
  /** L2: 大纲刷新 debounce timer */
  private _outlineRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** P3: 小地图 */
  private minimapEl: HTMLElement | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private _minimapAbort: AbortController | null = null;
  private _minimapRafPending = false;

  /** P3: 外框数据 (boundaryId → {nodeIds, label}) */
  private _boundaries: BoundaryRecord[] = [];

  /** Phase A: 自主连线数据 */
  private _connections: ConnectionRecord[] = [];

  /** 当前选中节点 ID */
  private selectedNodeId: string | null = null;

  /** 多选节点 ID 集合（Shift+点击追加） */
  private _multiSelectedIds: Set<string> = new Set();

  /** Pan/Zoom 状态 */
  private viewState: ViewState = { ...DEFAULT_VIEW_STATE };

  /** 拖拽状态 */
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartPanX = 0;
  private dragStartPanY = 0;

  /** 事件总线 */
  private eventBus = new MindflowEventBus();

  /** 撤销/重做管理器 */
  private undoRedo = new UndoRedoManager();

  /** 键盘快捷键 */
  private keyboard: KeyboardShortcuts | null = null;

  /** 是否正在编辑节点（contentEditable 模式） */
  private editingNodeId: string | null = null;

  /** P1-1: saveFreeNodes 防抖 timer */
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** P1-2: 编辑态 keydown 处理器引用（用于移除） */
  private _editKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

  /** P1-3: 文件修改监听引用 */
  private _fileModifyRef: ((file: TFile) => void) | null = null;

  /** N2: 自身保存标志 — 防止 saveFreeNodes 触发的 modify 事件导致 resync 循环 */
  private _isSelfSaving = false;

  /** P1: 拖拽状态 */
  private _dragNodeId: string | null = null;
  private _dragGhostEl: HTMLElement | null = null;
  private _dragDropTargetId: string | null = null;
  /** L1: 拖拽阈值监听器清理函数 */
  private _dragThresholdCleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return MINDFLOW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'MindFlow';
  }

  getIcon(): string {
    return 'network';
  }

  // ═══════════════════════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════════════════════

  async onOpen() {
    logger.debug('MindFlow: view opened');

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.classList.add('mindflow-view');
    container.style.padding = '0';
    container.style.overflow = 'hidden';
    container.style.position = 'relative';

    this.renderLayout(container);
    this.bindInteractions();
    this.bindKeyboardShortcuts();
    this.bindEventBus();

    // P1-3 + N2: 监听文件修改 → 自动 resync
    // 修复: 跳过自身保存 + 编辑中不 resync（防止 DOM 重建丢失编辑框）
    this._fileModifyRef = (file: TFile) => {
      if (this._isSelfSaving) return; // N2: 跳过自身保存
      if (this.editingNodeId) return; // 编辑中不 resync，避免 DOM 重建丢失编辑框
      if (this.currentFile && file.path === this.currentFile.path) {
        logger.debug('MindFlow: file modified externally, resyncing');
        this.resync().catch(err => logger.error('MindFlow: external modify resync failed', err));
      }
    };
    this.registerEvent(this.app.vault.on('modify', this._fileModifyRef));

    // 尝试加载当前活动文件
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === 'md') {
      await this.loadFile(activeFile);
    }
  }

  async onClose() {
    logger.debug('MindFlow: view closed');
    // P3: 清理小地图
    this.hideMinimap();
    // P2: 清理大纲面板
    this.hideOutline();
    // P1-1: 清理防抖 timer
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // N3: 清理编辑态 keydown 监听器
    if (this._editKeydownHandler && this.editingNodeId) {
      const el = this.nodeElements.get(this.editingNodeId);
      if (el) {
        const contentEl = el.querySelector('.mf-node__content') as HTMLElement;
        if (contentEl) contentEl.removeEventListener('keydown', this._editKeydownHandler);
      }
      this._editKeydownHandler = null;
      this.editingNodeId = null;
    }
    // P1 修复: 清理 Pan/Zoom 事件监听
    if (this._panAbort) {
      this._panAbort.abort();
      this._panAbort = null;
    }
    // L1: 清理拖拽阈值监听器
    if (this._dragThresholdCleanup) {
      this._dragThresholdCleanup();
      this._dragThresholdCleanup = null;
    }
    this.keyboard?.unbind();
    this.eventBus.clear();
    this.undoRedo.clear();
    // M1: 清理渲染 Component
    if (this._renderComponent) {
      this._renderComponent.unload();
      this._renderComponent = null;
    }
    this.renderCache.clear();
    // 清除搜索高亮
    clearSearchHighlights();
    this.rootNode = null;
    this.currentFile = null;
    this.nodeElements.clear();
  }

  // ═══════════════════════════════════════════════════════
  // 布局渲染
  // ═══════════════════════════════════════════════════════

  private renderLayout(container: HTMLElement) {
    this.toolbarEl = container.createDiv({ cls: 'mf-toolbar' });
    this.renderToolbar();

    this.viewportEl = container.createDiv({ cls: 'mf-viewport' });
    this.viewportEl.style.flex = '1';
    this.viewportEl.style.minHeight = '0';
    this.viewportEl.style.overflow = 'hidden';
    this.viewportEl.style.position = 'relative';

    this.canvasEl = this.viewportEl.createDiv({ cls: 'mf-canvas' });
    this.canvasEl.style.position = 'absolute';
    this.canvasEl.style.left = '0';
    this.canvasEl.style.top = '0';
    this.canvasEl.style.width = '100%';
    this.canvasEl.style.height = '100%';
    this.canvasEl.style.transformOrigin = '0 0';
    this.canvasEl.style.transition = 'transform 0.2s ease-out';

    this.svgEl = createSvgContainer(800, 600);
    this.canvasEl.appendChild(this.svgEl);

    this.nodeLayerEl = this.canvasEl.createDiv({ cls: 'mf-node-layer' });
    this.nodeLayerEl.style.position = 'absolute';
    this.nodeLayerEl.style.left = '0';
    this.nodeLayerEl.style.top = '0';
    this.nodeLayerEl.style.width = '100%';
    this.nodeLayerEl.style.height = '100%';
    this.nodeLayerEl.style.pointerEvents = 'none'; // 节点层不拦截事件，让子元素自行处理

    // 关系/自主连线层 — 在节点层之上，确保连线可交互
    this._relSvgEl = createSvgContainer(800, 600);
    this._relSvgEl.style.zIndex = '10';
    this.canvasEl.appendChild(this._relSvgEl);
  }

  private renderToolbar() {
    if (!this.toolbarEl) return;
    this.toolbarEl.empty();

    // 主要操作按钮
    const addChildBtn = this.toolbarEl.createEl('button', {
      cls: 'mf-toolbar__btn mf-toolbar__btn--primary',
      text: '+ Child',
    });
    addChildBtn.title = 'Add child node (Tab)';
    addChildBtn.addEventListener('click', () => this.handleInsertChild());

    const addSiblingBtn = this.toolbarEl.createEl('button', {
      cls: 'mf-toolbar__btn',
      text: '+ Sibling',
    });
    addSiblingBtn.title = 'Add sibling node (Enter)';
    addSiblingBtn.addEventListener('click', () => this.handleInsertSibling());

    const editBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: 'Edit' });
    editBtn.title = 'Edit selected node (F2)';
    editBtn.addEventListener('click', () => this.handleEditNode());

    const deleteBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: 'Delete' });
    deleteBtn.title = 'Delete selected node (Del)';
    deleteBtn.addEventListener('click', () => this.handleDeleteNode());

    // 分隔线
    this.toolbarEl.createSpan({ cls: 'mf-toolbar__sep' });

    // structureType 切换 — 点击弹出选择面板
    const STRUCTURE_LABELS: Record<string, string> = {
      'flow': '⚡',
      'skeleton': '✦',
      'hierarchy': '⊞',
      'process': '↻',
      'fishbone': '⋊',
      'freeform': '✱',
    };
    const currentStructure = this.meta.structureType ?? DEFAULT_STRUCTURE_TYPE;
    const structBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: STRUCTURE_LABELS[currentStructure] ?? currentStructure });
    structBtn.title = `Structure: ${currentStructure} | Layout: ${this.meta.layout ?? 'tree-right'} (click to change)`;
    structBtn.addEventListener('click', () => this.openStructurePicker());

    // 视图控制
    const fitBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: 'Fit' });
    fitBtn.title = 'Fit view (F1)';
    fitBtn.addEventListener('click', () => this.fitView());

    const undoBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: 'Undo' });
    undoBtn.title = 'Undo (Ctrl+Z)';
    undoBtn.addEventListener('click', () => this.handleUndo());

    const redoBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: 'Redo' });
    redoBtn.title = 'Redo (Ctrl+Shift+Z)';
    redoBtn.addEventListener('click', () => this.handleRedo());

    // 分隔线
    this.toolbarEl.createSpan({ cls: 'mf-toolbar__sep' });

    // P2: 大纲模式切换
    const outlineBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u2630' });
    outlineBtn.title = 'Toggle outline mode';
    outlineBtn.addEventListener('click', () => this.toggleOutline());

    // P2: 导出
    const exportBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u2b07' });
    exportBtn.title = 'Export as SVG';
    exportBtn.addEventListener('click', () => this.exportSVG());

    // P3: 外框
    const boundaryBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u25a2' });
    boundaryBtn.title = 'Add boundary (Shift+click to multi-select, then click)';
    boundaryBtn.addEventListener('click', () => this.addBoundary());

    // Phase A: 自主连线
    const connectBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u2194' });
    connectBtn.title = 'Connect selected nodes (Shift+click to select 2+ nodes)';
    connectBtn.addEventListener('click', () => this.addConnection());

    // P3: 小地图
    const minimapBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u25cb' });
    minimapBtn.title = 'Toggle minimap';
    minimapBtn.addEventListener('click', () => this.toggleMinimap());

    // Phase 3: 添加标注引用
    const annBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '@A' });
    annBtn.title = 'Link annotation to selected node';
    annBtn.addEventListener('click', () => this.openAnnotationPicker());

    // 标注搜索
    const searchBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u{1F50D}' });
    searchBtn.title = 'Search annotations in mindmap';
    searchBtn.addEventListener('click', () => this.openAnnotationSearch());

    // 详情编辑入口（选中节点后点击可查看/添加/编辑详情）
    const detailBtn = this.toolbarEl.createEl('button', { cls: 'mf-toolbar__btn', text: '\u{1F4D6}' });
    detailBtn.title = 'View / edit detail for selected node';
    detailBtn.addEventListener('click', () => {
      if (!this.selectedNodeId) {
        new Notice('Select a node first');
        return;
      }
      this.openDetailEditor(this.selectedNodeId);
    });

    // 文件名显示
    const fileLabel = this.toolbarEl.createSpan({ cls: 'mf-toolbar__file' });
    fileLabel.textContent = this.currentFile?.name ?? 'No file loaded';
  }

  // ═══════════════════════════════════════════════════════
  // 文件加载与同步
  // ═══════════════════════════════════════════════════════

  async loadFile(file: TFile): Promise<void> {
    this.currentFile = file;
    logger.debug('MindFlow: loading file', file.path);

    try {
      const content = await this.app.vault.read(file);
      await this.loadFromContent(content, file.name);
    } catch (err) {
      logger.error('MindFlow: failed to read file', err);
      new Notice('MindFlow: failed to load file');
    }
  }

  async loadFromContent(content: string, fileName: string): Promise<void> {
    try {
      const result = syncFromMarkdown(content, fileName.replace(/\.md$/i, ''));
      this.rootNode = result.root;
      this.meta = result.meta;

      // 默认折叠深层节点（参考 markmap initialExpandLevel）
      applyInitialExpandLevel(this.rootNode, DEFAULT_EXPAND_LEVEL);

      // 重置 undo 栈和渲染缓存（新文件加载）
      this.undoRedo.clear();
      this.renderCache.clear();
      this.selectedNodeId = null;

      // F3: 清理上一个文件的外框数据，M2: 从 meta 恢复
      this._boundaries = this.meta.boundaries ?? [];
      this._connections = this.meta.connections ?? [];

      await this.layoutAndRender();
      this.fitView();
      this.updateToolbar();
    } catch (err) {
      logger.error('MindFlow: loadFromContent failed', err);
      new Notice('Failed to load mindmap. Check console for details.');
    }
  }

  async resync(): Promise<void> {
    if (!this.currentFile) return;
    logger.debug('MindFlow: resyncing from file change');

    try {
      // N1: 保存用户当前折叠状态，resync 后恢复
      const savedCollapsed = this.rootNode
        ? collectCollapsedStates(this.rootNode)
        : {};

      const content = await this.app.vault.read(this.currentFile);
      const result = syncFromMarkdown(content, this.currentFile.name.replace(/\.md$/i, ''));
      this.rootNode = result.root;
      this.meta = result.meta;

      // N1: 不再无脑 applyInitialExpandLevel，而是恢复用户的折叠状态
      // 首次加载（savedCollapsed 为空）时才用默认折叠
      if (Object.keys(savedCollapsed).length > 0) {
        applyCollapsedStates(this.rootNode, savedCollapsed);
      } else {
        applyInitialExpandLevel(this.rootNode, DEFAULT_EXPAND_LEVEL);
      }

      this.undoRedo.clear();
      this.renderCache.clear();
      // M2: resync 后恢复外框 + 自主连线
      this._boundaries = this.meta.boundaries ?? [];
      this._connections = this.meta.connections ?? [];
      await this.layoutAndRender();
      this.fitView();
    } catch (err) {
      logger.error('MindFlow: resync failed', err);
    }
  }

  async saveFreeNodes(): Promise<void> {
    if (!this.currentFile || !this.rootNode) return;

    try {
      const content = await this.app.vault.read(this.currentFile);
      const newContent = writeMindmapConfig(content, this.meta, [this.rootNode]);

      if (newContent !== content) {
        // N2: 设置自身保存标志，用时间戳防止 modify 事件循环
        this._isSelfSaving = true;
        await this.app.vault.modify(this.currentFile, newContent);
        // 延迟 1 秒重置（确保 vault.on('modify') 事件已处理完毕）
        setTimeout(() => { this._isSelfSaving = false; }, 1000);
        logger.debug('MindFlow: free nodes saved to frontmatter');
      }
    } catch (err) {
      logger.error('MindFlow: failed to save free nodes', err);
      new Notice('MindFlow: failed to save');
    }
  }

  // ═══════════════════════════════════════════════════════
  // 布局与渲染
  // ═══════════════════════════════════════════════════════

  /**
   * 两遍布局 + 异步渲染管线
   *
   * Phase 2 核心方法：
   *   1. 占位布局（同步，估算高度）→ 立即渲染骨架
   *   2. 异步渲染节点内容（MarkdownRenderer）
   *   3. 测量实际高度
   *   4. 若高度变化 → 重布局 + CSS 过渡
   */
  private async layoutAndRender(): Promise<void> {
    if (!this.rootNode || !this.nodeLayerEl || !this.svgEl) return;

    // M1: 清空前 unload 旧渲染 Component，释放 MarkdownRenderer 子组件
    if (this._renderComponent) {
      this._renderComponent.unload();
      this._renderComponent = null;
    }

    try {
      // ── Step 1: 占位布局（同步，估算高度） ──
      layoutTree(this.rootNode, this.meta.layout ?? DEFAULT_LAYOUT_TYPE);

      const visibleNodes = getVisibleNodes(this.rootNode);
      const visibleEdges = getVisibleEdges(this.rootNode);

      // 清空旧渲染（P2-6: SVG 清空由 renderConnectors 内部处理，无需双重清空）
      clearNodes(this.nodeLayerEl);
      this.nodeElements.clear();

      // 渲染连线 + 节点骨架
      renderConnectors(visibleEdges, this.svgEl, this.meta.layout);
      this.nodeElements = renderNodes(visibleNodes, this.nodeLayerEl);

      // 注意: 关系/自主连线在 Step 4 渲染，此处节点 style.left/top 尚未设置

      // 更新 SVG 尺寸
    const bounds = getLayoutBounds(this.rootNode);
    const padding = 100;
    resizeSvg(this.svgEl, bounds.width + padding * 2, bounds.height + padding * 2);
    if (this._relSvgEl) {
      resizeSvg(this._relSvgEl, bounds.width + padding * 2, bounds.height + padding * 2);
    }

    // 绑定交互
    this.bindNodeInteractions();

    // 恢复选中态
    setSelectedNode(this.nodeElements, this.selectedNodeId);

    // ── Step 2: 异步渲染节点内容 ──
    // 确保 MathJax 已加载（Obsidian 懒加载，首次使用前需显式调用）
    // P0-1: 移除 try/catch 让错误可见；添加就绪轮询确保 MathJax 真正可用
    await loadMathJax();
    if (!window.MathJax) {
      logger.debug('MindFlow: MathJax global not ready after loadMathJax(), polling...');
      await new Promise<void>((resolve) => {
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += 100;
          if (window.MathJax) {
            clearInterval(interval);
            logger.debug('MindFlow: MathJax ready after', elapsed, 'ms');
            resolve();
          } else if (elapsed >= 3000) {
            clearInterval(interval);
            logger.warn('MindFlow: MathJax not available after 3s timeout, will attempt render anyway');
            resolve();
          }
        }, 100);
      });
    } else {
      logger.debug('MindFlow: MathJax already ready');
    }

    const sourcePath = this.currentFile?.path ?? '';
    // M1: 创建独立 Component 管理渲染子组件生命周期
    this._renderComponent = new Component();
    this._renderComponent.load();
    await renderNodesContent(
      this.app,
      visibleNodes,
      this.nodeElements,
      sourcePath,
      this._renderComponent, // M1: 独立 Component，清空时 unload
      this.renderCache,
      this._renderGen, // R2-2: 实例级代次计数器
    );

    // ── Step 3: 刷新 MathJax 样式 ──
    try {
      await finishRenderMath();
    } catch (err) {
      logger.debug('MindFlow: finishRenderMath error (non-fatal)', err);
    }

    // ── Step 4: 始终用测量值重布局，确保使用实际渲染尺寸 ──
    // Fix 6: 移除条件判断，O(N) relayout 开销可忽略
    relayoutWithMeasured(this.rootNode, this.meta.layout ?? DEFAULT_LAYOUT_TYPE);

    // 更新 DOM 位置（CSS transition 平滑过渡）
    for (const node of getVisibleNodes(this.rootNode)) {
      const el = this.nodeElements.get(node.id);
      const layout = node.layout;
      if (el && layout) {
        el.style.left = `${layout.x}px`;
        el.style.top = `${layout.y}px`;
        el.style.width = `${layout.width}px`; // 重布局后宽度可能变化
        el.style.minHeight = `${layout.height}px`;
      }
    }

    // 重新渲染连线（P2-6: renderConnectors 内部已清空，无需双重清空）
    const newEdges = getVisibleEdges(this.rootNode);
    renderConnectors(newEdges, this.svgEl, this.meta.layout);

    // 更新 SVG 尺寸
    const newBounds = getLayoutBounds(this.rootNode);
    resizeSvg(this.svgEl, newBounds.width + padding * 2, newBounds.height + padding * 2);

    // Phase A5: 渲染标注关系连线（跨树边）— 使用独立 SVG 层
    this._renderRelationEdges();

    // Phase A: 渲染自主连线 — 使用独立 SVG 层
    this._renderConnectionEdges();

    // 同步关系层 SVG 尺寸
    if (this._relSvgEl) {
      resizeSvg(this._relSvgEl, newBounds.width + padding * 2, newBounds.height + padding * 2);
    }

    // P3: 重布局后刷新外框和小地图 (R3: 延迟到 rAF 避免阻塞)
    requestAnimationFrame(() => {
      this.renderBoundaries();
      this.updateMinimap();
    });

    // L2: 大纲模式自动刷新 — 使用 debounce 避免频繁重建
    if (this._isOutlineMode) {
      this._scheduleOutlineRefresh();
    }
    } catch (err) {
      // R2-4: 确保错误时清理 _renderComponent
      if (this._renderComponent) {
        this._renderComponent.unload();
        this._renderComponent = null;
      }
      logger.error('MindFlow: layoutAndRender failed', err);
      throw err; // 重新抛出，让调用者的 try/catch 处理
    }
  }

  private updateToolbar(): void {
    if (!this.toolbarEl) return;
    const fileLabel = this.toolbarEl.querySelector('.mf-toolbar__file');
    if (fileLabel) {
      fileLabel.textContent = this.currentFile?.name ?? 'No file loaded';
    }
  }

  // ═══════════════════════════════════════════════════════
  // 事件总线
  // ═══════════════════════════════════════════════════════

  private bindEventBus(): void {
    // P1-1: 监听操作事件 → 防抖保存（500ms）
    // 修复: beginEdit 不触发保存（内容尚未变化）
    this.eventBus.on('operation', (e) => {
      logger.debug('MindFlow [bus]: operation', e.name, e.nodeId);
      if (e.name === 'beginEdit') return; // 编辑开始时不需要保存
      this.debouncedSave();
    });
  }

  /** P1-1: 防抖保存 Free 节点 */
  private debouncedSave(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveFreeNodes().catch(err => logger.error('MindFlow: debounced save failed', err));
    }, 500);
  }

  // ═══════════════════════════════════════════════════════
  // 键盘快捷键
  // ═══════════════════════════════════════════════════════

  private bindKeyboardShortcuts(): void {
    if (!this.viewportEl) return;

    this.keyboard = new KeyboardShortcuts(this.viewportEl, (action): boolean => {
      return this.handleShortcut(action);
    });
    this.keyboard.bind();
  }

  private handleShortcut(action: ShortcutAction): boolean {
    switch (action) {
      case 'insertChild':
        this.handleInsertChild();
        return true;
      case 'insertSibling':
        this.handleInsertSibling();
        return true;
      case 'editNode':
        this.handleEditNode();
        return true;
      case 'deleteNode':
        this.handleDeleteNode();
        return true;
      case 'fitView':
        this.fitView();
        return true;
      case 'zoomIn':
        this.zoomBy(1.2);
        return true;
      case 'zoomOut':
        this.zoomBy(1 / 1.2);
        return true;
      case 'zoomReset':
        this.resetView();
        return true;
      case 'undo':
        this.handleUndo();
        return true;
      case 'redo':
        this.handleRedo();
        return true;
      case 'toggleCollapse':
        if (this.selectedNodeId) this.toggleCollapse(this.selectedNodeId);
        return true;
      case 'navigateUp':
      case 'navigateDown':
      case 'navigateLeft':
      case 'navigateRight':
        this.navigate(action);
        return true;
      default:
        return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 交互：Pan / Zoom
  // ═══════════════════════════════════════════════════════

  private _panAbort: AbortController | null = null;

  private bindInteractions(): void {
    if (!this.viewportEl) return;

    // P1 修复: 用 AbortController 管理事件, onClose 时一次性清理
    this._panAbort = new AbortController();
    const sig = this._panAbort.signal;

    // Pan：鼠标拖拽空白区域
    this.viewportEl.addEventListener('mousedown', (e) => {
      // 放行：节点、关系连线、自主连线 — 这些不是拖拽目标
      const target = e.target as HTMLElement;
      if (target.closest('.mf-node')) return;
      if (target.closest('.mf-rel-edge')) return;
      if (target.closest('.mf-conn-edge')) return;

      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartPanX = this.viewState.panX;
      this.dragStartPanY = this.viewState.panY;
      if (this.viewportEl) this.viewportEl.style.cursor = 'grabbing';
      e.preventDefault();
    }, { signal: sig });

    this.viewportEl.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.viewState.panX = this.dragStartPanX + (e.clientX - this.dragStartX);
      this.viewState.panY = this.dragStartPanY + (e.clientY - this.dragStartY);
      this.applyTransform();
    }, { signal: sig });

    const endDrag = () => {
      this.isDragging = false;
      if (this.viewportEl) this.viewportEl.style.cursor = '';
    };
    this.viewportEl.addEventListener('mouseup', endDrag, { signal: sig });
    this.viewportEl.addEventListener('mouseleave', endDrag, { signal: sig });

    // Zoom：滚轮缩放（以鼠标为中心）
    this.viewportEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1);
    }, { signal: sig });
  }

  private applyTransform(): void {
    if (!this.canvasEl) return;
    const { panX, panY, scale } = this.viewState;
    this.canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    if (!this.viewportEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const newScale = Math.max(0.2, Math.min(3, this.viewState.scale * factor));
    const worldX = (mx - this.viewState.panX) / this.viewState.scale;
    const worldY = (my - this.viewState.panY) / this.viewState.scale;

    this.viewState.scale = newScale;
    this.viewState.panX = mx - worldX * newScale;
    this.viewState.panY = my - worldY * newScale;
    this.applyTransform();
  }

  private zoomBy(factor: number): void {
    if (!this.viewportEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  private resetView(): void {
    this.viewState = { ...DEFAULT_VIEW_STATE };
    this.applyTransform();
  }

  /**
   * 自动适配所有可见节点到视口
   *
   * 参考 markmap 的 fit() — 计算所有可见节点的边界框，
   * 调整 pan/scale 使其刚好填满视口（带 padding）。
   */
  fitView(): void {
    if (!this.rootNode || !this.viewportEl) return;

    layoutTree(this.rootNode, this.meta.layout ?? DEFAULT_LAYOUT_TYPE);
    const bounds = getLayoutBounds(this.rootNode);
    if (bounds.width === 0 || bounds.height === 0) return;

    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const padding = 60;
    const scaleX = (rect.width - padding * 2) / bounds.width;
    const scaleY = (rect.height - padding * 2) / bounds.height;
    const newScale = Math.min(Math.max(Math.min(scaleX, scaleY), 0.2), 1.5);

    // 居中
    this.viewState.scale = newScale;
    this.viewState.panX = padding - bounds.minX * newScale;
    this.viewState.panY = padding - bounds.minY * newScale;

    this.applyTransform();
    this.eventBus.emit('view', { type: 'fit' });
    logger.debug('MindFlow: fitView', { scale: newScale, bounds });
  }

  /** 打开认知结构类型选择面板 */
  private openStructurePicker(): void {
    const modal = new StructurePickerModal(this.app, this.meta.structureType ?? DEFAULT_STRUCTURE_TYPE, async (type) => {
      this.meta.structureType = type;
      // 结构类型切换时自动推荐最佳布局
      const recommendedLayout = STRUCTURE_DEFAULT_LAYOUT[type] ?? 'tree-right';
      if (this.meta.layout !== recommendedLayout) {
        this.meta.layout = recommendedLayout;
      }
      this.renderCache.clear();
      await this.layoutAndRender();
      this.fitView();
      this.updateToolbar();
      this.debouncedSave();
    });
    modal.open();
  }

  // ═══════════════════════════════════════════════════════
  // P2: 大纲模式 (委托到 mindflow-outline.ts)
  // ═══════════════════════════════════════════════════════

  private _buildOutlineCtx(): OutlineContext {
    const self = this;
    return {
      get rootNode() { return self.rootNode; },
      get selectedNodeId() { return self.selectedNodeId; },
      get viewportEl() { return self.viewportEl; },
      get outlineEl() { return self.outlineEl; },
      set outlineEl(v) { self.outlineEl = v; },
      get _isOutlineMode() { return self._isOutlineMode; },
      get _outlineRefreshTimer() { return self._outlineRefreshTimer; },
      set _outlineRefreshTimer(v) { self._outlineRefreshTimer = v; },
      selectNode: (id) => self.selectNode(id),
      scrollToNode: (id) => self.scrollToNode(id),
      toggleCollapse: (id) => self.toggleCollapse(id),
    };
  }

  private toggleOutline(): void {
    this._isOutlineMode = !this._isOutlineMode;
    if (this._isOutlineMode) {
      showOutline(this._buildOutlineCtx());
    } else {
      hideOutline(this._buildOutlineCtx());
    }
  }

  private hideOutline(): void { hideOutline(this._buildOutlineCtx()); }
  private _scheduleOutlineRefresh(): void { scheduleOutlineRefresh(this._buildOutlineCtx()); }

  private _buildMinimapCtx(): MinimapContext {
    const self = this;
    return {
      get rootNode() { return self.rootNode; },
      get viewportEl() { return self.viewportEl; },
      get selectedNodeId() { return self.selectedNodeId; },
      get viewState() { return self.viewState; },
      get minimapEl() { return self.minimapEl; },
      set minimapEl(v) { self.minimapEl = v; },
      get minimapCanvas() { return self.minimapCanvas; },
      set minimapCanvas(v) { self.minimapCanvas = v; },
      get _minimapAbort() { return self._minimapAbort; },
      set _minimapAbort(v) { self._minimapAbort = v; },
      get _minimapRafPending() { return self._minimapRafPending; },
      set _minimapRafPending(v) { self._minimapRafPending = v; },
      applyTransform: () => self.applyTransform(),
      updateMinimap: () => self.updateMinimap(),
    };
  }

  private _buildBoundaryCtx(): BoundaryContext {
    const self = this;
    return {
      get rootNode() { return self.rootNode; },
      get nodeLayerEl() { return self.nodeLayerEl; },
      get _boundaries() { return self._boundaries; },
      set _boundaries(v) { self._boundaries = v; },
      get meta() { return self.meta; },
      get app() { return self.app; },
      getBoundaryCandidateIds: () => self._getBoundaryCandidateIds(),
      clearMultiSelect: () => { self._multiSelectedIds.clear(); },
      applySelectionVisual: () => self._applySelectionVisual(),
      debouncedSave: () => self.debouncedSave(),
      renderBoundaries: () => self.renderBoundaries(),
      removeBoundary: (id) => self.removeBoundary(id),
      editBoundaryLabel: (id) => self._editBoundaryLabel(id),
    };
  }

  // ═══════════════════════════════════════════════════════
  // P2: 导出 SVG
  // ═══════════════════════════════════════════════════════

  private _buildConnectionsCtx(): ConnectionsContext {
    const self = this;
    return {
      get rootNode() { return self.rootNode; },
      get nodeElements() { return self.nodeElements; },
      get _relSvgEl() { return self._relSvgEl; },
      get _connections() { return self._connections; },
      set _connections(v) { self._connections = v; },
      get meta() { return self.meta; },
      get selectedNodeId() { return self.selectedNodeId; },
      get app() { return self.app; },
      get filePath() { return self.currentFile?.path ?? ''; },
      debouncedSave: () => self.debouncedSave(),
      layoutAndRender: () => self.layoutAndRender(),
      selectNode: (id) => self.selectNode(id),
      renderCacheClear: () => self.renderCache.clear(),
      undoRedoSnapshot: (label) => {
        if (!self.rootNode) { logger.warn('undoRedoSnapshot called with null rootNode'); return; }
        self.undoRedo.snapshot(label, self.rootNode, self.meta);
      },
      eventBusEmit: ((channel: any, payload: any) => self.eventBus.emit(channel, payload)) as ConnectionsContext['eventBusEmit'],
      getBoundaryCandidateIds: () => self._getBoundaryCandidateIds(),
      clearMultiSelect: () => { self._multiSelectedIds.clear(); },
      applySelectionVisual: () => self._applySelectionVisual(),
      renderRelationEdges: () => self._renderRelationEdges(),
      renderConnectionEdges: () => self._renderConnectionEdges(),
    };
  }

  // ═══════════════════════════════════════════════════════
  // 标注搜索 (委托到 mindflow-search.ts)
  // ═══════════════════════════════════════════════════════

  private openAnnotationSearch(): void {
    openAnnotationSearch({
      rootNode: this.rootNode,
      nodeElements: this.nodeElements,
      app: this.app,
      scrollToNode: (id) => this.scrollToNode(id),
      selectNode: (id) => this.selectNode(id),
    });
  }

  // ═══════════════════════════════════════════════════════
  // Phase 3: 标注引用选择器 (委托到 mindflow-connections.ts)
  // ═══════════════════════════════════════════════════════

  /** 打开标注选择器 Modal */
  private openAnnotationPicker(): void { openAnnotationPickerFn(this._buildConnectionsCtx()); }

  /** Phase 3: 跳转到标注原文 */

  /** 打开节点备注编辑器 */
  private openNoteEditor(nodeId: string): void {
    if (!this.rootNode) return;
    const node = findNode(this.rootNode, nodeId);
    if (!node) return;

    const modal = new NodeNoteModal(this.app, node.text.slice(0, 30), node.note ?? '', async (noteText) => {
      this.undoRedo.snapshot('editNote', this.rootNode!, this.meta);
      node.note = noteText || undefined;
      this.renderCache.clear();
      await this.layoutAndRender();
      this.selectNode(nodeId);
      this.debouncedSave();
    });
    modal.open();
  }

  /** 编辑父子连线标签 (edgeLabel + edgeNote) */
  private async _openEdgeLabelEditor(nodeId: string): Promise<void> { await openEdgeLabelEditor(this._buildConnectionsCtx(), nodeId); }

  /** 打开节点详情编辑器（md-seed 的 detail 双向编辑） */
  private openDetailEditor(nodeId: string): void {
    if (!this.rootNode) return;
    const node = findNode(this.rootNode, nodeId);
    if (!node) return;

    const modal = new NodeDetailModal(
      this.app,
      node.text.slice(0, 30),
      node.detail ?? '',
      node.id,
      async (detailText) => {
        // 更新内存中的节点
        node.detail = detailText || undefined;
        // 更新 MD 文件中的 detail 块
        await this._updateDetailInFile(nodeId, detailText);
        this.renderCache.clear();
        await this.layoutAndRender();
        this.selectNode(nodeId);
      },
    );
    modal.open();
  }

  /** 将详情块写入/更新/删除到 MD 文件 */
  private async _updateDetailInFile(nodeId: string, detailText: string): Promise<void> {
    if (!this.currentFile) return;
    const content = await this.app.vault.read(this.currentFile);
    const lines = content.split('\n');
    const openTag = `<!-- mf:detail id="${nodeId}" -->`;
    const closeTag = '<!-- /mf:detail -->';

    // 查找现有 detail 块
    let startIdx = -1;
    let endIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === openTag.trim()) {
        startIdx = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === closeTag.trim()) {
            endIdx = j;
            break;
          }
        }
        break;
      }
    }

    if (detailText.trim()) {
      // 有内容: 写入或替换
      const detailLines = detailText.split('\n');
      const block = [openTag, ...detailLines, closeTag];

      if (startIdx >= 0 && endIdx >= 0) {
        // 替换现有块
        lines.splice(startIdx, endIdx - startIdx + 1, ...block);
      } else {
        // 新增: 找到节点所在的标题/列表行，插入其后
        const node = findNode(this.rootNode!, nodeId);
        const sourceLine = node?.sourceLine ?? -1;
        const insertAfter = sourceLine >= 0 ? sourceLine + 1 : lines.length;
        // 插入空行 + detail 块
        lines.splice(insertAfter, 0, '', ...block);
      }
    } else {
      // 无内容: 删除现有块
      if (startIdx >= 0 && endIdx >= 0) {
        // 同时删除前导空行
        const removeStart = startIdx > 0 && lines[startIdx - 1].trim() === '' ? startIdx - 1 : startIdx;
        lines.splice(removeStart, endIdx - removeStart + 1);
      }
    }

    const newContent = lines.join('\n');
    await this.app.vault.modify(this.currentFile, newContent);
  }
  private showAnnotationDetail(uuid: string): void { showAnnotationDetailFn(this._buildConnectionsCtx(), uuid); }

  /** 导出当前导图为 SVG 文件 */
  private exportSVG(): void {
    if (!this.svgEl || !this.nodeLayerEl || !this.rootNode) {
      new Notice('Nothing to export');
      return;
    }

    const bounds = getLayoutBounds(this.rootNode);
    const padding = 40;
    const width = bounds.width + padding * 2;
    const height = bounds.height + padding * 2;

    // 合并树边 SVG 和关系/自主连线 SVG
    const svgClone = this.svgEl.cloneNode(true) as SVGSVGElement;
    if (this._relSvgEl) {
      const relClone = this._relSvgEl.cloneNode(true) as SVGSVGElement;
      while (relClone.firstChild) {
        svgClone.appendChild(relClone.firstChild);
      }
    }
    svgClone.setAttribute('width', String(width));
    svgClone.setAttribute('height', String(height));
    svgClone.setAttribute('viewBox', `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`);

    // F9: 内联关键 CSS 到导出 SVG
    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = `
      .mf-node { display: inline-flex; align-items: center; padding: 8px 14px; border-radius: 10px;
        font-size: 13px; line-height: 1.5; box-sizing: border-box; font-family: sans-serif; }
      .mf-node--md-seed { background: #fff; border: 2px solid #ccc; color: #333; }
      .mf-node--free { background: #f8f8f8; border: 2px solid #483699; color: #333; }
      .mf-node__content { overflow: visible; word-break: normal; }
      .mf-node__content strong { font-weight: 700; }
      .mf-node__content code { background: rgba(0,0,0,0.08); padding: 1px 5px; border-radius: 3px; font-size: 0.88em; }
      .mf-node__badge { font-size: 10px; font-weight: 700; }
    `;
    svgClone.insertBefore(styleEl, svgClone.firstChild);

    for (const [nodeId, el] of this.nodeElements) {
      const node = findNode(this.rootNode, nodeId);
      if (!node || !node.layout) continue;

      const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      fo.setAttribute('x', String(node.layout.x));
      fo.setAttribute('y', String(node.layout.y));
      fo.setAttribute('width', String(node.layout.width));
      fo.setAttribute('height', String(node.layout.height));

      const clone = el.cloneNode(true) as HTMLElement;
      clone.style.position = 'static';
      clone.style.left = '';
      clone.style.top = '';
      clone.style.width = '';
      clone.style.minHeight = '';
      fo.appendChild(clone);
      svgClone.appendChild(fo);
    }

    const serializer = new XMLSerializer();
    const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      serializer.serializeToString(svgClone);

    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const fileName = this.currentFile?.name?.replace(/\.md$/i, '') ?? 'mindmap';
    a.download = `${fileName}.svg`;
    a.click();
    URL.revokeObjectURL(url);

    new Notice(`Exported: ${fileName}.svg`);
  }

  // ═══════════════════════════════════════════════════════
  // P3: 小地图 (Minimap)
  // ═══════════════════════════════════════════════════════

  private toggleMinimap(): void { toggleMinimap(this._buildMinimapCtx()); }
  private hideMinimap(): void { hideMinimapImpl(this._buildMinimapCtx()); }
  private updateMinimap(): void { updateMinimapImpl(this._buildMinimapCtx()); }

  // ═══════════════════════════════════════════════════════
  // P3: 外框 (Boundary)
  // ═══════════════════════════════════════════════════════

  private addBoundary(): void { addBoundaryFn(this._buildBoundaryCtx()); }
  private removeBoundary(id: string): void { removeBoundaryFn(this._buildBoundaryCtx(), id); }
  private _cleanupStaleBoundaries(): void { cleanupStaleBoundaries(this._buildBoundaryCtx()); }
  private async _editBoundaryLabel(id: string): Promise<void> { await editBoundaryLabel(this.app, this._buildBoundaryCtx(), id); }

  /** 渲染所有外框 */
  private renderBoundaries(): void { renderBoundariesFn(this._buildBoundaryCtx()); }

  /** Phase A5: 收集标注关系并渲染跨树连线 */
  private _renderRelationEdges(): void { renderRelationEdgesFn(this._buildConnectionsCtx()); }

  /** Phase A5: 左键标注关系连线 → 查看详情 Modal */

  /** Phase A5: 右键标注关系连线 → 删除 (invalidateRelation) */
  private async _handleRelEdgeContextMenu(edge: RelationEdge, e: MouseEvent): Promise<void> { return handleRelEdgeContextMenu(this._buildConnectionsCtx(), edge, e); }

  /** Phase A: 添加自主连线 */
  private addConnection(): void { addConnectionFn(this._buildConnectionsCtx()); }

  /** Phase A: 渲染自主连线到 SVG */
  private _renderConnectionEdges(): void { renderConnectionEdgesFn(this._buildConnectionsCtx()); }

  /** Phase A: 删除自主连线 — 含确认弹窗 */

  /** Phase A: 编辑自主连线 label + note */

  // ═══════════════════════════════════════════════════════
  // 交互：节点
  // ═══════════════════════════════════════════════════════

  private bindNodeInteractions(): void {
    for (const [nodeId, el] of this.nodeElements) {
      // 单击选中 (Shift+点击 = 追加多选)
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          this.toggleMultiSelect(nodeId);
        } else {
          this.selectNode(nodeId);
        }
      });

      // 折叠/展开
      const collapseBtn = el.querySelector('[data-action="toggle-collapse"]');
      if (collapseBtn) {
        collapseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleCollapse(nodeId);
        });
      }

      // Note 角标点击 → 查看/编辑备注
      const noteBadge = el.querySelector('[data-action="view-note"]');
      if (noteBadge) {
        noteBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openNoteEditor(nodeId);
        });
      }

      // Detail 角标点击 → 查看/编辑详情
      const detailBadge = el.querySelector('[data-action="view-detail"]');
      if (detailBadge) {
        detailBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openDetailEditor(nodeId);
        });
      }

      // 双击编辑（annotation 节点双击查看标注详情；md-seed 有 detail 时查看详情）
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.selectNode(nodeId);
        const node = this.rootNode ? findNode(this.rootNode, nodeId) : null;
        if (node?.type === 'annotation' && node.annotationRef) {
          this.showAnnotationDetail(node.annotationRef);
        } else if (node?.detail) {
          // md-seed 有详情 → 打开详情编辑器
          this.openDetailEditor(nodeId);
        } else {
          this.handleEditNode();
        }
      });

      // 右键菜单
      el.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        this.selectNode(nodeId);
        const menu = new Menu();
        const node = this.rootNode ? findNode(this.rootNode, nodeId) : null;
        if (!node) return;

        menu.addItem((item) => {
          item.setTitle(node.detail ? 'Edit detail' : 'Add detail')
            .setIcon('book-open')
            .onClick(() => this.openDetailEditor(nodeId));
        });

        if (node.detail) {
          menu.addItem((item) => {
            item.setTitle('Remove detail')
              .setIcon('trash')
              .onClick(async () => {
                node.detail = undefined;
                await this._updateDetailInFile(nodeId, '');
                this.renderCache.clear();
                await this.layoutAndRender();
                this.selectNode(nodeId);
                new Notice('Detail removed');
              });
          });
        }

        if (node.type !== 'md-seed') {
          menu.addItem((item) => {
            item.setTitle(node.note ? 'Edit note' : 'Add note')
              .setIcon('pencil')
              .onClick(() => this.openNoteEditor(nodeId));
          });
        }

        // 父子连线语义标注 — 非根节点才显示
        if (node.parentId) {
          menu.addItem((item) => {
            item.setTitle(node.edgeLabel ? 'Edit edge label' : 'Add edge label')
              .setIcon('link')
              .onClick(() => this._openEdgeLabelEditor(nodeId));
          });
        }

        menu.showAtMouseEvent(e);
      });

      // F1/P1: 拖拽重排 — 只对 Free 节点启用，带 5px 移动阈值
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const node = this.rootNode ? findNode(this.rootNode, nodeId) : null;
        if (!node || node.type === 'md-seed') return;
        if ((e.target as HTMLElement).isContentEditable) return;
        if ((e.target as HTMLElement).closest('[data-action="toggle-collapse"]')) return;

        // F1/R1: 延迟启动 — 移动超过 5px 才真正开始拖拽
        const startX = e.clientX;
        const startY = e.clientY;
        let dragStarted = false;

        const onThresholdMove = (ev: MouseEvent) => {
          if (dragStarted) return;
          const dx = Math.abs(ev.clientX - startX);
          const dy = Math.abs(ev.clientY - startY);
          if (dx < 5 && dy < 5) return;
          dragStarted = true;
          document.removeEventListener('mousemove', onThresholdMove);
          document.removeEventListener('mouseup', onThresholdUp);
          this._dragThresholdCleanup = null;
          this._startDrag(nodeId);
        };

        const onThresholdUp = () => {
          if (!dragStarted) {
            document.removeEventListener('mousemove', onThresholdMove);
            document.removeEventListener('mouseup', onThresholdUp);
            this._dragThresholdCleanup = null;
          }
        };

        // L1: 注册清理函数，onClose 时调用
        this._dragThresholdCleanup = () => {
          document.removeEventListener('mousemove', onThresholdMove);
          document.removeEventListener('mouseup', onThresholdUp);
        };

        document.addEventListener('mousemove', onThresholdMove);
        document.addEventListener('mouseup', onThresholdUp);
      });
    }
  }

  /** P1: 开始拖拽 */
  private _startDrag(nodeId: string): void {
    this._dragNodeId = nodeId;
    const el = this.nodeElements.get(nodeId);
    if (!el) return;

    // 创建幽灵副本
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.style.opacity = '0.7';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    ghost.style.transition = 'none';
    ghost.classList.add('mf-node--dragging');
    this.canvasEl?.appendChild(ghost);
    this._dragGhostEl = ghost;

    // 全局 mousemove/mouseup (F1: 阈值已过，直接处理)
    const onMove = (e: MouseEvent) => {
      this._updateGhostPosition(e.clientX, e.clientY);
      this._updateDropTarget(e.clientX, e.clientY);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this._finishDrag();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** 更新幽灵元素位置 */
  private _updateGhostPosition(clientX: number, clientY: number): void {
    if (!this._dragGhostEl || !this.viewportEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const x = (clientX - rect.left - this.viewState.panX) / this.viewState.scale;
    const y = (clientY - rect.top - this.viewState.panY) / this.viewState.scale;
    this._dragGhostEl.style.left = `${x}px`;
    this._dragGhostEl.style.top = `${y}px`;
  }

  /** 检测拖拽悬停的目标节点 */
  private _updateDropTarget(clientX: number, clientY: number): void {
    if (!this.viewportEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const worldX = (clientX - rect.left - this.viewState.panX) / this.viewState.scale;
    const worldY = (clientY - rect.top - this.viewState.panY) / this.viewState.scale;

    // 清除上一次的高亮
    if (this._dragDropTargetId) {
      const oldEl = this.nodeElements.get(this._dragDropTargetId);
      oldEl?.classList.remove('mf-node--drop-target');
    }
    this._dragDropTargetId = null;

    // F11: 用 node.layout 数据碰撞检测（替代 DOM style 解析）
    if (!this.rootNode) return;
    const visibleNodes = getVisibleNodes(this.rootNode);
    for (const node of visibleNodes) {
      if (node.id === this._dragNodeId || !node.layout) continue;

      const nx = node.layout.x;
      const ny = node.layout.y;
      const nw = node.layout.width;
      const nh = node.layout.height;

      if (worldX >= nx && worldX <= nx + nw && worldY >= ny && worldY <= ny + nh) {
        // 不能拖到自身后代（防环）
        const dragNode = this._dragNodeId ? findNode(this.rootNode, this._dragNodeId) : null;
        if (dragNode && this._isDescendant(dragNode, node.id)) continue;

        // L3: 标注节点不能拖到标注节点下（防止嵌套标注）
        if (dragNode?.type === 'annotation' && node.type === 'annotation') continue;

        this._dragDropTargetId = node.id;
        const el = this.nodeElements.get(node.id);
        el?.classList.add('mf-node--drop-target');
        break;
      }
    }
  }

  /** 检查 targetId 是否是 node 的后代 */
  private _isDescendant(node: MindNode, targetId: string): boolean {
    for (const child of node.children) {
      if (child.id === targetId) return true;
      if (this._isDescendant(child, targetId)) return true;
    }
    return false;
  }

  /** 完成拖拽 — 执行 moveNode 或取消 */
  private async _finishDrag(): Promise<void> {
    try {
      // 清理幽灵
      if (this._dragGhostEl) {
        this._dragGhostEl.remove();
        this._dragGhostEl = null;
      }

      // 清理高亮
      if (this._dragDropTargetId) {
        const el = this.nodeElements.get(this._dragDropTargetId);
        el?.classList.remove('mf-node--drop-target');
      }

      const dragId = this._dragNodeId;
      const targetId = this._dragDropTargetId;
      this._dragNodeId = null;
      this._dragDropTargetId = null;

      if (!dragId || !targetId || !this.rootNode) return;

      // 执行移动
      this.undoRedo.snapshot('moveNode', this.rootNode, this.meta);
      const success = moveNode(this.rootNode, dragId, targetId);
      if (success) {
        this.eventBus.emit('operation', { name: 'moveNode', nodeId: dragId, data: { newParentId: targetId } });
        this.renderCache.clear();
        await this.layoutAndRender();
        this.selectNode(dragId);
      }
    } catch (err) {
      logger.error('MindFlow: _finishDrag failed', err);
      new Notice('Failed to complete drag operation');
    }
  }

  /** 选中节点 */
  private selectNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    this._multiSelectedIds.clear(); // 单选时清空多选
    this._applySelectionVisual();
    this.eventBus.emit('select', { nodeId });
  }

  /** Shift+点击切换多选 */
  private toggleMultiSelect(nodeId: string): void {
    if (this._multiSelectedIds.has(nodeId)) {
      this._multiSelectedIds.delete(nodeId);
    } else {
      this._multiSelectedIds.add(nodeId);
    }
    // 主选中设为最后操作的那个
    this.selectedNodeId = nodeId;
    this._applySelectionVisual();
    this.eventBus.emit('select', { nodeId });
  }

  /** 应用选中状态到 DOM */
  private _applySelectionVisual(): void {
    for (const [, el] of this.nodeElements) {
      el.classList.remove('mf-node--selected');
      el.classList.remove('mf-node--multi-selected');
    }
    if (this.selectedNodeId) {
      const el = this.nodeElements.get(this.selectedNodeId);
      el?.classList.add('mf-node--selected');
    }
    for (const id of this._multiSelectedIds) {
      if (id === this.selectedNodeId) continue;
      const el = this.nodeElements.get(id);
      el?.classList.add('mf-node--multi-selected');
    }
  }

  /** 获取当前参与外框操作的节点 ID 列表 */
  private _getBoundaryCandidateIds(): string[] {
    if (this._multiSelectedIds.size > 0) {
      return Array.from(this._multiSelectedIds);
    }
    return this.selectedNodeId ? [this.selectedNodeId] : [];
  }

  /** 折叠/展开 */
  private async toggleCollapse(nodeId: string): Promise<void> {
    if (!this.rootNode) return;
    const node = findNode(this.rootNode, nodeId);
    if (!node || node.children.length === 0) return;

    node.collapsed = !node.collapsed;
    this.eventBus.emit('collapse', { nodeId, collapsed: node.collapsed });
    await this.layoutAndRender();
  }

  // ═══════════════════════════════════════════════════════
  // 节点操作（参考 mind-elixir operation 模式）
  // ═══════════════════════════════════════════════════════

  /** 添加子节点（Tab） */
  private async handleInsertChild(): Promise<void> {
    try {
      if (!this.rootNode) return;

      const parentId = this.selectedNodeId ?? this.rootNode.id;
      const parent = findNode(this.rootNode, parentId);
      if (!parent) return;

      // undo 快照
      this.undoRedo.snapshot('insertChild', this.rootNode, this.meta);

      const newNode = createMindNode({
        id: generateId(),
        type: 'free',
        parentId: parent.id,
        text: 'New Node',
        children: [],
      });
      parent.children.push(newNode);

      this.eventBus.emit('operation', { name: 'insertChild', nodeId: newNode.id });
      await this.layoutAndRender();
      this.selectNode(newNode.id);

      // 自动进入编辑
      this.enterEditMode(newNode.id);
    } catch (err) {
      logger.error('MindFlow: handleInsertChild failed', err);
      new Notice('Failed to insert child node');
    }
  }

  /** 添加兄弟节点（Enter） */
  private async handleInsertSibling(): Promise<void> {
    try {
      if (!this.rootNode || !this.selectedNodeId) return;
      if (this.selectedNodeId === this.rootNode.id) {
        // 根节点没有兄弟 → 改为添加子节点
        this.handleInsertChild();
        return;
      }

      // undo 快照
      this.undoRedo.snapshot('insertSibling', this.rootNode, this.meta);

      const newNode = createMindNode({
        id: generateId(),
        type: 'free',
        parentId: null,
        text: 'New Node',
        children: [],
      });

      const result = insertSibling(this.rootNode, this.selectedNodeId, newNode);
      if (!result) {
        this.undoRedo.undo({ root: this.rootNode, meta: this.meta }); // 回滚快照
        return;
      }

      this.eventBus.emit('operation', { name: 'insertSibling', nodeId: newNode.id });
      await this.layoutAndRender();
      this.selectNode(newNode.id);
      this.enterEditMode(newNode.id);
    } catch (err) {
      logger.error('MindFlow: handleInsertSibling failed', err);
      new Notice('Failed to insert sibling node');
    }
  }

  /** 删除节点（Delete） */
  private async handleDeleteNode(): Promise<void> {
    try {
      if (!this.rootNode || !this.selectedNodeId) return;
      if (this.selectedNodeId === this.rootNode.id) return;

      const node = findNode(this.rootNode, this.selectedNodeId);
      // Phase 3: free + annotation 都可删除，只有 md-seed 不可删
      if (!node || node.type === 'md-seed') {
        new Notice('MD-Seed nodes cannot be deleted (edit the .md file instead)');
        return;
      }

      // undo 快照
      this.undoRedo.snapshot('removeNode', this.rootNode, this.meta);

      const deletedId = this.selectedNodeId;
      removeNode(this.rootNode, this.selectedNodeId);

      // R2-5: 清理引用了已删除节点的陈旧边界
      this._cleanupStaleBoundaries();

      this.eventBus.emit('operation', { name: 'removeNode', nodeId: deletedId });
      this.selectNode(null);
      await this.layoutAndRender();
    } catch (err) {
      logger.error('MindFlow: handleDeleteNode failed', err);
      new Notice('Failed to delete node');
    }
  }

  /** 编辑节点（F2 / 双击） */
  private handleEditNode(): void {
    if (!this.selectedNodeId) return;
    this.enterEditMode(this.selectedNodeId);
  }

  /**
   * 进入 contentEditable 编辑模式
   *
   * Phase 1.5: 使用 contentEditable 替代 prompt()
   * 参考 mind-elixir beginEdit/finishEdit 生命周期
   */
  private enterEditMode(nodeId: string): void {
    if (!this.rootNode) return;
    const node = findNode(this.rootNode, nodeId);
    if (!node) return;

    // Phase 3: md-seed + annotation 只读，只有 free 可编辑
    if (node.type === 'md-seed') {
      new Notice('MD-Seed nodes are read-only (edit the .md file instead)');
      return;
    }
    if (node.type === 'annotation') {
      new Notice('Annotation nodes are read-only (edit the source annotation)');
      return;
    }

    const el = this.nodeElements.get(nodeId);
    if (!el) return;

    // Phase 2: 使用渲染器的 enterEditMode
    enterEditMode(el, node);
    this.editingNodeId = nodeId;
    this.eventBus.emit('operation', { name: 'beginEdit', nodeId });

    const contentEl = el.querySelector('.mf-node__content') as HTMLElement;
    if (!contentEl) return;

    // P1-2: 移除上一次编辑的 keydown 监听器（防泄漏）
    if (this._editKeydownHandler) {
      contentEl.removeEventListener('keydown', this._editKeydownHandler);
      this._editKeydownHandler = null;
    }

    const finishEdit = async () => {
      if (this.editingNodeId !== nodeId) return;
      this.editingNodeId = null;

      // P1-2: 移除 keydown 监听器
      if (this._editKeydownHandler) {
        contentEl.removeEventListener('keydown', this._editKeydownHandler);
        this._editKeydownHandler = null;
      }

      // 用 innerText 而非 textContent——保留用户输入的换行格式
      const newText = contentEl.innerText?.trim() ?? '';
      exitEditMode(el);

      if (this.rootNode) {
        // newText 已 trim，用原始 node.text.trim() 比较以忽略内容前后的空白差异
        const textChanged = newText !== node.text && newText !== node.text.trim();
        if (textChanged) {
          this.undoRedo.snapshot('editNode', this.rootNode, this.meta);
          node.text = newText;
        }
        // 无论文本是否变化都重新渲染——编辑退出后必须从 raw MD → 渲染结果
        this.renderCache.clear();
        if (textChanged) {
          this.eventBus.emit('operation', { name: 'finishEdit', nodeId });
        }
        await this.layoutAndRender();
        this.selectNode(nodeId);
      }
    };

    // P1-2: 保存处理器引用以便后续移除
    this._editKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finishEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        contentEl.textContent = node.text; // 恢复原文本
        finishEdit();
      }
    };
    contentEl.addEventListener('keydown', this._editKeydownHandler);
    contentEl.addEventListener('blur', finishEdit, { once: true });
  }

  // ═══════════════════════════════════════════════════════
  // Undo / Redo
  // ═══════════════════════════════════════════════════════

  private handleUndo(): void {
    if (!this.rootNode) return;
    if (!this.undoRedo.canUndo()) {
      new Notice('Nothing to undo');
      return;
    }

    const snap = this.undoRedo.undo({ root: this.rootNode, meta: this.meta });
    if (!snap) return;

    this.applySnapshot(snap.freeRecords, snap.meta, snap.collapsedStates);
    logger.debug('MindFlow: undo', snap.label);
  }

  private handleRedo(): void {
    if (!this.rootNode) return;
    if (!this.undoRedo.canRedo()) {
      new Notice('Nothing to redo');
      return;
    }

    const snap = this.undoRedo.redo({ root: this.rootNode, meta: this.meta });
    if (!snap) return;

    this.applySnapshot(snap.freeRecords, snap.meta, snap.collapsedStates);
    logger.debug('MindFlow: redo', snap.label);
  }

  /**
   * 应用快照：用快照中的 Free 记录重建树
   *
   * P2-5: 不再重新读文件——文件内容未变，用缓存的 MD-Seed + 快照 Free 重建
   */
  private async applySnapshot(
    freeRecords: import('../types/mind-node').FreeNodeRecord[],
    meta: MindmapMeta,
    collapsedStates?: Record<string, boolean>,
  ): Promise<void> {
    try {
      if (!this.currentFile || !this.rootNode) return;

      // P2-5: 用缓存的内容重建，不重新读文件
      const content = await this.app.vault.read(this.currentFile);
      const result = syncFromMarkdown(content, this.currentFile.name.replace(/\.md$/i, ''));

      this.rootNode = result.root;
      this.meta = meta;
      // M2补1: 同步外框数据，避免 undo/redo 后渲染过时外框
      this._boundaries = meta.boundaries ?? [];
      this._connections = meta.connections ?? [];

      // P2-3: 恢复 collapsed 状态
      if (collapsedStates) {
        applyCollapsedStates(this.rootNode, collapsedStates);
      }

    this.renderCache.clear();
    await this.layoutAndRender();
    this.debouncedSave();
    } catch (err) {
      logger.error('MindFlow: applySnapshot failed', err);
      new Notice('Failed to apply undo/redo');
    }
  }

  // ═══════════════════════════════════════════════════════
  // 方向键导航（参考 mind-elixir 键盘导航）
  // ═══════════════════════════════════════════════════════

  private async navigate(direction: 'navigateUp' | 'navigateDown' | 'navigateLeft' | 'navigateRight'): Promise<void> {
    try {
      if (!this.rootNode || !this.selectedNodeId) return;

      const current = findNode(this.rootNode, this.selectedNodeId);
      if (!current) return;

      let target: MindNode | null = null;

    switch (direction) {
      case 'navigateLeft': {
        // → 父节点
        target = findParent(this.rootNode, this.selectedNodeId);
        break;
      }
      case 'navigateRight': {
        // → 第一个子节点
        if (current.children.length > 0) {
          if (current.collapsed) {
            current.collapsed = false;
            await this.layoutAndRender();
          }
          target = current.children[0];
        }
        break;
      }
      case 'navigateUp':
      case 'navigateDown': {
        // → 上/下兄弟节点
        const parent = findParent(this.rootNode, this.selectedNodeId);
        if (!parent) {
          // 根节点无兄弟
          break;
        }
        const idx = parent.children.findIndex((c) => c.id === this.selectedNodeId);
        if (direction === 'navigateUp' && idx > 0) {
          target = parent.children[idx - 1];
        } else if (direction === 'navigateDown' && idx < parent.children.length - 1) {
          target = parent.children[idx + 1];
        }
        break;
      }
    }

    if (target) {
      this.selectNode(target.id);
      this.scrollToNode(target.id);
    }
    } catch (err) {
      logger.error('MindFlow: navigate failed', err);
    }
  }

  /** 滚动到节点位置（使其可见） */
  private scrollToNode(nodeId: string): void {
    const el = this.nodeElements.get(nodeId);
    if (!el || !this.viewportEl) return;

    const layout = el.style;
    const x = parseFloat(layout.left) || 0;
    const y = parseFloat(layout.top) || 0;

    // 调整 pan 使节点出现在视口左上区域
    const padding = 100;
    this.viewState.panX = padding - x * this.viewState.scale;
    this.viewState.panY = padding - y * this.viewState.scale;
    this.applyTransform();
  }

  // ═══════════════════════════════════════════════════════
  // 公共 API
  // ═══════════════════════════════════════════════════════

  getCurrentFile(): TFile | null {
    return this.currentFile;
  }

  getRootNode(): MindNode | null {
    return this.rootNode;
  }
}
