import type { Annotation } from '../../../types/annotation';
import { PRESET_COLORS } from '../../../types/annotation';

/**
 * StatsView —— 侧边栏统计视图
 *
 * 负责渲染总览卡片、类型/颜色分布、摘要、占比条和最近标注。
 */
export interface StatsViewHost {
  jumpToAnnotation(annotation: Annotation): Promise<void>;
}

export class StatsView {
  constructor(private host: StatsViewHost) {}

  render(container: HTMLElement, annotations: Annotation[]): void {
    const total = annotations.length;

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

    for (const a of annotations) {
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
    const recent = [...annotations]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    for (const ann of recent) {
      const row = recentCard.createDiv({ cls: 'markvault-stat-recent-row' });
      const dot = row.createDiv({ cls: 'markvault-card-color-dot' });
      const preset = PRESET_COLORS.find(c => c.id === ann.color);
      dot.style.backgroundColor = preset ? preset.hex : ann.color;
      row.createSpan({ cls: 'markvault-stat-recent-text', text: ann.text.substring(0, 40) + (ann.text.length > 40 ? '...' : '') });
      row.createSpan({ cls: 'markvault-stat-recent-file', text: ann.filePath.split('/').pop()?.replace('.md', '') || '' });
      row.addEventListener('click', () => this.host.jumpToAnnotation(ann));
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
}
