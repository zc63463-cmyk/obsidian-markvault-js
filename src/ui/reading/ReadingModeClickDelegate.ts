import { Plugin } from 'obsidian';

/**
 * 阅读模式点击委托
 *
 * 使用 capture 阶段监听全局 click 事件，
 * 检测用户是否点击了 <mark data-uuid>、块级标注或 span 标注，
 * 并排除 CM6 编辑器区域（编辑模式下不拦截）。
 */
export interface ClickDelegateHost {
  /** 打开指定 uuid 的标注编辑 Modal */
  onOpenAnnotation(uuid: string): Promise<void>;
}

export class ReadingModeClickDelegate {
  constructor(
    private plugin: Plugin,
    private host: ClickDelegateHost,
  ) {}

  /** 注册全局点击委托 */
  setup(): void {
    this.plugin.registerDomEvent(document, 'click', async (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // 忽略在 Modal / 弹窗内部的点击，避免干扰编辑/输入
      if (target.closest('.markvault-modal') || target.closest('.modal-container') || target.closest('.modal-bg')) {
        return;
      }

      // 1. 检查 <mark> 标注（行内标注）
      let el: HTMLElement | null = target;
      let foundMark: HTMLElement | null = null;
      while (el && el !== document.body) {
        if (el.tagName === 'MARK' && el.hasAttribute('data-uuid')) {
          foundMark = el;
          break;
        }
        el = el.parentElement;
      }

      // 2. 如果不是 <mark>，检查块级/span 标注（.markvault-block-mark[data-uuid]）
      if (!foundMark) {
        el = target;
        while (el && el !== document.body) {
          if (el.hasClass?.('markvault-block-mark') && el.hasAttribute('data-uuid')) {
            foundMark = el;
            break;
          }
          el = el.parentElement;
        }
      }

      // 3. 检查 span 标注的 CM6 装饰（data-kind="span"）
      if (!foundMark) {
        el = target;
        while (el && el !== document.body) {
          if (el.getAttribute?.('data-kind') === 'span' && el.hasAttribute('data-uuid')) {
            foundMark = el;
            break;
          }
          el = el.parentElement;
        }
      }

      // 4. 检查自然语法标注（markvault-native）
      if (!foundMark) {
        el = target;
        while (el && el !== document.body) {
          if (el.hasClass?.('markvault-native') && el.hasAttribute('data-uuid')) {
            foundMark = el;
            break;
          }
          el = el.parentElement;
        }
      }

      // 5. 检查 region 标注（新架构 markvault-region-block-mark）
      if (!foundMark) {
        el = target;
        while (el && el !== document.body) {
          if (el.hasClass?.('markvault-region-block-mark') && el.hasAttribute('data-uuid')) {
            foundMark = el;
            break;
          }
          el = el.parentElement;
        }
      }

      // 6. 检查 region 标注（旧架构 markvault-region，向后兼容）
      if (!foundMark) {
        el = target;
        while (el && el !== document.body) {
          if (el.hasClass?.('markvault-region') && el.hasAttribute('data-uuid')) {
            foundMark = el;
            break;
          }
          el = el.parentElement;
        }
      }

      if (!foundMark) return; // 不是点击标注，忽略

      // 关键修复：判断是否在 CM6 编辑区域中
      const isInCmEditor = foundMark.closest('.cm-editor') !== null;
      if (isInCmEditor) {
        // 在 CM6 编辑区域中，不拦截点击（由 CM6 WidgetType 处理）
        return;
      }

      // 在阅读模式或非编辑区域中，拦截点击并打开编辑 Modal
      const uuid = foundMark.getAttribute('data-uuid');
      if (uuid) {
        e.stopImmediatePropagation();
        e.preventDefault();
        await this.host.onOpenAnnotation(uuid);
      }
    }, { capture: true });
  }

  /** 无状态委托，Plugin 会在 unload 时自动解绑事件 */
  destroy(): void {}
}
