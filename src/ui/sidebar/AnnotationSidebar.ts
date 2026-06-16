import { ItemView, WorkspaceLeaf, MarkdownView, TFile, Component, Notice } from 'obsidian';
import type { Annotation, AnnotationFilter } from '../../types/annotation';
import {
  getAnnotationsForFile,
  queryAnnotations,
  deleteAnnotation,
  addAnnotation,
  getAllAnnotations,
  getAnnotationByUuid,
  getRelations,
} from '../../db/annotation-repo';
import { debounce } from '../../utils/debounce';
import { applyUnifiedFilter, hasActiveFilters } from '../../search/filter-engine';
import { AnnotationModal } from '../editor/annotation-modal';
import { removeMarkTag, removeBlockAnchor, removeSpanAnchor } from '../../core/annotation-parser';
import { removeNativeAnnotation } from '../../core/native-annotation';
import { removeRegionAnnotation } from '../../core/region-annotation';
import { StatsView } from './views/StatsView';
import { CurrentFileToolbar } from './components/CurrentFileToolbar';
import { FilterBar } from './components/FilterBar';
import { BatchBar } from './components/BatchBar';
import { AllNotesView, type AllNotesSubView } from './views/AllNotesView';
import { AnnotationCard } from './components/AnnotationCard';

export const MARKVAULT_SIDEBAR_VIEW_TYPE = 'markvault-sidebar';

/** 侧边栏 Tab 类型 */
type SidebarTab = 'current' | 'all' | 'stats';

export class AnnotationSidebar extends ItemView {
  private filter: AnnotationFilter = {
    type: 'all',
    color: 'all',
    sortBy: 'position',
  };

  private currentFilePath: string | null = null;
  private containerEl_: HTMLElement | null = null;
  private component_: Component | null = null;

  // 视图状态
  private activeTab: SidebarTab = 'current';
  private allNotesSubView: AllNotesSubView = 'timeline';
  private searchQuery: string = '';
  private selectedUuids: Set<string> = new Set();
  private batchMode: boolean = false;

  // 缓存
  private allAnnotationsCache: Annotation[] = [];

  // Phase 3: 字段过滤状态
  private fieldFilterEntries: Array<{ key: string; value: string }> = [];

  // Plugin 实例引用（用于访问 modifyGuard 等保护机制）
  private pluginInstance: import('../../utils/plugin-interface').MarkVaultPluginInterface | null = null;

  private statsView: StatsView;
  private currentFileToolbar: CurrentFileToolbar;
  private filterBar: FilterBar;
  private batchBar: BatchBar;
  private allNotesView: AllNotesView;
  private annotationCard: AnnotationCard;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.statsView = new StatsView({
      jumpToAnnotation: (ann) => this.jumpToAnnotation(ann),
    });
    this.currentFileToolbar = new CurrentFileToolbar({
      app: this.app,
      getCurrentFilePath: () => this.currentFilePath,
      getPluginInstance: () => this.pluginInstance,
      removeAnnotationFromContent: (content, ann) => this.removeAnnotationFromContent(content, ann),
      onCleared: (filePath) => this.onFileCleared(filePath),
      syncCurrentFile: async (filePath) => {
        const plugin = this.pluginInstance;
        if (!plugin) throw new Error('MarkVault: plugin not initialized');
        return plugin.forceSyncFile(filePath);
      },
    });
    this.filterBar = new FilterBar({
      filter: this.filter,
      fieldFilterEntries: this.fieldFilterEntries,
      refreshListOnly: () => this.refreshListOnly(),
    });
    this.batchBar = new BatchBar({
      app: this.app,
      getPluginInstance: () => this.pluginInstance,
      selectedUuids: this.selectedUuids,
      getActiveTab: () => this.activeTab,
      getCurrentFilePath: () => this.currentFilePath,
      getFilter: () => this.filter,
      renderContent: () => this.renderContent(),
    });
    this.allNotesView = new AllNotesView({
      app: this.app,
      isBatchMode: () => this.batchMode,
      getAllNotesSubView: () => this.allNotesSubView,
      setAllNotesSubView: (view) => { this.allNotesSubView = view; },
      getAllAnnotations: () => getAllAnnotations(),
      applySearchFilter: (anns) => this.applySearchFilter(anns),
      renderAnnotationCard: (container, ann, showFilePath) => this.renderAnnotationCard(container, ann, showFilePath),
      renderFilterBar: (container) => this.renderFilterBar(container),
      renderBatchBar: (container) => this.renderBatchBar(container),
      renderContent: () => this.renderContent(),
    });
    this.annotationCard = new AnnotationCard({
      app: this.app,
      isBatchMode: () => this.batchMode,
      selectedUuids: this.selectedUuids,
      fieldFilterEntries: this.fieldFilterEntries,
      getBatchCountElement: () => this.containerEl_?.querySelector('#markvault-batch-count') as HTMLElement | null,
      getMarkdownComponent: () => this.component_,
      getPluginInstance: () => this.pluginInstance,
      formatRelativeTime: (date) => this.formatRelativeTime(date),
      onEdit: (ann) => this.editAnnotation(ann),
      onJump: (ann) => this.jumpToAnnotation(ann),
      onDelete: (ann) => this.deleteAnnotationWithConfirm(ann),
      refreshListOnly: () => this.refreshListOnly(),
    });
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.onFileChange();
      }),
    );
  }

  /**
   * 设置 plugin 实例引用。
   * 在 main.ts 注册视图时调用，避免硬编码插件 ID。
   */
  setPluginInstance(plugin: import('../../utils/plugin-interface').MarkVaultPluginInterface): void {
    this.pluginInstance = plugin;
  }

  getViewType(): string {
    return MARKVAULT_SIDEBAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'MarkVault';
  }

  getIcon(): string {
    return 'pen-tool';
  }

  async onOpen() {
    this.containerEl_ = this.containerEl.children[1] as HTMLElement;
    this.containerEl_.empty();
    this.containerEl_.addClass('markvault-sidebar');
    this.onFileChange();
  }

  async onClose() {
    if (this.component_) {
      this.component_.unload();
      this.component_ = null;
    }
  }

  private async onFileChange() {
    const activeFile = this.app.workspace.getActiveFile();
    const newFilePath = activeFile?.path ?? null;

    if (newFilePath !== this.currentFilePath) {
      this.currentFilePath = newFilePath;
      if (this.activeTab === 'current') {
        await this.renderContent();
      }
    }
  }

  // ─── 主渲染 ────────────────────────────────────────────

  async render() {
    await this.renderContent();
  }

  private async renderContent() {
    if (!this.containerEl_) return;
    this.containerEl_.empty();

    if (this.component_) {
      this.component_.unload();
    }
    this.component_ = new Component();
    this.component_.load();

    this.selectedUuids.clear();
    this.batchMode = false;
    this.fieldFilterEntries = [];

    // ── Tab 栏 ──
    this.renderTabBar();

    // ── 搜索框 ──
    this.renderSearchBar();

    // ── 内容区 ──
    const contentArea = this.containerEl_.createDiv({ cls: 'markvault-content-area' });

    switch (this.activeTab) {
      case 'current':
        await this.renderCurrentNoteView(contentArea);
        break;
      case 'all':
        await this.renderAllNotesView(contentArea);
        break;
      case 'stats':
        await this.renderStatsView(contentArea);
        break;
    }
  }

  // ─── Tab 栏 ─────────────────────────────────────────────

  private renderTabBar() {
    const tabBar = this.containerEl_!.createDiv({ cls: 'markvault-tab-bar' });

    const tabs: Array<{ id: SidebarTab; icon: string; label: string }> = [
      { id: 'current', icon: '📄', label: 'Current' },
      { id: 'all', icon: '📚', label: 'All Notes' },
      { id: 'stats', icon: '📊', label: 'Stats' },
    ];

    for (const tab of tabs) {
      const btn = tabBar.createEl('button', {
        cls: `markvault-tab-btn ${this.activeTab === tab.id ? 'active' : ''}`,
      });
      btn.createSpan({ text: tab.icon, cls: 'markvault-tab-icon' });
      btn.createSpan({ text: tab.label, cls: 'markvault-tab-label' });
      btn.addEventListener('click', async () => {
        this.activeTab = tab.id;
        await this.renderContent();
      });
    }

    // 图谱快捷入口 — 打开 Relation Graph 视图
    const graphBtn = tabBar.createEl('button', {
      cls: 'markvault-tab-btn markvault-graph-tab-btn',
      attr: { 'aria-label': 'Open Relation Graph' },
    });
    graphBtn.createSpan({ text: '🔗', cls: 'markvault-tab-icon' });
    graphBtn.createSpan({ text: 'Graph', cls: 'markvault-tab-label' });
    graphBtn.addEventListener('click', () => {
      if (this.pluginInstance) {
        (this.pluginInstance as any).activateGraphView();
      }
    });
  }

  // ─── 搜索栏 ─────────────────────────────────────────────

  private renderSearchBar() {
    const searchBar = this.containerEl_!.createDiv({ cls: 'markvault-search-bar' });

    const input = searchBar.createEl('input', {
      type: 'text',
      placeholder: 'Search annotations...',
      cls: 'markvault-search-input',
      value: this.searchQuery,
    });

    input.addEventListener('input', debounce(async () => {
      this.searchQuery = input.value;
      await this.refreshListOnly();
    }, 300));

    // 批量操作按钮
    const batchToggle = searchBar.createEl('button', {
      cls: `markvault-batch-toggle ${this.batchMode ? 'active' : ''}`,
      text: '☑️',
      title: 'Batch mode',
    });
    batchToggle.addEventListener('click', async () => {
      this.batchMode = !this.batchMode;
      batchToggle.toggleClass('active', this.batchMode);
      await this.renderContent(); // 🔧 P0 修复：批量栏需要 renderContent 才显示
    });
  }

  // ─── 当前笔记视图 ──────────────────────────────────────

  // ─── 当前文件工具栏 ──────────────────────────────────

  /** 渲染当前文件操作工具栏（文件名 + 清空标注按钮） */
  private renderCurrentFileToolbar(container: HTMLElement) {
    this.currentFileToolbar.render(container);
  }

  /** 当前文件清空后的清理回调 */
  private async onFileCleared(filePath: string) {
    await this.pluginInstance?.updateSpanCache(filePath);
    await this.refreshListOnly();
  }

  private async renderCurrentNoteView(container: HTMLElement) {
    if (!this.currentFilePath) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'Open a file to see its annotations' });
      return;
    }

    // 文件名工具栏 — 清空标注按钮
    this.renderCurrentFileToolbar(container);

    // 过滤栏
    const filterBar = container.createDiv({ cls: 'markvault-filter-section' });
    this.renderFilterBar(filterBar);

    // 批量操作栏
    if (this.batchMode) {
      this.renderBatchBar(container);
    }

    // 标注列表
    const listContainer = container.createDiv({ cls: 'markvault-sidebar-list' });
    listContainer.id = 'markvault-list-container';

    await this.loadAndRenderAnnotations(listContainer, this.currentFilePath);
  }

  // ─── 全部笔记视图 ──────────────────────────────────────

  private async renderAllNotesView(container: HTMLElement) {
    await this.allNotesView.render(container);
  }

  // ─── 统计视图 ───────────────────────────────────────────

  private async renderStatsView(container: HTMLElement) {
    this.allAnnotationsCache = await getAllAnnotations();
    this.statsView.render(container, this.allAnnotationsCache);
  }

  // ─── 过滤栏 ─────────────────────────────────────────────

  private renderFilterBar(container: HTMLElement) {
    this.filterBar.render(container);
  }

  // ─── 批量操作栏 ────────────────────────────────────────

  private renderBatchBar(container: HTMLElement) {
    this.batchBar.render(container);
  }

  // ─── 标注卡片 ──────────────────────────────────────────

  private renderAnnotationCard(container: HTMLElement, annotation: Annotation, showFilePath: boolean) {
    this.annotationCard.render(container, annotation, showFilePath);
  }

  // ─── 加载标注列表 ──────────────────────────────────────


  // ─── 加载标注列表 ──────────────────────────────────────

  private async loadAndRenderAnnotations(container: HTMLElement, filePath: string) {
    let annotations: Annotation[];

    // 🔧 Phase 4.5: 统一委托给 filter-engine 判断
    const hasActive = hasActiveFilters(this.filter) || !!this.searchQuery?.trim();

    if (hasActive) {
      annotations = await queryAnnotations({
        ...this.filter,
        searchQuery: this.searchQuery?.trim() || undefined,
      });
      annotations = annotations.filter(a => a.filePath === filePath);
    } else {
      annotations = await getAnnotationsForFile(filePath);
      if (this.filter.sortBy === 'createdAt') {
        annotations.sort((a, b) => b.createdAt - a.createdAt);
      } else if (this.filter.sortBy === 'updatedAt') {
        annotations.sort((a, b) => b.updatedAt - a.updatedAt);
      }
    }

    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations yet' });
      return;
    }

    for (const annotation of annotations) {
      this.renderAnnotationCard(container, annotation, false);
    }
  }

  // ─── 搜索过滤 ──────────────────────────────────────────

  private applySearchFilter(annotations: Annotation[]): Annotation[] {
    return applyUnifiedFilter(annotations, this.filter, this.searchQuery);
  }

  // ─── 只刷新列表部分（不重建整个 UI） ────────────────────

  private async refreshListOnly() {
    const listContainer = this.containerEl_?.querySelector('.markvault-sidebar-list') as HTMLElement;
    if (!listContainer) return;
    listContainer.empty();

    // 同步字段过滤条件到 filter
    if (this.fieldFilterEntries.length > 0) {
      this.filter.fieldFilters = {};
      for (const entry of this.fieldFilterEntries) {
        this.filter.fieldFilters[entry.key] = entry.value;
      }
    } else {
      this.filter.fieldFilters = undefined;
    }

    // 更新过滤栏状态
    const filterSection = this.containerEl_?.querySelector('.markvault-filter-section');
    if (filterSection) {
      this.renderFilterBar(filterSection as HTMLElement);
    }

    if (this.activeTab === 'current') {
      if (this.currentFilePath) {
        await this.loadAndRenderAnnotations(listContainer, this.currentFilePath);
      } else {
        listContainer.createDiv({ cls: 'markvault-empty-state', text: 'Open a file to see its annotations' });
      }
    } else if (this.activeTab === 'all') {
      this.allAnnotationsCache = await getAllAnnotations();
      const filtered = this.applySearchFilter(this.allAnnotationsCache);

      switch (this.allNotesSubView) {
        case 'timeline':
          this.allNotesView.renderTimelineView(listContainer, filtered);
          break;
        case 'by-file':
          this.allNotesView.renderByFileView(listContainer, filtered);
          break;
        case 'by-color':
          this.allNotesView.renderByColorView(listContainer, filtered);
          break;
      }
    }
  }

  // ─── 交互操作 ──────────────────────────────────────────

  private async jumpToAnnotation(annotation: Annotation) {
    const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);

    let view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    try {
      // ── 策略 1：阅读模式下直接滚动到渲染后的 DOM 元素 ──
      if (view.getMode() === 'preview') {
        const scrolled = await this.scrollToPreviewAnnotation(view, annotation.uuid);
        if (scrolled) return;

        // 阅读模式下找不到元素（可能未渲染），降级到源码模式
        const state = leaf.getViewState();
        if (state?.state) {
          state.state.mode = 'source';
          await leaf.setViewState(state);
        }
        view = leaf.view as MarkdownView;
      }

      // ── 策略 2：源码模式基于 UUID 锚点搜索定位 ──
      const editor = (view as MarkdownView).editor;
      if (!editor) return;

      const content = await this.app.vault.read(file);
      let searchStr: string;
      if (annotation.kind === 'block') {
        searchStr = `markvault:${annotation.uuid}`;
      } else if (annotation.kind === 'span') {
        searchStr = `markvault-span:${annotation.uuid}`;
      } else if (annotation.kind === 'region') {
        searchStr = `markvault-region:${annotation.uuid}:start`;
      } else if (annotation.format === 'native') {
        searchStr = `mv:i:${annotation.uuid}`;
      } else {
        searchStr = `data-uuid="${annotation.uuid}"`;
      }

      // region 在编辑模式下通过原生选区定位，触发外部选框
      if (annotation.kind === 'region') {
        const plugin = this.pluginInstance;
        if (plugin && plugin.selectRegionInEditor(annotation)) {
          return;
        }
      }

      const idx = content.indexOf(searchStr);
      if (idx === -1) {
        // 锚点可能被删除，降级为行号定位
        console.warn(`MarkVault: UUID ${annotation.uuid} not found in source`);
        editor.setCursor({ line: annotation.startLine, ch: 0 });
        editor.scrollIntoView(
          { from: { line: annotation.startLine, ch: 0 }, to: { line: annotation.startLine + 1, ch: 0 } },
          true,
        );
        return;
      }

      const pos = editor.offsetToPos(idx);
      editor.setCursor(pos);
      editor.scrollIntoView({
        from: pos,
        to: { line: pos.line + 1, ch: 0 },
      }, true);
    } catch (err) {
      console.error('MarkVault: jumpToAnnotation error', err);
    }
  }

  /**
   * 在阅读模式 DOM 中查找并滚动到指定 uuid 的标注元素
   * 阅读模式渲染是异步的，因此采用轮询等待 post-processor 完成
   */
  private async scrollToPreviewAnnotation(view: MarkdownView, uuid: string): Promise<boolean> {
    const container = view.previewMode?.containerEl;
    if (!container) return false;

    // 先尝试立即查找（文件已打开且渲染完成时）
    let el = container.querySelector(`[data-uuid="${uuid}"]`) as HTMLElement | null;

    // 若未渲染，强制 rerender，然后轮询等待 post-processor 生效
    if (!el && view.previewMode?.rerender) {
      view.previewMode.rerender(true);
    }

    // 最多轮询 2 秒（20 × 100ms）
    for (let i = 0; i < 20 && !el; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      el = container.querySelector(`[data-uuid="${uuid}"]`) as HTMLElement | null;
    }

    if (!el) return false;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 高亮闪烁 1.5s，帮助用户定位
    const originalOutline = el.style.outline;
    el.style.outline = '2px solid #FACC15';
    setTimeout(() => {
      el!.style.outline = originalOutline;
    }, 1500);

    return true;
  }

  private async editAnnotation(annotation: Annotation) {
    const fresh = await getAnnotationByUuid(annotation.uuid);
    if (!fresh) return;

    // 获取 plugin 实例
    const plugin = this.pluginInstance;
    if (!plugin) return;

    // 🔧 P0 修复：走 plugin 的保护机制，防止 syncFromMarkdown 覆盖
    plugin.markAnnotationActive(annotation.uuid, annotation.filePath);

    const modal = new AnnotationModal(
      this.app,
      plugin,
      fresh,
      async () => {
        // 保存回调
        plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
        await this.refreshListOnly();
      },
      async (_uuid) => {
        // 🔧 审计修复：Modal 已处理 MD 移除，回调只做清理
        plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
        plugin.markFileSynced(annotation.filePath);
        try {
          await plugin.updateSpanCache(annotation.filePath);
        } catch (err) {
          console.error('MarkVault: sidebar edit delete spanCache error', annotation.filePath, err);
        }
        await this.refreshListOnly();
      },
    );

    // 注册打开的 Modal，便于文件删除/重命名时自动关闭
    plugin.registerActiveAnnotationModal(annotation.uuid, modal);

    // Modal 关闭时取消保护
    const originalOnClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      plugin.unregisterActiveAnnotationModal(annotation.uuid);
      plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
      originalOnClose();
    };

    modal.open();
  }

  /**
   * 根据标注 kind 从 Markdown 内容中移除对应锚点。
   * 返回清理后的内容；如果未找到锚点则返回 null。
   */
  private removeAnnotationFromContent(content: string, annotation: Annotation): string | null {
    if (annotation.format === 'native') {
      const result = removeNativeAnnotation(content, annotation.uuid);
      return result ?? null;
    }
    if (annotation.kind === 'block') {
      const result = removeBlockAnchor(content, annotation.uuid);
      return result !== content ? result : null;
    }
    if (annotation.kind === 'span') {
      const result = removeSpanAnchor(content, annotation.uuid);
      return result !== content ? result : null;
    }
    if (annotation.kind === 'region') {
      const result = removeRegionAnnotation(content, annotation.uuid);
      return result ?? null;
    }
    const result = removeMarkTag(content, annotation.uuid);
    return result ? result.content : null;
  }

  private async deleteAnnotationWithConfirm(annotation: Annotation) {
    // 🔧 v5.1: 有关联关系时在确认信息中提示
    const rels = getRelations(annotation.uuid);
    const totalRels = rels.outgoing.length + rels.incoming.length;
    const baseText = annotation.text.substring(0, 50);
    const confirmMsg = totalRels > 0
      ? `Delete annotation "${baseText}..."? It has ${totalRels} relation${totalRels > 1 ? 's' : ''} that will also be removed.`
      : `Delete annotation "${baseText}..."?`;
    const confirmed = confirm(confirmMsg);
    if (!confirmed) return;

    const plugin = this.pluginInstance;
    if (!plugin) return;

    // 🔧 审计修复：清理活跃保护状态（防止 Modal 打开时从侧边栏删除）
    plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);

    // 🔧 P0 修复：保存原始数据用于 MD 失败时回滚（深拷贝确保不丢失可选字段）
    const backup: Annotation = JSON.parse(JSON.stringify(annotation));

    try {
      await deleteAnnotation(annotation.uuid);

      const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
      if (!(file instanceof TFile)) {
        new Notice('Annotation deleted (source file not found)', 3000);
        await this.refreshListOnly();
        return;
      }

      // 使用 vault.process 原子读写，避免 read+modify 之间文件状态变化导致失败
      // 提前关闭同步窗口，避免 vault.process 触发 onFileOpen 重复 sync
      plugin.markFileSynced(annotation.filePath);
      plugin.modifyGuard.acquire(annotation.filePath);
      let mdChanged = false;
      try {
        const written = await this.app.vault.process(file, (content) => {
          const result = this.removeAnnotationFromContent(content, annotation);
          return result ?? content;
        });
        mdChanged = written.length !== file.stat.size;
      } catch (processErr) {
        // 🔧 P0 修复：MD 失败，回滚 DB
        console.error('MarkVault: sidebar delete MD error, rolling back', processErr);
        await addAnnotation(backup);
        throw processErr;
      } finally {
        plugin.modifyGuard.release(annotation.filePath);
      }
      // vault.process 完成后再次延长冷却期，覆盖元数据重解析耗时
      plugin.markFileSynced(annotation.filePath);

      if (!mdChanged) {
        console.warn('MarkVault: sidebar delete — markdown content unchanged');
      }

      await plugin.updateSpanCache(annotation.filePath);
      new Notice('Annotation deleted', 3000);
      await this.refreshListOnly();
    } catch (err) {
      console.error('MarkVault: sidebar delete annotation error', err);
      new Notice(
        `Failed to delete annotation: ${err instanceof Error ? err.message : 'unknown error'}`,
        5000,
      );
      await this.refreshListOnly();
    }
  }

  // ─── 工具方法 ──────────────────────────────────────────

  private formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) {
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    } else if (days > 0) {
      return `${days}d ago`;
    } else if (hours > 0) {
      return `${hours}h ago`;
    } else if (minutes > 0) {
      return `${minutes}m ago`;
    } else {
      return 'just now';
    }
  }

  /** 外部调用：刷新侧边栏 */
  async refresh() {
    // 先更新当前文件路径
    const activeFile = this.app.workspace.getActiveFile();
    const newFilePath = activeFile?.path ?? null;
    if (newFilePath !== this.currentFilePath) {
      this.currentFilePath = newFilePath;
    }
    console.log(`MarkVault sidebar: refresh — filePath=${this.currentFilePath}, tab=${this.activeTab}`);
    await this.refreshListOnly();
  }
}
