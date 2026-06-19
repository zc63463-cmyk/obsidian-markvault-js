import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { Annotation } from '../../../types/annotation';
import { PRESET_COLORS } from '../../../types/annotation';

/**
 * AllNotesView —— 侧边栏"全部笔记"视图
 *
 * 负责子视图 Tab、时间线/按文件/按颜色三种分组渲染。
 */
export type AllNotesSubView = 'timeline' | 'by-file' | 'by-color';

export interface AllNotesViewHost {
  app: App;
  isBatchMode(): boolean;
  getAllNotesSubView(): AllNotesSubView;
  setAllNotesSubView(view: AllNotesSubView): void;
  getAllAnnotations(): Promise<Annotation[]>;
  applySearchFilter(annotations: Annotation[]): Annotation[];
  renderAnnotationCard(container: HTMLElement, annotation: Annotation, showFilePath: boolean): void;
  renderFilterBar(container: HTMLElement): void;
  renderBatchBar(container: HTMLElement): void;
  renderContent(): Promise<void>;
}

export class AllNotesView {
  constructor(private host: AllNotesViewHost) {}

  async render(container: HTMLElement): Promise<void> {
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
        cls: `markvault-sub-tab-btn ${this.host.getAllNotesSubView() === tab.id ? 'active' : ''}`,
      });
      btn.addEventListener('click', async () => {
        this.host.setAllNotesSubView(tab.id);
        await this.host.renderContent();
      });
    }

    // 过滤栏
    const filterBar = container.createDiv({ cls: 'markvault-filter-section' });
    this.host.renderFilterBar(filterBar);

    // 批量操作栏
    if (this.host.isBatchMode()) {
      this.host.renderBatchBar(container);
    }

    // 内容
    const listContainer = container.createDiv({ cls: 'markvault-sidebar-list' });
    listContainer.id = 'markvault-list-container';

    // 加载所有标注
    const allAnnotations = await this.host.getAllAnnotations();

    // 搜索过滤
    const filtered = this.host.applySearchFilter(allAnnotations);

    // S3 审查修复: All Notes 视图也加节点数上限保护
    const ALL_NOTES_LIMIT = 1000;
    let displayAnnotations = filtered;
    let truncatedNote = '';
    if (filtered.length > ALL_NOTES_LIMIT) {
      displayAnnotations = filtered.slice(0, ALL_NOTES_LIMIT);
      truncatedNote = `（显示前 ${ALL_NOTES_LIMIT} 条，共 ${filtered.length} 条，请使用搜索/筛选缩小范围）`;
    }

    switch (this.host.getAllNotesSubView()) {
      case 'timeline':
        this.renderTimelineView(listContainer, displayAnnotations);
        break;
      case 'by-file':
        this.renderByFileView(listContainer, displayAnnotations);
        break;
      case 'by-color':
        this.renderByColorView(listContainer, displayAnnotations);
        break;
    }

    if (truncatedNote) {
      const noticeEl = listContainer.createDiv({ cls: 'markvault-truncate-notice', text: truncatedNote });
      noticeEl.style.cssText = 'padding: 8px 12px; color: var(--text-muted); font-size: 12px; text-align: center;';
    }
  }

  renderTimelineView(container: HTMLElement, annotations: Annotation[]) {
    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations found' });
      return;
    }

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

    for (const [date, items] of groups) {
      const groupEl = container.createDiv({ cls: 'markvault-timeline-group' });
      groupEl.createDiv({ cls: 'markvault-timeline-date', text: date });

      for (const annotation of items) {
        this.host.renderAnnotationCard(groupEl, annotation, true);
      }
    }
  }

  renderByFileView(container: HTMLElement, annotations: Annotation[]) {
    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations found' });
      return;
    }

    const groups = new Map<string, Annotation[]>();
    for (const a of annotations) {
      const fileName = a.filePath.split('/').pop()?.replace('.md', '') || a.filePath;
      if (!groups.has(fileName)) groups.set(fileName, []);
      groups.get(fileName)!.push(a);
    }

    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [fileName, items] of sorted) {
      const groupEl = container.createDiv({ cls: 'markvault-file-group' });

      const header = groupEl.createDiv({ cls: 'markvault-file-group-header' });
      header.createSpan({ text: '📄', cls: 'markvault-file-group-icon' });
      header.createSpan({ text: fileName, cls: 'markvault-file-group-name' });
      header.createSpan({ text: `${items.length}`, cls: 'markvault-file-group-count' });

      const list = groupEl.createDiv({ cls: 'markvault-file-group-list' });
      let expanded = false;
      header.addEventListener('click', () => {
        expanded = !expanded;
        list.toggleClass('expanded', expanded);
        header.toggleClass('expanded', expanded);
      });
      header.addEventListener('dblclick', async () => {
        const firstItem = items[0];
        const file = this.host.app.vault.getAbstractFileByPath(firstItem.filePath);
        if (file instanceof TFile) {
          await this.host.app.workspace.getLeaf(false).openFile(file);
        }
      });

      for (const annotation of items) {
        this.host.renderAnnotationCard(list, annotation, false);
      }
    }
  }

  renderByColorView(container: HTMLElement, annotations: Annotation[]) {
    if (annotations.length === 0) {
      container.createDiv({ cls: 'markvault-empty-state', text: 'No annotations found' });
      return;
    }

    const groups = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (!groups.has(a.color)) groups.set(a.color, []);
      groups.get(a.color)!.push(a);
    }

    for (const pc of PRESET_COLORS) {
      const items = groups.get(pc.id);
      if (!items || items.length === 0) continue;

      const groupEl = container.createDiv({ cls: 'markvault-color-group' });

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
        this.host.renderAnnotationCard(list, annotation, true);
      }
    }
  }
}
