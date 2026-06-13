import { Plugin } from 'obsidian';
import { PRESET_COLORS } from '../../types/annotation';
import type { AnnotationType, Annotation } from '../../types/annotation';

/**
 * 阅读模式浮动工具条
 *
 * 监听选中文本事件，在阅读模式下显示一个浮动工具条，
 * 允许用户选择标注类型和颜色并创建标注。
 */
export interface CreateAnnotationRequest {
  selectedText: string;
  color: string;
  type: AnnotationType;
  kind: Annotation['kind'];
}

export interface ReadingToolbarHost {
  /** 根据用户选择创建标注 */
  createReadingAnnotation(request: CreateAnnotationRequest): Promise<void>;
}

export class ReadingModeToolbar {
  private toolbar: HTMLElement | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private plugin: Plugin,
    private host: ReadingToolbarHost,
  ) {}

  /** 注册阅读模式选中文本事件 */
  setup(): void {
    this.plugin.registerDomEvent(document, 'mouseup', (e: MouseEvent) => {
      // 忽略在工具栏自身上的点击
      if (this.toolbar && this.toolbar.contains(e.target as Node)) return;

      // 延迟一帧，等 selection 更新
      if (this.hideTimeout) clearTimeout(this.hideTimeout);
      this.hideTimeout = setTimeout(() => this.handleSelection(e), 50);
    });

    // 滚动或窗口大小变化时隐藏工具栏
    this.plugin.registerDomEvent(document, 'selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        this.hide();
      }
    });
  }

  /** 销毁工具条，移除 DOM */
  destroy(): void {
    this.hide();
  }

  /** 处理阅读模式文本选择 */
  private handleSelection(e: MouseEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      this.hide();
      return;
    }

    // 检查是否在 CM6 编辑器中（编辑模式有自己的右键菜单）
    const target = e.target as HTMLElement;
    if (target.closest('.cm-editor') || target.closest('.cm-content')) return;
    if (target.closest('.markdown-source-view')) return;

    // 必须选中了文本
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (text.length === 0) return;

    // 检查是否在预览区域（阅读模式）
    if (!target.closest('.markdown-preview-view') && !target.closest('.markdown-reading-view')) {
      this.hide();
      return;
    }

    this.show(range, text);
  }

  /** 显示浮动工具条 */
  private show(range: Range, selectedText: string) {
    this.hide();

    const toolbar = document.createElement('div');
    toolbar.className = 'markvault-reading-toolbar';
    toolbar.setAttribute('data-markvault', 'reading-toolbar');

    toolbar.style.position = 'absolute';
    toolbar.style.zIndex = '9999';

    // 当前选中的标注类型
    let currentType: AnnotationType = 'highlight';
    let currentKind: Annotation['kind'] = 'inline';

    // ── 左侧：类型选择按钮 ──
    const typeGroup = document.createElement('div');
    typeGroup.className = 'markvault-reading-type-group';

    const types: Array<{ type: AnnotationType; label: string; icon: string; kind?: Annotation['kind'] }> = [
      { type: 'highlight', label: 'Highlight', icon: '🎨' },
      { type: 'bold', label: 'Bold', icon: 'B' },
      { type: 'underline', label: 'Underline', icon: 'U̲' },
      { type: 'highlight', label: 'Block', icon: '⬜', kind: 'block' },
    ];

    const typeBtns: HTMLElement[] = [];
    for (const t of types) {
      const btn = document.createElement('button');
      btn.className = 'markvault-reading-type-btn';
      btn.textContent = t.icon;
      btn.title = t.label;
      if (t.type === 'highlight' && !t.kind) btn.classList.add('active');

      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        currentType = t.type;
        currentKind = t.kind || 'inline';
        // 切换 active 状态
        typeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      typeGroup.appendChild(btn);
      typeBtns.push(btn);
    }

    toolbar.appendChild(typeGroup);

    // 分隔线
    const sep = document.createElement('span');
    sep.className = 'markvault-reading-toolbar-sep';
    toolbar.appendChild(sep);

    // ── 右侧：颜色圆点 ──
    const colorGroup = document.createElement('div');
    colorGroup.className = 'markvault-reading-color-group';

    for (const c of PRESET_COLORS) {
      const btn = document.createElement('button');
      btn.className = 'markvault-reading-color-btn';
      btn.style.backgroundColor = c.hex;
      btn.title = `${c.label} (${currentType})`;
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.host.createReadingAnnotation({
          selectedText,
          color: c.id,
          type: currentType,
          kind: currentKind,
        }).catch((err) => {
          console.error('MarkVault: create reading annotation failed', err);
        });
        this.hide();
      });
      colorGroup.appendChild(btn);
    }

    toolbar.appendChild(colorGroup);

    document.body.appendChild(toolbar);

    // 定位：选中文本上方
    const rect = range.getBoundingClientRect();
    const toolbarHeight = 36; // 预估高度
    let left = rect.left + rect.width / 2;
    let top = rect.top - toolbarHeight - 6 + window.scrollY;

    // 如果上方空间不足，放下方
    if (rect.top < toolbarHeight + 10) {
      top = rect.bottom + 6 + window.scrollY;
    }

    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
    toolbar.style.transform = 'translate(-50%, 0)';

    this.toolbar = toolbar;

    // 动画进入
    requestAnimationFrame(() => {
      toolbar.style.opacity = '1';
      toolbar.style.transform = 'translate(-50%, 0) scale(1)';
    });
  }

  /** 隐藏工具条 */
  hide() {
    if (this.toolbar) {
      const t = this.toolbar;
      t.style.opacity = '0';
      t.style.transform = 'translate(-50%, 0) scale(0.8)';
      setTimeout(() => {
        if (t.parentElement) {
          t.remove();
        }
      }, 150);
      this.toolbar = null;
    }
  }
}
