import { Menu } from 'obsidian';
import type { AnnotationFilter } from '../../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS } from '../../../types/annotation';
import { getFieldKeys, getFieldValues, getGroupNames } from '../../../db/annotation-repo';

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
}
