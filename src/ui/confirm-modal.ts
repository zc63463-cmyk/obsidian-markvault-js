import { App, Modal } from 'obsidian';

/**
 * 可复用的确认对话框 — 替代 window.confirm()
 *
 * Obsidian 主题适配的确认 Modal，支持：
 * - 标题和消息体（支持 \n 换行）
 * - 自定义 OK / Cancel 按钮文案
 * - 危险操作红色 OK 按钮
 * - Promise<boolean> 返回值，与 confirm() 语义一致
 *
 * 使用方式：
 *   const ok = await ConfirmModal.open(app, { title: 'Delete?', message: '...' });
 *   if (!ok) return;
 */
export class ConfirmModal extends Modal {
  private result = false;
  private _resolve!: (value: boolean) => void;

  private config: ConfirmModalConfig;

  private constructor(app: App, config: ConfirmModalConfig) {
    super(app);
    this.config = config;
  }

  /**
   * 静态工厂方法 — 打开 Modal 并返回 Promise<boolean>
   * true = 用户点击 OK，false = 取消或关闭
   */
  static open(app: App, config: ConfirmModalConfig | string): Promise<boolean> {
    const cfg: ConfirmModalConfig =
      typeof config === 'string' ? { message: config } : config;
    const modal = new ConfirmModal(app, cfg);
    return modal._show();
  }

  private _show(): Promise<boolean> {
    return new Promise(resolve => {
      this._resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    const cfg = this.config;

    // ── 标题 ──
    titleEl.setText(cfg.title || 'Confirm');

    // ── 消息体 ──
    const messageEl = contentEl.createDiv({ cls: 'markvault-confirm-message' });
    // 支持多行（\n → <br>）
    const lines = cfg.message.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) messageEl.createEl('br');
      messageEl.appendText(lines[i]);
    }

    // ── 按钮栏 ──
    const buttonBar = contentEl.createDiv({ cls: 'markvault-confirm-buttons' });

    const okCls = cfg.dangerous ? 'mod-warning' : 'mod-cta';
    const okBtn = buttonBar.createEl('button', {
      text: cfg.okText || 'OK',
      cls: okCls,
    });
    okBtn.addEventListener('click', () => {
      this.result = true;
      this.close();
    });

    const cancelBtn = buttonBar.createEl('button', {
      text: cfg.cancelText || 'Cancel',
    });
    cancelBtn.addEventListener('click', () => {
      this.result = false;
      this.close();
    });

    // 键盘支持：Enter = OK, Escape = Cancel
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        this.result = true;
        this.close();
      } else if (ev.key === 'Escape') {
        this.result = false;
        this.close();
      }
    };
    contentEl.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this._resolve(this.result);
  }
}

/** ConfirmModal 配置 */
export interface ConfirmModalConfig {
  /** 消息文本（支持 \n 换行） */
  message: string;
  /** 标题（默认 "Confirm"） */
  title?: string;
  /** OK 按钮文案（默认 "OK"） */
  okText?: string;
  /** Cancel 按钮文案（默认 "Cancel"） */
  cancelText?: string;
  /** 是否为危险操作（OK 按钮变红） */
  dangerous?: boolean;
}
