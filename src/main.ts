import { Plugin, MarkdownView, TFile, Notice, type MarkdownPostProcessorContext } from 'obsidian';
import { logger } from './utils/logger';
import type { MarkVaultSettings, AnnotationType, Annotation, SpanRange } from './types/annotation';
import type { MarkVaultPluginInterface } from './utils/plugin-interface';
import { DEFAULT_SETTINGS, RelationSchema } from './types/annotation';
import { ActiveAnnotationState } from './plugin/active-state';
import { AnnotationCacheManager } from './plugin/cache-manager';
import { AnnotationSyncEngine } from './plugin/sync-engine';
import { AnnotationCreator } from './plugin/annotation-creator';
import { MARKVAULT_SIDEBAR_VIEW_TYPE, AnnotationSidebar } from './ui/sidebar/AnnotationSidebar';
import { MARKVAULT_GRAPH_VIEW_TYPE, RelationGraphView } from './ui/graph/RelationGraphView';
import { registerContextMenu, registerCommands, getBlockAnchorPrefixesForListItem, adjustRegionStartOffsetForListItem, adjustRegionEndOffsetForListItem } from './ui/editor/context-menu';
import { MarkVaultSettingTab } from './ui/settings/settings-tab';
import { syncFromMarkdown, getPlainTextForOffsetRecovery, extractContextFromContent } from './core/markdown-sync';
import { injectFormatRegistry } from './core/annotation-parser';
import { formatRegistry } from './format/format-registry';
import { initFormatRegistry } from './format/format-setup';
import {
  computeBlockSignature,
  computeSpanSignature,
  findBlockLineBySignature,
  findSpanLineBySignature,
  detectBlockTypeAtLine,
} from './core/block-fingerprint';
import {
  parseBlockAnchors,
  parseBlockDoubleAnchors,
  findBlockDoubleAnchorRange,
  findBlockTargetLine,
  findBlockContentEndLine,
  computeSpanRanges,
  findSpanEndLine,
  buildMarkTag,
  buildBlockAnchorStart,
  buildBlockAnchorEnd,
  buildSpanAnchor,
} from './core/annotation-parser';
import { scanMarkdownContexts, detectBlockAtLine, type BlockInfo } from './core/md-context';
import { markdownToPlainWithMap } from './core/markdown-plain';
import { markvaultDecorationPlugin, markvaultRegionLayer, setFilePathResolver, setActiveEditorView, removeEditorView, clearActiveEditorViews, requestRegionLayerRedraw, clearSpanCache, clearRegionCache, clearBlockCache, setAnnotationClickHandler } from './core/highlight-applier';
import { createOffsetTrackerExtension, applyIncrementalOffsetFix, type ChangeInfo } from './core/offset-tracker';
import { batchRecoverOffsets } from './core/offset-recovery';
import { buildAnnotation, finalizeAnnotation } from './core/annotation-creator';
import { AnnotationModal } from './ui/editor/annotation-modal';
import { initAnnotationStore, annotationStore } from './db/annotation-store';
import { getAnnotationByUuid } from './db/annotation-repo';
import { generateId } from './utils/id';
import { migrateFromIndexedDB } from './db/migration';

import { buildNativeAnnotation } from './core/native-annotation';
import { buildRegionAnchor, parseRegionAnnotations, REGION_ANCHOR_REGEX } from './core/region-annotation';
import { computeSignature } from './core/block-fingerprint';
import { updateSpanCacheForFile, clearSpanCacheForFile, type SpanAnnotationData, updateRegionCacheForFile, clearRegionCacheForFile, type RegionAnnotationData, getRegionCacheForFile, updateBlockCacheForFile, clearBlockCacheForFile, type BlockAnnotationData, getBlockCacheForFile } from './core/highlight-applier';

import { ModifyGuard } from './utils/modify-guard';
import { ReadingModeProcessor } from './plugin/reading-processor';
import { AnnotationSearchEngine } from './search/search-engine';

// ── MindFlow 思维导图模块 ──
import { MindFlowView, MINDFLOW_VIEW_TYPE } from './mindflow/view/mindflow-view';

// ── PDF 标注扩展模块 ──
import { PDFRenderer } from './pdf/pdf-renderer';
import { getActivePDFView, getPDFSelection, getPDFFromLeaf, isPDFLeaf, type PDFViewLike } from './pdf/viewer-bridge';
import { createPDFAnnotation } from './pdf/pdf-creator';
import { RendererRegistry } from './core/renderer';
import { getAnnotationsForFile } from './db/annotation-repo';

export default class MarkVaultPlugin extends Plugin implements MarkVaultPluginInterface {
  settings: MarkVaultSettings = DEFAULT_SETTINGS;
  /** v4.3: 关系类型 Schema 实例 — 从 settings 动态构建 */
  relationSchema: RelationSchema = new RelationSchema(DEFAULT_SETTINGS.customRelationTypes);
  private sidebar: AnnotationSidebar | null = null;
  /** v4.3 Phase 2: 关系图谱视图 */
  private graphView: RelationGraphView | null = null;

  // 🆕 PDF 标注扩展
  private pdfRenderer: PDFRenderer | null = null;
  private rendererRegistry: RendererRegistry = new RendererRegistry();
  private _currentPdfFilePath: string | null = null;

  // 当前活跃文件的路径，用于偏移修正（SyncEngine 需要读写）
  activeFilePath: string | null = null;

  // 🆕 防重入保护：当插件自身在修改文件时（创建标注、保存批注），
  // 阻止 onFileOpen() 重新触发 syncFromMarkdown()，避免竞态条件覆盖数据
  // per-file Map + 自动过期，比全局布尔值 + setTimeout 更安全
  public modifyGuard = new ModifyGuard(3000);

  // 🆕 防重入扩展：记录正在编辑的标注 uuid 集合
  // 委托给 ActiveAnnotationState 模块管理
  readonly activeState = new ActiveAnnotationState();

  // 🆕 缓存管理：委托给 AnnotationCacheManager 模块
  readonly cacheManager!: AnnotationCacheManager;

  // 🆕 同步引擎：委托给 AnnotationSyncEngine 模块
  readonly syncEngine!: AnnotationSyncEngine;

  // 🆕 标注创建：委托给 AnnotationCreator 模块
  readonly annotationCreator!: AnnotationCreator;

  // 🆕 阅读模式处理器
  readonly readingProcessor!: ReadingModeProcessor;

  // 🆕 公开暴露 AnnotationStore，供 MindFlow 等视图访问
  public annotationStore = annotationStore;

  // 🆕 AnnotationStore 是否初始化成功
  private _storeReady = false;

  // 🆕 搜索引擎实例（全文搜索 + Relation Picker）
  private _searchEngine: AnnotationSearchEngine | null = null;

  /** 检查 AnnotationStore 是否已就绪 */
  public isStoreReady(): boolean {
    return this._storeReady;
  }

  /** 获取搜索引擎实例（供 RelationPicker 等使用） */
  public getSearchEngine(): AnnotationSearchEngine {
    if (!this._searchEngine) {
      this._searchEngine = new AnnotationSearchEngine(annotationStore);
    }
    return this._searchEngine;
  }

  /** v4.3: 获取关系类型 Schema 实例 */
  public getRelationSchema(): RelationSchema {
    return this.relationSchema;
  }

  /** 注册一个标注为"正在编辑"状态，防止被 sync 覆盖 */
  public markAnnotationActive(uuid: string, filePath?: string) {
    this.activeState.markAnnotationActive(uuid, filePath);
  }

  /** 取消标注的"正在编辑"状态 */
  public unmarkAnnotationActive(uuid: string, filePath?: string) {
    this.activeState.unmarkAnnotationActive(uuid, filePath);
  }

  /** 检查一个标注是否正在被编辑 */
  public isAnnotationActive(uuid: string): boolean {
    return this.activeState.isAnnotationActive(uuid);
  }

  /** 检查某个文件是否有正在编辑的标注（同步，无需查询 DB） */
  public isFileEditing(filePath: string): boolean {
    return this.activeState.isFileEditing(filePath);
  }

  /** 注册当前打开的 AnnotationModal */
  public registerActiveAnnotationModal(uuid: string, modal: AnnotationModal): void {
    this.activeState.registerActiveAnnotationModal(uuid, modal);
  }

  /** 注销已关闭的 AnnotationModal */
  public unregisterActiveAnnotationModal(uuid: string): void {
    this.activeState.unregisterActiveAnnotationModal(uuid);
  }

  /** 关闭指定文件上所有打开的 AnnotationModal */
  public closeActiveModalsForFile(filePath: string): void {
    this.activeState.closeActiveModalsForFile(filePath);
  }

  /** 标记文件数据已一致，跳过 onFileOpen 的重复 sync（委托给 SyncEngine） */
  public markFileSynced(filePath: string): void {
    this.syncEngine.markFileSynced(filePath);
  }

  /**
   * 更新 span / block 标注缓存（委托给 CacheManager）
   */
  public async updateSpanCache(filePath: string): Promise<void> {
    return this.cacheManager.updateSpanCache(filePath);
  }

  /**
   * 更新 region 标注缓存（委托给 CacheManager）
   */
  public async updateRegionCache(filePath: string): Promise<void> {
    return this.cacheManager.updateRegionCache(filePath);
  }

  /**
   * 立即同步更新 region 缓存（委托给 CacheManager）
   */
  public updateRegionCacheImmediately(filePath: string, newAnnotation: Annotation): void {
    this.cacheManager.updateRegionCacheImmediately(filePath, newAnnotation);
  }

  /**
   * 立即同步更新 block 缓存（委托给 CacheManager）
   */
  public updateBlockCacheImmediately(filePath: string, newAnnotation: Annotation): void {
    this.cacheManager.updateBlockCacheImmediately(filePath, newAnnotation);
  }

  /**
   * 在编辑模式下选中 region 的内容范围（委托给 CacheManager）
   */
  public selectRegionInEditor(annotation: Annotation): boolean {
    return this.cacheManager.selectRegionInEditor(annotation);
  }

  async onload() {
    // 初始化子模块（需要 this 引用）
    (this as any).cacheManager = new AnnotationCacheManager(this.app);
    (this as any).syncEngine = new AnnotationSyncEngine(this);
    (this as any).annotationCreator = new AnnotationCreator(this);
    (this as any).readingProcessor = new ReadingModeProcessor(this);

    logger.debug('MarkVault: loading plugin...');

    // ── Phase G-2: 初始化 FormatRegistry 并注入到解析器 ──
    initFormatRegistry();
    injectFormatRegistry(formatRegistry);

    // ── PDF 标注扩展: 初始化渲染器 ──
    try {
      this.pdfRenderer = new PDFRenderer(this.app);
      this.pdfRenderer.setClickHandler((uuid: string) => {
        this.openAnnotationModal(uuid).catch((err) => {
          logger.error('PDF highlight click handler failed', err);
        });
      });
      this.rendererRegistry.register(this.pdfRenderer);
      logger.debug('MarkVault: PDF renderer registered');
    } catch (err) {
      logger.error('MarkVault: failed to initialize PDF renderer', err);
    }

    // ── 设置加载（最先执行，后续功能依赖设置） ──────────
    try {
      await this.loadSettings();
    } catch (err) {
      logger.error('MarkVault: failed to load settings, using defaults', err);
      this.settings = DEFAULT_SETTINGS;
    }

    // ── AnnotationStore 初始化（Phase 2: 分片 JSON + 内存索引） ──
    try {
      initAnnotationStore(this.app.vault);
      // v4.3: 注入关系类型 Schema（在 initialize 之前，确保所有操作使用自定义配置）
      annotationStore.setRelationSchema(this.relationSchema);
      await annotationStore.initialize();
      this._storeReady = true;
      const migratedCount = await migrateFromIndexedDB();
      if (migratedCount > 0) {
        logger.debug(`MarkVault: migrated ${migratedCount} annotations from IndexedDB`);
      }
    } catch (err) {
      logger.error('MarkVault: failed to initialize AnnotationStore', err);
      this._storeReady = false;
      new Notice('MarkVault: failed to initialize annotation database. Some features are disabled.', 8000);
    }

    // ── CM6 扩展注册 ──────────────────────────────
    try {
      // 注入文件路径解析器（供 highlight-applier 使用）
      setFilePathResolver(() => {
        const activeFile = this.app.workspace.getActiveFile();
        return activeFile ? activeFile.path : null;
      });

      // 🔧 P1-17 修复：注入编辑模式标注点击回调
      setAnnotationClickHandler((uuid: string) => {
        this.openAnnotationModal(uuid).catch((err) => {
          logger.error('MarkVault: openAnnotationModal from editor click failed', err);
        });
      });

      // 1. 标注高亮 Decoration Plugin
      this.registerEditorExtension(markvaultDecorationPlugin);

      // 2. Region 背景层 — RectangleMarker 几何覆盖层
      // 可覆盖代码块/公式块/图片等 CM6 Widget，Decoration.mark 无法触及
      this.registerEditorExtension(markvaultRegionLayer);

      // 3. 偏移追踪 Extension
      this.registerEditorExtension(
        createOffsetTrackerExtension((changes) => {
          this.readingProcessor.handleDocChange(changes);
        }),
      );
    } catch (err) {
      logger.error('MarkVault: failed to register CM6 extensions', err);
      // CM6 注册失败不应该阻止整个插件加载
      // 只是编辑模式下不会有高亮渲染
    }

    // ── Obsidian 事件注册 ─────────────────────────

    // 注册侧边栏视图
    try {
      this.registerView(
        MARKVAULT_SIDEBAR_VIEW_TYPE,
        (leaf) => {
          this.sidebar = new AnnotationSidebar(leaf);
          this.sidebar.setPluginInstance(this);
          return this.sidebar;
        },
      );
    } catch (err) {
      logger.error('MarkVault: failed to register sidebar view', err);
    }

    // 注册关系图谱视图
    try {
      this.registerView(
        MARKVAULT_GRAPH_VIEW_TYPE,
        (leaf) => {
          this.graphView = new RelationGraphView(leaf);
          this.graphView.setPluginInstance(this);
          return this.graphView;
        },
      );
    } catch (err) {
      logger.error('MarkVault: failed to register graph view', err);
    }

    // 注册 MindFlow 思维导图视图
    try {
      this.registerView(
        MINDFLOW_VIEW_TYPE,
        (leaf) => new MindFlowView(leaf),
      );
      logger.debug('MarkVault: MindFlow view registered');
    } catch (err) {
      logger.error('MarkVault: failed to register MindFlow view', err);
    }

    // 添加侧边栏图标
    try {
      this.addRibbonIcon('pen-tool', 'MarkVault-JS', () => {
        this.activateSidebar();
      });
    } catch (err) {
      logger.error('MarkVault: failed to add ribbon icon', err);
    }

    // 添加关系图谱图标
    try {
      this.addRibbonIcon('git-branch', 'MarkVault Relation Graph', () => {
        this.activateGraphView();
      });
    } catch (err) {
      logger.error('MarkVault: failed to add graph ribbon icon', err);
    }

    // 添加 MindFlow 图标
    try {
      this.addRibbonIcon('network', 'MindFlow MindMap', () => {
        this.activateMindFlowView();
      });
    } catch (err) {
      logger.error('MarkVault: failed to add MindFlow ribbon icon', err);
    }

    // 注册命令（最关键 — 必须成功）
    try {
      registerCommands(this);
      logger.debug('MarkVault: commands registered');
    } catch (err) {
      logger.error('MarkVault: failed to register commands', err);
    }

    // 注册 MindFlow 命令
    try {
      this.addCommand({
        id: 'mindflow-create',
        name: 'MindFlow: Create new mindmap',
        callback: async () => {
          await this.createMindFlowFile();
        },
      });

      this.addCommand({
        id: 'mindflow-open',
        name: 'MindFlow: Open mindmap for current file',
        callback: async () => {
          await this.activateMindFlowView();
        },
      });

      logger.debug('MarkVault: MindFlow commands registered');
    } catch (err) {
      logger.error('MarkVault: failed to register MindFlow commands', err);
    }

    // 注册 PDF 标注命令
    try {
      this.addCommand({
        id: 'pdf-create-highlight',
        name: 'PDF: Create highlight from selection',
        callback: async () => {
          await this.createPDFHighlightFromSelection();
        },
      });

      logger.debug('MarkVault: PDF commands registered');
    } catch (err) {
      logger.error('MarkVault: failed to register PDF commands', err);
    }

    // 注册右键菜单
    if (this.settings.showContextMenu) {
      try {
        registerContextMenu(this);
      } catch (err) {
        logger.error('MarkVault: failed to register context menu', err);
      }
    }

    // 注册设置页
    try {
      this.addSettingTab(new MarkVaultSettingTab(this.app, this));
    } catch (err) {
      logger.error('MarkVault: failed to register settings tab', err);
    }

    // 文件打开时同步标注
    try {
      this.registerEvent(
        this.app.workspace.on('file-open', async (file) => {
          if (file instanceof TFile && file.extension === 'md') {
            this.activeFilePath = file.path;
            await this.onFileOpen(file);
          } else if (file instanceof TFile && file.extension === 'pdf') {
            // PDF 文件打开: 挂载渲染器并加载标注
            this.activeFilePath = file.path;
            await this.handlePDFOpen(file);
          } else {
            // 离开 PDF 视图时卸载渲染器
            if (this._currentPdfFilePath) {
              this.unmountPDFRenderer();
            }
            this.activeFilePath = null;
          }
        }),
      );
    } catch (err) {
      logger.error('MarkVault: failed to register file-open handler', err);
    }

    // 🆕 文件删除时清理关联标注
    try {
      this.registerEvent(
        this.app.vault.on('delete', async (file) => {
          await this.syncEngine.handleFileDelete(file);
        }),
      );
    } catch (err) {
      logger.error('MarkVault: failed to register delete handler', err);
    }

    // 🆕 文件重命名时同步更新标注路径
    try {
      this.registerEvent(
        this.app.vault.on('rename', async (file, oldPath) => {
          await this.syncEngine.handleFileRename(file, oldPath);
        }),
      );
    } catch (err) {
      logger.error('MarkVault: failed to register rename handler', err);
    }

    // 🆕 当前文件/视图变化时刷新缓存（用于切换标签页、阅读/编辑模式切换）
    // 只做轻量级缓存刷新，不做全量 sync，避免 vault.modify 后重复昂贵同步。
    try {
      this.registerEvent(
        this.app.workspace.on('active-leaf-change', async () => {
          await this.syncEngine.handleActiveLeafChange();
        }),
      );
    } catch (err) {
      logger.error('MarkVault: failed to register active-leaf-change handler', err);
    }

    // 阅读模式渲染：PostProcessor + 工具条 + 点击委托 — 委托给 ReadingModeProcessor
    this.readingProcessor.registerPostProcessor();
    this.readingProcessor.setupReadingModeUI();

    // 🆕 尝试从磁盘加载搜索引擎索引（避免启动时全量重建）
    await this._loadSearchIndex();

    logger.info('plugin loaded successfully');
  }

  async onunload() {
    logger.info('unloading plugin');
    // 🔧 BUG-8 修复：立即清除 CM6 EditorView 引用，防止异步 dispatch 到已销毁的 view
    // 🔧 P0-1 修复：使用 clearActiveEditorViews() 彻底清空 Set
    clearActiveEditorViews();
    // 🔧 Phase H 修复：清除模块级缓存和闭包引用，防止热重载后脏数据
    setFilePathResolver(null);
    setAnnotationClickHandler(null);
    clearSpanCache();
    clearRegionCache();
    clearBlockCache();
    try {
      // 🆕 持久化搜索引擎索引
      await this._saveSearchIndex();
      this.readingProcessor.destroy();
      this.modifyGuard.releaseAll();
      await annotationStore.shutdown();
      // 🔧 Phase H 修复：清除实例引用，帮助 GC 及时回收
      this.sidebar = null as any;
      this.graphView = null as any;
      this.activeFilePath = null;
      this._searchEngine = null;
    } catch (err) {
      logger.error('MarkVault: failed to shutdown AnnotationStore', err);
    }
  }

  // 🆕 搜索引擎索引持久化（避免启动时全量重建倒排索引）

  /** 索引文件路径（插件目录下） */
  private get _searchIndexPath(): string {
    return `${(this.app.vault.adapter as any).getBasePath?.() ?? ''}.obsidian/plugins/markvault-js/search-index.json`;
  }

  /** 从磁盘加载搜索索引快照 */
  private async _loadSearchIndex(): Promise<void> {
    try {
      const indexPath = '.obsidian/plugins/markvault-js/search-index.json';
      if (!(await this.app.vault.adapter.exists(indexPath))) return;

      const raw = await this.app.vault.adapter.read(indexPath);
      const snapshot = JSON.parse(raw);
      if (snapshot?.version !== 1) return; // 版本不匹配

      this.getSearchEngine().importIndex(snapshot);
      logger.debug(`MarkVault: loaded search index (${snapshot.indexedCount} annotations)`);
    } catch (err) {
      // 加载失败非致命——走正常的 _ensureIndex 延迟重建
      logger.warn('MarkVault: failed to load search index, will rebuild on first search', err);
    }
  }

  /** 保存搜索索引快照到磁盘 */
  private async _saveSearchIndex(): Promise<void> {
    if (!this._searchEngine) return;
    try {
      const snapshot = this._searchEngine.exportIndex();
      const indexPath = '.obsidian/plugins/markvault-js/search-index.json';
      await this.app.vault.adapter.write(indexPath, JSON.stringify(snapshot));
      logger.debug('MarkVault: saved search index');
    } catch (err) {
      logger.error('MarkVault: failed to save search index', err);
    }
  }

  // ─── 设置 ──────────────────────────────────────

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // v4.3: 兼容旧设置 — 如果没有 customRelationTypes，填充默认值
    if (!this.settings.customRelationTypes || this.settings.customRelationTypes.length === 0) {
      this.settings.customRelationTypes = DEFAULT_SETTINGS.customRelationTypes;
    }

    // v5.14: 兼容旧设置 — customTemplates 为 undefined 时初始化为空数组
    if (!this.settings.customTemplates) {
      this.settings.customTemplates = [];
    }

    // v6.1: 同步 knownGroups 到 annotation-repo
    const { setKnownGroups } = await import('./db/annotation-repo');
    setKnownGroups(this.settings.knownGroups ?? []);

    // v4.3: 重建 RelationSchema（设置加载后必须重建）
    this.relationSchema = new RelationSchema(this.settings.customRelationTypes);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ─── 侧边栏 ───────────────────────────────────

  async activateSidebar() {
    try {
      const existing = this.app.workspace.getLeavesOfType(MARKVAULT_SIDEBAR_VIEW_TYPE);
      if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        return;
      }
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: MARKVAULT_SIDEBAR_VIEW_TYPE,
          active: true,
        });
        this.app.workspace.revealLeaf(rightLeaf);
      }
    } catch (err) {
      logger.error('MarkVault: failed to activate sidebar', err);
    }
  }

  async refreshSidebar() {
    try {
      if (this.sidebar) {
        await this.sidebar.refresh();
      }
    } catch (err) {
      logger.error('MarkVault: failed to refresh sidebar', err);
    }
    // P2-7: 标注变更后同时刷新关系图谱
    this.refreshGraphView();
  }

  /** 激活关系图谱视图 */
  async activateGraphView() {
    try {
      const existing = this.app.workspace.getLeavesOfType(MARKVAULT_GRAPH_VIEW_TYPE);
      if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        if (this.graphView) {
          this.graphView.refresh();
        }
        return;
      }
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: MARKVAULT_GRAPH_VIEW_TYPE,
          active: true,
        });
        this.app.workspace.revealLeaf(leaf);
      }
    } catch (err) {
      logger.error('MarkVault: failed to activate graph view', err);
    }
  }

  /** 刷新关系图谱视图 */
  refreshGraphView() {
    try {
      if (this.graphView) {
        this.graphView.refresh();
      }
    } catch (err) {
      logger.error('MarkVault: failed to refresh graph view', err);
    }
  }

  // ─── MindFlow 思维导图 ────────────────────────

  /** 激活 MindFlow 视图（加载当前活动文件） */
  async activateMindFlowView() {
    try {
      const existing = this.app.workspace.getLeavesOfType(MINDFLOW_VIEW_TYPE);
      if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        // 重新加载当前文件
        const view = existing[0].view;
        if (view instanceof MindFlowView) {
          const activeFile = this.app.workspace.getActiveFile();
          if (activeFile && activeFile.extension === 'md') {
            await view.loadFile(activeFile);
          }
        }
        return;
      }

      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: MINDFLOW_VIEW_TYPE,
          active: true,
        });
        this.app.workspace.revealLeaf(leaf);
      }
    } catch (err) {
      logger.error('MarkVault: failed to activate MindFlow view', err);
      new Notice('Failed to open MindFlow view');
    }
  }

  /** 创建新的 MindFlow 导图文件 */
  async createMindFlowFile() {
    try {
      // 生成文件名
      const timestamp = new Date().toISOString().slice(0, 10);
      const fileName = `MindMap-${timestamp}.md`;

      // 默认导图内容
      const defaultContent = `# New MindMap\n\n## Topic 1\n\n- Idea A\n- Idea B\n\n## Topic 2\n`;

      // 创建文件
      const file = await this.app.vault.create(fileName, defaultContent);
      logger.debug('MindFlow: created file', file.path);

      // 在编辑器中打开文件
      await this.app.workspace.openLinkText(file.path, '', false);

      // 激活 MindFlow 视图
      await this.activateMindFlowView();

      new Notice(`MindFlow: created ${fileName}`);
    } catch (err) {
      logger.error('MarkVault: failed to create MindFlow file', err);
      new Notice('Failed to create mindmap file');
    }
  }

  // ─── 文件打开时同步 ────────────────────────────

  async onFileOpen(file: TFile) {
    return this.syncEngine.onFileOpen(file);
  }

  // ─── PDF 标注扩展 ────────────────────────────────────

  /**
   * PDF 文件打开时: 等待 DOM 渲染完成后挂载渲染器并加载已有标注。
   * 用轮询检测替代硬编码延迟，确保 PDF.js DOM 就绪后再挂载。
   */
  async handlePDFOpen(file: TFile): Promise<void> {
    // 如果切换到不同的 PDF，先卸载旧的
    if (this._currentPdfFilePath && this._currentPdfFilePath !== file.path) {
      this.unmountPDFRenderer();
    }

    this._currentPdfFilePath = file.path;

    // 轮询检测 PDF.js DOM 就绪（最多等待 3 秒）
    const pdfView = await this.waitForPDFViewReady(3000);
    if (!pdfView) {
      logger.debug('MarkVault: PDF view not ready after 3s, will retry on next event');
      return;
    }

    // 加载该 PDF 文件的所有标注
    const annotations = await getAnnotationsForFile(file.path);
    logger.debug(`MarkVault: loaded ${annotations.length} PDF annotations for ${file.path}`);

    // 挂载渲染器
    if (this.pdfRenderer) {
      try {
        this.pdfRenderer.mount(pdfView.containerEl, annotations);
        logger.debug('MarkVault: PDF renderer mounted');
      } catch (err) {
        logger.error('MarkVault: failed to mount PDF renderer', err);
      }
    }

    // 刷新侧边栏以显示 PDF 标注
    await this.refreshSidebar();
  }

  /**
   * 轮询检测 PDF 视图 DOM 就绪。
   * PDF.js 异步渲染页面元素，硬编码延迟不可靠。
   */
  private async waitForPDFViewReady(timeoutMs: number): Promise<PDFViewLike | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const pdfView = getActivePDFView(this.app);
      if (pdfView) {
        // 检查是否有至少一个页面元素已渲染
        const hasPage = pdfView.containerEl.querySelector('[data-page-number], .page');
        if (hasPage) {
          return pdfView;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return getActivePDFView(this.app); // 最后尝试一次
  }

  /** 卸载 PDF 渲染器 */
  unmountPDFRenderer(): void {
    if (this.pdfRenderer) {
      try {
        this.pdfRenderer.unmount();
        logger.debug('MarkVault: PDF renderer unmounted');
      } catch (err) {
        logger.error('MarkVault: failed to unmount PDF renderer', err);
      }
    }
    this._currentPdfFilePath = null;
  }

  /**
   * 从当前 PDF 选区创建高亮标注。
   * 用户在 PDF 中选中文本后执行此命令。
   */
  async createPDFHighlightFromSelection(): Promise<void> {
    if (!this._storeReady) {
      new Notice('MarkVault: annotation database not initialized', 5000);
      return;
    }

    const pdfView = getActivePDFView(this.app);
    if (!pdfView) {
      new Notice('MarkVault: no active PDF view', 3000);
      return;
    }

    const filePath = this._currentPdfFilePath;
    if (!filePath) {
      new Notice('MarkVault: no PDF file is open', 3000);
      return;
    }

    // 从选区提取 PDF 标注信息
    const selection = getPDFSelection(pdfView);
    if (!selection) {
      new Notice('MarkVault: no text selected in PDF. Select text first.', 3000);
      return;
    }

    // 创建标注
    const annotation = await createPDFAnnotation({
      filePath,
      selection,
      type: 'highlight',
      color: 'yellow',
    });

    if (!annotation) {
      new Notice('MarkVault: failed to create PDF annotation', 3000);
      return;
    }

    // 更新渲染器
    if (this.pdfRenderer) {
      const allAnns = await getAnnotationsForFile(filePath);
      this.pdfRenderer.update(allAnns);
    }

    // 刷新侧边栏
    await this.refreshSidebar();

    new Notice(`MarkVault: PDF highlight created on page ${selection.page + 1}`, 2000);
    logger.debug(`MarkVault: PDF highlight created: ${annotation.uuid}`);
  }

  /**
   * 强制同步当前文件：
   * 1. 从 Markdown 同步元数据（note / tags / color / type / fields / targetHash）
   * 2. 对行内标注执行偏移恢复
   * 3. 对 block/span 标注执行目标位置恢复（基于 targetHash 指纹）
   * 4. 更新 span 缓存并刷新侧边栏
   */
  async forceSyncFile(filePath: string): Promise<{
    added: number;
    updated: number;
    inlineRecovered: number;
    blocksRecovered: number;
    spansRecovered: number;
    failed: number;
  }> {
    return this.syncEngine.forceSyncFile(filePath);
  }

  /** 调度侧边栏刷新，使用 requestAnimationFrame 并去重 */
  scheduleSidebarRefresh(): void {
    this.syncEngine.scheduleSidebarRefresh();
  }

  // ─── 数据管理 ──────────────────────────────────

  async rebuildDatabase() {
    if (!this._storeReady) {
      new Notice('MarkVault: annotation database not initialized', 5000);
      return;
    }

    logger.info('rebuilding database...');
    let total = 0;
    let skipped = 0;

    try {
      const markdownFiles = this.app.vault.getMarkdownFiles();

      for (const file of markdownFiles) {
        try {
          const content = await this.app.vault.read(file);
          const result = await syncFromMarkdown(content, file.path);
          total += result.added;
        } catch (err) {
          skipped++;
          logger.warn(`MarkVault: rebuild skipped ${file.path}`, err);
        }
      }

      logger.debug(`MarkVault: rebuilt database, ${total} annotations added, ${skipped} files skipped`);
      new Notice(`MarkVault: rebuilt database — ${total} added, ${skipped} skipped`, 4000);
      await this.refreshSidebar();
    } catch (err) {
      logger.error('MarkVault: rebuild database error', err);
      new Notice('MarkVault: failed to rebuild database', 5000);
    }
  }

  async exportAnnotations() {
    if (!this._storeReady) {
      new Notice('MarkVault: annotation database not initialized', 5000);
      return;
    }

    try {
      const annotations = await annotationStore.getAllAnnotations();
      const json = JSON.stringify(annotations, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `markvault-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.error('MarkVault: export error', err);
    }
  }

  // ─── 标注交互 ──────────────────────────────────

  /**
   * 通过 uuid 打开标注编辑 Modal
   * 支持阅读模式点击标注 → 编辑批注
   */
  async openAnnotationModal(uuid: string) {
    try {
      const annotation = await annotationStore.getAnnotationByUuid(uuid);
      if (!annotation) {
        logger.warn('MarkVault: annotation not found for uuid', uuid);
        return;
      }

      // 标记此标注为"正在编辑"状态
      this.markAnnotationActive(uuid, annotation.filePath);

      const modal = new AnnotationModal(
        this.app,
        this,
        annotation,
        async (_updated) => {
          // 保存回调
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          await this.refreshSidebar();
        },
        async (_deletedUuid) => {
          // 🔧 审计修复：Modal 已处理 MD 移除，回调只做清理
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          // 标记文件已同步（Modal 中 modifyGuard 已释放）
          this.markFileSynced(annotation.filePath);
          await this.updateSpanCache(annotation.filePath);
      await this.updateRegionCache(annotation.filePath);
          await this.refreshSidebar();
        },
      );

      // 注册打开的 Modal，便于文件删除/重命名时自动关闭
      this.registerActiveAnnotationModal(uuid, modal);

      // Modal 关闭时如果没有触发回调（如按 Esc），也取消保护
      // 使用 Modal 的 onClose 生命周期钩子
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        this.unregisterActiveAnnotationModal(uuid);
        this.unmarkAnnotationActive(uuid, annotation.filePath);
        originalOnClose();
      };

      modal.open();
    } catch (err) {
      logger.error('MarkVault: failed to open annotation modal', err);
    }
  }

  // ─── 阅读模式创建标注 ──────────────────────

  /** 获取默认高亮颜色（供 ReadingModeProcessor 使用） */
  public getDefaultColor(): string {
    return this.settings.defaultHighlightColor;
  }

  /** 在阅读模式下创建标注（委托给 AnnotationCreator） */
  async createReadingAnnotation(selectedText: string, color: string, type: AnnotationType = 'highlight', kind: Annotation['kind'] = 'inline') {
    return this.annotationCreator.createReadingAnnotation(selectedText, color, type, kind);
  }

  /** 在源文件中查找选中文本的偏移（委托给 AnnotationCreator） */
  public findBestTextOffset(content: string, selectedText: string): { startOffset: number; endOffset: number } | null {
    return this.annotationCreator.findBestTextOffset(content, selectedText);
  }
}
