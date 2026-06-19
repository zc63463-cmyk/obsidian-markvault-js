/**
 * Keyboard Shortcuts — 导图键盘快捷键
 *
 * 参考 mind-elixir 快捷键设计：
 *   Tab        → 添加子节点
 *   Enter      → 添加兄弟节点
 *   F2 / Space → 进入编辑
 *   Delete     → 删除节点（仅 Free）
 *   F1         → 居中视图（fitView）
 *   Ctrl + +   → 放大
 *   Ctrl + -   → 缩小
 *   Ctrl + 0   → 重置缩放
 *   Ctrl + Z   → 撤销
 *   Ctrl+Shift+Z / Ctrl+Y → 重做
 *   ↑↓←→      → 节点导航（上下兄弟，左右父子）
 *
 * IME 安全：在输入法组合输入期间（compositionstart ~ compositionend）
 * 禁止所有快捷键，避免干扰中文输入。
 */

import { logger } from '../../utils/logger';

/** 快捷键处理器签名 */
export interface ShortcutHandler {
  /** 返回 true 表示已处理（阻止默认行为） */
  (action: ShortcutAction): boolean;
}

/** 快捷键动作枚举 */
export type ShortcutAction =
  | 'insertChild'
  | 'insertSibling'
  | 'editNode'
  | 'deleteNode'
  | 'fitView'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'undo'
  | 'redo'
  | 'navigateUp'
  | 'navigateDown'
  | 'navigateLeft'
  | 'navigateRight'
  | 'toggleCollapse';

/**
 * 键盘快捷键管理器
 *
 * 绑定到容器元素，监听 keydown 事件，
 * 在 IME 安全条件下触发对应动作。
 */
export class KeyboardShortcuts {
  private handler: ShortcutHandler;
  private target: HTMLElement;
  private imeComposing = false;

  constructor(target: HTMLElement, handler: ShortcutHandler) {
    this.target = target;
    this.handler = handler;
  }

  /** 绑定事件监听器 */
  bind(): void {
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('compositionstart', this.onCompositionStart);
    this.target.addEventListener('compositionend', this.onCompositionEnd);
    // 全局 tabindex 让容器可聚焦
    if (!this.target.hasAttribute('tabindex')) {
      this.target.setAttribute('tabindex', '0');
    }
    logger.debug('MindFlow: keyboard shortcuts bound');
  }

  /** 解绑事件监听器 */
  unbind(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('compositionstart', this.onCompositionStart);
    this.target.removeEventListener('compositionend', this.onCompositionEnd);
  }

  private onCompositionStart = (): void => {
    this.imeComposing = true;
  };

  private onCompositionEnd = (): void => {
    this.imeComposing = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // IME 组合输入期间禁止快捷键
    if (this.imeComposing) return;

    // 编辑态下只处理 Esc / Ctrl+Z / Ctrl+Shift+Z
    const isEditing = (e.target as HTMLElement)?.isContentEditable;
    if (isEditing) {
      // Esc 退出编辑由 view 层 contentEditable 处理
      return;
    }

    const action = this.mapKeyToAction(e);
    if (!action) return;

    const handled = this.handler(action);
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** 将键盘事件映射到动作 */
  private mapKeyToAction(e: KeyboardEvent): ShortcutAction | null {
    const ctrl = e.ctrlKey || e.metaKey;

    // ── Ctrl 组合键 ──
    if (ctrl) {
      switch (e.key) {
        case 'z':
        case 'Z':
          return e.shiftKey ? 'redo' : 'undo';
        case 'y':
        case 'Y':
          return 'redo';
        case '=':
        case '+':
          return 'zoomIn';
        case '-':
        case '_':
          return 'zoomOut';
        case '0':
          return 'zoomReset';
      }
      return null;
    }

    // ── 功能键 ──
    switch (e.key) {
      case 'F1':
        return 'fitView';
      case 'F2':
        return 'editNode';
      case 'Tab':
        return 'insertChild';
      case 'Enter':
        return 'insertSibling';
      case 'Delete':
        return 'deleteNode';
      // P2-4: 移除 Backspace 映射（与文本编辑场景冲突）
      case 'ArrowUp':
        return 'navigateUp';
      case 'ArrowDown':
        return 'navigateDown';
      case 'ArrowLeft':
        return 'navigateLeft';
      case 'ArrowRight':
        return 'navigateRight';
      case ' ':
        return 'toggleCollapse';
    }

    return null;
  }
}
