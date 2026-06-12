import { ItemView, WorkspaceLeaf, MarkdownView, TFile, Component, Menu, MarkdownRenderer } from 'obsidian';
import type { Annotation, AnnotationFilter, AnnotationType } from '../../types/annotation';
import { PRESET_COLORS } from '../../types/annotation';
import {
  getAnnotationsForFile,
  queryAnnotations,
  deleteAnnotation,
  updateAnnotation,
  getAnnotationStats,
  getAllAnnotations,
  getAnnotationByUuid,
} from '../../db/annotation-repo';
import { debounce } from '../../utils/debounce';
import { AnnotationModal } from '../editor/annotation-modal';
import { removeMarkTag, removeBlockAnchor, removeSpanAnchor } from '../../core/annotation-parser';

export const MARKVAULT_SIDEBAR_VIEW_TYPE = 'markvault-sidebar';

/** 侧边栏 Tab 类型 */
type SidebarTab = 'current' | 'all' | 'stats';

/** 侧边栏全笔记子视图 */
type AllNotesSubView = 'timeline' | 'by-file' | 'by-color';

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

  // Plugin 实例引用（用于访问 _isInternalModify 等保护机制）
  private pluginInstance: any = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
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
  setPluginInstance(plugin: any): void {
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
      await this.refreshListOnly();
    });
  }

  // ─── 当前笔记视图 ──────────────────────────────────────

  private async renderCurrentNoteView(container: HTMLElement) {
    if (!this.currentFilePath) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'Open a file to see its annotations' });
      return;
    }

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
    // 子视图 Tab
    const subTabBar = container.createDiv({ cls: 'markvault-sub-tab-bar' });
    const subTabs: Array<{ id: AllNotesSubView; icon: string; label: string }> = [
      { id: 'timeline', icon: '🕐', label: 'Timeline' },
      { id: 'by-file', icon: '📁', label: 'By File' },
      { id: 'by-color', icon: '🎨', label: 'By Color' },
    ];

    for (const tab of subTabs) {
      const btn = subTabBar.createEl('button', {
        text: `${tab.icon} ${tab.label}`,
        cls: `markvault-sub-tab-btn ${this.allNotesSubView === tab.id ? 'active' : ''}`,
      });
      btn.addEventListener('click', async () => {
        this.allNotesSubView = tab.id;
        await this.renderContent();
      });
    }

    // 过滤栏
    const filterBar = container.createDiv({ cls: 'markvault-filter-section' });
    this.renderFilterBar(filterBar);

    // 批量操作栏
    if (this.batchMode) {
      this.renderBatchBar(container);
    }

    // 内容
    const listContainer = container.createDiv({ cls: 'markvault-sidebar-list' });
    listContainer.id = 'markvault-list-container';

    // 加载所有标注
    this.allAnnotationsCache = await getAllAnnotations();

    // 搜索过滤
    let filtered = this.applySearchFilter(this.allAnnotationsCache);

    switch (this.allNotesSubView) {
      case 'timeline':
        this.renderTimelineView(listContainer, filtered);
        break;
      case 'by-file':
        this.renderByFileView(listContainer, filtered);
        break;
      case 'by-color':
        this.renderByColorView(listContainer, filtered);
        break;
    }
  }

  // ─── 统计视图 ───────────────────────────────────────────

  private async renderStatsView(container: HTMLElement) {
    this.allAnnotationsCache = await getAllAnnotations();
    const total = this.allAnnotationsCache.length;

    // 总览卡
    const overviewCard = container.createDiv({ cls: 'markvault-stats-overview' });
    overviewCard.createDiv({ cls: 'markvault-stats-number', text: String(total) });
    overviewCard.createDiv({ cls: 'markvault-stats-label', text: 'Total Annotations' });

    // 统计网格
    const grid = container.createDiv({ cls: 'markvault-stats-grid' });

    // 按类型统计
    const byType: Record<string, number> = {};
    const byColor: Record<string, number> = {};
    let withNotes = 0;
    let withTags = 0;
    const fileSet = new Set<string>();
    const recentDay = Date.now() - 24 * 60 * 60 * 1000;
    let recentCount = 0;

    for (const a of this.allAnnotationsCache) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      byColor[a.color] = (byColor[a.color] || 0) + 1;
      if (a.note && a.note.trim()) withNotes++;
      if (a.tags.length > 0) withTags++;
      fileSet.add(a.filePath);
      if (a.createdAt > recentDay) recentCount++;
    }

    // 类型分布卡
    this.renderStatCard(grid, 'By Type', Object.entries(byType).map(([k, v]) => ({
      label: k,
      value: v,
      color: k === 'highlight' ? '#FACC15' : k === 'bold' ? '#60A5FA' : '#4ADE80',
    })));

    // 颜色分布卡
    this.renderStatCard(grid, 'By Color', PRESET_COLORS.map(c => ({
      label: c.label,
      value: byColor[c.id] || 0,
      color: c.hex,
    })));

    // 摘要卡
    const summaryCard = grid.createDiv({ cls: 'markvault-stat-card' });
    summaryCard.createDiv({ cls: 'markvault-stat-card-title', text: 'Summary' });
    const summaryItems = [
      { label: 'With notes', value: withNotes },
      { label: 'With tags', value: withTags },
      { label: 'Files', value: fileSet.size },
      { label: 'Last 24h', value: recentCount },
    ];
    for (const item of summaryItems) {
      const row = summaryCard.createDiv({ cls: 'markvault-stat-row' });
      row.createSpan({ text: item.label, cls: 'markvault-stat-row-label' });
      row.createSpan({ text: String(item.value), cls: 'markvault-stat-row-value' });
    }

    // 类型占比条
    if (total > 0) {
      const barCard = grid.createDiv({ cls: 'markvault-stat-card' });
      barCard.createDiv({ cls: 'markvault-stat-card-title', text: 'Type Distribution' });
      const barContainer = barCard.createDiv({ cls: 'markvault-stat-bar' });
      const typeColors: Record<string, string> = {
        highlight: '#FACC15',
        bold: '#60A5FA',
        underline: '#4ADE80',
      };
      for (const [type, count] of Object.entries(byType)) {
        const pct = Math.round((count / total) * 100);
        const segment = barContainer.createDiv({ cls: 'markvault-stat-bar-segment' });
        segment.style.width = `${pct}%`;
        segment.style.backgroundColor = typeColors[type] || '#888';
        segment.title = `${type}: ${count} (${pct}%)`;
        if (pct >= 10) {
          segment.createSpan({ text: `${pct}%`, cls: 'markvault-stat-bar-label' });
        }
      }
    }

    // 颜色占比条
    if (total > 0) {
      const colorBarCard = grid.createDiv({ cls: 'markvault-stat-card' });
      colorBarCard.createDiv({ cls: 'markvault-stat-card-title', text: 'Color Distribution' });
      const colorBarContainer = colorBarCard.createDiv({ cls: 'markvault-stat-bar' });
      for (const pc of PRESET_COLORS) {
        const count = byColor[pc.id] || 0;
        if (count === 0) continue;
        const pct = Math.round((count / total) * 100);
        const segment = colorBarContainer.createDiv({ cls: 'markvault-stat-bar-segment' });
        segment.style.width = `${pct}%`;
        segment.style.backgroundColor = pc.hex;
        segment.title = `${pc.label}: ${count} (${pct}%)`;
      }
    }

    // 最近标注
    const recentCard = grid.createDiv({ cls: 'markvault-stat-card markvault-stat-card-wide' });
    recentCard.createDiv({ cls: 'markvault-stat-card-title', text: 'Recent Annotations' });
    const recent = [...this.allAnnotationsCache]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    for (const ann of recent) {
      const row = recentCard.createDiv({ cls: 'markvault-stat-recent-row' });
      const dot = row.createDiv({ cls: 'markvault-card-color-dot' });
      const preset = PRESET_COLORS.find(c => c.id === ann.color);
      dot.style.backgroundColor = preset ? preset.hex : ann.color;
      const textSpan = row.createSpan({ cls: 'markvault-stat-recent-text', text: ann.text.substring(0, 40) + (ann.text.length > 40 ? '...' : '') });
      const fileSpan = row.createSpan({ cls: 'markvault-stat-recent-file', text: ann.filePath.split('/').pop()?.replace('.md', '') || '' });
      row.addEventListener('click', () => this.jumpToAnnotation(ann));
    }
  }

  private renderStatCard(
    container: HTMLElement,
    title: string,
    items: Array<{ label: string; value: number; color: string }>,
  ) {
    const card = container.createDiv({ cls: 'markvault-stat-card' });
    card.createDiv({ cls: 'markvault-stat-card-title', text: title });

    for (const item of items) {
      const row = card.createDiv({ cls: 'markvault-stat-row' });
      const dot = row.createDiv({ cls: 'markvault-stat-dot' });
      dot.style.backgroundColor = item.color;
      row.createSpan({ text: item.label, cls: 'markvault-stat-row-label' });
      row.createSpan({ text: String(item.value), cls: 'markvault-stat-row-value' });
    }
  }

  // ─── 过滤栏 ─────────────────────────────────────────────

  private renderFilterBar(container: HTMLElement) {
    container.empty();

    // 类型过滤
    const typeFilters: Array<{ label: string; value: AnnotationFilter['type']; icon: string }> = [
      { label: 'All', value: 'all', icon: '✦' },
      { label: 'Highlight', value: 'highlight', icon: '🎨' },
      { label: 'Bold', value: 'bold', icon: '𝗕' },
      { label: 'Underline', value: 'underline', icon: 'U̲' },
    ];

    const typeBar = container.createDiv({ cls: 'markvault-filter-bar' });
    for (const tf of typeFilters) {
      const btn = typeBar.createEl('button', {
        text: `${tf.icon} ${tf.label}`,
        cls: `markvault-filter-btn ${this.filter.type === tf.value ? 'active' : ''}`,
      });
      btn.addEventListener('click', async () => {
        this.filter.type = tf.value;
        await this.refreshListOnly();
      });
    }

    // 颜色过滤
    const colorBar = container.createDiv({ cls: 'markvault-filter-colors' });
    const allColorBtn = colorBar.createEl('button', {
      text: 'All',
      cls: `markvault-color-btn ${this.filter.color === 'all' ? 'active' : ''}`,
    });
    allColorBtn.addEventListener('click', async () => {
      this.filter.color = 'all';
      await this.refreshListOnly();
    });

    for (const pc of PRESET_COLORS) {
      const colorBtn = colorBar.createEl('button', {
        cls: `markvault-color-btn markvault-color-dot ${this.filter.color === pc.id ? 'active' : ''}`,
        attr: { title: pc.label },
      });
      colorBtn.style.backgroundColor = pc.hex;
      colorBtn.addEventListener('click', async () => {
        this.filter.color = pc.id;
        await this.refreshListOnly();
      });
    }

    // 是否有批注过滤
    const noteBar = container.createDiv({ cls: 'markvault-filter-bar' });
    const noteFilters: Array<{ label: string; value: boolean | undefined; icon: string }> = [
      { label: 'All', value: undefined, icon: '📋' },
      { label: 'With Note', value: true, icon: '📝' },
    ];
    for (const nf of noteFilters) {
      const btn = noteBar.createEl('button', {
        text: `${nf.icon} ${nf.label}`,
        cls: `markvault-filter-btn ${this.filter.hasNote === nf.value ? 'active' : ''}`,
      });
      btn.addEventListener('click', async () => {
        this.filter.hasNote = nf.value;
        await this.refreshListOnly();
      });
    }

    // 排序
    const sortBar = container.createDiv({ cls: 'markvault-filter-sort' });
    const sortOptions: Array<{ label: string; value: AnnotationFilter['sortBy']; icon: string }> = [
      { label: 'Position', value: 'position', icon: '📍' },
      { label: 'Newest', value: 'createdAt', icon: '🆕' },
      { label: 'Updated', value: 'updatedAt', icon: '🔄' },
    ];
    for (const so of sortOptions) {
      const btn = sortBar.createEl('button', {
        text: `${so.icon} ${so.label}`,
        cls: `markvault-sort-btn ${this.filter.sortBy === so.value ? 'active' : ''}`,
      });
      btn.addEventListener('click', async () => {
        this.filter.sortBy = so.value;
        await this.refreshListOnly();
      });
    }
  }

  // ─── 批量操作栏 ────────────────────────────────────────

  private renderBatchBar(container: HTMLElement) {
    const bar = container.createDiv({ cls: 'markvault-batch-bar' });

    const selectAllBtn = bar.createEl('button', {
      text: 'Select All',
      cls: 'markvault-batch-btn',
    });
    selectAllBtn.addEventListener('click', async () => {
      // 全选当前可见标注
      const listContainer = container.querySelector('.markvault-sidebar-list');
      if (listContainer) {
        const checkboxes = listContainer.querySelectorAll('.markvault-card-checkbox');
        checkboxes.forEach((cb) => {
          const input = cb as HTMLInputElement;
          input.checked = true;
          const uuid = input.dataset.uuid;
          if (uuid) this.selectedUuids.add(uuid);
        });
      }
      this.updateBatchBarCount(bar);
    });

    const deselectBtn = bar.createEl('button', {
      text: 'Deselect',
      cls: 'markvault-batch-btn',
    });
    deselectBtn.addEventListener('click', () => {
      this.selectedUuids.clear();
      const listContainer = container.querySelector('.markvault-sidebar-list');
      if (listContainer) {
        const checkboxes = listContainer.querySelectorAll('.markvault-card-checkbox');
        checkboxes.forEach((cb) => {
          (cb as HTMLInputElement).checked = false;
        });
      }
      this.updateBatchBarCount(bar);
    });

    // 批量改色
    const colorBtn = bar.createEl('button', {
      text: '🎨 Color',
      cls: 'markvault-batch-btn',
    });
    colorBtn.addEventListener('click', () => {
      this.showBatchColorMenu(colorBtn);
    });

    // 批量删除
    const deleteBtn = bar.createEl('button', {
      text: '🗑️ Delete',
      cls: 'markvault-batch-btn markvault-batch-delete',
    });
    deleteBtn.addEventListener('click', async () => {
      if (this.selectedUuids.size === 0) return;
      const confirmed = confirm(`Delete ${this.selectedUuids.size} annotations?`);
      if (!confirmed) return;

      // 🔧 P0 修复：设置 _isInternalModify 防止 syncFromMarkdown 覆盖
      const plugin = this.pluginInstance;

      for (const uuid of this.selectedUuids) {
        const annotation = await getAnnotationByUuid(uuid);
        if (annotation) {
          await deleteAnnotation(uuid);
          try {
            const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
            if (file instanceof TFile) {
              const content = await this.app.vault.read(file);
              let newContent: string | null = null;

              if (annotation.kind === 'block') {
                const result = removeBlockAnchor(content, uuid);
                if (result !== content) newContent = result;
              } else if (annotation.kind === 'span') {
                const result = removeSpanAnchor(content, uuid);
                if (result !== content) newContent = result;
              } else {
                const result = removeMarkTag(content, uuid);
                if (result) newContent = result.content;
              }

              if (newContent && plugin) {
                plugin._isInternalModify = true;
                try {
                  await this.app.vault.modify(file, newContent);
                } finally {
                  setTimeout(() => { plugin._isInternalModify = false; }, 500);
                }
              }
            }
          } catch (err) {
            if (plugin) plugin._isInternalModify = false;
            console.error('MarkVault: batch delete mark error', err);
          }
        }
      }
      this.selectedUuids.clear();
      await this.renderContent();
    });

    // 选中计数
    const countEl = bar.createSpan({ cls: 'markvault-batch-count', text: '0 selected' });
    countEl.id = 'markvault-batch-count';
  }

  private updateBatchBarCount(bar: HTMLElement) {
    const countEl = bar.querySelector('#markvault-batch-count');
    if (countEl) {
      countEl.textContent = `${this.selectedUuids.size} selected`;
    }
  }

  private showBatchColorMenu(anchor: HTMLElement) {
    const menu = new Menu();
    for (const pc of PRESET_COLORS) {
      menu.addItem((item) => {
        item.setTitle(`Change to ${pc.label}`)
          .setChecked(false)
          .onClick(async () => {
            await this.batchChangeColor(pc.id);
          });
      });
    }
    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async batchChangeColor(colorId: string) {
    if (this.selectedUuids.size === 0) return;

    // 🔧 P0 修复：设置 _isInternalModify 防止 syncFromMarkdown 覆盖
    const plugin = this.pluginInstance;

    for (const uuid of this.selectedUuids) {
      const annotation = await getAnnotationByUuid(uuid);
      if (annotation) {
        await updateAnnotation(uuid, { color: colorId });
        // 更新 Markdown
        try {
          const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
          if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            const { updateMarkTag } = await import('../../core/annotation-parser');
            const newContent = updateMarkTag(content, uuid, { color: colorId });
            if (newContent !== content && plugin) {
              plugin._isInternalModify = true;
              try {
                await this.app.vault.modify(file, newContent);
              } finally {
                setTimeout(() => { plugin._isInternalModify = false; }, 500);
              }
            }
          }
        } catch (err) {
          if (plugin) plugin._isInternalModify = false;
          console.error('MarkVault: batch color change error', err);
        }
      }
    }
    this.selectedUuids.clear();
    await this.renderContent();
  }

  // ─── 时间线视图 ────────────────────────────────────────

  private renderTimelineView(container: HTMLElement, annotations: Annotation[]) {
    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations found' });
      return;
    }

    // 按日期分组
    const groups = new Map<string, Annotation[]>();
    for (const a of annotations) {
      const date = new Date(a.createdAt).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(a);
    }

    // 按时间倒序渲染
    for (const [date, items] of groups) {
      const groupEl = container.createDiv({ cls: 'markvault-timeline-group' });
      groupEl.createDiv({ cls: 'markvault-timeline-date', text: date });

      for (const annotation of items) {
        this.renderAnnotationCard(groupEl, annotation, true);
      }
    }
  }

  // ─── 按文件分组视图 ────────────────────────────────────

  private renderByFileView(container: HTMLElement, annotations: Annotation[]) {
    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations found' });
      return;
    }

    // 按文件分组
    const groups = new Map<string, Annotation[]>();
    for (const a of annotations) {
      const fileName = a.filePath.split('/').pop()?.replace('.md', '') || a.filePath;
      if (!groups.has(fileName)) groups.set(fileName, []);
      groups.get(fileName)!.push(a);
    }

    // 按标注数量排序
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [fileName, items] of sorted) {
      const groupEl = container.createDiv({ cls: 'markvault-file-group' });

      // 文件头
      const header = groupEl.createDiv({ cls: 'markvault-file-group-header' });
      header.createSpan({ text: '📄', cls: 'markvault-file-group-icon' });
      header.createSpan({ text: fileName, cls: 'markvault-file-group-name' });
      header.createSpan({ text: `${items.length}`, cls: 'markvault-file-group-count' });

      // 文件头点击 → 打开文件
      header.addEventListener('click', async () => {
        const firstItem = items[0];
        const file = this.app.vault.getAbstractFileByPath(firstItem.filePath);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      });

      // 标注列表（默认折叠）
      const list = groupEl.createDiv({ cls: 'markvault-file-group-list' });

      // 折叠/展开
      let expanded = false;
      header.addEventListener('click', (e) => {
        if (e.target !== header) return;
        expanded = !expanded;
        list.toggleClass('expanded', expanded);
        header.toggleClass('expanded', expanded);
      });

      for (const annotation of items) {
        this.renderAnnotationCard(list, annotation, false);
      }
    }
  }

  // ─── 按颜色分组视图 ────────────────────────────────────

  private renderByColorView(container: HTMLElement, annotations: Annotation[]) {
    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations found' });
      return;
    }

    // 按颜色分组
    const groups = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (!groups.has(a.color)) groups.set(a.color, []);
      groups.get(a.color)!.push(a);
    }

    // 按 PRESET_COLORS 顺序渲染
    for (const pc of PRESET_COLORS) {
      const items = groups.get(pc.id);
      if (!items || items.length === 0) continue;

      const groupEl = container.createDiv({ cls: 'markvault-color-group' });

      // 颜色头
      const header = groupEl.createDiv({ cls: 'markvault-color-group-header' });
      const dot = header.createDiv({ cls: 'markvault-color-group-dot' });
      dot.style.backgroundColor = pc.hex;
      header.createSpan({ text: pc.label, cls: 'markvault-color-group-name' });
      header.createSpan({ text: `${items.length}`, cls: 'markvault-color-group-count' });

      const list = groupEl.createDiv({ cls: 'markvault-color-group-list' });
      let expanded = false;
      header.addEventListener('click', () => {
        expanded = !expanded;
        list.toggleClass('expanded', expanded);
        header.toggleClass('expanded', expanded);
      });

      for (const annotation of items) {
        this.renderAnnotationCard(list, annotation, true);
      }
    }
  }

  // ─── 标注卡片 ──────────────────────────────────────────

  private renderAnnotationCard(container: HTMLElement, annotation: Annotation, showFilePath: boolean) {
    const card = container.createDiv({ cls: 'markvault-card' });

    // 批量模式 checkbox
    if (this.batchMode) {
      const checkbox = card.createEl('input', {
        type: 'checkbox',
        cls: 'markvault-card-checkbox',
      });
      checkbox.dataset.uuid = annotation.uuid;
      if (this.selectedUuids.has(annotation.uuid)) {
        checkbox.checked = true;
      }
      checkbox.addEventListener('change', (e) => {
        if (checkbox.checked) {
          this.selectedUuids.add(annotation.uuid);
        } else {
          this.selectedUuids.delete(annotation.uuid);
        }
        // 更新计数
        const countEl = this.containerEl_?.querySelector('#markvault-batch-count');
        if (countEl) {
          countEl.textContent = `${this.selectedUuids.size} selected`;
        }
      });
    }

    // 卡片头部
    const header = card.createDiv({ cls: 'markvault-card-header' });

    const preset = PRESET_COLORS.find(c => c.id === annotation.color);
    const colorHex = preset ? preset.hex : annotation.color;

    const colorDot = header.createDiv({ cls: 'markvault-card-color-dot' });
    colorDot.style.backgroundColor = colorHex;

    const typeLabel = header.createDiv({ cls: 'markvault-card-type' });
    typeLabel.textContent = annotation.type;

    if (showFilePath) {
      const fileLabel = header.createDiv({ cls: 'markvault-card-file' });
      const fileName = annotation.filePath.split('/').pop()?.replace('.md', '') || annotation.filePath;
      fileLabel.textContent = `📄 ${fileName}`;
      fileLabel.title = annotation.filePath;
    } else {
      const lineLabel = header.createDiv({ cls: 'markvault-card-line' });
      lineLabel.textContent = `Line ${annotation.startLine + 1}`;
    }

    // 操作按钮区
    const actionsHeader = header.createDiv({ cls: 'markvault-card-header-actions' });

    const jumpBtn = actionsHeader.createEl('button', {
      cls: 'markvault-card-jump',
      text: '⏎',
    });
    jumpBtn.title = 'Jump to annotation';
    jumpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.jumpToAnnotation(annotation);
    });

    // 快速改色按钮
    const colorBtn = actionsHeader.createEl('button', {
      cls: 'markvault-card-quick-color',
      text: '🎨',
    });
    colorBtn.title = 'Change color';
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showQuickColorMenu(colorBtn, annotation);
    });

    // 标注原文 — 使用 MarkdownRenderer 渲染，支持 LaTeX 公式等
    const textEl = card.createDiv({ cls: 'markvault-card-text' });
    // 🔧 v2.0: 对块级标注和含特殊内容的标注使用 Markdown 渲染
    // 对纯文本标注保持原样（避免过度渲染）
    const needsRender = annotation.kind === 'block' || annotation.kind === 'span'
      || annotation.text.includes('$')
      || annotation.text.includes('`')
      || annotation.text.includes('**')
      || annotation.text.includes('==')
      || annotation.text.includes('|')
      || annotation.text.includes('>');

    if (needsRender && this.component_) {
      // 异步渲染 Markdown（包括 LaTeX 公式）
      MarkdownRenderer.renderMarkdown(
        annotation.text,
        textEl,
        annotation.filePath,
        this.component_,
      ).catch((err: unknown) => {
        console.error('MarkVault: failed to render annotation text', err);
        textEl.textContent = annotation.text;
      });
    } else {
      textEl.textContent = annotation.text;
    }

    // 批注内容
    if (annotation.note) {
      const noteEl = card.createDiv({ cls: 'markvault-card-note' });
      noteEl.textContent = annotation.note;
    }

    // 标签
    if (annotation.tags.length > 0) {
      const tagsEl = card.createDiv({ cls: 'markvault-card-tags' });
      for (const tag of annotation.tags) {
        tagsEl.createSpan({ cls: 'markvault-tag', text: `#${tag}` });
      }
    }

    // 底部操作
    const actions = card.createDiv({ cls: 'markvault-card-actions' });

    // 时间戳
    const timeEl = actions.createSpan({ cls: 'markvault-card-time' });
    const date = new Date(annotation.updatedAt);
    timeEl.textContent = this.formatRelativeTime(date);

    const editBtn = actions.createEl('button', { cls: 'markvault-action-btn', text: '✏️' });
    editBtn.title = 'Edit annotation';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editAnnotation(annotation);
    });

    const deleteBtn = actions.createEl('button', { cls: 'markvault-action-btn markvault-delete-btn', text: '🗑️' });
    deleteBtn.title = 'Delete annotation';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.deleteAnnotationWithConfirm(annotation);
    });

    // 卡片点击 → 打开编辑 Modal（用户最期望的操作）
    card.addEventListener('click', () => {
      if (this.batchMode) {
        // 批量模式下点击 = 切换选中
        const cb = card.querySelector('.markvault-card-checkbox') as HTMLInputElement;
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      } else {
        // 🔧 修复：点击标注卡片直接打开编辑Modal，而不是仅跳转
        this.editAnnotation(annotation);
      }
    });
  }

  // ─── 快速改色菜单 ──────────────────────────────────────

  private showQuickColorMenu(anchor: HTMLElement, annotation: Annotation) {
    const menu = new Menu();
    for (const pc of PRESET_COLORS) {
      menu.addItem((item) => {
        item.setTitle(`${pc.label} (${pc.id === annotation.color ? 'current' : ''})`)
          .setChecked(pc.id === annotation.color)
          .onClick(async () => {
            await this.quickChangeColor(annotation, pc.id);
          });
      });
    }
    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async quickChangeColor(annotation: Annotation, colorId: string) {
    await updateAnnotation(annotation.uuid, { color: colorId });
    // 更新 Markdown
    // 🔧 P0 修复：设置 _isInternalModify 防止 syncFromMarkdown 覆盖
    const plugin = this.pluginInstance;
    try {
      const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        let newContent: string;

        if (annotation.kind === 'span') {
          // Span 标注：更新 %%markvault-span:...%% 锚点
          const { updateSpanAnchor } = await import('../../core/annotation-parser');
          newContent = updateSpanAnchor(content, annotation.uuid, { color: colorId });
        } else if (annotation.kind === 'block') {
          // 块级标注：更新 %%markvault:...%% 锚点
          const { updateBlockAnchor } = await import('../../core/annotation-parser');
          newContent = updateBlockAnchor(content, annotation.uuid, { color: colorId });
        } else {
          // 行内标注：更新 <mark> 标签
          const { updateMarkTag } = await import('../../core/annotation-parser');
          newContent = updateMarkTag(content, annotation.uuid, { color: colorId });
        }

        if (newContent !== content && plugin) {
          plugin._isInternalModify = true;
          try {
            await this.app.vault.modify(file, newContent);
          } finally {
            setTimeout(() => { plugin._isInternalModify = false; }, 500);
          }
        }

        // 🔧 刷新 span 缓存
        if (plugin?.updateSpanCache) {
          await plugin.updateSpanCache(annotation.filePath);
        }
      }
    } catch (err) {
      if (plugin) plugin._isInternalModify = false;
      console.error('MarkVault: quick color change error', err);
    }
    await this.refreshListOnly();
  }

  // ─── 加载标注列表 ──────────────────────────────────────

  private async loadAndRenderAnnotations(container: HTMLElement, filePath: string) {
    console.log(`MarkVault sidebar: loadAndRenderAnnotations — filePath=${filePath}, search=${this.searchQuery}, filter=${JSON.stringify(this.filter)}`);
    let annotations: Annotation[];

    if (this.searchQuery && this.searchQuery.trim()) {
      annotations = await queryAnnotations({
        ...this.filter,
        searchQuery: this.searchQuery,
      });
      annotations = annotations.filter(a => a.filePath === filePath);
    } else if (this.filter.type === 'all' && this.filter.color === 'all' && !this.filter.hasNote) {
      annotations = await getAnnotationsForFile(filePath);
      if (this.filter.sortBy === 'createdAt') {
        annotations.sort((a, b) => b.createdAt - a.createdAt);
      } else if (this.filter.sortBy === 'updatedAt') {
        annotations.sort((a, b) => b.updatedAt - a.updatedAt);
      }
    } else {
      annotations = await queryAnnotations(this.filter);
      annotations = annotations.filter(a => a.filePath === filePath);
    }

    console.log(`MarkVault sidebar: found ${annotations.length} annotations for ${filePath}`);

    // 调试：打印前几个标注的详细信息
    if (annotations.length > 0) {
      console.log(`MarkVault sidebar: first annotation uuid=${annotations[0].uuid}, text="${annotations[0].text.substring(0, 50)}...", note="${annotations[0].note?.substring(0, 50) || ''}"`);
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
    let filtered = [...annotations];

    // 类型过滤
    if (this.filter.type && this.filter.type !== 'all') {
      filtered = filtered.filter(a => a.type === this.filter.type);
    }

    // 颜色过滤
    if (this.filter.color && this.filter.color !== 'all') {
      filtered = filtered.filter(a => a.color === this.filter.color);
    }

    // 批注过滤
    if (this.filter.hasNote) {
      filtered = filtered.filter(a => a.note && a.note.trim().length > 0);
    }

    // 搜索
    if (this.searchQuery && this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(a =>
        a.text.toLowerCase().includes(q) ||
        a.note.toLowerCase().includes(q) ||
        a.tags.some(t => t.toLowerCase().includes(q)) ||
        a.filePath.toLowerCase().includes(q),
      );
    }

    // 排序
    const sortBy = this.filter.sortBy || 'position';
    switch (sortBy) {
      case 'position':
        filtered.sort((a, b) => a.startOffset - b.startOffset);
        break;
      case 'createdAt':
        filtered.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'updatedAt':
        filtered.sort((a, b) => b.updatedAt - a.updatedAt);
        break;
    }

    return filtered;
  }

  // ─── 只刷新列表部分（不重建整个 UI） ────────────────────

  private async refreshListOnly() {
    const listContainer = this.containerEl_?.querySelector('.markvault-sidebar-list') as HTMLElement;
    if (!listContainer) return;
    listContainer.empty();

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
          this.renderTimelineView(listContainer, filtered);
          break;
        case 'by-file':
          this.renderByFileView(listContainer, filtered);
          break;
        case 'by-color':
          this.renderByColorView(listContainer, filtered);
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

    const view = leaf.view;
    if (view instanceof MarkdownView && view.editor) {
      // 🔧 v2.0 修复：先尝试精确偏移定位，如果失败则用行号定位
      // 对 span/block 标注：startOffset=endOffset=锚点偏移，优先使用 startLine
      if (annotation.kind === 'span' || annotation.kind === 'block') {
        // span/block 标注：startLine 指向内容起始行
        const targetLine = annotation.startLine;
        view.editor.setCursor({ line: targetLine, ch: 0 });
        view.editor.scrollIntoView(
          { from: { line: targetLine, ch: 0 }, to: { line: targetLine + 1, ch: 0 } },
          true,
        );
      } else {
        try {
          const pos = view.editor.offsetToPos(annotation.startOffset);
          view.editor.setCursor(pos);
          view.editor.scrollIntoView({
            from: pos,
            to: view.editor.offsetToPos(annotation.endOffset),
          }, true);
        } catch {
          // 偏移失效时降级为行号定位
          view.editor.setCursor({ line: annotation.startLine, ch: 0 });
          view.editor.scrollIntoView(
            { from: { line: annotation.startLine, ch: 0 }, to: { line: annotation.startLine + 1, ch: 0 } },
            true,
          );
        }
      }
    }

    // 🔧 修复：跳转后同时打开编辑Modal
    await this.editAnnotation(annotation);
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
      plugin as any,
      fresh,
      async () => {
        // 保存回调
        plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
        await this.refreshListOnly();
      },
      async (uuid) => {
        // 删除回调
        plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
        try {
          const ann = await getAnnotationByUuid(uuid);
          if (ann) {
            const file = this.app.vault.getAbstractFileByPath(ann.filePath);
            if (file instanceof TFile) {
              const content = await this.app.vault.read(file);

              // 🆕 v2.0: 根据标注类型选择不同的删除方式
              if (ann.kind === 'block') {
                // 块级标注：移除 %%markvault:...%% 锚点
                const newContent = removeBlockAnchor(content, uuid);
                if (newContent !== content) {
                  plugin._isInternalModify = true;
                  try {
                    await this.app.vault.modify(file, newContent);
                  } finally {
                    setTimeout(() => { plugin._isInternalModify = false; }, 500);
                  }
                }
              } else if (ann.kind === 'span') {
                // Span 标注：移除 %%markvault-span:...%% 锚点
                const newContent = removeSpanAnchor(content, uuid);
                if (newContent !== content) {
                  plugin._isInternalModify = true;
                  try {
                    await this.app.vault.modify(file, newContent);
                  } finally {
                    setTimeout(() => { plugin._isInternalModify = false; }, 500);
                  }
                }
              } else {
                // 行内标注：移除 <mark> 标签
                const result = removeMarkTag(content, uuid);
                if (result) {
                  plugin._isInternalModify = true;
                  try {
                    await this.app.vault.modify(file, result.content);
                  } finally {
                    setTimeout(() => { plugin._isInternalModify = false; }, 500);
                  }
                }
              }
            }
          }
        } catch (err) {
          plugin._isInternalModify = false;
          console.error('MarkVault: sidebar delete annotation error', err);
        }
        await this.refreshListOnly();
      },
    );

    // Modal 关闭时取消保护
    const originalOnClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
      originalOnClose();
    };

    modal.open();
  }

  private async deleteAnnotationWithConfirm(annotation: Annotation) {
    const confirmed = confirm(`Delete annotation "${annotation.text.substring(0, 50)}..."?`);
    if (confirmed) {
      await deleteAnnotation(annotation.uuid);
      // 🔧 P0 修复：设置 _isInternalModify 防止 syncFromMarkdown 覆盖
      const plugin = this.pluginInstance;
      try {
        const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file);

          // 🆕 v2.0: 根据标注类型选择不同的删除方式
          if (annotation.kind === 'block') {
            // 块级标注：移除 %%markvault:...%% 锚点
            const newContent = removeBlockAnchor(content, annotation.uuid);
            if (newContent !== content && plugin) {
              plugin._isInternalModify = true;
              try {
                await this.app.vault.modify(file, newContent);
              } finally {
                setTimeout(() => { plugin._isInternalModify = false; }, 500);
              }
            }
          } else if (annotation.kind === 'span') {
            // Span 标注：移除 %%markvault-span:...%% 锚点
            const newContent = removeSpanAnchor(content, annotation.uuid);
            if (newContent !== content && plugin) {
              plugin._isInternalModify = true;
              try {
                await this.app.vault.modify(file, newContent);
              } finally {
                setTimeout(() => { plugin._isInternalModify = false; }, 500);
              }
            }
          } else {
            // 行内标注：移除 <mark> 标签
            const result = removeMarkTag(content, annotation.uuid);
            if (result && plugin) {
              plugin._isInternalModify = true;
              try {
                await this.app.vault.modify(file, result.content);
              } finally {
                setTimeout(() => { plugin._isInternalModify = false; }, 500);
              }
            }
          }
        }
      } catch (err) {
        if (plugin) plugin._isInternalModify = false;
        console.error('MarkVault: sidebar delete annotation error', err);
      }
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
