import { Menu } from 'obsidian';
import type { AnnotationFilter } from '../../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS } from '../../../types/annotation';
import { getFieldKeys, getFieldValues, getGroupNames, getMergedGroupNames, getTagFrequencies } from '../../../db/annotation-repo';

/**
 * FilterBar —— 侧边栏过滤栏
 *
 * 负责渲染类型/颜色/排序/批注过滤，以及 Phase 3 的字段过滤 UI。
 */
export interface FilterBarHost {
  filter: AnnotationFilter;
  fieldFilterEntries: Array<{ key: string; value: string }>;
  selectedTags: string[];
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
    if (this.host.fieldFilterEntries.length > 0) {
      const tagsWrap = fieldRow.createDiv({ cls: 'markvault-field-filter-tags' });
      for (let i = 0; i < this.host.fieldFilterEntries.length; i++) {
        const entry = this.host.fieldFilterEntries[i];
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
          this.host.fieldFilterEntries.splice(i, 1);
          await this.host.refreshListOnly();
        });
      }
    }

    // 添加字段过滤按钮（+ 图标）
    const addFieldFilterBtn = fieldRow.createEl('button', {
      text: this.host.fieldFilterEntries.length > 0 ? '+' : '+ Field',
      cls: 'markvault-add-field-filter-btn',
      attr: { title: 'Add field filter' },
    });
    addFieldFilterBtn.addEventListener('click', async () => {
      const keys = await getFieldKeys();
      this.showAddFieldFilterMenu(addFieldFilterBtn, keys);
    });

    // ── 第四行：v4.0 元数据过滤（Mastery / Priority / Group / Relations） ──
    const metaRow = container.createDiv({ cls: 'markvault-filter-row markvault-filter-meta-row' });
    metaRow.createSpan({ cls: 'markvault-filter-group-label', text: '📋' });

    // Mastery 过滤
    const masteryGroup = metaRow.createDiv({ cls: 'markvault-filter-group' });
    const masteryBtn = masteryGroup.createEl('button', {
      text: this.host.filter.mastery && this.host.filter.mastery !== 'all'
        ? MASTERY_LABELS[this.host.filter.mastery] || this.host.filter.mastery
        : 'Mastery',
      cls: `markvault-filter-btn ${this.host.filter.mastery && this.host.filter.mastery !== 'all' ? 'active' : ''}`,
      attr: { title: 'Filter by mastery level' },
    });
    masteryBtn.addEventListener('click', () => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('All').setChecked(!this.host.filter.mastery || this.host.filter.mastery === 'all')
          .onClick(async () => { this.host.filter.mastery = 'all'; await this.host.refreshListOnly(); });
      });
      for (const [value, label] of Object.entries(MASTERY_LABELS)) {
        menu.addItem((item) => {
          item.setTitle(label).setChecked(this.host.filter.mastery === value)
            .onClick(async () => { this.host.filter.mastery = value as any; await this.host.refreshListOnly(); });
        });
      }
      menu.showAtMouseEvent({ clientX: masteryBtn.getBoundingClientRect().left, clientY: masteryBtn.getBoundingClientRect().bottom } as MouseEvent);
    });

    // Group 过滤
    const groupBtn = metaRow.createEl('button', {
      text: this.host.filter.group && this.host.filter.group !== 'all'
        ? this.host.filter.group
        : 'Group',
      cls: `markvault-filter-btn ${this.host.filter.group && this.host.filter.group !== 'all' ? 'active' : ''}`,
      attr: { title: 'Filter by group' },
    });
    groupBtn.addEventListener('click', () => {
      const groups = getMergedGroupNames(); // v6.0: 合并 groups 字段 + tags group: 前缀
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('All').setChecked(!this.host.filter.group || this.host.filter.group === 'all')
          .onClick(async () => { this.host.filter.group = 'all'; await this.host.refreshListOnly(); });
      });
      for (const g of groups) {
        menu.addItem((item) => {
          item.setTitle(g).setChecked(this.host.filter.group === g)
            .onClick(async () => { this.host.filter.group = g; await this.host.refreshListOnly(); });
        });
      }
      menu.showAtMouseEvent({ clientX: groupBtn.getBoundingClientRect().left, clientY: groupBtn.getBoundingClientRect().bottom } as MouseEvent);
    });

    // Tag 过滤（自定义 Popover + 多选 AND）
    const selected = this.host.selectedTags;
    const hasMulti = selected.length > 1;
    const tagBtnText = selected.length === 0
      ? '#'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} tags`;
    const tagBtn = metaRow.createEl('button', {
      text: tagBtnText,
      cls: `markvault-filter-btn ${selected.length > 0 ? 'active' : ''}`,
      attr: { title: hasMulti ? selected.join(', ') : 'Filter by tag' },
    });
    tagBtn.addEventListener('click', () => {
      this.showTagFilterPopover(tagBtn);
    });

    // 多选 tag chips (显示在按钮后面)
    if (hasMulti) {
      for (const t of selected) {
        const chip = metaRow.createEl('span', { cls: 'markvault-tag-filter-chip' });
        chip.style.display = 'inline-flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '2px';
        chip.style.padding = '1px 6px';
        chip.style.background = 'var(--interactive-accent, #483699)';
        chip.style.color = '#fff';
        chip.style.borderRadius = '10px';
        chip.style.fontSize = '11px';
        chip.style.cursor = 'pointer';
        chip.textContent = t;
        const x = chip.createSpan({ text: ' ×' });
        x.style.opacity = '0.7';
        chip.addEventListener('click', async (e) => {
          e.stopPropagation();
          this.host.selectedTags = this.host.selectedTags.filter(st => st !== t);
          await this.host.refreshListOnly();
        });
      }
    }

    // Has Relations 过滤
    const relBtn = metaRow.createEl('button', {
      text: this.host.filter.hasRelations ? '🔗' : '🔗',
      cls: `markvault-filter-btn ${this.host.filter.hasRelations ? 'active' : ''}`,
      attr: { title: 'Filter by has relations' },
    });
    relBtn.addEventListener('click', async () => {
      this.host.filter.hasRelations = this.host.filter.hasRelations ? undefined : true;
      await this.host.refreshListOnly();
    });

    // Needs Correction 过滤
    const corrBtn = metaRow.createEl('button', {
      text: '⚠️',
      cls: `markvault-filter-btn ${this.host.filter.needsCorrection ? 'active' : ''}`,
      attr: { title: 'Filter by needs correction' },
    });
    corrBtn.addEventListener('click', async () => {
      this.host.filter.needsCorrection = this.host.filter.needsCorrection ? undefined : true;
      await this.host.refreshListOnly();
    });

    // v4.1: Motivation 语义过滤
    const motBtn = metaRow.createEl('button', {
      text: this.host.filter.motivation && this.host.filter.motivation !== 'all' ? '🎯' : '🎯',
      cls: `markvault-filter-btn ${this.host.filter.motivation && this.host.filter.motivation !== 'all' ? 'active' : ''}`,
      attr: { title: 'Filter by motivation (annotation intent)' },
    });
    motBtn.addEventListener('click', () => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('All').setChecked(!this.host.filter.motivation || this.host.filter.motivation === 'all')
          .onClick(async () => { this.host.filter.motivation = 'all'; await this.host.refreshListOnly(); });
      });
      for (const m of ['highlighting', 'commenting', 'questioning', 'editing', 'bookmarking'] as const) {
        const labels: Record<string, string> = { highlighting: '🖍️ Highlighting', commenting: '💬 Commenting', questioning: '❓ Questioning', editing: '✏️ Editing', bookmarking: '🔖 Bookmarking' };
        menu.addItem((item) => {
          item.setTitle(labels[m] || m).setChecked(this.host.filter.motivation === m)
            .onClick(async () => { this.host.filter.motivation = m as any; await this.host.refreshListOnly(); });
        });
      }
      menu.showAtMouseEvent({ clientX: motBtn.getBoundingClientRect().left, clientY: motBtn.getBoundingClientRect().bottom } as MouseEvent);
    });
  }

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
          this.host.fieldFilterEntries.push({ key, value: val });
          await this.host.refreshListOnly();
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

  /** Tag 过滤器 Popover：内置搜索 + 频率排序 + 层级缩进 */
  private showTagFilterPopover(anchor: HTMLElement): void {
    // 关闭旧 popover（如果存在）
    const existing = document.querySelector('.markvault-tag-filter-popover');
    if (existing) { existing.remove(); return; }

    const frequencies = getTagFrequencies();
    const currentTag = this.host.filter.tag;
    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 240;

    // ── 构建层级树 ──
    interface TagTreeNode {
      fullPath: string;
      label: string;
      children: TagTreeNode[];
      count: number;
    }
    const rootNodes: TagTreeNode[] = [];
    const nodeMap = new Map<string, TagTreeNode>();

    for (const f of frequencies) {
      const parts = f.name.split('/');
      let parentList = rootNodes;
      let parentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        const currentPath = parentPath ? `${parentPath}/${seg}` : seg;
        let node = nodeMap.get(currentPath);
        if (!node) {
          node = { fullPath: currentPath, label: seg, children: [], count: 0 };
          nodeMap.set(currentPath, node);
          parentList.push(node);
        }
        // leaf count（终端的 count 来自 frequencies）
        if (i === parts.length - 1) {
          node.count = f.count;
        }
        parentList = node.children;
        parentPath = currentPath;
      }
    }

    // 计算非叶子节点的总标注数（子节点 count 之和）
    function computeCounts(nodes: TagTreeNode[]): number {
      let total = 0;
      for (const n of nodes) {
        const childSum = computeCounts(n.children);
        if (n.count === 0) n.count = childSum; // 非叶子节点用子节点合计
        total += n.count;
      }
      return total;
    }
    computeCounts(rootNodes);

    // ── Popover 容器 ──
    const popover = document.body.createDiv({ cls: 'markvault-tag-filter-popover' });
    popover.style.position = 'fixed';
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.width = `${popoverWidth}px`;
    popover.style.maxHeight = '360px';
    popover.style.display = 'flex';
    popover.style.flexDirection = 'column';
    popover.style.background = 'var(--background-primary, #fff)';
    popover.style.border = '1px solid var(--background-modifier-border, #ccc)';
    popover.style.borderRadius = '8px';
    popover.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
    popover.style.zIndex = '9999';
    popover.style.overflow = 'hidden';

    // ── 搜索框 ──
    const searchInput = popover.createEl('input', {
      type: 'text',
      cls: 'markvault-tag-filter-search',
      attr: { placeholder: 'Search tags...' },
    });
    searchInput.style.width = '100%';
    searchInput.style.boxSizing = 'border-box';
    searchInput.style.padding = '10px 12px';
    searchInput.style.border = 'none';
    searchInput.style.borderBottom = '1px solid var(--background-modifier-border, #ddd)';
    searchInput.style.fontSize = '14px';
    searchInput.style.background = 'var(--background-primary, #fff)';
    searchInput.style.color = 'var(--text-normal, #333)';
    searchInput.style.outline = 'none';

    // ── 列表容器 ──
    const listContainer = popover.createDiv({ cls: 'markvault-tag-filter-list' });
    listContainer.style.flex = '1';
    listContainer.style.overflowY = 'auto';
    listContainer.style.padding = '4px';

    // ── 通用行渲染 ──
    const createItemRow = (label: string, fullPath: string, count: number, depth: number, isActive: boolean): HTMLElement => {
      const actuallyActive = isActive || this.host.selectedTags.includes(fullPath);
      const item = listContainer.createDiv({ cls: 'markvault-tag-filter-item' });
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';
      item.style.padding = '5px 10px';
      item.style.paddingLeft = `${10 + depth * 14}px`;
      item.style.borderRadius = '6px';
      item.style.cursor = 'pointer';
      item.style.fontSize = '13px';
      item.style.transition = 'background 0.1s';

      if (isActive) {
        item.style.background = 'var(--interactive-accent, #483699)';
        item.style.color = '#fff';
      }

      const leftSide = item.createSpan();
      // 层级引导线
      if (depth > 0) {
        leftSide.style.color = isActive ? 'rgba(255,255,255,0.5)' : 'var(--text-faint, #bbb)';
        leftSide.style.marginRight = '4px';
        leftSide.style.fontSize = '11px';
      }

      // leaf 图标 vs folder 图标
      const hasChildren = nodeMap.get(fullPath)?.children?.length ?? 0 > 0;
      const icon = hasChildren ? '▸ ' : '  ';
      leftSide.appendText(icon + label);

      const countBadge = item.createSpan({ text: `${count}`, cls: 'markvault-tag-filter-count' });
      countBadge.style.fontSize = '11px';
      countBadge.style.padding = '1px 6px';
      countBadge.style.borderRadius = '10px';
      countBadge.style.background = isActive ? 'rgba(255,255,255,0.3)' : 'var(--background-modifier-hover, #f0f0f0)';

      item.addEventListener('mouseenter', () => {
        if (!isActive) item.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
      });
      item.addEventListener('mouseleave', () => {
        if (!isActive) item.style.background = '';
      });
      item.addEventListener('click', async () => {
        // 多选 toggle：如果已在选中列表则移除，否则添加
        const idx = this.host.selectedTags.indexOf(fullPath);
        if (idx >= 0) {
          this.host.selectedTags.splice(idx, 1);
        } else {
          this.host.selectedTags.push(fullPath);
        }
        // 不关闭 popover，允许连续选择；关闭 popover 需点击外部或按 Esc
        await this.host.refreshListOnly();
      });
      return item;
    };

    // ── 递归渲染树节点 ──
    const renderTree = (nodes: TagTreeNode[], depth: number, query: string) => {
      const q = query.toLowerCase();
      for (const node of nodes) {
        const matchSelf = !q || node.label.toLowerCase().includes(q);
        const hasMatchingChildren = !q || node.children.some(c => c.label.toLowerCase().includes(q));

        if (matchSelf || hasMatchingChildren) {
          createItemRow(node.label, node.fullPath, node.count, depth, false);
          if (node.children.length > 0) {
            renderTree(node.children, depth + 1, query);
          }
        }
      }
    };

    // ── 搜索模式的扁平渲染 ──
    const renderFlatSearch = (query: string) => {
      const q = query.toLowerCase();
      const allNodes = [...nodeMap.values()];
      // 先排序：以 q 开头的排前面，再按 count 降序
      allNodes.sort((a, b) => {
        const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return b.count - a.count || a.label.localeCompare(b.label);
      });

      for (const node of allNodes) {
        if (node.label.toLowerCase().includes(q)) {
          // 搜索模式显示完整路径
          const displayLabel = node.fullPath.includes('/') ? node.fullPath : node.label;
          createItemRow(displayLabel, node.fullPath, node.count, 0, false);
        }
      }
    };

    // ── 主渲染 ──
    const renderList = (query: string) => {
      listContainer.empty();

      // "All" 选项
      const allItem = listContainer.createDiv({ cls: 'markvault-tag-filter-item' });
      allItem.style.display = 'flex';
      allItem.style.justifyContent = 'space-between';
      allItem.style.padding = '6px 10px';
      allItem.style.borderRadius = '6px';
      allItem.style.cursor = 'pointer';
      allItem.style.fontSize = '13px';
      if (!currentTag || currentTag === 'all') {
        allItem.style.background = 'var(--interactive-accent, #483699)';
        allItem.style.color = '#fff';
      }
      allItem.createSpan({ text: 'All tags' });
      allItem.addEventListener('click', async () => {
        this.host.selectedTags.length = 0; // 清空多选
        popover.remove();
        await this.host.refreshListOnly();
      });

      const q = query.toLowerCase().trim();

      if (rootNodes.length === 0) {
        const noItem = listContainer.createDiv();
        noItem.style.padding = '16px 10px';
        noItem.style.textAlign = 'center';
        noItem.style.color = 'var(--text-muted, #888)';
        noItem.style.fontSize = '12px';
        noItem.textContent = 'No tags in any annotation';
        return;
      }

      const hasHierarchy = rootNodes.some(n => n.children.length > 0);

      // v6.1: 最近使用区（前5个高频标签，仅在无搜索时显示）
      if (!q) {
        const top5 = frequencies.slice(0, 5);
        if (top5.length > 0) {
          const recentLabel = listContainer.createDiv();
          recentLabel.style.padding = '4px 10px 2px';
          recentLabel.style.fontSize = '10px';
          recentLabel.style.color = 'var(--text-faint, #aaa)';
          recentLabel.style.textTransform = 'uppercase';
          recentLabel.textContent = 'Frequent';
          for (const f of top5) {
            const pill = createItemRow(f.name, f.name, f.count, 0, false);
            pill.style.background = this.host.selectedTags.includes(f.name)
              ? 'var(--interactive-accent, #483699)'
              : 'var(--background-modifier-hover, #f5f5f5)';
          }
          const sep = listContainer.createDiv();
          sep.style.margin = '4px 10px';
          sep.style.height = '1px';
          sep.style.background = 'var(--background-modifier-border, #ddd)';
        }
      }

      if (q && hasHierarchy) {
        // 有搜索且有层级：走扁平路径（搜索模式）
        renderFlatSearch(q);
      } else if (q) {
        // 有搜索但无层级：扁平过滤
        const flat = [...nodeMap.values()];
        flat.sort((a, b) => {
          const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
          const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          return b.count - a.count;
        });
        let shown = 0;
        for (const node of flat) {
          if (node.label.toLowerCase().includes(q)) {
            createItemRow(node.label, node.fullPath, node.count, 0, currentTag === node.fullPath);
            shown++;
          }
        }
        if (shown === 0) {
          const noItem = listContainer.createDiv();
          noItem.style.padding = '16px 10px';
          noItem.style.textAlign = 'center';
          noItem.style.color = 'var(--text-muted, #888)';
          noItem.style.fontSize = '12px';
          noItem.textContent = 'No matching tags';
        }
      } else {
        // 无搜索：树形渲染
        renderTree(rootNodes, 0, '');
      }
    };

    // 初始渲染
    renderList('');

    // 搜索事件
    searchInput.addEventListener('input', () => {
      renderList(searchInput.value);
    });

    // 键盘 Escape
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') popover.remove();
    });

    // 点击外部关闭
    const onClickOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        popover.remove();
        document.removeEventListener('click', onClickOutside, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', onClickOutside, true);
    }, 0);

    // 自动聚焦搜索框
    setTimeout(() => searchInput.focus(), 50);
  }
}
