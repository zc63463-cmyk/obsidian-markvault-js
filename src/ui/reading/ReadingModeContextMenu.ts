import { Plugin, Menu } from 'obsidian';
import { PRESET_COLORS } from '../../types/annotation';
import type { AnnotationType, Annotation } from '../../types/annotation';

export interface ReadingContextMenuHost {
  createReadingAnnotation(request: {
    selectedText: string;
    color: string;
    type: AnnotationType;
    kind: Annotation['kind'];
  }): Promise<void>;
  getDefaultColor(): string;
}

/**
 * 阅读模式右键菜单
 *
 * 在阅读模式选中文本后右键，弹出快速标注菜单：
 * - Highlight / Bold / Underline 一键创建
 * - 颜色快捷选择
 */
export class ReadingModeContextMenu {
  constructor(
    private plugin: Plugin,
    private host: ReadingContextMenuHost,
  ) {}

  destroy(): void {
    // registerDomEvent 由 Obsidian 在插件卸载时自动清理
  }

  setup(): void {
    this.plugin.registerDomEvent(document, 'contextmenu', (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // 只在阅读/预览区域生效
      if (!target.closest('.markdown-preview-view') && !target.closest('.markdown-reading-view')) {
        return;
      }

      // 忽略插件自身 UI
      if (target.closest('.markvault-reading-toolbar, .markvault-modal, .modal-container')) {
        return;
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;

      const text = sel.toString().trim();
      if (text.length === 0) return;

      // 阻止浏览器默认右键菜单
      e.preventDefault();
      e.stopPropagation();

      this.showMenu(e, text);
    }, { capture: true });
  }

  private showMenu(e: MouseEvent, selectedText: string): void {
    const menu = new Menu();
    const defaultColor = this.host.getDefaultColor();

    menu.addItem((item) => {
      item.setTitle('🎨 Highlight')
        .setIcon('pen-tool')
        .onClick(async () => {
          await this.createAnnotation(selectedText, 'highlight', defaultColor);
        });
    });

    menu.addItem((item) => {
      item.setTitle('𝗕 Bold')
        .setIcon('bold')
        .onClick(async () => {
          await this.createAnnotation(selectedText, 'bold', defaultColor);
        });
    });

    menu.addItem((item) => {
      item.setTitle('U̲ Underline')
        .setIcon('underline')
        .onClick(async () => {
          await this.createAnnotation(selectedText, 'underline', defaultColor);
        });
    });

    menu.addSeparator();

    for (const color of PRESET_COLORS) {
      menu.addItem((item) => {
        item.setTitle(`${color.emoji} ${color.label}`)
          .onClick(async () => {
            await this.createAnnotation(selectedText, 'highlight', color.id);
          });
      });
    }

    menu.showAtMouseEvent(e);
  }

  private async createAnnotation(
    selectedText: string,
    type: AnnotationType,
    color: string,
  ): Promise<void> {
    try {
      await this.host.createReadingAnnotation({
        selectedText,
        color,
        type,
        kind: 'inline',
      });
    } catch (err) {
      console.error('MarkVault: reading mode context menu create annotation failed', err);
    }
  }
}
