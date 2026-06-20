import { Menu } from 'obsidian';
import type { AnnotationFilter } from '../../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS } from '../../../types/annotation';
import { getFieldKeys, getFieldValues, getGroupNames, getTagFrequencies } from '../../../db/annotation-repo';

/**
 * FilterBar —— 侧边栏过滤栏
 *
 * 负责渲染类型/颜色/排序/批注过滤，以及 Phase 3 的字段过滤 UI。
 */
export interface FilterBarHost {
  filter: AnnotationFilter;
  fieldFilterEntries: Array<{ key: string; value: string }>;
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
      const groups = getGroupNames();
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

    // Tag 过滤（自定义 Popover：搜索框 + 频率排序列表）
    const tagBtn = metaRow.createEl('button', {
      text: this.host.filter.tag && this.host.filter.tag !== 'all'
        ? this.host.filter.tag
        : '#',
      cls: `markvault-filter-btn ${this.host.filter.tag && this.host.filter.tag !== 'all' ? 'active' : ''}`,
      attr: { title: 'Filter by tag' },
    });
    tagBtn.addEventListener('click', () => {
      this.showTagFilterPopover(tagBtn);
    });

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

  /** Tag 过滤器 Popover：内置搜索 + 频率排序 */
  private showTagFilterPopover(anchor: HTMLElement): void {
    // 关闭旧 popover（如果存在）
    const existing = document.querySelector('.markvault-tag-filter-popover');
    if (existing) { existing.remove(); return; }

    const frequencies = getTagFrequencies();
    const currentTag = this.host.filter.tag;
    const rect = anchor.getBoundingClientRect();

    // ── Popover 容器 ──
    const popover = document.body.createDiv({ cls: 'markvault-tag-filter-popover' });
    popover.style.position = 'fixed';
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.width = '220px';
    popover.style.maxHeight = '320px';
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

    // ── 列表容器（可滚动） ──
    const listContainer = popover.createDiv({ cls: 'markvault-tag-filter-list' });
    listContainer.style.flex = '1';
    listContainer.style.overflowY = 'auto';
    listContainer.style.padding = '4px';

    // ── 渲染函数 ──
    const renderList = (query: string) => {
      listContainer.empty();
      const q = query.toLowerCase().trim();

      let filtered = frequencies;
      if (q) {
        filtered = frequencies.filter(f => f.name.toLowerCase().includes(q));
        // 搜索模式下优先匹配开头（排序微调）
        filtered.sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          return b.count - a.count || a.name.localeCompare(b.name);
        });
      }

      // "All" 选项
      const allItem = listContainer.createDiv({ cls: 'markvault-tag-filter-item' });
      allItem.style.display = 'flex';
      allItem.style.justifyContent = 'space-between';
      allItem.style.alignItems = 'center';
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
        this.host.filter.tag = 'all';
        popover.remove();
        await this.host.refreshListOnly();
      });

      if (filtered.length === 0) {
        const noItem = listContainer.createDiv();
        noItem.style.padding = '20px 10px';
        noItem.style.textAlign = 'center';
        noItem.style.color = 'var(--text-muted, #888)';
        noItem.style.fontSize = '12px';
        noItem.textContent = 'No matching tags';
        return;
      }

      for (const f of filtered) {
        const item = listContainer.createDiv({ cls: 'markvault-tag-filter-item' });
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '6px 10px';
        item.style.borderRadius = '6px';
        item.style.cursor = 'pointer';
        item.style.fontSize = '13px';
        item.style.transition = 'background 0.1s';

        if (currentTag === f.name) {
          item.style.background = 'var(--interactive-accent, #483699)';
          item.style.color = '#fff';
        }

        // 标签名（搜索匹配高亮）
        const nameSpan = item.createSpan({ text: f.name });

        // 使用频率标记
        const countBadge = item.createSpan({
          text: `${f.count}`,
          cls: 'markvault-tag-filter-count',
        });
        countBadge.style.fontSize = '11px';
        countBadge.style.padding = '1px 6px';
        countBadge.style.borderRadius = '10px';
        countBadge.style.background = currentTag === f.name
          ? 'rgba(255,255,255,0.3)'
          : 'var(--background-modifier-hover, #f0f0f0)';

        item.addEventListener('mouseenter', () => {
          if (currentTag !== f.name) {
            item.style.background = 'var(--background-modifier-hover, rgba(0,0,0,0.05))';
          }
        });
        item.addEventListener('mouseleave', () => {
          if (currentTag !== f.name) {
            item.style.background = '';
          }
        });
        item.addEventListener('click', async () => {
          this.host.filter.tag = f.name;
          popover.remove();
          await this.host.refreshListOnly();
        });
      }
    };

    // 初始渲染
    renderList('');

    // 搜索输入事件
    searchInput.addEventListener('input', () => {
      renderList(searchInput.value);
    });

    // 键盘：Escape 关闭
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        popover.remove();
      }
    });

    // 点击外部关闭
    const onClickOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        popover.remove();
        document.removeEventListener('click', onClickOutside, true);
      }
    };
    // 延迟注册防止立即触发
    setTimeout(() => {
      document.addEventListener('click', onClickOutside, true);
    }, 0);

    // 自动聚焦搜索框
    setTimeout(() => searchInput.focus(), 50);
  }
}
