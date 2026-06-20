import { Menu } from 'obsidian';
import type { AnnotationFilter } from '../../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS } from '../../../types/annotation';
import { getFieldKeys, getFieldValues, getGroupNames, getMergedGroupNames, getTagFrequencies } from '../../../db/annotation-repo';

/** 标签树节点 */
interface TagTreeNode {
  fullPath: string;
  label: string;
  children: TagTreeNode[];
  count: number;
}

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

  // ─── 共享工具方法 ──────────────────────────────────────

  /** 构建层级化标签树，供多个 Popover 复用 */
  private buildTagTree(): {
    rootNodes: TagTreeNode[];
    nodeMap: Map<string, TagTreeNode>;
    frequencies: ReturnType<typeof getTagFrequencies>;
  } {
    const frequencies = getTagFrequencies();
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
        if (i === parts.length - 1) {
          node.count = f.count;
        }
        parentList = node.children;
        parentPath = currentPath;
      }
    }

    // 计算非叶子节点计数
    function computeCounts(nodes: TagTreeNode[]): number {
      let total = 0;
      for (const n of nodes) {
        const childSum = computeCounts(n.children);
        if (n.count === 0) n.count = childSum;
        total += n.count;
      }
      return total;
    }
    computeCounts(rootNodes);

    return { rootNodes, nodeMap, frequencies };
  }

  /** 统计活跃的元数据过滤条件数量 */
  private countActiveMetaFilters(): number {
    let count = 0;
    const f = this.host.filter;
    if (f.mastery && f.mastery !== 'all') count++;
    if (f.group && f.group !== 'all') count++;
    if (this.host.selectedTags.length > 0) count++;
    if (f.hasRelations === true) count++;
    if (f.needsCorrection === true) count++;
    if (f.motivation && f.motivation !== 'all') count++;
    return count;
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
    const hasTags = this.host.selectedTags.length > 0;
    const { body: tagsBody } = createSection(scrollContainer, 'Tags', hasTags);

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

    const tagTree = this.buildTagTree();
    const { rootNodes, nodeMap, frequencies } = tagTree;

    // v6.1: 标签行渲染（内联版）
    const createTagRow = (fullPath: string, label: string, count: number, depth: number): HTMLElement => {
      const isActive = this.host.selectedTags.includes(fullPath);
      const item = tagList.createDiv();
      Object.assign(item.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 10px',
        paddingLeft: `${10 + depth * 14}px`,
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '12px',
        transition: 'background 0.1s',
      });
      if (isActive) {
        item.style.background = 'var(--interactive-accent, #483699)';
        item.style.color = '#fff';
      }

      const leftSide = item.createSpan();
      if (depth > 0 && !isActive) {
        leftSide.style.color = 'var(--text-faint, #bbb)';
      }
      const hasChildren = (nodeMap.get(fullPath)?.children?.length ?? 0) > 0;
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
        const idx = this.host.selectedTags.indexOf(fullPath);
        if (idx >= 0) {
          this.host.selectedTags.splice(idx, 1);
        } else {
          this.host.selectedTags.push(fullPath);
        }
        await this.host.refreshListOnly();
        this.refreshUnifiedPopoverSections(popover);
      });
      return item;
    };

    const renderTagTree = (nodes: TagTreeNode[], depth: number, query: string) => {
      const q = query.toLowerCase();
      for (const node of nodes) {
        const matchSelf = !q || node.label.toLowerCase().includes(q);
        const hasMatchingChildren = !q || node.children.some(c => c.label.toLowerCase().includes(q));
        if (matchSelf || hasMatchingChildren) {
          createTagRow(node.fullPath, node.label, node.count, depth);
          if (node.children.length > 0) {
            renderTagTree(node.children, depth + 1, query);
          }
        }
      }
    };

    const renderFlatSearch = (query: string) => {
      const q = query.toLowerCase();
      const allNodes = [...nodeMap.values()];
      allNodes.sort((a, b) => {
        const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return b.count - a.count || a.label.localeCompare(b.label);
      });
      for (const node of allNodes) {
        if (node.label.toLowerCase().includes(q)) {
          const displayLabel = node.fullPath.includes('/') ? node.fullPath : node.label;
          createTagRow(node.fullPath, displayLabel, node.count, 0);
        }
      }
    };

    const renderTagList = (query: string) => {
      tagList.empty();
      const q = query.toLowerCase().trim();

      if (rootNodes.length === 0) {
        const noItem = tagList.createDiv();
        noItem.style.padding = '12px 10px';
        noItem.style.textAlign = 'center';
        noItem.style.color = 'var(--text-muted, #888)';
        noItem.style.fontSize = '11px';
        noItem.textContent = 'No tags in any annotation';
        return;
      }

      if (q) {
        renderFlatSearch(q);
      } else {
        renderTagTree(rootNodes, 0, '');
      }
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
      this.host.selectedTags.length = 0;
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

    const groups = getMergedGroupNames();
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

    const motConfig: Array<{ value: string; label: string }> = [
      { value: 'highlighting', label: '🖍️ Highlighting' },
      { value: 'commenting', label: '💬 Commenting' },
      { value: 'questioning', label: '❓ Questioning' },
      { value: 'editing', label: '✏️ Editing' },
      { value: 'bookmarking', label: '🔖 Bookmarking' },
    ];

    createOptionRow(motBody, 'All', !this.host.filter.motivation || this.host.filter.motivation === 'all', async () => {
      this.host.filter.motivation = 'all';
      await this.host.refreshListOnly();
      this.refreshUnifiedPopoverSections(popover);
    });
    for (const mc of motConfig) {
      createOptionRow(motBody, mc.label, this.host.filter.motivation === mc.value, async () => {
        this.host.filter.motivation = mc.value as any;
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
    for (const t of this.host.selectedTags) {
      makeChip(`# ${t}`, async () => {
        this.host.selectedTags = this.host.selectedTags.filter(st => st !== t);
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
      const motLabel = motConfig.find(m => m.value === this.host.filter.motivation)?.label || this.host.filter.motivation;
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
      this.host.selectedTags.length = 0;
      this.host.filter.hasRelations = undefined;
      this.host.filter.needsCorrection = undefined;
      this.host.filter.motivation = 'all';
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

    const motConfig: Array<{ value: string; label: string }> = [
      { value: 'highlighting', label: '🖍️ Highlighting' },
      { value: 'commenting', label: '💬 Commenting' },
      { value: 'questioning', label: '❓ Questioning' },
      { value: 'editing', label: '✏️ Editing' },
      { value: 'bookmarking', label: '🔖 Bookmarking' },
    ];

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
    for (const t of this.host.selectedTags) {
      makeChip(`# ${t}`, async () => {
        this.host.selectedTags = this.host.selectedTags.filter(st => st !== t);
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
      const motLabel = motConfig.find(m => m.value === this.host.filter.motivation)?.label || this.host.filter.motivation;
      makeChip(`Motivation: ${motLabel}`, async () => {
        this.host.filter.motivation = 'all';
        await this.host.refreshListOnly();
      });
    }
  }
}
