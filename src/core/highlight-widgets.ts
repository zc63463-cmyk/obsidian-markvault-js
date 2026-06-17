/**
 * CM6 Widget 类型集合
 * 
 * 7 个 Widget 用于编辑模式下的标注渲染：
 * - MarkOpenWidget / MarkCloseWidget: 隐藏 <mark>/</mark> 标签
 * - BlockAnchorWidget: 隐藏 %%markvault:%% 锚点行
 * - NativeAnchorWidget: 隐藏 %%mv:i:...%% 自然语法锚点
 * - BlockBadgeWidget: block 标注编辑模式徽章
 * - RegionAnchorMarkerWidget: region 锚点标记
 * 
 * @module highlight-widgets
 */

import { WidgetType } from '@codemirror/view';
import { PRESET_COLORS, type AnnotationType } from '../types/annotation';

// ─── Widget Types ────────────────────────────────────────

/**
 * 隐藏 <mark> 开标签的 Widget
 * 将 <mark data-uuid="..." ...> 替换为一个不可见的 span
 */
export class MarkOpenWidget extends WidgetType {
  constructor(
    readonly uuid: string,
    readonly type: AnnotationType,
    readonly color: string,
    readonly note: string,
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-mark-open';
    span.dataset.uuid = this.uuid;
    span.dataset.type = this.type;
    span.dataset.color = this.color;
    if (this.note) {
      span.title = this.note;
    }
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    // 🔧 P1-17 修复：返回 false 让点击事件冒泡到 DOM 事件处理器
    return false;
  }
}

/**
 * 隐藏 </mark> 闭标签的 Widget
 */
export class MarkCloseWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-mark-close';
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * 隐藏 %%markvault:%% 锚点行的 Widget
 * 将锚点行替换为一个不可见的 span，保持锚点行占位但不可见
 */
export class BlockAnchorWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-block-anchor-hidden';
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * 隐藏 %%mv:i:...%% 自然语法锚点的 Widget
 */
export class NativeAnchorWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'markvault-native-anchor-hidden';
    span.style.display = 'none';
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * 🔧 P1-18 修复：Block 标注编辑模式徽章
 * 在编辑模式下给 block 标注的目标行添加类型+颜色徽章，
 * 与阅读模式的 block-type-badge 保持视觉一致性。
 */
export class BlockBadgeWidget extends WidgetType {
  constructor(
    readonly uuid: string,
    readonly type: AnnotationType,
    readonly color: string,
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = `markvault-block-badge markvault-block-badge-${this.type} markvault-block-badge-${this.color}`;
    span.dataset.uuid = this.uuid;
    span.dataset.kind = 'block';

    const preset = PRESET_COLORS.find(c => c.id === this.color);
    const hex = preset ? preset.hex : this.color;

    // 类型图标
    const icon = document.createElement('span');
    icon.className = 'markvault-block-badge-icon';
    icon.textContent = this.type === 'bold' ? '𝗕' : this.type === 'underline' ? 'U̲' : '🎨';

    // 颜色点
    const dot = document.createElement('span');
    dot.className = 'markvault-block-badge-dot';
    dot.style.backgroundColor = hex;

    span.appendChild(icon);
    span.appendChild(dot);
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Region 锚点标记 Widget
 * 编辑模式下把隐藏的 region start/end 锚点替换为一个可见的小符号，
 * 让用户能感知 region 边界，同时不遮挡正文。
 */
export class RegionAnchorMarkerWidget extends WidgetType {
  constructor(
    readonly uuid: string,
    readonly type: AnnotationType,
    readonly color: string,
    readonly position: 'start' | 'end',
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = `markvault-region-anchor-marker markvault-region-anchor-${this.position}`;
    span.textContent = this.position === 'start' ? '▭' : '▭';
    span.title = `Region ${this.position}`;
    span.style.color = this.getColorHex();
    span.style.opacity = '0.6';
    span.style.fontSize = '0.85em';
    span.style.padding = '0 1px';
    span.style.userSelect = 'none';
    span.style.cursor = 'pointer';
    span.dataset.uuid = this.uuid;
    span.dataset.position = this.position;
    return span;
  }

  private getColorHex(): string {
    const preset = PRESET_COLORS.find(c => c.id === this.color);
    return preset ? preset.hex : this.color;
  }

  ignoreEvent() {
    // 🔧 P1-17 修复：返回 false 允许 region 锚点标记点击交互
    return false;
  }
}
