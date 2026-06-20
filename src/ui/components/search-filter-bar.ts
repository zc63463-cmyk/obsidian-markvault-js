/**
 * search-filter-bar.ts — 共享的标注搜索筛选栏组件
 *
 * 提取自 RelationPickerModal 和 AnnotationPickerModal 的重复筛选逻辑。
 * 两个 Modal 共用同一套 PickerFilterState + Filter button 渲染。
 *
 * 共享内容:
 *   - PickerFilterState: 筛选状态管理 (filter + selectedTags)
 *   - renderTypeFilterBtn / renderMasteryFilterBtn / renderTagsFilterBtn / renderGroupFilterBtn
 *   - doPickerSearch: 统一搜索入口 (sync tags → engine.search)
 *
 * RelationPickerModal 独有的筛选 (Color/Motivation/Field/Scope) 保留在原文件。
 */

import { Menu } from 'obsidian';
import type { AnnotationFilter, MasteryLevel, AnnotationType } from '../../types/annotation';
import { MASTERY_LABELS } from '../../types/annotation';
import type { AnnotationSearchEngine } from '../../search/search-engine';
import type { SearchResult } from '../../search/types';
import { getGroupNames, getTagFrequencies, getAllAnnotations } from '../../db/annotation-repo';
import { buildTagTree, type TagTreeNode } from '../../utils/tag-tree';

// ═══════════════════════════════════════════════════════
// PickerFilterState — 共享的筛选状态
// ═══════════════════════════════════════════════════════

export class PickerFilterState {
  filter: AnnotationFilter = { type: 'all', color: 'all' };
  selectedTags: string[] = [];

  reset(): void {
    this.filter = { type: 'all', color: 'all' };
    this.selectedTags = [];
  }

  /** Sync selectedTags into filter.tags before passing to engine.search() */
  syncToFilter(): AnnotationFilter {
    const f = { ...this.filter };
    if (this.selectedTags.length > 0) {
      f.tags = this.selectedTags;
    } else {
      f.tags = undefined;
    }
    return f;
  }

  hasActiveFilters(): boolean {
    return (
      (this.filter.type !== undefined && this.filter.type !== 'all') ||
      (this.filter.mastery !== undefined && this.filter.mastery !== 'all') ||
      (this.filter.group !== undefined && this.filter.group !== 'all') ||
      (this.filter.color !== undefined && this.filter.color !== 'all') ||
      (this.filter.motivation !== undefined && this.filter.motivation !== 'all') ||
      this.selectedTags.length > 0
    );
  }
}

// ═══════════════════════════════════════════════════════
// Filter Button 渲染函数
// ═══════════════════════════════════════════════════════
// 每个函数创建按钮 + 绑定 Menu click 事件。
// 返回按钮 DOM 元素，调用方可用它更新按钮文字（active 状态时）。

const FILTER_BTN_STYLE =
  'padding:2px 10px;border:1px solid var(--background-modifier-border,#ddd);' +
  'border-radius:4px;cursor:pointer;font-size:11px;' +
  'background:var(--background-primary,#fff)';

/** 创建通用筛选按钮 */
function _createFilterBtn(parent: HTMLElement, defaultLabel: string): HTMLButtonElement {
  const btn = parent.createEl('button', { text: defaultLabel });
  btn.style.cssText = FILTER_BTN_STYLE;
  return btn;
}

/** 设置按钮为 active 状态 */
function _setBtnActive(btn: HTMLButtonElement, text: string): void {
  btn.textContent = text;
  btn.style.background = 'var(--interactive-accent,#483699)';
  btn.style.color = '#fff';
  btn.style.borderColor = 'var(--interactive-accent,#483699)';
}

/** 重置按钮为默认状态 */
function _setBtnDefault(btn: HTMLButtonElement, text: string): void {
  btn.textContent = text;
  btn.style.background = 'var(--background-primary,#fff)';
  btn.style.color = '';
  btn.style.borderColor = 'var(--background-modifier-border,#ddd)';
}

// ─── Type 筛选按钮 ────────────────────────────────────

export function renderTypeFilterBtn(
  parent: HTMLElement,
  filterState: PickerFilterState,
  onChange: () => void,
): HTMLButtonElement {
  const currentType = filterState.filter.type ?? 'all';
  const btn = _createFilterBtn(parent, currentType !== 'all' ? currentType : 'Type');
  if (currentType !== 'all') _setBtnActive(btn, currentType);

  btn.addEventListener('click', () => {
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle('All').setChecked(currentType === 'all')
        .onClick(() => { filterState.filter.type = 'all'; _setBtnDefault(btn, 'Type'); onChange(); });
    });
    for (const t of ['highlight', 'bold', 'underline'] as AnnotationType[]) {
      menu.addItem((item) => {
        item.setTitle(t).setChecked(currentType === t)
          .onClick(() => { filterState.filter.type = t; _setBtnActive(btn, t); onChange(); });
      });
    }
    menu.showAtMouseEvent({
      clientX: btn.getBoundingClientRect().left,
      clientY: btn.getBoundingClientRect().bottom,
    } as MouseEvent);
  });
  return btn;
}

// ─── Mastery 筛选按钮 ─────────────────────────────────

export function renderMasteryFilterBtn(
  parent: HTMLElement,
  filterState: PickerFilterState,
  onChange: () => void,
): HTMLButtonElement {
  const currentMastery = filterState.filter.mastery ?? 'all';
  const isActive = currentMastery !== 'all';
  const btnLabel = isActive ? (MASTERY_LABELS[currentMastery] || currentMastery) : 'Mastery';
  const btn = _createFilterBtn(parent, btnLabel);
  if (isActive) _setBtnActive(btn, btnLabel);

  btn.addEventListener('click', () => {
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle('All').setChecked(!isActive)
        .onClick(() => { filterState.filter.mastery = 'all'; _setBtnDefault(btn, 'Mastery'); onChange(); });
    });
    for (const [value, label] of Object.entries(MASTERY_LABELS)) {
      menu.addItem((item) => {
        item.setTitle(label).setChecked(currentMastery === value)
          .onClick(() => { filterState.filter.mastery = value as MasteryLevel; _setBtnActive(btn, label); onChange(); });
      });
    }
    menu.showAtMouseEvent({
      clientX: btn.getBoundingClientRect().left,
      clientY: btn.getBoundingClientRect().bottom,
    } as MouseEvent);
  });
  return btn;
}

// ─── Tags 多选筛选按钮 (v6.2: Popover 对齐侧边栏) ─────

export function renderTagsFilterBtn(
  parent: HTMLElement,
  filterState: PickerFilterState,
  onChange: () => void,
): HTMLButtonElement {
  const selCount = filterState.selectedTags.length;
  const btnLabel = selCount > 0 ? `# ${selCount}` : '# Tags';
  const btn = _createFilterBtn(parent, btnLabel);
  if (selCount > 0) _setBtnActive(btn, btnLabel);

  let popoverEl: HTMLElement | null = null;
  let tagGroupsMap: Map<string, Set<string>> | null = null;
  let activeGroup: string | null = null;

  const ensureTagGroups = async () => {
    if (tagGroupsMap) return;
    tagGroupsMap = new Map();
    const all = await getAllAnnotations();
    for (const ann of all) {
      const gs = ann.groups ?? [];
      for (const t of ann.tags) {
        let set = tagGroupsMap.get(t);
        if (!set) { set = new Set(); tagGroupsMap.set(t, set); }
        for (const g of gs) set.add(g);
      }
    }
  };

  const getFilteredFrequencies = (groupFilter: string | null) => {
    const allFreqs = getTagFrequencies();
    if (!groupFilter || !tagGroupsMap) return allFreqs;
    return allFreqs.filter(f => tagGroupsMap!.get(f.name)?.has(groupFilter));
  };

  const buildTreeForGroup = (groupFilter: string | null) => {
    const filteredFreqs = getFilteredFrequencies(groupFilter);
    return buildTagTree(filteredFreqs);
  };

  const removePopover = () => {
    if (popoverEl) { popoverEl.remove(); popoverEl = null; }
  };

  const closeOnOutsideClick = (e: MouseEvent) => {
    if (popoverEl && !popoverEl.contains(e.target as Node) && e.target !== btn) {
      removePopover();
      document.removeEventListener('click', closeOnOutsideClick, true);
    }
  };

  btn.addEventListener('click', () => {
    // Toggle: 如果已打开则关闭
    if (popoverEl) { removePopover(); document.removeEventListener('click', closeOnOutsideClick, true); return; }

    const frequencies = getTagFrequencies();
    if (frequencies.length === 0) return;

    // 创建 popover
    popoverEl = document.body.createDiv({ cls: 'markvault-tags-popover' });
    Object.assign(popoverEl.style, {
      position: 'fixed',
      zIndex: '1000',
      minWidth: '240px',
      maxWidth: '300px',
      maxHeight: '360px',
      background: 'var(--background-primary, #fff)',
      border: '1px solid var(--background-modifier-border, #ddd)',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    });
    const rect = btn.getBoundingClientRect();
    popoverEl.style.top = `${rect.bottom + 4}px`;
    popoverEl.style.left = `${Math.min(rect.left, window.innerWidth - 310)}px`;

    // Group 筛选芯片
    const groupChips = popoverEl.createDiv();
    groupChips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;padding:6px 10px;border-bottom:1px solid var(--background-modifier-border,#ddd)';

    const renderGroupChips = () => {
      groupChips.empty();
      const groups = getGroupNames().slice(0, 5);
      const allChip = groupChips.createSpan({ text: 'All' });
      allChip.style.cssText = 'padding:1px 8px;border-radius:8px;cursor:pointer;font-size:11px;border:1px solid var(--background-modifier-border,#ddd)';
      if (!activeGroup) { allChip.style.background = 'var(--interactive-accent,#483699)'; allChip.style.color = '#fff'; }
      allChip.addEventListener('click', () => { activeGroup = null; renderGroupChips(); renderTagList(); });

      for (const g of groups) {
        const chip = groupChips.createSpan({ text: g });
        chip.style.cssText = 'padding:1px 8px;border-radius:8px;cursor:pointer;font-size:11px;border:1px solid var(--background-modifier-border,#ddd);white-space:nowrap';
        if (activeGroup === g) { chip.style.background = 'var(--interactive-accent,#483699)'; chip.style.color = '#fff'; }
        chip.addEventListener('click', () => { activeGroup = g; renderGroupChips(); renderTagList(); });
      }
    };
    renderGroupChips();

    // 搜索框
    const searchInput = popoverEl.createEl('input', {
      type: 'text',
      attr: { placeholder: 'Search tags...' },
    });
    Object.assign(searchInput.style, {
      width: '100%', boxSizing: 'border-box', padding: '6px 10px',
      border: 'none', borderBottom: '1px solid var(--background-modifier-border,#ddd)',
      fontSize: '12px', background: 'var(--background-primary,#fff)', outline: 'none',
    });
    searchInput.addEventListener('input', () => renderTagList());

    // 标签列表容器
    const tagList = popoverEl.createDiv();
    tagList.style.cssText = 'overflow-y:auto;flex:1;min-height:0';
    tagList.style.maxHeight = '240px';

    // 渲染标签树
    const renderTagList = () => {
      const query = searchInput.value.toLowerCase().trim();
      const { rootNodes } = buildTreeForGroup(activeGroup);

      tagList.empty();

      const renderNode = (node: TagTreeNode, depth: number) => {
        const fullPath = node.fullPath;
        if (query && !fullPath.toLowerCase().includes(query)) {
          // Still render if children might match
          const childHasMatch = node.children.some(c => c.fullPath.toLowerCase().includes(query));
          if (!childHasMatch && query) return;
          // If parent doesn't match, skip it but render matching children
          if (!fullPath.toLowerCase().includes(query)) {
            for (const child of node.children) renderNode(child, depth);
            return;
          }
        }

        const isSelected = filterState.selectedTags.includes(fullPath);
        const row = tagList.createDiv();
        row.style.cssText = `display:flex;align-items:center;padding:3px 10px;padding-left:${10 + depth * 14}px;cursor:pointer;font-size:12px;transition:background .1s`;
        if (isSelected) row.style.background = 'var(--background-modifier-hover,rgba(0,0,0,.05))';

        const check = row.createSpan({ text: isSelected ? '☑' : '☐' });
        check.style.cssText = 'margin-right:6px;font-size:11px;flex-shrink:0';

        const label = row.createSpan({ text: node.label });
        label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

        const count = row.createSpan({ text: String(node.count) });
        count.style.cssText = 'font-size:10px;color:var(--text-muted,#999);margin-left:auto;flex-shrink:0';

        row.addEventListener('mouseenter', () => { if (!isSelected) row.style.background = 'var(--background-modifier-hover,rgba(0,0,0,.05))'; });
        row.addEventListener('mouseleave', () => { if (!isSelected) row.style.background = ''; });
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isSelected) {
            filterState.selectedTags = filterState.selectedTags.filter(t => t !== fullPath);
          } else {
            filterState.selectedTags.push(fullPath);
          }
          const n = filterState.selectedTags.length;
          if (n > 0) _setBtnActive(btn, `# ${n}`);
          else _setBtnDefault(btn, '# Tags');
          onChange();
          renderTagList();
        });

        for (const child of node.children) renderNode(child, depth + 1);
      };

      // 空状态
      if (rootNodes.length === 0) {
        const empty = tagList.createDiv({ text: activeGroup ? `No tags in "${activeGroup}"` : 'No tags in any annotation' });
        empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-muted,#888);font-size:12px';
        return;
      }

      for (const node of rootNodes) renderNode(node, 0);
    };

    // 底部 "All tags" 清除按钮
    const footer = popoverEl.createDiv();
    footer.style.cssText = 'border-top:1px solid var(--background-modifier-border,#ddd);padding:4px 10px';
    const allBtn = footer.createDiv({ text: 'All tags' });
    allBtn.style.cssText = 'padding:4px 0;cursor:pointer;font-size:12px;color:var(--text-muted,#888);text-align:center;border-radius:4px';
    allBtn.addEventListener('mouseenter', () => { allBtn.style.background = 'var(--background-modifier-hover,rgba(0,0,0,.05))'; });
    allBtn.addEventListener('mouseleave', () => { allBtn.style.background = ''; });
    allBtn.addEventListener('click', () => {
      filterState.selectedTags = [];
      _setBtnDefault(btn, '# Tags');
      onChange();
      removePopover();
      document.removeEventListener('click', closeOnOutsideClick, true);
    });

    renderTagList();

    // 后台加载 tag→groups 映射
    ensureTagGroups().then(() => renderTagList());

    // 延迟注册外部点击关闭（避免当前 click 直接触发）
    setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 10);
  });

  return btn;
}

// ─── Group 筛选按钮 ───────────────────────────────────

export function renderGroupFilterBtn(
  parent: HTMLElement,
  filterState: PickerFilterState,
  onChange: () => void,
  groupLimit = 20,
): HTMLButtonElement {
  const currentGroup = filterState.filter.group ?? 'all';
  const isActive = currentGroup !== 'all';
  const btn = _createFilterBtn(parent, isActive ? currentGroup : 'Group');
  if (isActive) _setBtnActive(btn, currentGroup);

  btn.addEventListener('click', () => {
    const groups = getGroupNames();
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle('All').setChecked(!isActive)
        .onClick(() => { filterState.filter.group = 'all'; _setBtnDefault(btn, 'Group'); onChange(); });
    });
    for (const g of groups.slice(0, groupLimit)) {
      menu.addItem((item) => {
        item.setTitle(g).setChecked(currentGroup === g)
          .onClick(() => { filterState.filter.group = g; _setBtnActive(btn, g); onChange(); });
      });
    }
    menu.showAtMouseEvent({
      clientX: btn.getBoundingClientRect().left,
      clientY: btn.getBoundingClientRect().bottom,
    } as MouseEvent);
  });
  return btn;
}

// ═══════════════════════════════════════════════════════
// 统一搜索入口
// ═══════════════════════════════════════════════════════

export interface PickerSearchParams {
  engine: AnnotationSearchEngine;
  filterState: PickerFilterState;
  /** 搜索关键词 */
  query?: string;
  /** 搜索范围 */
  scope?: 'file' | 'all';
  /** 当 scope='file' 时的文件路径 */
  filePath?: string;
  /** 排除的 UUID（如自身） */
  excludeUuid?: string;
  /** 额外的筛选条件（RelationPicker 独有: color/motivation/fieldFilters） */
  extraFilter?: Partial<AnnotationFilter>;
}

export interface PickerSearchResult {
  results: SearchResult[];
  /** 排除自身前的总数（用于显示排除信息） */
  totalBeforeExclude: number;
}

export function doPickerSearch(params: PickerSearchParams): PickerSearchResult {
  // 合并 filter
  const filter = params.filterState.syncToFilter();

  // 应用额外筛选条件
  if (params.extraFilter) {
    if (params.extraFilter.color !== undefined) filter.color = params.extraFilter.color;
    if (params.extraFilter.motivation !== undefined) filter.motivation = params.extraFilter.motivation;
    if (params.extraFilter.fieldFilters !== undefined) filter.fieldFilters = params.extraFilter.fieldFilters;
  }

  const searchResult = params.engine.search({
    query: params.query || undefined,
    scope: params.scope ?? 'all',
    filePath: params.scope === 'file' ? params.filePath : undefined,
    filter,
    sortByRelevance: !!params.query,
    // 不限制 — 让调用方切片；确保 totalBeforeExclude 准确
    limit: undefined,
    facets: true,
  });

  const totalBefore = searchResult.length;
  const filtered = params.excludeUuid
    ? searchResult.filter(r => r.annotation.uuid !== params.excludeUuid)
    : searchResult;

  // 调用方可自行切片 `results.slice(0, N)`
  return { results: filtered, totalBeforeExclude: totalBefore };
}
