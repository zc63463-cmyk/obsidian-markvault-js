import { App, Modal, TextAreaComponent, TextComponent, Setting, TFile, MarkdownRenderer, Component } from 'obsidian';
import type { Annotation, AnnotationType, AnnotationFlag, AnnotationMotivation, AnnotationRelation, PresetColorId, RelationType } from '../../types/annotation';
import { PRESET_COLORS, RELATION_SOURCE_LABELS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS, MOTIVATION_LABELS, MOTIVATION_OPTIONS, normalizeUserFieldKey, inferMotivation } from '../../types/annotation';
import type { MasteryLevel, ReviewPriority } from '../../types/annotation';
import { updateAnnotation, deleteAnnotation, addAnnotation, addRelation, invalidateRelation, restoreRelation, updateFlags, addGroupToAnnotation, removeGroupFromAnnotation, getGroupNames, getRelations } from '../../db/annotation-repo';
import { RelationPickerModal } from './relation-picker-modal';
import { ConfirmModal } from '../confirm-modal';
import { updateMarkTag, removeMarkTag, updateBlockAnchor, removeBlockAnchor, updateSpanAnchor, removeSpanAnchor } from '../../core/annotation-parser';
import { updateNativeAnnotation, removeNativeAnnotation } from '../../core/native-annotation';
import { updateRegionAnnotation, removeRegionAnnotation } from '../../core/region-annotation';
import { encodeFields, applyTemplate } from '../../utils/fields';
import type { MarkVaultPluginInterface } from '../../utils/plugin-interface';

/**
 * 批注编辑 Modal
 * 查看/编辑标注的批注内容、标签、颜色和类型
 */
export class AnnotationModal extends Modal {
  private annotation: Annotation;
  private plugin: MarkVaultPluginInterface;
  private noteValue: string;
  private tagsValue: string;
  private selectedColor: string;
  private selectedType: AnnotationType;
  private fieldsValue: Record<string, string>;
  private flagsValue: AnnotationFlag;
  private groupsValue: string[];
  private motivationValue: AnnotationMotivation | '';
  private aliasValue: string;
  private onSave: (annotation: Annotation) => void;
  private onDelete: (uuid: string) => void;
  private component_: Component;

  constructor(
    app: App,
    plugin: MarkVaultPluginInterface,
    annotation: Annotation,
    onSave: (annotation: Annotation) => void,
    onDelete: (uuid: string) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.annotation = annotation;
    this.noteValue = annotation.note;
    this.tagsValue = annotation.tags.join(', ');
    this.selectedColor = annotation.color;
    this.selectedType = annotation.type;
    this.fieldsValue = annotation.fields ? { ...annotation.fields } : {};
    this.flagsValue = annotation.flags ? { ...annotation.flags } : {};
    this.groupsValue = annotation.groups ? [...annotation.groups] : [];
    this.motivationValue = annotation.motivation || '';
    this.aliasValue = annotation.alias || '';
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.component_ = new Component();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('markvault-modal');

    // 标题
    contentEl.createEl('h2', { text: 'Edit Annotation', cls: 'markvault-modal-title' });

    // 标注原文（只读）— 使用 MarkdownRenderer 渲染，支持 LaTeX/代码块等
    const quoteEl = contentEl.createDiv({ cls: 'markvault-modal-quote' });
    MarkdownRenderer.renderMarkdown(
      this.annotation.text,
      quoteEl,
      this.annotation.filePath,
      this.component_,
    ).catch((err: unknown) => {
      console.error('MarkVault: failed to render annotation quote', err);
      quoteEl.createEl('em', { text: `"${this.annotation.text.substring(0, 200)}${this.annotation.text.length > 200 ? '...' : ''}"` });
    });

    // 检测是否为 mermaid 块，如果是则添加全屏预览按钮
    if (this._containsMermaid(this.annotation.text)) {
      this._attachExpandButton(quoteEl, 'quote');
    }

    // ── v5.3: 图谱别名（Graph Alias） ──
    new Setting(contentEl)
      .setName('🏷️ Graph Alias')
      .setDesc('Short name for this annotation in the relation graph (e.g. "欧拉公式", "费马定理"). Leave empty to hide label.')
      .addText((text: TextComponent) => {
        text.setValue(this.aliasValue)
          .setPlaceholder('e.g. 欧拉公式, Newton\'s 2nd Law...')
          .onChange((value) => {
            this.aliasValue = value.trim();
          });
        text.inputEl.addClass('markvault-modal-alias-input');
      });

    // ── 类型选择 ──
    new Setting(contentEl)
      .setName('Type')
      .setDesc('Annotation display style')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('highlight', 'Highlight')
          .addOption('bold', 'Bold')
          .addOption('underline', 'Underline')
          .setValue(this.selectedType)
          .onChange((value) => {
            this.selectedType = value as AnnotationType;
            this.updatePreview();
          });
      });

    // ── v4.1: Motivation 选择（标注意图） ──
    new Setting(contentEl)
      .setName('Motivation')
      .setDesc('Why you annotated this (W3C Web Annotation)')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (const m of MOTIVATION_OPTIONS) {
          dropdown.addOption(m, MOTIVATION_LABELS[m]);
        }
        dropdown.setValue(this.motivationValue);
        dropdown.onChange((value) => {
          this.motivationValue = value as AnnotationMotivation | '';
        });
      });

    // ── 颜色选择器 ──
    const colorSetting = new Setting(contentEl)
      .setName('Color')
      .setDesc('Choose highlight color');

    const colorPickerContainer = colorSetting.controlEl.createDiv({ cls: 'markvault-modal-color-picker' });

    PRESET_COLORS.forEach((color) => {
      const dot = colorPickerContainer.createEl('button', {
        cls: 'markvault-modal-color-dot',
        attr: {
          'data-color': color.id,
          'title': color.label,
          'style': `background-color: ${color.hex};`,
        },
      });

      if (color.id === this.selectedColor) {
        dot.addClass('active');
      }

      dot.addEventListener('click', () => {
        // 移除其他选中状态
        colorPickerContainer.querySelectorAll('.markvault-modal-color-dot').forEach((el) => {
          el.removeClass('active');
        });
        dot.addClass('active');
        this.selectedColor = color.id;
        this.updatePreview();
      });
    });

    // ── 预览区 ──
    const previewEl = contentEl.createDiv({ cls: 'markvault-modal-preview' });
    this.renderPreview(previewEl);

    // 批注编辑
    new Setting(contentEl)
      .setName('Note')
      .setDesc('Add your annotation note')
      .addTextArea((text: TextAreaComponent) => {
        text.setValue(this.noteValue)
          .onChange((value) => {
            this.noteValue = value;
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addClass('markvault-modal-note-input');
      });

    // 标签编辑
    new Setting(contentEl)
      .setName('Tags')
      .setDesc('Comma-separated tags')
      .addText((text: TextComponent) => {
        text.setValue(this.tagsValue)
          .onChange((value) => {
            this.tagsValue = value;
          });
        text.inputEl.addClass('markvault-modal-tags-input');
      });

    // ── Fields 编辑区 ──
    const fieldsSection = contentEl.createDiv({ cls: 'markvault-modal-fields' });
    fieldsSection.createEl('h3', { text: 'Fields', cls: 'markvault-modal-fields-title' });

    // 字段行容器
    const fieldsListEl = fieldsSection.createDiv({ cls: 'markvault-modal-fields-list' });
    this.renderFieldRows(fieldsListEl);

    // Add Field 按钮
    const addFieldBtn = fieldsSection.createEl('button', {
      text: '+ Add Field',
      cls: 'markvault-modal-add-field-btn',
    });
    addFieldBtn.addEventListener('click', () => {
      const keys = Object.keys(this.fieldsValue);
      const newKey = `field${keys.length + 1}`;
      this.fieldsValue[newKey] = '';
      this.renderFieldRows(fieldsListEl);
    });

    // Apply Template 下拉菜单
    const templates = this.plugin.settings.fieldTemplates;
    if (templates && templates.length > 0) {
      const templateContainer = fieldsSection.createDiv({ cls: 'markvault-modal-template-section' });
      templateContainer.createSpan({ text: 'Apply template: ', cls: 'markvault-modal-template-label' });

      const templateSelect = templateContainer.createEl('select', { cls: 'markvault-modal-template-select' });
      templateSelect.createEl('option', { text: 'Choose template...', value: '' });
      for (const tpl of templates) {
        templateSelect.createEl('option', { text: tpl.name, value: tpl.id });
      }

      templateSelect.addEventListener('change', () => {
        const tplId = templateSelect.value;
        if (!tplId) return;
        const tpl = templates.find(t => t.id === tplId);
        if (tpl) {
          this.fieldsValue = applyTemplate(tpl, this.fieldsValue);
          this.renderFieldRows(fieldsListEl);
          templateSelect.value = ''; // 重置选择
        }
      });
    }

    // ═══════════════════════════════════════════════════════
    // v4.0: 学习状态标记 (Flags)
    // ═══════════════════════════════════════════════════════
    const flagsSection = contentEl.createDiv({ cls: 'markvault-modal-flags' });
    flagsSection.createEl('h3', { text: 'Learning Status', cls: 'markvault-modal-section-title' });

    // 掌握度
    new Setting(flagsSection)
      .setName('Mastery')
      .setDesc('How well you understand this annotation')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (const [value, label] of Object.entries(MASTERY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.flagsValue.mastery || '');
        dropdown.onChange((value) => {
          if (value) {
            this.flagsValue.mastery = value as MasteryLevel;
          } else {
            delete this.flagsValue.mastery;
          }
        });
      });

    // 复习优先级
    new Setting(flagsSection)
      .setName('Review Priority')
      .setDesc('How urgently you need to review this')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (const [value, label] of Object.entries(REVIEW_PRIORITY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.flagsValue.reviewPriority || '');
        dropdown.onChange((value) => {
          if (value) {
            this.flagsValue.reviewPriority = value as ReviewPriority;
          } else {
            delete this.flagsValue.reviewPriority;
          }
        });
      });

    // 信心指数
    new Setting(flagsSection)
      .setName('Confidence')
      .setDesc('Your confidence level (1-5)')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Not set');
        for (let i = 1; i <= 5; i++) {
          dropdown.addOption(String(i), `${i} - ${['Very Low', 'Low', 'Medium', 'High', 'Very High'][i - 1]}`);
        }
        dropdown.setValue(this.flagsValue.confidence ? String(this.flagsValue.confidence) : '');
        dropdown.onChange((value) => {
          if (value) {
            this.flagsValue.confidence = Number(value) as 1 | 2 | 3 | 4 | 5;
          } else {
            delete this.flagsValue.confidence;
          }
        });
      });

    // 纠偏标记
    new Setting(flagsSection)
      .setName('Needs Correction')
      .setDesc('Mark if your understanding may be wrong')
      .addToggle((toggle) => {
        toggle.setValue(this.flagsValue.needsCorrection || false);
        toggle.onChange((value) => {
          this.flagsValue.needsCorrection = value || undefined;
        });
      });

    // ═══════════════════════════════════════════════════════
    // v4.0: 标注分组 (Groups)
    // ═══════════════════════════════════════════════════════
    const groupsSection = contentEl.createDiv({ cls: 'markvault-modal-groups' });
    groupsSection.createEl('h3', { text: 'Groups', cls: 'markvault-modal-section-title' });

    const groupsListEl = groupsSection.createDiv({ cls: 'markvault-modal-groups-list' });
    this.renderGroupTags(groupsListEl);

    // Add Group 按钮
    const addGroupBtn = groupsSection.createEl('button', {
      text: '+ Add Group',
      cls: 'markvault-modal-add-group-btn',
    });
    addGroupBtn.addEventListener('click', () => {
      const existingGroups = getGroupNames();
      const groupName = prompt('Enter group name:\n\nExisting groups: ' + existingGroups.join(', '));
      if (groupName && groupName.trim() && !this.groupsValue.includes(groupName.trim())) {
        this.groupsValue.push(groupName.trim());
        this.renderGroupTags(groupsListEl);
      }
    });

    // ═══════════════════════════════════════════════════════
    // v4.0: 标注间关联 (Relations)
    // ═══════════════════════════════════════════════════════
    const relationsSection = contentEl.createDiv({ cls: 'markvault-modal-relations' });
    relationsSection.createEl('h3', { text: 'Relations', cls: 'markvault-modal-section-title' });

    const relationsListEl = relationsSection.createDiv({ cls: 'markvault-modal-relations-list' });
    this.renderRelations(relationsListEl);

    // Add Relation 按钮
    const addRelBtn = relationsSection.createEl('button', {
      text: '+ Add Relation',
      cls: 'markvault-modal-add-relation-btn',
    });
    addRelBtn.addEventListener('click', () => {
      const engine = this.plugin.getSearchEngine();
      engine.markDirty(); // Ensure index is fresh

      const picker = new RelationPickerModal(
        this.app,
        engine,
        this.plugin.getRelationSchema(),
        this.annotation.uuid,
        this.annotation.filePath,
        (result) => {
          // 立即持久化关联
          // 🔧 BUG-fix: addRelation() 内部已向 store 中的 annotation 对象 push 了 relation
          // this.annotation 与 store 中的对象是同一个引用，无需再手动 push
          addRelation(this.annotation.uuid, {
            targetUuid: result.targetUuid,
            type: result.type,
            createdAt: Date.now(),
            note: result.note,
            source: 'manual',  // v4.2: 来源溯源
          }).then(() => {
            this.renderRelations(relationsListEl);
          }).catch((err) => {
            console.error('MarkVault: failed to add relation', err);
            alert('Failed to add relation: ' + err.message);
          });
        },
      );
      picker.open();
    });

    // 操作按钮
    const buttonBar = contentEl.createDiv({ cls: 'markvault-modal-buttons' });

    const saveBtn = buttonBar.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', async () => {
      await this.save();
      this.close();
    });

    const deleteBtn = buttonBar.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', async () => {
      // 🔧 v5.1: 有关联关系时提示用户，避免误删
      const rels = getRelations(this.annotation.uuid);
      const totalRels = rels.outgoing.length + rels.incoming.length;
      const confirmMsg = totalRels > 0
        ? `Delete this annotation? It has ${totalRels} relation${totalRels > 1 ? 's' : ''} that will also be removed.`
        : 'Delete this annotation?';
      const confirmed = await ConfirmModal.open(this.app, {
        message: confirmMsg,
        title: 'Delete Annotation',
        okText: 'Delete',
        dangerous: true,
      });
      if (confirmed) {
        await this.remove();
        this.close();
      }
    });

    const cancelBtn = buttonBar.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });
  }

  /** 检测文本是否包含 mermaid 代码块 */
  private _containsMermaid(text: string): boolean {
    return /```mermaid\s*[\s\S]*?```/.test(text);
  }

  /**
   * 附加全屏展开按钮到预览/quote 容器
   * @param container - quote 或 preview 容器
   * @param source - 标识来源 ('quote' | 'preview')
   */
  private _attachExpandButton(container: HTMLElement, source: 'quote' | 'preview') {
    // 使用 position:relative 确保按钮定位正确
    container.style.position = 'relative';

    const btn = container.createEl('button', {
      cls: 'markvault-mermaid-expand-btn',
      attr: { title: 'Fullscreen preview (Expand mermaid diagram)', 'aria-label': 'Expand mermaid preview' },
    });
    // SVG 全屏图标 (类似 Obsidian 的展开图标)
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 3 21 3 21 9"></polyline>
      <polyline points="9 21 3 21 3 15"></polyline>
      <line x1="21" y1="3" x2="14" y2="10"></line>
      <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>`;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openMermaidPreview();
    });
  }

  /**
   * Mermaid 全屏预览浮层 — V4 PanZoom 实现
   *
   * 基于三个参考项目的深度研究成果重写:
   *
   * 核心架构 (viewport + canvas 双层):
   *   viewport: overflow:hidden 容器，拦截所有输入事件
   *   canvas:   CSS transform 双重变换 translate(panX, panY) scale(zoom)
   *
   * 关键改进 (vs V3):
   *   1. 动态 transition 管理 — 拖拽/滚轮时禁用，按钮/双击/重置时启用
   *      (参考 obsidian-mermaid-fullscreen: onMouseDown→transition:none, onMouseUp→恢复)
   *   2. requestAnimationFrame 节流 — wheel/mousemove 不再直写 DOM，合并到下一帧
   *   3. 正确的事件监听器生命周期 — mousedown 时注册 document mousemove/mouseup，
   *      mouseup 时注销，而非 V3 的"创建时注册，首次 mouseup 后丢失"Bug
   *   4. 指数缩放 — wheel 使用乘法因子而非加法，更自然 (参考 anvaka/panzoom)
   *   5. fitScale 计算时序 — 双重 rAF + SVG viewBox 回退
   *   6. 完整清理 — close 时移除所有监听器，无内存泄漏
   */
  private _openMermaidPreview() {
    // ── Zoom/Pan 状态 ──
    const state = {
      zoom: 1.0,
      fitScale: 1.0,
      panX: 0,
      panY: 0,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0,
    };
    const ZOOM_FACTOR = 1.08;          // 指数缩放因子 (每次滚轮 ×1.08 或 ÷1.08)
    const ZOOM_STEP = 0.25;            // 工具栏按钮步长 (线性)
    const MAX_ZOOM = 5.0;              // 最高 500%
    const MIN_ZOOM_FACTOR = 0.15;     // 最低 15% (允许在 fitScale 基础上继续缩小)
    const ANIM_DURATION = '0.18s';     // 平滑动画时长 (transition 启用时)
    const ANIM_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'; // 弹性缓动
    const WHEEL_ANIM_RESTORE_MS = 80;  // 滚轮结束后恢复 transition 的延迟

    // rAF 节流追踪
    let rafId = 0;
    // 滚轮 transition 恢复定时器
    let wheelTransTimer: ReturnType<typeof setTimeout> | null = null;
    // 所有需要清理的监听器 (close 时一次性移除)
    const cleanupFns: (() => void)[] = [];

    // ═══════ DOM 结构 ═══════
    const overlay = document.createElement('div');
    overlay.addClass('markvault-mermaid-overlay');

    const modal = overlay.createDiv({ cls: 'markvault-mermaid-modal' });

    // ── 工具栏 ──
    const toolbar = modal.createDiv({ cls: 'markvault-mermaid-toolbar' });
    const leftGroup = toolbar.createDiv({ cls: 'markvault-mermaid-toolbar-left' });
    leftGroup.createSpan({ text: 'Mermaid Diagram Preview', cls: 'markvault-mermaid-title' });

    const zoomGroup = toolbar.createDiv({ cls: 'markvault-mermaid-zoom-group' });

    const zoomOutBtn = zoomGroup.createEl('button', {
      cls: 'markvault-mermaid-zoom-btn',
      attr: { title: 'Zoom out (-)', 'aria-label': 'Zoom out' },
    });
    zoomOutBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

    const zoomLabel = zoomGroup.createSpan({ text: 'Fit', cls: 'markvault-mermaid-zoom-label' });

    const zoomInBtn = zoomGroup.createEl('button', {
      cls: 'markvault-mermaid-zoom-btn',
      attr: { title: 'Zoom in (+)', 'aria-label': 'Zoom in' },
    });
    zoomInBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

    const resetBtn = zoomGroup.createEl('button', {
      cls: 'markvault-mermaid-zoom-btn markvault-mermaid-zoom-reset',
      attr: { title: 'Reset to fit (Ctrl+0)', 'aria-label': 'Reset zoom' },
    });
    resetBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`;

    const rightGroup = toolbar.createDiv({ cls: 'markvault-mermaid-toolbar-right' });
    const closeBtn = rightGroup.createEl('button', {
      cls: 'markvault-mermaid-close-btn',
      attr: { title: 'Close (Esc)', 'aria-label': 'Close preview' },
    });
    closeBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

    // ── 视口 + 变换层 ──
    const viewport = modal.createDiv({ cls: 'markvault-mermaid-viewport' });
    const canvas = viewport.createDiv({ cls: 'markvault-mermaid-canvas' });

    // ═══════ Markdown 渲染 + fitScale 计算 ═══════
    const previewComponent = new Component();
    MarkdownRenderer.renderMarkdown(
      this.annotation.text, canvas, this.annotation.filePath, previewComponent,
    ).then(() => {
      // 双重 rAF 确保浏览器完成布局后再测量
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          computeFitScale();
          panzoomSetFit();
        });
      });
    }).catch((err: unknown) => {
      console.error('MarkVault: mermaid preview render failed', err);
      canvas.createEl('pre', { text: this.annotation.text, cls: 'markvault-mermaid-fallback' });
    });

    /** 计算 fitScale — 使用 SVG 尺寸，优先 viewBox，回退 getBoundingClientRect */
    function computeFitScale() {
      const svg = canvas.querySelector('svg');
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      if (!svg || vw <= 0 || vh <= 0) { state.fitScale = 1.0; return; }

      // 优先从 viewBox 获取 SVG 原始尺寸 (更准确，不受 CSS 影响)
      const viewBox = svg.getAttribute('viewBox');
      let svgW: number, svgH: number;
      if (viewBox) {
        const parts = viewBox.split(/[\s,]+/).map(Number);
        svgW = parts[2] || 0;
        svgH = parts[3] || 0;
      } else {
        // 回退: getBoundingClientRect (可能受 max-width 等影响)
        const rect = svg.getBoundingClientRect();
        svgW = rect.width;
        svgH = rect.height;
      }

      if (svgW <= 0 || svgH <= 0) { state.fitScale = 1.0; return; }

      // 适配到视口内，留 padding
      const padW = 40, padH = 32; // 20px 左右 + 16px 上下 padding
      const scaleW = (vw - padW) / svgW;
      const scaleH = (vh - padH) / svgH;
      state.fitScale = Math.min(1.0, scaleW, scaleH);
    }

    // ═══════ PanZoom 核心 ═══════

    /** 将当前 state 写入 canvas.style.transform (无 transition) */
    const applyTransform = () => {
      canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    };

    /** 启用 canvas 的 CSS transition (用于按钮/双击/重置的平滑动画) */
    const enableTransition = () => {
      canvas.style.transition = `transform ${ANIM_DURATION} ${ANIM_EASE}`;
    };

    /** 禁用 canvas 的 CSS transition (用于拖拽/滚轮，防止延迟) */
    const disableTransition = () => {
      canvas.style.transition = 'none';
    };

    /** 更新缩放百分比标签 */
    const updateZoomLabel = () => {
      zoomLabel.setText(`${Math.round(state.zoom * 100)}%`);
    };

    /**
     * 光标中心缩放 — 核心算法
     * 参考 mermaid-view-enhancer:
     *   currentPoint = (cursor - pan) / zoom   // 光标在 canvas 坐标系中的位置
     *   pan' = cursor - currentPoint × zoom'   // 缩放后保持光标位置不变
     */
    const zoomAt = (newZoom: number, cx: number, cy: number) => {
      const minZoom = Math.min(MIN_ZOOM_FACTOR, state.fitScale);
      const clamped = Math.max(minZoom, Math.min(MAX_ZOOM, newZoom));
      if (clamped === state.zoom) return;
      const ptX = (cx - state.panX) / state.zoom;
      const ptY = (cy - state.panY) / state.zoom;
      state.zoom = clamped;
      state.panX = cx - ptX * clamped;
      state.panY = cy - ptY * clamped;
      applyTransform();
      updateZoomLabel();
    };

    /** 适配到容器 (fit-to-width) — 带 transition 平滑动画 */
    const panzoomSetFit = () => {
      enableTransition();
      state.zoom = state.fitScale;
      state.panX = 0;
      state.panY = 0;
      applyTransform();
      updateZoomLabel();
      // 动画结束后关闭 transition (防止后续拖拽/滚轮受影响)
      setTimeout(disableTransition, 180);
    };

    // ═══════ 事件: 鼠标滚轮 (指数缩放 + rAF 节流) ═══════

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 拖拽中忽略滚轮 (防冲突)
      if (state.isDragging) return;

      // 禁用 transition → 立即响应，无延迟
      disableTransition();
      // 清除之前的恢复定时器 (连续滚轮时保持 transition:none)
      if (wheelTransTimer !== null) {
        clearTimeout(wheelTransTimer);
        wheelTransTimer = null;
      }

      // rAF 节流: 如果已有待处理帧，跳过本次
      if (rafId) return;

      rafId = requestAnimationFrame(() => {
        rafId = 0;

        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        // 指数缩放: deltaY > 0 → 放大, < 0 → 缩小
        // 乘法因子比加法更自然 (参考 anvaka/panzoom)
        const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
        zoomAt(state.zoom * factor, cx, cy);
      });

      // 滚轮停止后恢复 transition (用于后续按钮操作)
      wheelTransTimer = setTimeout(() => {
        wheelTransTimer = null;
      }, WHEEL_ANIM_RESTORE_MS);
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    cleanupFns.push(() => viewport.removeEventListener('wheel', onWheel));

    // ═══════ 事件: 鼠标拖拽 (mousedown→document mousemove/mouseup) ═══════

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // 只响应左键
      e.preventDefault();

      state.isDragging = true;
      state.dragStartX = e.clientX - state.panX;
      state.dragStartY = e.clientY - state.panY;

      // 拖拽时禁用 transition → 消除 rubber-band 延迟感
      disableTransition();

      viewport.addClass('markvault-mermaid-grabbing');

      // 拖拽期间在 document 上监听 (确保鼠标移出视口也能继续拖拽)
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!state.isDragging) return;

      // rAF 节流
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        state.panX = e.clientX - state.dragStartX;
        state.panY = e.clientY - state.dragStartY;
        applyTransform();
      });
    };

    const onMouseUp = () => {
      if (!state.isDragging) return;
      state.isDragging = false;
      viewport.removeClass('markvault-mermaid-grabbing');

      // 拖拽结束 → 移除 document 监听器 (不再需要，下次 mousedown 再注册)
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    viewport.addEventListener('mousedown', onMouseDown);
    cleanupFns.push(() => viewport.removeEventListener('mousedown', onMouseDown));
    // 注意: mousemove/mouseup 在 mousedown 时才注册，mouseup 时注销
    // close 时也需安全移除 (以防拖拽中被关闭)
    cleanupFns.push(() => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    });

    // ═══════ 事件: 双击 (fit ↔ 100% 切换) ═══════

    viewport.addEventListener('dblclick', (e: MouseEvent) => {
      e.preventDefault();
      // 双击需要平滑动画 → 启用 transition
      enableTransition();
      if (state.zoom > state.fitScale * 1.05) {
        // 当前已放大 → 回到 fit
        panzoomSetFit();
      } else {
        // 当前是 fit → 跳到 100%，光标位置居中
        const rect = viewport.getBoundingClientRect();
        zoomAt(1.0, e.clientX - rect.left, e.clientY - rect.top);
        // 动画结束后关闭 transition
        setTimeout(disableTransition, 180);
      }
    });

    // ═══════ 事件: 触摸 (pinch zoom + single finger drag) ═══════
    // 参考 mermaid-view-enhancer 的触摸实现

    let lastTouchDist = 0;
    let touchRafId = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        // 双指: pinch zoom
        const [t1, t2] = [e.touches[0], e.touches[1]];
        lastTouchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        disableTransition();
      } else if (e.touches.length === 1) {
        // 单指: 拖拽
        state.isDragging = true;
        state.dragStartX = e.touches[0].clientX - state.panX;
        state.dragStartY = e.touches[0].clientY - state.panY;
        disableTransition();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault(); // 阻止页面滚动

      if (e.touches.length === 2) {
        // Pinch zoom + rAF 节流
        if (touchRafId) return;
        touchRafId = requestAnimationFrame(() => {
          touchRafId = 0;
          const [t1, t2] = [e.touches[0], e.touches[1]];
          const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
          if (lastTouchDist > 0) {
            const rect = viewport.getBoundingClientRect();
            const cx = (t1.clientX + t2.clientX) / 2 - rect.left;
            const cy = (t1.clientY + t2.clientY) / 2 - rect.top;
            zoomAt(state.zoom * (dist / lastTouchDist), cx, cy);
          }
          lastTouchDist = dist;
        });
      } else if (e.touches.length === 1 && state.isDragging) {
        // 单指拖拽 + rAF 节流
        if (touchRafId) return;
        touchRafId = requestAnimationFrame(() => {
          touchRafId = 0;
          state.panX = e.touches[0].clientX - state.dragStartX;
          state.panY = e.touches[0].clientY - state.dragStartY;
          applyTransform();
        });
      }
    };

    const onTouchEnd = () => {
      state.isDragging = false;
      lastTouchDist = 0;
      if (touchRafId) { cancelAnimationFrame(touchRafId); touchRafId = 0; }
    };

    viewport.addEventListener('touchstart', onTouchStart, { passive: false });
    viewport.addEventListener('touchmove', onTouchMove, { passive: false });
    viewport.addEventListener('touchend', onTouchEnd);
    cleanupFns.push(() => {
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
    });

    // ═══════ 工具栏按钮 (带 transition 平滑动画) ═══════

    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enableTransition();
      const rect = viewport.getBoundingClientRect();
      zoomAt(state.zoom + ZOOM_STEP, rect.width / 2, rect.height / 2);
      setTimeout(disableTransition, 180);
    });

    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enableTransition();
      const rect = viewport.getBoundingClientRect();
      zoomAt(state.zoom - ZOOM_STEP, rect.width / 2, rect.height / 2);
      setTimeout(disableTransition, 180);
    });

    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panzoomSetFit();
    });

    // ═══════ 键盘快捷键 ═══════

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); panzoomSetFit(); return; }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        enableTransition();
        const rect = viewport.getBoundingClientRect();
        zoomAt(state.zoom + ZOOM_STEP, rect.width / 2, rect.height / 2);
        setTimeout(disableTransition, 180);
        return;
      }
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        enableTransition();
        const rect = viewport.getBoundingClientRect();
        zoomAt(state.zoom - ZOOM_STEP, rect.width / 2, rect.height / 2);
        setTimeout(disableTransition, 180);
        return;
      }
    };
    document.addEventListener('keydown', keyHandler);
    cleanupFns.push(() => document.removeEventListener('keydown', keyHandler));

    // ═══════ 关闭 ═══════

    const close = () => {
      // 取消所有待处理的 rAF
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (touchRafId) { cancelAnimationFrame(touchRafId); touchRafId = 0; }
      // 清除定时器
      if (wheelTransTimer !== null) { clearTimeout(wheelTransTimer); wheelTransTimer = null; }
      // 移除所有监听器 (一次性清理)
      for (const fn of cleanupFns) fn();
      cleanupFns.length = 0;
      // 卸载渲染组件
      previewComponent.unload();
      // 关闭动画
      overlay.addClass('markvault-mermaid-overlay-closing');
      setTimeout(() => overlay.remove(), 200);
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // ═══════ 挂载到 DOM ═══════
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.addClass('markvault-mermaid-overlay-visible'));
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.component_.unload();
  }

  /** 更新预览样式 */
  private updatePreview() {
    const previewEl = this.contentEl.querySelector('.markvault-modal-preview') as HTMLElement;
    if (previewEl) {
      previewEl.empty();
      this.renderPreview(previewEl);
    }
  }

  /** 渲染预览 — 使用 MarkdownRenderer 支持 LaTeX/代码块 */
  private renderPreview(container: HTMLElement) {
    container.empty();

    container.createSpan({
      text: 'Preview: ',
      cls: 'markvault-modal-preview-label',
    });

    const previewContent = container.createDiv({ cls: 'markvault-modal-preview-content' });

    // 使用 MarkdownRenderer 渲染预览内容
    MarkdownRenderer.renderMarkdown(
      this.annotation.text,
      previewContent,
      this.annotation.filePath,
      this.component_,
    ).catch((err: unknown) => {
      console.error('MarkVault: failed to render preview', err);
      previewContent.createEl('span', {
        text: this.annotation.text.substring(0, 60) + (this.annotation.text.length > 60 ? '...' : ''),
      });
    });

    // 检测 mermaid 块并附加全屏预览按钮
    if (this._containsMermaid(this.annotation.text)) {
      this._attachExpandButton(container, 'preview');
    }

    // 应用当前选择的样式到预览容器
    const preset = PRESET_COLORS.find(c => c.id === this.selectedColor);
    const hex = preset ? preset.hex : this.selectedColor;

    previewContent.style.transition = 'all 0.2s ease';
    switch (this.selectedType) {
      case 'highlight':
        previewContent.style.backgroundColor = `${hex}33`;
        previewContent.style.borderRadius = '4px';
        previewContent.style.padding = '4px 8px';
        break;
      case 'bold':
        previewContent.style.fontWeight = 'bold';
        previewContent.style.borderBottom = `2px solid ${hex}`;
        previewContent.style.padding = '4px 8px';
        break;
      case 'underline':
        previewContent.style.textDecoration = 'underline';
        previewContent.style.textDecorationColor = hex;
        previewContent.style.textUnderlineOffset = '2px';
        break;
    }
  }

  /** 渲染 Fields 编辑行 */
  private renderFieldRows(container: HTMLElement) {
    container.empty();
    const entries = Object.entries(this.fieldsValue);

    for (const [key, value] of entries) {
      const row = container.createDiv({ cls: 'markvault-modal-field-row' });

      const keyInput = row.createEl('input', {
        type: 'text',
        value: key,
        cls: 'markvault-modal-field-key',
        attr: { placeholder: 'Key' },
      });

      const valueInput = row.createEl('input', {
        type: 'text',
        value: value,
        cls: 'markvault-modal-field-value',
        attr: { placeholder: 'Value' },
      });

      const deleteBtn = row.createEl('button', {
        text: '✕',
        cls: 'markvault-modal-field-delete',
      });

      // 事件处理：实时更新 fieldsValue
      keyInput.addEventListener('input', () => {
        const oldKey = key;
        const newKey = keyInput.value;
        if (oldKey !== newKey) {
          delete this.fieldsValue[oldKey];
          this.fieldsValue[newKey] = valueInput.value;
        }
      });

      valueInput.addEventListener('input', () => {
        this.fieldsValue[keyInput.value] = valueInput.value;
        // 软限制：超长字段值警告
        if (valueInput.value.length > 1000) {
          valueInput.style.borderColor = 'var(--text-error, #e74c3c)';
          valueInput.title = '字段值过长，可能影响 Markdown 文件可读性';
        } else {
          valueInput.style.borderColor = '';
          valueInput.title = '';
        }
      });

      deleteBtn.addEventListener('click', () => {
        delete this.fieldsValue[keyInput.value];
        this.renderFieldRows(container);
      });
    }
  }

  /** 渲染 Group 标签 */
  private renderGroupTags(container: HTMLElement) {
    container.empty();

    for (const group of this.groupsValue) {
      const tag = container.createDiv({ cls: 'markvault-modal-group-tag' });
      tag.createSpan({ text: group, cls: 'markvault-modal-group-name' });
      const removeBtn = tag.createEl('button', {
        text: '✕',
        cls: 'markvault-modal-group-remove',
      });
      removeBtn.addEventListener('click', () => {
        this.groupsValue = this.groupsValue.filter(g => g !== group);
        this.renderGroupTags(container);
      });
    }
  }

  /** 渲染 Relations 列表 */
  private renderRelations(container: HTMLElement) {
    container.empty();

    const relations = this.annotation.relations || [];

    if (relations.length === 0) {
      container.createSpan({ text: 'No relations yet', cls: 'markvault-modal-relations-empty' });
      return;
    }

    // v4.2: 有效关系在前，已失效关系在后（灰色显示）
    const activeRels = relations.filter(r => !r.invalidAt);
    const invalidatedRels = relations.filter(r => r.invalidAt);

    for (const rel of activeRels) {
      this._renderRelationRow(container, rel, false);
    }

    for (const rel of invalidatedRels) {
      this._renderRelationRow(container, rel, true);
    }
  }

  /** 渲染单个 relation 行 */
  private _renderRelationRow(container: HTMLElement, rel: AnnotationRelation, isInvalidated: boolean) {
    const row = container.createDiv({
      cls: isInvalidated ? 'markvault-modal-relation-row markvault-relation-invalidated' : 'markvault-modal-relation-row',
    });

    // v5.12: 关系类型标签 — dot 色块 + 文字
    const typeLabel = this.plugin.getRelationSchema().getLabel(rel.type);
    const typeColor = this.plugin.getRelationSchema().getConfig(rel.type)?.color || '#78716C';
    const typeSpan = row.createSpan({ cls: 'markvault-modal-relation-type' });
    typeSpan.createSpan({
      cls: 'markvault-modal-relation-dot',
      attr: { style: `background: ${typeColor}` },
    });
    typeSpan.createSpan({ text: typeLabel });

    // 目标 UUID（截断显示）
    const shortUuid = rel.targetUuid.length > 8
      ? rel.targetUuid.substring(0, 8) + '...'
      : rel.targetUuid;
    row.createSpan({
      text: shortUuid,
      cls: 'markvault-modal-relation-target',
      attr: { title: rel.targetUuid },
    });

    // v4.2: 来源标签
    if (rel.source) {
      const sourceLabel = RELATION_SOURCE_LABELS[rel.source] || rel.source;
      row.createSpan({ text: sourceLabel, cls: 'markvault-modal-relation-source' });
    }

    if (isInvalidated) {
      // 已失效 — 显示失效时间和恢复按钮
      const invalidDate = rel.invalidAt ? new Date(rel.invalidAt).toLocaleDateString() : '?';
      row.createSpan({ text: `(已失效 ${invalidDate})`, cls: 'markvault-relation-invalidated-hint' });

      // 恢复按钮
      const restoreBtn = row.createEl('button', { text: '↺', cls: 'markvault-modal-relation-restore' });
      restoreBtn.title = '恢复此关系（双向级联）';
      restoreBtn.addEventListener('click', async () => {
        try {
          // v4.2 P1: 使用 restoreRelation（双向级联清除 invalidAt）
          await restoreRelation(this.annotation.uuid, rel.targetUuid, rel.type);
          this.renderRelations(container);
        } catch (err) {
          console.error('MarkVault: failed to restore relation', err);
        }
      });
    } else {
      // 有效关系 — 删除按钮（改为软删除/失效）
      const removeBtn = row.createEl('button', {
        text: '✕',
        cls: 'markvault-modal-relation-remove',
      });
      removeBtn.addEventListener('click', async () => {
        try {
          // v4.2: 默认使用软删除（invalidateRelation），保留历史可回溯
          await invalidateRelation(this.annotation.uuid, rel.targetUuid, rel.type);
          this.renderRelations(container);
        } catch (err) {
          console.error('MarkVault: failed to invalidate relation', err);
        }
      });
    }
  }

  private async save() {
    const tags = this.tagsValue
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const updates: Partial<Annotation> = {
      note: this.noteValue,
      tags,
    };

    // 如果颜色或类型发生变化，也一并更新
    if (this.selectedColor !== this.annotation.color) {
      updates.color = this.selectedColor;
    }
    if (this.selectedType !== this.annotation.type) {
      updates.type = this.selectedType;
    }

    // 🆕 Phase 3: 收集 fields（过滤空键） + v4.1: u: 前缀规范化
    const filteredFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.fieldsValue)) {
      if (k.trim()) {
        // 用户自定义字段自动添加 u: 前缀（排除以 _ 开头的系统字段和已有 u: 前缀的）
        const normalizedKey = normalizeUserFieldKey(k.trim());
        filteredFields[normalizedKey] = v;
      }
    }
    if (Object.keys(filteredFields).length > 0 || this.annotation.fields) {
      updates.fields = filteredFields;
    }

    // v4.0: 收集 groups
    if (this.groupsValue.length > 0 || this.annotation.groups) {
      updates.groups = this.groupsValue;
    }

    // v4.1: 收集 motivation
    // 如果用户手动选择了 motivation，使用用户选择；否则根据当前 note/flags 重新推断
    if (this.motivationValue) {
      updates.motivation = this.motivationValue;
    } else {
      // 用户清空了 motivation → 根据当前 note 内容重新推断
      updates.motivation = inferMotivation({
        note: updates.note ?? this.annotation.note,
        needsCorrection: updates.flags?.needsCorrection ?? this.annotation.flags?.needsCorrection,
        kind: this.annotation.kind,
      });
    }

    // v5.3: 收集图谱别名（带校验）
    // 🔧 F1 审计修复：先 trim + replace（移除危险字符），再 slice（截断长度）
    // 这样 replace 移除 < > 后的字符串长度才是最终长度，不会出现截断后再替换导致长度不一致
    // 🔧 F5 审计修复：DB 和 MD 的 alias 语义分离
    // - DB: undefined = "删除 alias 字段", "" = "alias 为空字符串"（语义错误）
    // - MD: "" = "删除 data-alias 属性 / 写 _ 占位", undefined = "不更新"
    // 所以：DB 用 rawAlias || undefined，MD 用 rawAlias || ""
    let aliasForMD: string | undefined; // 传给 updateMarkTag/updateBlockAnchor/updateSpanAnchor
    {
      const rawAlias = this.aliasValue.trim().replace(/[<>]/g, '').slice(0, 50);
      if (rawAlias.length > 0 || this.annotation.alias) {
        updates.alias = rawAlias || undefined; // DB: undefined 表示删除
        aliasForMD = rawAlias; // MD: "" 表示删除 data-alias/写 _ 占位
      }
    }

    console.log(`MarkVault modal: saving annotation ${this.annotation.uuid}`, updates);

    // 🔧 P0 修复：捕获原始值用于 MD 失败时回滚
    const originalNote = this.annotation.note;
    const originalTags = [...this.annotation.tags];
    const originalColor = this.annotation.color;
    const originalType = this.annotation.type;
    const originalFields = this.annotation.fields ? { ...this.annotation.fields } : undefined;
    const originalAlias = this.annotation.alias; // v5.3

    // ① 更新 AnnotationStore（先写 Store，再写 Markdown）
    await updateAnnotation(this.annotation.uuid, updates);

    // v4.0: 更新 Flags（独立 API，不在 updates 中，因为 merge 逻辑需要特殊处理）
    const hasFlags = Object.keys(this.flagsValue).length > 0;
    if (hasFlags) {
      await updateFlags(this.annotation.uuid, this.flagsValue);
    }

    // ② 更新 Markdown — 设置防重入标志，阻止 onFileOpen() 在此期间触发 syncFromMarkdown()
    const file = this.app.vault.getAbstractFileByPath(this.annotation.filePath);
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      console.log(`MarkVault modal: read file ${file.path}, length=${content.length}`);

      let newContent = content;

      if (this.annotation.kind === 'span') {
        // Span 标注：更新 %%markvault-span:...%% 锚点
        newContent = updateSpanAnchor(content, this.annotation.uuid, {
          note: this.noteValue,
          color: updates.color,
          type: updates.type,
          alias: aliasForMD, // F5: "" 表示删除锚点 alias 段
        });
      } else if (this.annotation.kind === 'block') {
        // 块级标注：更新 %%markvault:...%% 锚点
        newContent = updateBlockAnchor(content, this.annotation.uuid, {
          note: this.noteValue,
          color: updates.color,
          type: updates.type,
          alias: aliasForMD, // F5: "" 表示删除锚点 alias 段
        });
      } else if (this.annotation.kind === 'region') {
        // 区域标注：双锚点包围
        // alias 仅存 DB（region 锚点格式不含 alias 段），不写入 Markdown
        newContent = updateRegionAnnotation(content, this.annotation.uuid, {
          color: updates.color,
          type: updates.type,
          note: this.noteValue,
        }) ?? content;
      } else if (this.annotation.format === 'native') {
        // 自然语法标注：隐身锚点 + 原生 Markdown 包裹
        // note/tags/fields/alias 只存在 Store 中，锚点只保存 uuid/type/color
        newContent = updateNativeAnnotation(content, this.annotation.uuid, {
          color: updates.color,
          type: updates.type,
        }) ?? content;
      } else {
        // 行内标注：更新 <mark> 标签
        newContent = updateMarkTag(content, this.annotation.uuid, {
          note: this.noteValue,
          tags,
          color: updates.color,
          type: updates.type,
          fields: Object.keys(filteredFields).length > 0 ? encodeFields(filteredFields) : '',
          alias: aliasForMD, // F5: "" 表示删除 data-alias 属性
        });
      }

      // 验证内容确实发生了变化
      if (newContent !== content) {
        this.plugin.modifyGuard.acquire(this.annotation.filePath);
        try {
          // 🔧 B-2 修复：使用 vault.process 原子读写，try-finally 保证 modifyGuard 释放
          // vault.process 保证：回调抛错 → MD 不变；回调成功 → MD 已更新
          await this.app.vault.process(file, () => newContent);
          console.log(`MarkVault modal: updated markdown for ${this.annotation.uuid}`);
        } catch (processErr) {
          console.error(`MarkVault modal: MD update failed for ${this.annotation.uuid}`, processErr);
          throw processErr;
        } finally {
          this.plugin.modifyGuard.release(this.annotation.filePath);
        }
      } else {
        // 🔧 非异常：block/span/region/native 锚点格式不存 tags/fields/groups 等认知字段，
        // 仅 Store 更新即可。仅当 note/color/type/alias 均未变化时才可能是异常。
        const mdFields = ['note', 'color', 'type', 'alias'] as const;
        const mdFieldsChanged = mdFields.some(f => updates[f as keyof typeof updates] !== undefined);
        if (mdFieldsChanged) {
          // 传入了会写 MD 的字段但 MD 没变，可能是锚点格式不匹配
          console.warn(`MarkVault modal: markdown content unchanged for ${this.annotation.uuid}`);
        } else {
          console.log(`MarkVault modal: store-only update for ${this.annotation.uuid} (tags/fields/groups)`);
        }
      }
    }

    // ③ 更新内存中的 annotation
    this.annotation.note = this.noteValue;
    this.annotation.tags = tags;
    if (updates.color) this.annotation.color = updates.color;
    if (updates.type) this.annotation.type = updates.type;
    if (updates.fields !== undefined) this.annotation.fields = updates.fields;
    if (updates.groups !== undefined) this.annotation.groups = updates.groups;
    if (hasFlags) this.annotation.flags = { ...this.flagsValue };
    if (updates.alias !== undefined) this.annotation.alias = updates.alias;

    // 🔧 P1 修复：标记文件已同步，避免 onFileOpen 触发无意义的全量 sync
    this.plugin.markFileSynced(this.annotation.filePath);
    // 🔧 P1 修复：更新 span 缓存，确保 CM6 装饰立即反映最新修改
    try {
      await this.plugin.updateSpanCache(this.annotation.filePath);
      await this.plugin.updateRegionCache(this.annotation.filePath);
    } catch (err) {
      console.error('MarkVault modal: updateSpanCache error', err);
    }

    this.onSave(this.annotation);
  }

  private async remove() {
    // 🔧 P0 修复：保存原始数据用于 MD 失败时回滚（深拷贝确保不丢失可选字段）
    const backup: Annotation = JSON.parse(JSON.stringify(this.annotation));

    // ① 从 AnnotationStore 删除
    await deleteAnnotation(this.annotation.uuid);

    // ② 从 Markdown 移除标注（使用 vault.process 原子读写）
    const file = this.app.vault.getAbstractFileByPath(this.annotation.filePath);
    if (file instanceof TFile) {
      this.plugin.modifyGuard.acquire(this.annotation.filePath);
      try {
        await this.app.vault.process(file, (content) => {
          if (this.annotation.kind === 'span') {
            return removeSpanAnchor(content, this.annotation.uuid);
          }
          if (this.annotation.kind === 'block') {
            return removeBlockAnchor(content, this.annotation.uuid);
          }
          if (this.annotation.kind === 'region') {
            return removeRegionAnnotation(content, this.annotation.uuid) ?? content;
          }
          if (this.annotation.format === 'native') {
            return removeNativeAnnotation(content, this.annotation.uuid) ?? content;
          }
          const result = removeMarkTag(content, this.annotation.uuid);
          return result ? result.content : content;
        });
        console.log(`MarkVault modal: removed annotation ${this.annotation.uuid} from markdown`);
      } catch (processErr) {
        // 🔧 P0 修复：MD 写入失败，回滚 DB（重新添加标注）
        console.error(`MarkVault modal: MD removal failed, rolling back DB for ${this.annotation.uuid}`, processErr);
        await addAnnotation(backup);
        throw processErr; // 传播错误，阻止 onDelete 回调
      } finally {
        this.plugin.modifyGuard.release(this.annotation.filePath);
      }
    }

    // 🔧 P1 修复：标记文件已同步
    this.plugin.markFileSynced(this.annotation.filePath);
    // 🔧 P1 修复：更新 span 缓存
    try {
      await this.plugin.updateSpanCache(this.annotation.filePath);
    } catch (err) {
      console.error('MarkVault modal: remove updateSpanCache error', err);
    }

    this.onDelete(this.annotation.uuid);
    // 🔧 UX 修复：删除成功后关闭 Modal
    this.close();
  }
}
