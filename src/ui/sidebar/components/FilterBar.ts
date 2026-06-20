import { Menu } from 'obsidian';
import type { AnnotationFilter } from '../../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS, MOTIVATION_LABELS } from '../../../types/annotation';
import { getFieldKeys, getFieldValues, getGroupNames, getTagFrequencies, getAllAnnotations } from '../../../db/annotation-repo';
import { buildTagTree, type TagTreeNode } from '../../../utils/tag-tree';

/**
 * FilterBar —— 侧边栏过滤栏
 *
 * 负责渲染类型/颜色/排序/批注过滤，以及 Phase 3 的字段过滤 UI。
 */
export interface FilterBarHost {
  filter: AnnotationFilter;
  // P0 fix: 用 getter 函数避免引用脱节
  getFieldFilterEntries(): Array<{ key: string; value: string }>;
  getSelectedTags(): string[];
  getFieldMultiValues(): Record<string, string[]>;
  setSelectedTags(tags: string[]): void;
  setFieldMultiValues(values: Record<string, string[]>): void;
  setFieldFilterEntries(entries: Array<{ key: string; value: string }>): void;
  refreshListOnly(): Promise<void>;
}

export class FilterBar {
  constructor(private host: FilterBarHost) {}

  render(container: HTMLElement): void {
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
        cls: `markvault-filter-btn ${this.host.filter.type === tf.value ? 'active' : ''}`,
        attr: { title: tf.label },
      });
      btn.addEventListener('click', async () => {
        this.host.filter.type = tf.value;
        await this.host.refreshListOnly();
      });
    }

    // 颜色过滤（小圆点）
    const colorGroup = row1.createDiv({ cls: 'markvault-filter-group' });
    colorGroup.createSpan({ cls: 'markvault-filter-group-label', text: 'Color' });
    const allColorBtn = colorGroup.createEl('button', {
      text: 'All',
      cls: `markvault-color-btn markvault-color-mini ${this.host.filter.color === 'all' ? 'active' : ''}`,
    });
    allColorBtn.addEventListener('click', async () => {
      this.host.filter.color = 'all';
      await this.host.refreshListOnly();
    });
    for (const pc of PRESET_COLORS) {
      const colorBtn = colorGroup.createEl('button', {
        cls: `markvault-color-btn markvault-color-dot ${this.host.filter.color === pc.id ? 'active' : ''}`,
        attr: { title: pc.label },
      });
      colorBtn.style.backgroundColor = pc.hex;
      colorBtn.addEventListener('click', async () => {
        this.host.filter.color = pc.id;
        await this.host.refreshListOnly();
      });
    }

    // ── 第二行：排序 + 批注 ──
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
        cls: `markvault-sort-btn ${this.host.filter.sortBy === so.value ? 'active' : ''}`,
        attr: { title: so.label === 'Pos' ? 'Position' : so.label === 'New' ? 'Newest' : 'Updated' },
      });
      btn.addEventListener('click', async () => {
        this.host.filter.sortBy = so.value;
        await this.host.refreshListOnly();
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
        cls: `markvault-filter-btn ${this.host.filter.hasNote === nf.value ? 'active' : ''}`,
        attr: { title: nf.value === undefined ? 'All' : 'With Note' },
      });
      btn.addEventListener('click', async () => {
        this.host.filter.hasNote = nf.value;
        await this.host.refreshListOnly();
      });
    }

    // ── 第三行：By Field（内联下拉式） ──
    const fieldRow = container.createDiv({ cls: 'markvault-filter-row markvault-filter-field-row' });
    fieldRow.createSpan({ cls: 'markvault-filter-group-label', text: '🏷️' });

    // 字段过滤条件标签（横排显示）
    if (this.host.getFieldFilterEntries().length > 0) {
      const tagsWrap = fieldRow.createDiv({ cls: 'markvault-field-filter-tags' });
      for (let i = 0; i < this.host.getFieldFilterEntries().length; i++) {
        const entry = this.host.getFieldFilterEntries()[i];
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
          this.host.getFieldFilterEntries().splice(i, 1);
          await this.host.refreshListOnly();
        });
      }
    }

    // 添加字段过滤按钮（分面 Popover）
    const addFieldFilterBtn = fieldRow.createEl('button', {
      text: this.host.getFieldFilterEntries().length > 0 ? '+' : '+ Field',
      cls: 'markvault-add-field-filter-btn',
      attr: { title: 'Add field filter (faceted)' },
    });
    addFieldFilterBtn.addEventListener('click', async () => {
      this.showFacetedFieldPopover(addFieldFilterBtn);
    });

    // ── 第四行：v4.0 元数据过滤（统一面板） ──
    const metaRow = container.createDiv({ cls: 'markvault-filter-row markvault-filter-meta-row' });
    metaRow.createSpan({ cls: 'markvault-filter-group-label', text: '📋' });

    const filterCount = this.countActiveMetaFilters();
    const filterBtn = metaRow.createEl('button', {
      text: filterCount > 0 ? `📋 ${filterCount} filters` : 'Filters',
      cls: `markvault-filter-btn ${filterCount > 0 ? 'active' : ''}`,
      attr: { title: 'Metadata filters' },
    });
    filterBtn.addEventListener('click', () => {
      this.showUnifiedMetaPopover(filterBtn);
    });
  }

  /** v6.1: 分面字段 Popover — 折叠面板 + 多选 */
  private async showFacetedFieldPopover(anchor: HTMLElement): Promise<void> {
    const existing = document.querySelector('.markvault-faceted-field-popover');
    if (existing) { existing.remove(); return; }

    const keys = await getFieldKeys();
    const fv = this.host.getFieldMultiValues() ?? {};

    const popover = document.body.createDiv({ cls: 'markvault-faceted-field-popover' });
    const r = anchor.getBoundingClientRect();
    Object.assign(popover.style, {
      position: 'fixed', left: `${r.left}px`, top: `${r.bottom + 4}px`,
      width: '240px', maxHeight: '400px', overflowY: 'auto',
      background: 'var(--background-primary,#fff)',
      border: '1px solid var(--background-modifier-border,#ccc)',
      borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.15)', zIndex: '9999',
    });

    if (keys.length === 0) {
      popover.createDiv({ text: 'No fields in annotations' }).style.padding = '12px';
      return;
    }

    for (const key of keys) {
      const section = popover.createDiv();
      const header = section.createDiv();
      Object.assign(header.style, { padding: '6px 12px', fontWeight: '600', fontSize: '12px', cursor: 'pointer',
        background: 'var(--background-secondary,#f5f5f5)', borderBottom: '1px solid var(--background-modifier-border,#ddd)' });
      header.textContent = key;

      const selected = fv[key] ?? [];
      const values = await getFieldValues(key);
      for (const val of values) {
        const row = section.createDiv();
        const checked = selected.includes(val);
        Object.assign(row.style, { display: 'flex', alignItems: 'center', padding: '3px 16px', fontSize: '12px',
          cursor: 'pointer', transition: 'background .1s' });
        if (checked) { row.style.background = 'var(--interactive-accent,#483699)'; row.style.color = '#fff'; }

        const cb = row.createSpan({ text: checked ? '☑ ' : '☐ ' });
        row.createSpan({ text: val });
        row.addEventListener('click', () => {
          const arr = fv[key] ?? [];
          if (arr.includes(val)) {
            arr.splice(arr.indexOf(val), 1);
            if (arr.length === 0) delete fv[key];
          } else {
            if (!fv[key]) fv[key] = [];
            fv[key].push(val);
          }
          row.style.background = !arr.includes(val) ? 'none' : 'var(--interactive-accent,#483699)';
          row.style.color = !arr.includes(val) ? '' : '#fff';
          cb.textContent = !arr.includes(val) ? '☐ ' : '☑ ';
        });
      }
    }

    const footer = popover.createDiv();
    footer.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 12px;border-top:1px solid var(--background-modifier-border,#ddd);gap:6px';

    const applyBtn = footer.createEl('button', { text: 'Apply' });
    applyBtn.style.cssText = 'padding:4px 12px;border:none;border-radius:4px;cursor:pointer;color:#fff;background:var(--interactive-accent,#483699);font-size:12px';
    applyBtn.addEventListener('click', async () => {
      this.host.setFieldMultiValues(fv);
      // 同步到旧 fieldFilterEntries
      this.host.setFieldFilterEntries([]);
      for (const [k, vs] of Object.entries(fv)) {
        for (const v of vs) this.host.getFieldFilterEntries().push({ key: k, value: v });
      }
      popover.remove();
      await this.host.refreshListOnly();
    });

    const clearBtn = footer.createEl('button', { text: 'Clear' });
    Object.assign(clearBtn.style, { padding: '4px 12px', border: '1px solid var(--background-modifier-border,#ccc)',
      borderRadius: '4px', cursor: 'pointer', background: 'var(--background-secondary,#f5f5f5)', fontSize: '12px' });
    clearBtn.addEventListener('click', async () => {
      this.host.setFieldMultiValues({});
      this.host.setFieldFilterEntries([]);
      popover.remove();
      await this.host.refreshListOnly();
    });

    const _onOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        popover.remove(); document.removeEventListener('click', _onOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', _onOutside, true), 0);
  }

  // ─── 共享工具方法 ──────────────────────────────────────

  /** 统计活跃的元数据过滤条件数量 */
  private countActiveMetaFilters(): number {
    let count = 0;
    const f = this.host.filter;
    if (f.mastery && f.mastery !== 'all') count++;
    if (f.group && f.group !== 'all') count++;
    if (this.host.getSelectedTags().length > 0) count++;
    if (f.hasRelations === true) count++;
    if (f.needsCorrection === true) count++;
    if (f.motivation && f.motivation !== 'all') count++;
    if (f.reviewPriority && f.reviewPriority !== 'all') count++;
    return count;
  }

  /** 统一元数据过滤 Popover：折叠式分段 + 标签树 + 活跃条件气泡 */
  private showUnifiedMetaPopover(anchor: HTMLElement): void {
    const existing = document.querySelector('.markvault-unified-meta-popover');
    if (existing) { existing.remove(); return; }

    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 290;

    const popover = document.body.createDiv({ cls: 'markvault-unified-meta-popover' });
    Object.assign(popover.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.bottom + 4}px`,
      width: `${popoverWidth}px`,
      maxHeight: '520px',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--background-primary, #fff)',
      border: '1px solid var(--background-modifier-border, #ccc)',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
      zIndex: '9999',
      overflow: 'hidden',
    });

    // ── 滚动容器 ──
    const scrollContainer = popover.createDiv();
    scrollContainer.style.flex = '1';
    scrollContainer.style.overflowY = 'auto';
    scrollContainer.style.padding = '6px 0';

    // ── 折叠段辅助函数 ──
    const createSection = (parent: HTMLElement, title: string, defaultOpen: boolean) => {
      const section = parent.createDiv({ cls: 'markvault-unified-section' });
      const header = section.createDiv({ cls: 'markvault-unified-section-header' });
      Object.assign(header.style, {
        display: 'flex',
        alignItems: 'center',
        padding: '6px 12px',
        cursor: 'pointer',
        userSelect: 'none',
        fontSize: '13px',
        fontWeight: '600',
        color: 'var(--text-normal, #333)',
      });
      header.addEventListener('mouseenter', () => {
        header.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
      });
      header.addEventListener('mouseleave', () => {
        header.style.background = '';
      });

      const icon = header.createSpan({ text: defaultOpen ? '▾' : '▸' });
      icon.style.marginRight = '6px';
      icon.style.fontSize = '10px';
      icon.style.width = '14px';
      icon.style.flexShrink = '0';

      header.createSpan({ text: title });

      const body = section.createDiv({ cls: 'markvault-unified-section-body' });
      body.style.display = defaultOpen ? 'block' : 'none';

      header.addEventListener('click', () => {
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        icon.textContent = isOpen ? '▸' : '▾';
      });

      return { header, body };
    };

    // ── 选项行辅助函数 ──
    const createOptionRow = (
      parent: HTMLElement,
      label: string,
      isActive: boolean,
      onClick: () => Promise<void>,
    ) => {
      const row = parent.createDiv();
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        padding: '5px 12px',
        cursor: 'pointer',
        fontSize: '12px',
        borderRadius: '4px',
        margin: '1px 4px',
        transition: 'background 0.1s',
      });
      if (isActive) {
        row.style.background = 'var(--interactive-accent, #483699)';
        row.style.color = '#fff';
      }
      row.addEventListener('mouseenter', () => {
        if (!isActive) row.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
      });
      row.addEventListener('mouseleave', () => {
        if (!isActive) row.style.background = '';
      });
      row.createSpan({ text: label });
      row.addEventListener('click', async () => {
        await onClick();
      });
      return row;
    };

    // ═══════════════════════════════════════════════════════
    // 1. Tags 段
    // ═══════════════════════════════════════════════════════
    const hasTags = this.host.getSelectedTags().length > 0;
    const { body: tagsBody } = createSection(scrollContainer, 'Tags', hasTags);

    // v6.1: Group 筛选栏 — 按关联分组过滤标签
    const groupChips = tagsBody.createDiv();
    groupChips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;padding:4px 10px';
    let activeGroup: string | null = null;

    // 一次性构建 tag→groups 映射
    let tagGroupsMap: Map<string, Set<string>> | null = null;
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

    const renderGroupChips = () => {
      groupChips.empty();
      const groups = getGroupNames();
      const allChip = groupChips.createSpan({ text: 'All' });
      allChip.style.cssText = 'padding:1px 8px;border-radius:8px;cursor:pointer;font-size:11px;border:1px solid var(--background-modifier-border,#ddd);transition:all .15s';
      if (!activeGroup) { allChip.style.background = 'var(--interactive-accent,#483699)'; allChip.style.color = '#fff'; allChip.style.borderColor = 'var(--interactive-accent,#483699)'; }
      allChip.addEventListener('click', () => { activeGroup = null; renderGroupChips(); renderTagList(tagSearch.value); });

      for (const g of groups) {
        const chip = groupChips.createSpan({ text: g });
        chip.style.cssText = 'padding:1px 8px;border-radius:8px;cursor:pointer;font-size:11px;border:1px solid var(--background-modifier-border,#ddd);transition:all .15s;white-space:nowrap';
        if (activeGroup === g) { chip.style.background = 'var(--interactive-accent,#483699)'; chip.style.color = '#fff'; chip.style.borderColor = 'var(--interactive-accent,#483699)'; }
        chip.addEventListener('click', async () => { await ensureTagGroups(); activeGroup = g; renderGroupChips(); renderTagList(tagSearch.value); });
      }
    };
    renderGroupChips();

    // 后台加载 tag→groups 映射
    ensureTagGroups();

    const tagSearch = tagsBody.createEl('input', {
      type: 'text',
      attr: { placeholder: 'Search tags...' },
    });
    Object.assign(tagSearch.style, {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 10px',
      border: 'none',
      borderBottom: '1px solid var(--background-modifier-border, #ddd)',
      fontSize: '12px',
      background: 'var(--background-primary, #fff)',
      color: 'var(--text-normal, #333)',
      outline: 'none',
    });

    const tagList = tagsBody.createDiv();
    tagList.style.maxHeight = '200px';
    tagList.style.overflowY = 'auto';
    tagList.style.padding = '4px 0';

    // 动态构建标签树（按 Group 筛选后重建）
    const rebuildTagTree = () => {
      const filteredFreqs = getFilteredFrequencies(activeGroup);
      return { ...buildTagTree(filteredFreqs), filteredFreqs };
    };

    // v6.1: 标签行渲染（内联版）
    const createTagRow = (fullPath: string, label: string, count: number, depth: number, _nm: Map<string, TagTreeNode>): HTMLElement => {
      const isActive = this.host.getSelectedTags().includes(fullPath);
      const item = tagList.createDiv();
      Object.assign(item.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 10px', paddingLeft: `${10 + depth * 14}px`,
        borderRadius: '4px', cursor: 'pointer', fontSize: '12px', transition: 'background 0.1s',
      });
      if (isActive) { item.style.background = 'var(--interactive-accent, #483699)'; item.style.color = '#fff'; }

      const leftSide = item.createSpan();
      if (depth > 0 && !isActive) { leftSide.style.color = 'var(--text-faint, #bbb)'; }
      const hasChildren = (_nm.get(fullPath)?.children?.length ?? 0) > 0;
      const icon = hasChildren ? '▸ ' : '  ';
      leftSide.appendText(icon + label);

      const badge = item.createSpan({ text: `${count}` });
      Object.assign(badge.style, {
        fontSize: '10px',
        padding: '0px 5px',
        borderRadius: '8px',
        background: isActive ? 'rgba(255,255,255,0.3)' : 'var(--background-modifier-hover, #f0f0f0)',
      });

      item.addEventListener('mouseenter', () => {
        if (!isActive) item.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
      });
      item.addEventListener('mouseleave', () => {
        if (!isActive) item.style.background = '';
      });
      item.addEventListener('click', async () => {
        const idx = this.host.getSelectedTags().indexOf(fullPath);
        if (idx >= 0) {
          this.host.getSelectedTags().splice(idx, 1);
        } else {
          this.host.getSelectedTags().push(fullPath);
        }
        await this.host.refreshListOnly();
        this.refreshUnifiedPopoverSections(popover);
      });
      return item;
    };

    // (旧 renderTagTree / renderFlatSearch 已由 renderTagList 内的 renderLocalTagTree / renderLocalFlat 取代)

    const renderTagList = (query: string) => {
      tagList.empty();
      const q = query.toLowerCase().trim();
      const { rootNodes: rn, nodeMap: nm } = rebuildTagTree();

      if (rn.length === 0) {
        const noItem = tagList.createDiv();
        noItem.style.padding = '12px 10px'; noItem.style.textAlign = 'center';
        noItem.style.color = 'var(--text-muted, #888)'; noItem.style.fontSize = '11px';
        noItem.textContent = activeGroup ? `No tags in "${activeGroup}"` : 'No tags in any annotation';
        return;
      }

      const renderLocalTagTree = (nodes: TagTreeNode[], depth: number) => {
        for (const node of nodes) {
          const matchSelf = !q || node.label.toLowerCase().includes(q);
          const hasMatchingChildren = !q || node.children.some(c => c.label.toLowerCase().includes(q));
          if (matchSelf || hasMatchingChildren) {
            createTagRow(node.fullPath, node.label, node.count, depth, nm);
            if (node.children.length > 0) renderLocalTagTree(node.children, depth + 1);
          }
        }
      };

      const renderLocalFlat = () => {
        const allNodes = [...nm.values()];
        allNodes.sort((a, b) => {
          const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
          const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          return b.count - a.count || a.label.localeCompare(b.label);
        });
        for (const node of allNodes) {
          if (node.label.toLowerCase().includes(q)) {
            const displayLabel = node.fullPath.includes('/') ? node.fullPath : node.label;
            createTagRow(node.fullPath, displayLabel, node.count, 0, nm);
          }
        }
      };

      if (q) { renderLocalFlat(); } else { renderLocalTagTree(rn, 0); }
    };

    renderTagList('');
    tagSearch.addEventListener('input', () => renderTagList(tagSearch.value));
    // 阻止 input 上的 Escape 关闭整个 popover（让 Escape 用于关闭 popover）
    tagSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        popover.remove();
      }
    });

    const tagSep = tagsBody.createDiv();
    tagSep.style.margin = '2px 8px';
    tagSep.style.height = '1px';
    tagSep.style.background = 'var(--background-modifier-border, #ddd)';

    // "All tags" 清除按钮
    const allTagsBtn = tagsBody.createDiv();
    Object.assign(allTagsBtn.style, {
      padding: '5px 12px',
      cursor: 'pointer',
      fontSize: '12px',
      color: 'var(--text-muted, #888)',
      borderRadius: '4px',
      margin: '1px 4px',
    });
    allTagsBtn.textContent = 'All tags';
    allTagsBtn.addEventListener('mouseenter', () => {
      allTagsBtn.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
    });
    allTagsBtn.addEventListener('mouseleave', () => {
      allTagsBtn.style.background = '';
    });
    allTagsBtn.addEventListener('click', async () => {
      this.host.getSelectedTags().length = 0;
      await this.host.refreshListOnly();
      this.refreshUnifiedPopoverSections(popover);
    });

    // ═══════════════════════════════════════════════════════
    // 2. Mastery 段
    // ═══════════════════════════════════════════════════════
    const hasMastery = !!(this.host.filter.mastery && this.host.filter.mastery !== 'all');
    const { body: masteryBody } = createSection(scrollContainer, 'Mastery', hasMastery);

    createOptionRow(masteryBody, 'All', !this.host.filter.mastery || this.host.filter.mastery === 'all', async () => {
      this.host.filter.mastery = 'all';
      await this.host.refreshListOnly();
      this.refreshUnifiedPopoverSections(popover);
    });
    for (const [value, label] of Object.entries(MASTERY_LABELS)) {
      createOptionRow(masteryBody, label, this.host.filter.mastery === value, async () => {
        this.host.filter.mastery = value as any;
        await this.host.refreshListOnly();
        this.refreshUnifiedPopoverSections(popover);
      });
    }

    // ═══════════════════════════════════════════════════════
    // 3. Group 段
    // ═══════════════════════════════════════════════════════
    const hasGroup = !!(this.host.filter.group && this.host.filter.group !== 'all');
    const { body: groupBody } = createSection(scrollContainer, 'Group', hasGroup);

    const groups = getGroupNames();
    createOptionRow(groupBody, 'All', !this.host.filter.group || this.host.filter.group === 'all', async () => {
      this.host.filter.group = 'all';
      await this.host.refreshListOnly();
      this.refreshUnifiedPopoverSections(popover);
    });
    for (const g of groups) {
      createOptionRow(groupBody, g, this.host.filter.group === g, async () => {
        this.host.filter.group = g;
        await this.host.refreshListOnly();
        this.refreshUnifiedPopoverSections(popover);
      });
    }

    // ═══════════════════════════════════════════════════════
    // 4. Has Relations / Needs Correction 段（合并行）
    // ═══════════════════════════════════════════════════════
    const boolSection = scrollContainer.createDiv({ cls: 'markvault-unified-section' });
    const boolHeader = boolSection.createDiv({ cls: 'markvault-unified-section-header' });
    Object.assign(boolHeader.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '6px 12px',
      fontSize: '12px',
    });

    const createToggleChip = (parent: HTMLElement, label: string, isActive: boolean, onClick: () => Promise<void>) => {
      const chip = parent.createDiv();
      Object.assign(chip.style, {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 10px',
        borderRadius: '12px',
        cursor: 'pointer',
        fontSize: '12px',
        border: '1px solid var(--background-modifier-border, #ccc)',
        transition: 'all 0.15s',
        userSelect: 'none',
      });
      if (isActive) {
        chip.style.background = 'var(--interactive-accent, #483699)';
        chip.style.color = '#fff';
        chip.style.borderColor = 'var(--interactive-accent, #483699)';
      }
      const checkIcon = chip.createSpan({ text: isActive ? '☑' : '☐' });
      checkIcon.style.marginRight = '4px';
      chip.createSpan({ text: label });
      chip.addEventListener('click', async () => {
        await onClick();
        this.refreshUnifiedPopoverSections(popover);
      });
      return chip;
    };

    createToggleChip(boolHeader, 'Has Relations', this.host.filter.hasRelations === true, async () => {
      this.host.filter.hasRelations = this.host.filter.hasRelations ? undefined : true;
      await this.host.refreshListOnly();
    });
    createToggleChip(boolHeader, 'Needs Correction', this.host.filter.needsCorrection === true, async () => {
      this.host.filter.needsCorrection = this.host.filter.needsCorrection ? undefined : true;
      await this.host.refreshListOnly();
    });

    // ═══════════════════════════════════════════════════════
    // 5. Motivation 段
    // ═══════════════════════════════════════════════════════
    const hasMotivation = !!(this.host.filter.motivation && this.host.filter.motivation !== 'all');
    const { body: motBody } = createSection(scrollContainer, 'Motivation', hasMotivation);

    const motEntries = Object.entries(MOTIVATION_LABELS) as [string, string][];
    createOptionRow(motBody, 'All', !this.host.filter.motivation || this.host.filter.motivation === 'all', async () => {
      this.host.filter.motivation = 'all';
      await this.host.refreshListOnly();
      this.refreshUnifiedPopoverSections(popover);
    });
    for (const [value, label] of motEntries) {
      createOptionRow(motBody, label, this.host.filter.motivation === value, async () => {
        this.host.filter.motivation = value as any;
        await this.host.refreshListOnly();
        this.refreshUnifiedPopoverSections(popover);
      });
    }

    // ═══════════════════════════════════════════════════════
    // 6. Footer：活跃条件 + 清除全部
    // ═══════════════════════════════════════════════════════
    const footer = popover.createDiv();
    Object.assign(footer.style, {
      borderTop: '1px solid var(--background-modifier-border, #ddd)',
      padding: '8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });

    // 活跃条件气泡
    const chipsRow = footer.createDiv();
    chipsRow.style.display = 'flex';
    chipsRow.style.flexWrap = 'wrap';
    chipsRow.style.gap = '4px';

    const makeChip = (text: string, onRemove: () => Promise<void>) => {
      const chip = chipsRow.createDiv();
      Object.assign(chip.style, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        padding: '2px 8px',
        borderRadius: '10px',
        fontSize: '11px',
        background: 'var(--interactive-accent, #483699)',
        color: '#fff',
        cursor: 'pointer',
      });
      chip.createSpan({ text });
      const x = chip.createSpan({ text: '×' });
      x.style.opacity = '0.7';
      x.style.fontSize = '10px';
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        await onRemove();
        this.refreshUnifiedPopoverSections(popover);
      });
      return chip;
    };

    // 构建活跃条件气泡
    if (this.host.filter.mastery && this.host.filter.mastery !== 'all') {
      const label = MASTERY_LABELS[this.host.filter.mastery] || this.host.filter.mastery;
      makeChip(`Mastery: ${label}`, async () => {
        this.host.filter.mastery = 'all';
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.group && this.host.filter.group !== 'all') {
      makeChip(`Group: ${this.host.filter.group}`, async () => {
        this.host.filter.group = 'all';
        await this.host.refreshListOnly();
      });
    }
    for (const t of this.host.getSelectedTags()) {
      makeChip(`# ${t}`, async () => {
        this.host.setSelectedTags(this.host.getSelectedTags().filter(st => st !== t));
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.hasRelations === true) {
      makeChip('Has Relations', async () => {
        this.host.filter.hasRelations = undefined;
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.needsCorrection === true) {
      makeChip('Needs Correction', async () => {
        this.host.filter.needsCorrection = undefined;
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.motivation && this.host.filter.motivation !== 'all') {
      const motLabel = MOTIVATION_LABELS[this.host.filter.motivation] || this.host.filter.motivation;
      makeChip(`Motivation: ${motLabel}`, async () => {
        this.host.filter.motivation = 'all';
        await this.host.refreshListOnly();
      });
    }

    // "Clear All" 按钮
    const clearAllBtn = footer.createEl('button', { text: 'Clear All' });
    Object.assign(clearAllBtn.style, {
      width: '100%',
      padding: '6px',
      border: '1px solid var(--background-modifier-border, #ccc)',
      borderRadius: '6px',
      background: 'var(--background-secondary, #f5f5f5)',
      color: 'var(--text-normal, #333)',
      cursor: 'pointer',
      fontSize: '12px',
    });
    clearAllBtn.addEventListener('mouseenter', () => {
      clearAllBtn.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.08))';
    });
    clearAllBtn.addEventListener('mouseleave', () => {
      clearAllBtn.style.background = 'var(--background-secondary, #f5f5f5)';
    });
    clearAllBtn.addEventListener('click', async () => {
      this.host.filter.mastery = 'all';
      this.host.filter.group = 'all';
      this.host.getSelectedTags().length = 0;
      this.host.filter.hasRelations = undefined;
      this.host.filter.needsCorrection = undefined;
      this.host.filter.motivation = 'all';
      this.host.filter.reviewPriority = undefined;
      popover.remove();
      await this.host.refreshListOnly();
    });

    // ── 关闭逻辑 ──
    const onClickOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        popover.remove();
        document.removeEventListener('click', onClickOutside, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', onClickOutside, true);
    }, 0);

    // Escape 关闭
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        popover.remove();
        document.removeEventListener('keydown', onKeyDown, true);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    // 清理 Escape 监听器
    const origRemove = popover.remove.bind(popover);
    popover.remove = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      origRemove();
    };
  }

  /** 刷新统一 Popover 内的分段状态（不关闭弹窗） */
  private refreshUnifiedPopoverSections(popover: HTMLElement): void {
    // 重建 footer 中的活跃条件气泡
    const footer = popover.querySelector(':scope > div:last-child') as HTMLElement;
    if (!footer) return;
    const chipsRow = footer.firstElementChild as HTMLElement;
    if (!chipsRow) return;
    chipsRow.empty();

    const makeChip = (text: string, onRemove: () => Promise<void>) => {
      const chip = chipsRow.createDiv();
      Object.assign(chip.style, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        padding: '2px 8px',
        borderRadius: '10px',
        fontSize: '11px',
        background: 'var(--interactive-accent, #483699)',
        color: '#fff',
        cursor: 'pointer',
      });
      chip.createSpan({ text });
      const x = chip.createSpan({ text: '×' });
      x.style.opacity = '0.7';
      x.style.fontSize = '10px';
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        await onRemove();
        this.refreshUnifiedPopoverSections(popover);
      });
      return chip;
    };

    if (this.host.filter.mastery && this.host.filter.mastery !== 'all') {
      const label = MASTERY_LABELS[this.host.filter.mastery] || this.host.filter.mastery;
      makeChip(`Mastery: ${label}`, async () => {
        this.host.filter.mastery = 'all';
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.group && this.host.filter.group !== 'all') {
      makeChip(`Group: ${this.host.filter.group}`, async () => {
        this.host.filter.group = 'all';
        await this.host.refreshListOnly();
      });
    }
    for (const t of this.host.getSelectedTags()) {
      makeChip(`# ${t}`, async () => {
        this.host.setSelectedTags(this.host.getSelectedTags().filter(st => st !== t));
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.hasRelations === true) {
      makeChip('Has Relations', async () => {
        this.host.filter.hasRelations = undefined;
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.needsCorrection === true) {
      makeChip('Needs Correction', async () => {
        this.host.filter.needsCorrection = undefined;
        await this.host.refreshListOnly();
      });
    }
    if (this.host.filter.motivation && this.host.filter.motivation !== 'all') {
      const motLabel = MOTIVATION_LABELS[this.host.filter.motivation] || this.host.filter.motivation;
      makeChip(`Motivation: ${motLabel}`, async () => {
        this.host.filter.motivation = 'all';
        await this.host.refreshListOnly();
      });
    }
  }
}
