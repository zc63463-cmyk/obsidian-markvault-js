import { ItemView, WorkspaceLeaf, MarkdownView, TFile, Component, Menu, MarkdownRenderer, Notice } from 'obsidian';
import type { Annotation, AnnotationFilter } from '../../types/annotation';
import { PRESET_COLORS } from '../../types/annotation';
import {
  getAnnotationsForFile,
  queryAnnotations,
  deleteAnnotation,
  updateAnnotation,
  addAnnotation,
  getAnnotationStats,
  getAllAnnotations,
  getAnnotationByUuid,
} from '../../db/annotation-repo';
import { debounce } from '../../utils/debounce';
import { AnnotationModal } from '../editor/annotation-modal';
import { removeMarkTag, removeBlockAnchor, removeSpanAnchor, updateMarkTag, updateBlockAnchor, updateSpanAnchor } from '../../core/annotation-parser';
import { getFieldKeys, getFieldValues } from '../../db/annotation-repo';

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

  // Phase 3: 字段过滤状态
  private fieldFilterEntries: Array<{ key: string; value: string }> = [];

  // Plugin 实例引用（用于访问 modifyGuard 等保护机制）
  private pluginInstance: import('../../utils/plugin-interface').MarkVaultPluginInterface | null = null;

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
    const toolbar = container.createDiv({ cls: 'markvault-file-toolbar' });

    // 文件名
    const fileName = this.currentFilePath!.split('/').pop() || this.currentFilePath!;
    toolbar.createSpan({ cls: 'markvault-file-name', text: `📄 ${fileName}` });

    // 清空标注按钮
    const clearBtn = toolbar.createEl('button', {
      cls: 'markvault-clear-file-btn',
      title: 'Delete all annotations in this file',
    });
    clearBtn.createSpan({ text: '🗑️', cls: 'markvault-clear-icon' });
    clearBtn.createSpan({ text: 'Clear all', cls: 'markvault-clear-label' });

    clearBtn.addEventListener('click', async () => {
      if (!this.currentFilePath) return;
      const annotations = await getAnnotationsForFile(this.currentFilePath);
      if (annotations.length === 0) return;

      const confirmed = confirm(
        `Delete all ${annotations.length} annotations in "${fileName}"?\n\nThis will remove all highlights, blocks, and spans from this file.`
      );
      if (!confirmed) return;

      const plugin = this.pluginInstance;
      if (!plugin) return;
      const notice = new Notice(`Deleting ${annotations.length} annotations...`, 0);

      // 🔧 先设置冷却，关闭 onFileOpen 同步窗口
      plugin.markFileSynced(this.currentFilePath);

      // 🔧 备份所有标注 + 清理保护状态（深拷贝避免回滚时字段丢失）
      const backups = new Map<string, Annotation>();
      for (const ann of annotations) {
        backups.set(ann.uuid, JSON.parse(JSON.stringify(ann)));
        plugin.unmarkAnnotationActive(ann.uuid, ann.filePath);
      }

      // 🔧 统一 try/catch：任何步骤失败均可完整回滚
      try {
        // ── ① 批量删除 DB ──
        let dbDeleted = 0;
        for (const ann of annotations) {
          await deleteAnnotation(ann.uuid);
          dbDeleted++;
        }
        console.log(`MarkVault: clear all — ${dbDeleted} DB annotations deleted`);

        // ── ② 清理 MD ──
        // 使用 vault.process 原子读写，避免 read+modify 之间文件状态变化导致失败
        const file = this.app.vault.getAbstractFileByPath(this.currentFilePath);
        if (file instanceof TFile) {
          const stripAnchors = (content: string): string => {
            let newContent = content;
            for (const ann of annotations) {
              const result = this.removeAnnotationFromContent(newContent, ann);
              if (result) newContent = result;
            }
            return newContent;
          };

          plugin.modifyGuard.acquire(this.currentFilePath);
          try {
            console.log('MarkVault: clear all — calling vault.process');
            const written = await this.app.vault.process(file, stripAnchors);
            if (written.length === file.stat.size) {
              console.warn('MarkVault: clear all — markdown content unchanged after strip');
            } else {
              console.log(`MarkVault: clear all — removed ${file.stat.size - written.length} bytes`);
            }
          } catch (processErr) {
            // 首次 process 失败，短暂等待后重试一次（处理文件瞬态锁定）
            console.warn('MarkVault: clear all — vault.process failed, retrying in 200ms', processErr);
            await new Promise(r => setTimeout(r, 200));
            await this.app.vault.process(file, stripAnchors);
          } finally {
            plugin.modifyGuard.release(this.currentFilePath);
          }
          // vault.process 完成后再次延长冷却期，覆盖元数据重解析耗时
          plugin.markFileSynced(this.currentFilePath);
          console.log(`MarkVault: clear all — MD cleaned`);
        } else {
          console.warn('MarkVault: clear all — source file not found, DB annotations deleted only');
        }

        await plugin.updateSpanCache(this.currentFilePath);
        notice.hide();
        new Notice(`✅ Deleted ${annotations.length} annotations from "${fileName}"`, 4000);
        await this.refreshListOnly();

      } catch (err) {
        // 🔧 统一回滚：恢复所有备份标注
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('MarkVault: clear all failed, rolling back DB', err);
        let restored = 0;
        for (const [uuid, backup] of backups) {
          try {
            await addAnnotation(backup);
            restored++;
          } catch (addErr) {
            console.error(`MarkVault: rollback add failed for ${uuid}`, addErr);
          }
        }
        notice.hide();
        new Notice(
          `❌ Clear all failed: ${errMsg} (${restored}/${backups.size} rolled back)`,
          8000,
        );
        await this.refreshListOnly();
      }
    });
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

    // ── 第一行：类型 + 颜色（紧凑横排） ──
    const row1 = container.createDiv({ cls: 'markvault-filter-row' });

    // 类型过滤
    const typeFilters: Array<{ label: string; value: AnnotationFilter['type']; icon: string }> = [
      { label: 'All', value: 'all', icon: '✦' },
      { label: 'HL', value: 'highlight', icon: '' },
      { label: 'Bold', value: 'bold', icon: '' },
      { label: 'UL', value: 'underline', icon: '' },
    ];

    const typeGroup = row1.createDiv({ cls: 'markvault-filter-group' });
    typeGroup.createSpan({ cls: 'markvault-filter-group-label', text: 'Type' });
    for (const tf of typeFilters) {
      const btn = typeGroup.createEl('button', {
        text: tf.icon ? `${tf.icon}` : tf.label,
        cls: `markvault-filter-btn ${this.filter.type === tf.value ? 'active' : ''}`,
        attr: { title: tf.label },
      });
      btn.addEventListener('click', async () => {
        this.filter.type = tf.value;
        await this.refreshListOnly();
      });
    }

    // 颜色过滤（小圆点）
    const colorGroup = row1.createDiv({ cls: 'markvault-filter-group' });
    colorGroup.createSpan({ cls: 'markvault-filter-group-label', text: 'Color' });
    const allColorBtn = colorGroup.createEl('button', {
      text: 'All',
      cls: `markvault-color-btn markvault-color-mini ${this.filter.color === 'all' ? 'active' : ''}`,
    });
    allColorBtn.addEventListener('click', async () => {
      this.filter.color = 'all';
      await this.refreshListOnly();
    });
    for (const pc of PRESET_COLORS) {
      const colorBtn = colorGroup.createEl('button', {
        cls: `markvault-color-btn markvault-color-dot ${this.filter.color === pc.id ? 'active' : ''}`,
        attr: { title: pc.label },
      });
      colorBtn.style.backgroundColor = pc.hex;
      colorBtn.addEventListener('click', async () => {
        this.filter.color = pc.id;
        await this.refreshListOnly();
      });
    }

    // ── 第二行：排序 + 批注 + 字段过滤 ──
    const row2 = container.createDiv({ cls: 'markvault-filter-row' });

    // 排序
    const sortGroup = row2.createDiv({ cls: 'markvault-filter-group' });
    sortGroup.createSpan({ cls: 'markvault-filter-group-label', text: 'Sort' });
    const sortOptions: Array<{ label: string; value: AnnotationFilter['sortBy']; icon: string }> = [
      { label: 'Pos', value: 'position', icon: '' },
      { label: 'New', value: 'createdAt', icon: '' },
      { label: 'Upd', value: 'updatedAt', icon: '' },
    ];
    for (const so of sortOptions) {
      const btn = sortGroup.createEl('button', {
        text: so.label,
        cls: `markvault-sort-btn ${this.filter.sortBy === so.value ? 'active' : ''}`,
        attr: { title: so.label === 'Pos' ? 'Position' : so.label === 'New' ? 'Newest' : 'Updated' },
      });
      btn.addEventListener('click', async () => {
        this.filter.sortBy = so.value;
        await this.refreshListOnly();
      });
    }

    // 批注过滤
    const noteGroup = row2.createDiv({ cls: 'markvault-filter-group' });
    noteGroup.createSpan({ cls: 'markvault-filter-group-label', text: 'Note' });
    const noteFilters: Array<{ label: string; value: boolean | undefined }> = [
      { label: 'All', value: undefined },
      { label: '✎', value: true },
    ];
    for (const nf of noteFilters) {
      const btn = noteGroup.createEl('button', {
        text: nf.label,
        cls: `markvault-filter-btn ${this.filter.hasNote === nf.value ? 'active' : ''}`,
        attr: { title: nf.value === undefined ? 'All' : 'With Note' },
      });
      btn.addEventListener('click', async () => {
        this.filter.hasNote = nf.value;
        await this.refreshListOnly();
      });
    }

    // ── 第三行：By Field（内联下拉式） ──
    const fieldRow = container.createDiv({ cls: 'markvault-filter-row markvault-filter-field-row' });
    fieldRow.createSpan({ cls: 'markvault-filter-group-label', text: '🏷️' });

    // 字段过滤条件标签（横排显示）
    if (this.fieldFilterEntries.length > 0) {
      const tagsWrap = fieldRow.createDiv({ cls: 'markvault-field-filter-tags' });
      for (let i = 0; i < this.fieldFilterEntries.length; i++) {
        const entry = this.fieldFilterEntries[i];
        const filterTag = tagsWrap.createDiv({ cls: 'markvault-field-filter-tag' });
        filterTag.createSpan({ cls: 'markvault-field-filter-key', text: entry.key });
        filterTag.createSpan({ cls: 'markvault-field-filter-eq', text: '=' });
        filterTag.createSpan({ cls: 'markvault-field-filter-val', text: entry.value });
        const removeBtn = filterTag.createEl('button', {
          text: '✕',
          cls: 'markvault-field-filter-remove',
        });
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          this.fieldFilterEntries.splice(i, 1);
          await this.refreshListOnly();
        });
      }
    }

    // 添加字段过滤按钮（+ 图标）
    const addFieldFilterBtn = fieldRow.createEl('button', {
      text: this.fieldFilterEntries.length > 0 ? '+' : '+ Field',
      cls: 'markvault-add-field-filter-btn',
      attr: { title: 'Add field filter' },
    });
    addFieldFilterBtn.addEventListener('click', async () => {
      const fieldKeys = await getFieldKeys();
      this.showAddFieldFilterMenu(addFieldFilterBtn, fieldKeys);
    });
  }

  // ─── 字段过滤菜单 ──────────────────────────────────────

  private showAddFieldFilterMenu(anchor: HTMLElement, fieldKeys: string[]) {
    const menu = new Menu();

    if (fieldKeys.length === 0) {
      menu.addItem((item) => {
        item.setTitle('No fields found in annotations').setDisabled(true);
      });
    } else {
      for (const key of fieldKeys) {
        menu.addItem((item) => {
          item.setTitle(key).onClick(async () => {
            // 选择 key 后，显示 value 列表
            const values = await getFieldValues(key);
            this.showFieldValueMenu(anchor, key, values);
          });
        });
      }
    }

    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private showFieldValueMenu(anchor: HTMLElement, key: string, values: string[]) {
    const menu = new Menu();

    for (const val of values) {
      menu.addItem((item) => {
        item.setTitle(val).onClick(async () => {
          // 添加过滤条件
          this.fieldFilterEntries.push({ key, value: val });
          await this.refreshListOnly();
        });
      });
    }

    if (values.length === 0) {
      menu.addItem((item) => {
        item.setTitle('No values found').setDisabled(true);
      });
    }

    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
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

      const plugin = this.pluginInstance;
      if (!plugin) return;

      // 🔧 P0 修复：两阶段提交，支持跨文件原子回滚
      type BatchDeleteFileEntry = {
        file: TFile;
        originalContent: string;
        items: Array<{ uuid: string; kind: string }>;
        backups: Map<string, Annotation>;
      };

      const byFile = new Map<string, BatchDeleteFileEntry>();
      const missingUuids: string[] = [];

      // ── Phase 1: 收集数据 ──
      for (const uuid of this.selectedUuids) {
        const annotation = await getAnnotationByUuid(uuid);
        if (!annotation) {
          missingUuids.push(uuid);
          continue;
        }

        // 清理活跃保护状态
        plugin.unmarkAnnotationActive(uuid, annotation.filePath);

        let entry = byFile.get(annotation.filePath);
        if (!entry) {
          const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
          if (!(file instanceof TFile)) {
            missingUuids.push(uuid);
            continue;
          }
          const content = await this.app.vault.read(file);
          entry = {
            file,
            originalContent: content,
            items: [],
            backups: new Map(),
          };
          byFile.set(annotation.filePath, entry);
        }

        entry.backups.set(uuid, JSON.parse(JSON.stringify(annotation)));
        entry.items.push({ uuid, kind: annotation.kind || 'inline' });
      }

      // ── Phase 2: 统一删除 DB ──
      for (const entry of byFile.values()) {
        for (const uuid of entry.backups.keys()) {
          await deleteAnnotation(uuid);
        }
      }

      // ── Phase 3: 应用 MD 修改（vault.process 原子读写）；任意文件失败则全量回滚 ──
      const modifiedFiles: string[] = [];
      let hasFailure = false;
      let lastError: unknown = null;

      for (const [filePath, entry] of byFile) {
        plugin.markFileSynced(filePath);
        plugin.modifyGuard.acquire(filePath);
        try {
          await this.app.vault.process(entry.file, (content) => {
            let newContent = content;
            for (const item of entry.items) {
              if (item.kind === 'block') {
                newContent = removeBlockAnchor(newContent, item.uuid);
              } else if (item.kind === 'span') {
                newContent = removeSpanAnchor(newContent, item.uuid);
              } else {
                const result = removeMarkTag(newContent, item.uuid);
                if (result) newContent = result.content;
              }
            }
            return newContent;
          });
          modifiedFiles.push(filePath);
        } catch (processErr) {
          lastError = processErr;
          hasFailure = true;
          break;
        } finally {
          plugin.modifyGuard.release(filePath);
        }
      }

      if (hasFailure) {
        // 回滚 DB：恢复所有已删除的标注
        for (const entry of byFile.values()) {
          for (const backup of entry.backups.values()) {
            try {
              await addAnnotation(backup);
            } catch (addErr) {
              console.error('MarkVault: batch delete rollback add failed', addErr);
            }
          }
        }

        // 回滚 MD：将已成功修改的文件恢复为原始内容（同样使用 process 避免 mtime 冲突）
        for (const filePath of modifiedFiles) {
          const entry = byFile.get(filePath)!;
          const originalContent = entry.originalContent;
          plugin.modifyGuard.acquire(filePath);
          try {
            await this.app.vault.process(entry.file, () => originalContent);
          } catch (restoreErr) {
            console.error(`MarkVault: batch delete MD restore failed for ${filePath}`, restoreErr);
          } finally {
            plugin.modifyGuard.release(filePath);
          }
        }

        new Notice(
          `Batch delete failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
          5000,
        );
      } else {
        new Notice(
          `Deleted ${this.selectedUuids.size - missingUuids.length} annotations`,
          4000,
        );
      }

      // 更新 span 缓存
      for (const filePath of byFile.keys()) {
        try {
          await plugin.updateSpanCache(filePath);
        } catch (err) {
          console.error('MarkVault: batch delete spanCache error', filePath, err);
        }
      }

      this.selectedUuids.clear();
      await this.renderContent();
    });

    // 🆕 Phase 3: 导出按钮
    const exportBtn = bar.createEl('button', {
      text: '📥 Export',
      cls: 'markvault-batch-btn',
    });
    exportBtn.addEventListener('click', () => {
      this.showExportMenu(exportBtn);
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

  // ─── 导出功能 ──────────────────────────────────────────

  private showExportMenu(anchor: HTMLElement) {
    const menu = new Menu();

    // 导出当前过滤结果
    menu.addItem((item) => {
      item.setTitle('Export filtered (JSON)')
        .onClick(async () => {
          await this.exportFiltered('json');
        });
    });

    menu.addItem((item) => {
      item.setTitle('Export filtered (Markdown)')
        .onClick(async () => {
          await this.exportFiltered('markdown');
        });
    });

    // 导出选中标注
    if (this.selectedUuids.size > 0) {
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(`Export ${this.selectedUuids.size} selected (JSON)`)
          .onClick(async () => {
            await this.exportSelected('json');
          });
      });
      menu.addItem((item) => {
        item.setTitle(`Export ${this.selectedUuids.size} selected (Markdown)`)
          .onClick(async () => {
            await this.exportSelected('markdown');
          });
      });
    }

    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async exportFiltered(format: 'json' | 'markdown') {
    let annotations: Annotation[];

    if (this.activeTab === 'current' && this.currentFilePath) {
      annotations = await queryAnnotations({
        ...this.filter,
      });
      annotations = annotations.filter(a => a.filePath === this.currentFilePath);
    } else {
      annotations = await queryAnnotations(this.filter);
    }

    this.doExport(annotations, format);
  }

  private async exportSelected(format: 'json' | 'markdown') {
    const annotations: Annotation[] = [];
    for (const uuid of this.selectedUuids) {
      const ann = await getAnnotationByUuid(uuid);
      if (ann) annotations.push(ann);
    }
    this.doExport(annotations, format);
  }

  private doExport(annotations: Annotation[], format: 'json' | 'markdown') {
    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      const content = JSON.stringify(annotations, null, 2);
      this.downloadFile(content, `markvault-export-${dateStr}.json`, 'application/json');
    } else {
      // Markdown 格式：按文件分组
      const byFile = new Map<string, Annotation[]>();
      for (const a of annotations) {
        const fileName = a.filePath.split('/').pop() || a.filePath;
        if (!byFile.has(fileName)) byFile.set(fileName, []);
        byFile.get(fileName)!.push(a);
      }

      let md = `# MarkVault Export\n\nExported: ${new Date().toLocaleString()}\nTotal: ${annotations.length} annotations\n\n---\n\n`;

      for (const [fileName, items] of byFile) {
        md += `## ${fileName}\n\n`;
        for (const a of items) {
          md += `> ${a.text.replace(/\n/g, '\n> ')}\n\n`;
          if (a.note) md += `**Note**: ${a.note}\n\n`;
          if (a.fields && Object.keys(a.fields).length > 0) {
            const fieldsStr = Object.entries(a.fields).map(([k, v]) => `${k}=${v}`).join(', ');
            md += `**Fields**: ${fieldsStr}\n\n`;
          }
          if (a.tags.length > 0) {
            md += `**Tags**: ${a.tags.map(t => `#${t}`).join(' ')}\n\n`;
          }
          md += `---\n\n`;
        }
      }

      this.downloadFile(md, `markvault-export-${dateStr}.md`, 'text/markdown');
    }
  }

  private downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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

    const plugin = this.pluginInstance;
    if (!plugin) return;

    // 🔧 审计修复：按文件分组 + 保存原始颜色用于回滚
    const byFile = new Map<string, Array<{ uuid: string; kind: string; originalColor: string }>>();

    for (const uuid of this.selectedUuids) {
      const annotation = await getAnnotationByUuid(uuid);
      if (!annotation) continue;

      const originalColor = annotation.color;
      await updateAnnotation(uuid, { color: colorId });

      let group = byFile.get(annotation.filePath);
      if (!group) {
        group = [];
        byFile.set(annotation.filePath, group);
      }
      group.push({ uuid, kind: annotation.kind || 'inline', originalColor });
    }

    // 批量处理：每个文件只做一次 vault.modify
    const affectedFiles = new Set<string>();
    for (const [filePath, items] of byFile) {
      try {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) continue;

        const content = await this.app.vault.read(file);
        let newContent = content;

        for (const item of items) {
          if (item.kind === 'span') {
            newContent = updateSpanAnchor(newContent, item.uuid, { color: colorId });
          } else if (item.kind === 'block') {
            newContent = updateBlockAnchor(newContent, item.uuid, { color: colorId });
          } else {
            newContent = updateMarkTag(newContent, item.uuid, { color: colorId });
          }
        }

        if (newContent !== content) {
          plugin.modifyGuard.acquire(filePath);
          try {
            await this.app.vault.modify(file, newContent);
          } catch (mdErr) {
            // 🔧 P0 修复：MD 失败，回滚该文件所有标注
            console.error(`MarkVault: batch color change MD error for ${filePath}, rolling back`, mdErr);
            for (const item of items) {
              await updateAnnotation(item.uuid, { color: item.originalColor });
            }
            throw mdErr;
          } finally {
            plugin.modifyGuard.release(filePath);
          }
        }

        plugin.markFileSynced(filePath);
        affectedFiles.add(filePath);
      } catch (err) {
        plugin.modifyGuard.releaseNow(filePath);
        console.error('MarkVault: batch color change error', filePath, err);
      }
    }

    // 更新 span 缓存
    for (const filePath of affectedFiles) {
      try {
        await plugin.updateSpanCache(filePath);
      } catch (err) {
        console.error('MarkVault: batch color change spanCache error', filePath, err);
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

      // 文件头 — 点击展开/折叠，双击打开文件
      // 标注列表（默认折叠）
      const list = groupEl.createDiv({ cls: 'markvault-file-group-list' });
      let expanded = false;
      header.addEventListener('click', () => {
        expanded = !expanded;
        list.toggleClass('expanded', expanded);
        header.toggleClass('expanded', expanded);
      });
      header.addEventListener('dblclick', async () => {
        const firstItem = items[0];
        const file = this.app.vault.getAbstractFileByPath(firstItem.filePath);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
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

    // 标注原文 — 使用 MarkdownRenderer 统一渲染，支持链接、公式、粗体等
    const textEl = card.createDiv({ cls: 'markvault-card-text' });

    if (this.component_) {
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

    // 🆕 Phase 3: Fields 展示
    if (annotation.fields && Object.keys(annotation.fields).length > 0) {
      const fieldsEl = card.createDiv({ cls: 'markvault-card-fields' });
      const entries = Object.entries(annotation.fields);
      const showCount = Math.min(entries.length, 3);

      for (let i = 0; i < showCount; i++) {
        const [k, v] = entries[i];
        const fieldTag = fieldsEl.createSpan({ cls: 'markvault-field-tag' });
        fieldTag.createSpan({ text: k, cls: 'markvault-field-tag-key' });
        fieldTag.createSpan({ text: ':', cls: 'markvault-field-tag-sep' });
        fieldTag.createSpan({ text: v, cls: 'markvault-field-tag-value' });

        // 点击字段标签 → 快速添加到过滤条件
        fieldTag.addEventListener('click', (e) => {
          e.stopPropagation();
          // 检查是否已存在
          const exists = this.fieldFilterEntries.some(fe => fe.key === k && fe.value === v);
          if (!exists) {
            this.fieldFilterEntries.push({ key: k, value: v });
            this.refreshListOnly();
          }
        });
      }

      // 超过 3 个折叠
      if (entries.length > 3) {
        const moreEl = fieldsEl.createSpan({
          cls: 'markvault-field-more',
          text: `${entries.length - 3} more...`,
        });
        let expanded = false;
        moreEl.addEventListener('click', (e) => {
          e.stopPropagation();
          expanded = !expanded;
          if (expanded) {
            // 展开剩余
            for (let i = 3; i < entries.length; i++) {
              const [k, v] = entries[i];
              const fieldTag = fieldsEl.createSpan({ cls: 'markvault-field-tag' });
              fieldTag.createSpan({ text: k, cls: 'markvault-field-tag-key' });
              fieldTag.createSpan({ text: ':', cls: 'markvault-field-tag-sep' });
              fieldTag.createSpan({ text: v, cls: 'markvault-field-tag-value' });
            }
            moreEl.textContent = 'less';
          } else {
            // 折叠：移除索引 >= 3 的字段标签
            const allFieldTags = fieldsEl.querySelectorAll('.markvault-field-tag');
            for (let i = 3; i < allFieldTags.length; i++) {
              allFieldTags[i].remove();
            }
            moreEl.textContent = `${entries.length - 3} more...`;
          }
        });
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

    const jumpBtn = actions.createEl('button', { cls: 'markvault-action-btn', text: '↩️' });
    jumpBtn.title = 'Jump to source';
    jumpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.jumpToAnnotation(annotation);
    });

    const deleteBtn = actions.createEl('button', { cls: 'markvault-action-btn markvault-delete-btn', text: '🗑️' });
    deleteBtn.title = 'Delete annotation';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.deleteAnnotationWithConfirm(annotation);
    });

    // 卡片点击 → 跳转到原文锚点位置
    card.addEventListener('click', () => {
      if (this.batchMode) {
        // 批量模式下点击 = 切换选中
        const cb = card.querySelector('.markvault-card-checkbox') as HTMLInputElement;
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      } else {
        this.jumpToAnnotation(annotation);
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
    // 🔧 P0 修复：捕获原始颜色用于 MD 失败时回滚
    const originalColor = annotation.color;
    await updateAnnotation(annotation.uuid, { color: colorId });

    const plugin = this.pluginInstance;
    if (!plugin) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        let newContent: string;

        if (annotation.kind === 'span') {
          newContent = updateSpanAnchor(content, annotation.uuid, { color: colorId });
        } else if (annotation.kind === 'block') {
          newContent = updateBlockAnchor(content, annotation.uuid, { color: colorId });
        } else {
          newContent = updateMarkTag(content, annotation.uuid, { color: colorId });
        }

        if (newContent !== content) {
          plugin.modifyGuard.acquire(annotation.filePath);
          try {
            await this.app.vault.modify(file, newContent);
          } catch (mdErr) {
            // 🔧 P0 修复：MD 失败，回滚 DB
            console.error('MarkVault: quickChangeColor MD error, rolling back', mdErr);
            await updateAnnotation(annotation.uuid, { color: originalColor });
            throw mdErr;
          } finally {
            plugin.modifyGuard.release(annotation.filePath);
          }
        }

        plugin.markFileSynced(annotation.filePath);
        await plugin.updateSpanCache(annotation.filePath);
      }
    } catch (err) {
      plugin.modifyGuard.releaseNow(annotation.filePath);
      console.error('MarkVault: quick color change error', err);
    }
    await this.refreshListOnly();
  }

  // ─── 加载标注列表 ──────────────────────────────────────

  private async loadAndRenderAnnotations(container: HTMLElement, filePath: string) {
    let annotations: Annotation[];

    // 🔧 P0 修复：fieldFilters 存在时始终走 queryAnnotations，否则会被跳过
    const hasActiveFilters = this.searchQuery?.trim()
      || this.filter.type !== 'all'
      || this.filter.color !== 'all'
      || this.filter.hasNote
      || (this.filter.fieldFilters && Object.keys(this.filter.fieldFilters).length > 0);

    if (hasActiveFilters) {
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

    // 🔧 P0 修复：字段过滤 — applySearchFilter 中处理 all notes 视图
    if (this.filter.fieldFilters && Object.keys(this.filter.fieldFilters).length > 0) {
      for (const [key, value] of Object.entries(this.filter.fieldFilters)) {
        filtered = filtered.filter(a =>
          a.fields && a.fields[key] !== undefined && a.fields[key] === value,
        );
      }
    }

    // 搜索
    if (this.searchQuery && this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(a =>
        a.text.toLowerCase().includes(q) ||
        a.note.toLowerCase().includes(q) ||
        a.tags.some(t => t.toLowerCase().includes(q)) ||
        a.filePath.toLowerCase().includes(q) ||
        (a.fields && Object.entries(a.fields).some(([k, v]) =>
          k.toLowerCase().includes(q) || v.toLowerCase().includes(q)
        )),
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
    if (!(view instanceof MarkdownView)) return;

    // 阅读模式下没有 editor，切换到源码模式
    if (!view.editor) {
      const state = leaf.getViewState();
      if (state.state) {
        state.state.mode = 'source';
        await leaf.setViewState(state);
      }
    }
    if (!view.editor) return;

    // ── 基于 UUID 锚点搜索定位（不依赖存储的偏移量，永不漂移） ──
    try {
      const content = await this.app.vault.read(file);
      let searchStr: string;
      if (annotation.kind === 'block') {
        searchStr = `markvault:${annotation.uuid}`;
      } else if (annotation.kind === 'span') {
        searchStr = `markvault-span:${annotation.uuid}`;
      } else {
        searchStr = `data-uuid="${annotation.uuid}"`;
      }

      const idx = content.indexOf(searchStr);
      if (idx === -1) {
        // 锚点可能被删除，降级为行号定位
        console.warn(`MarkVault: UUID ${annotation.uuid} not found in source`);
        view.editor.setCursor({ line: annotation.startLine, ch: 0 });
        view.editor.scrollIntoView(
          { from: { line: annotation.startLine, ch: 0 }, to: { line: annotation.startLine + 1, ch: 0 } },
          true,
        );
        return;
      }

      const pos = view.editor.offsetToPos(idx);
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({
        from: pos,
        to: { line: pos.line + 1, ch: 0 },
      }, true);
    } catch (err) {
      console.error('MarkVault: jumpToAnnotation error', err);
    }
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
      async (uuid) => {
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
    if (annotation.kind === 'block') {
      const result = removeBlockAnchor(content, annotation.uuid);
      return result !== content ? result : null;
    }
    if (annotation.kind === 'span') {
      const result = removeSpanAnchor(content, annotation.uuid);
      return result !== content ? result : null;
    }
    const result = removeMarkTag(content, annotation.uuid);
    return result ? result.content : null;
  }

  private async deleteAnnotationWithConfirm(annotation: Annotation) {
    const confirmed = confirm(`Delete annotation "${annotation.text.substring(0, 50)}..."?`);
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
