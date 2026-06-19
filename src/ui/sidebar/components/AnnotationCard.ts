import { App, Component, Menu, TFile, MarkdownRenderer, MarkdownView } from 'obsidian';
import type { Annotation, AnnotationRelation, PDFSelector } from '../../../types/annotation';
import { PRESET_COLORS, MASTERY_LABELS, REVIEW_PRIORITY_LABELS, MOTIVATION_LABELS } from '../../../types/annotation';
import type { MarkVaultPluginInterface } from '../../../utils/plugin-interface';
import { updateSpanAnchor, updateBlockAnchor, updateMarkTag } from '../../../core/annotation-parser';
import { updateNativeAnnotation } from '../../../core/native-annotation';
import { updateRegionAnnotation } from '../../../core/region-annotation';
import { updateAnnotation, getRelations, getAnnotationByUuid } from '../../../db/annotation-repo';

/**
 * AnnotationCard —— 单个标注卡片
 *
 * 负责渲染标注卡片、字段标签、快速改色、操作按钮。
 */
export interface AnnotationCardHost {
  app: App;
  isBatchMode(): boolean;
  selectedUuids: Set<string>;
  fieldFilterEntries: Array<{ key: string; value: string }>;
  getBatchCountElement(): HTMLElement | null;
  getMarkdownComponent(): Component | null;
  getPluginInstance(): MarkVaultPluginInterface | null;
  formatRelativeTime(date: Date): string;
  onEdit(annotation: Annotation): void;
  onJump(annotation: Annotation): void;
  onDelete(annotation: Annotation): Promise<void>;
  refreshListOnly(): Promise<void>;
}

export class AnnotationCard {
  constructor(private host: AnnotationCardHost) {}

  render(container: HTMLElement, annotation: Annotation, showFilePath: boolean): void {
    const card = container.createDiv({ cls: 'markvault-card' });

    // 批量模式 checkbox
    if (this.host.isBatchMode()) {
      const checkbox = card.createEl('input', {
        type: 'checkbox',
        cls: 'markvault-card-checkbox',
      });
      checkbox.dataset.uuid = annotation.uuid;
      if (this.host.selectedUuids.has(annotation.uuid)) {
        checkbox.checked = true;
      }
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.host.selectedUuids.add(annotation.uuid);
        } else {
          this.host.selectedUuids.delete(annotation.uuid);
        }
        const countEl = this.host.getBatchCountElement();
        if (countEl) {
          countEl.textContent = `${this.host.selectedUuids.size} selected`;
        }
      });
    }

    // 卡片头部
    const header = card.createDiv({ cls: 'markvault-card-header' });

    const preset = PRESET_COLORS.find(c => c.id === annotation.color);
    const colorHex = preset ? preset.hex : annotation.color;

    const colorDot = header.createDiv({ cls: 'markvault-card-color-dot' });
    colorDot.style.backgroundColor = colorHex;

    const typeLabel = header.createDiv({ cls: 'markvault-card-type' });
    typeLabel.textContent = annotation.type;

    if (showFilePath) {
      const fileLabel = header.createDiv({ cls: 'markvault-card-file' });
      const fileName = annotation.filePath.split('/').pop()?.replace(/\.(md|pdf)$/, '') || annotation.filePath;
      const isPdf = annotation.docType === 'pdf' || annotation.filePath.endsWith('.pdf');
      fileLabel.textContent = isPdf ? `📕 ${fileName}` : `📄 ${fileName}`;
      fileLabel.title = annotation.filePath;
    } else if (annotation.docType === 'pdf') {
      // PDF 标注显示页码而非行号
      const selector = annotation.selector as PDFSelector | undefined;
      const page = selector?.page ?? 0;
      const pageLabel = header.createDiv({ cls: 'markvault-card-line' });
      pageLabel.textContent = `Page ${page + 1}`;
    } else {
      const lineLabel = header.createDiv({ cls: 'markvault-card-line' });
      lineLabel.textContent = `Line ${annotation.startLine + 1}`;
    }

    // 操作按钮区
    const actionsHeader = header.createDiv({ cls: 'markvault-card-header-actions' });

    // 快速改色按钮
    const colorBtn = actionsHeader.createEl('button', {
      cls: 'markvault-card-quick-color',
      text: '🎨',
    });
    colorBtn.title = 'Change color';
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showQuickColorMenu(colorBtn, annotation);
    });

    // 标注原文
    const textEl = card.createDiv({ cls: 'markvault-card-text' });
    const displayText = annotation.text || (annotation.docType === 'pdf' ? '_(empty — click edit to add text)_' : annotation.text);
    const component = this.host.getMarkdownComponent();
    if (component) {
      MarkdownRenderer.renderMarkdown(
        displayText,
        textEl,
        annotation.filePath,
        component,
      ).catch((err: unknown) => {
        console.error('MarkVault: failed to render annotation text', err);
        textEl.textContent = displayText;
      });
    } else {
      textEl.textContent = displayText;
    }

    // 批注内容
    if (annotation.note) {
      const noteEl = card.createDiv({ cls: 'markvault-card-note' });
      noteEl.textContent = annotation.note;
    }

    // 标签
    if (annotation.tags.length > 0) {
      const tagsEl = card.createDiv({ cls: 'markvault-card-tags' });
      for (const tag of annotation.tags) {
        tagsEl.createSpan({ cls: 'markvault-tag', text: `#${tag}` });
      }
    }

    // Phase 3: Fields 展示
    if (annotation.fields && Object.keys(annotation.fields).length > 0) {
      const fieldsEl = card.createDiv({ cls: 'markvault-card-fields' });
      const entries = Object.entries(annotation.fields);
      const showCount = Math.min(entries.length, 3);

      for (let i = 0; i < showCount; i++) {
        const [k, v] = entries[i];
        const fieldTag = fieldsEl.createSpan({ cls: 'markvault-field-tag' });
        fieldTag.createSpan({ text: k, cls: 'markvault-field-tag-key' });
        fieldTag.createSpan({ text: ':', cls: 'markvault-field-tag-sep' });
        fieldTag.createSpan({ text: v, cls: 'markvault-field-tag-value' });

        fieldTag.addEventListener('click', (e) => {
          e.stopPropagation();
          const exists = this.host.fieldFilterEntries.some(fe => fe.key === k && fe.value === v);
          if (!exists) {
            this.host.fieldFilterEntries.push({ key: k, value: v });
            this.host.refreshListOnly();
          }
        });
      }

      if (entries.length > 3) {
        const moreEl = fieldsEl.createSpan({
          cls: 'markvault-field-more',
          text: `${entries.length - 3} more...`,
        });
        let expanded = false;
        moreEl.addEventListener('click', (e) => {
          e.stopPropagation();
          expanded = !expanded;
          if (expanded) {
            for (let i = 3; i < entries.length; i++) {
              const [k, v] = entries[i];
              const fieldTag = fieldsEl.createSpan({ cls: 'markvault-field-tag' });
              fieldTag.createSpan({ text: k, cls: 'markvault-field-tag-key' });
              fieldTag.createSpan({ text: ':', cls: 'markvault-field-tag-sep' });
              fieldTag.createSpan({ text: v, cls: 'markvault-field-tag-value' });
            }
            moreEl.textContent = 'less';
          } else {
            const allFieldTags = fieldsEl.querySelectorAll('.markvault-field-tag');
            for (let i = 3; i < allFieldTags.length; i++) {
              allFieldTags[i].remove();
            }
            moreEl.textContent = `${entries.length - 3} more...`;
          }
        });
      }
    }

    // v4.0: 元数据徽章区域（Relations / Flags / Groups）
    const metaEl = card.createDiv({ cls: 'markvault-card-meta' });

    // 关系徽章 — v5.1: 可点击展开关联详情
    const activeRelations = annotation.relations?.filter(r => !r.invalidAt) ?? [];
    if (activeRelations.length > 0) {
      const relBadge = metaEl.createSpan({ cls: 'markvault-meta-badge markvault-badge-relation markvault-rel-toggle' });
      relBadge.textContent = `🔗 ${activeRelations.length}`;
      relBadge.title = `${activeRelations.length} active relation(s) — click to expand`;

      // 关联详情面板（默认折叠）
      const relPanel = card.createDiv({ cls: 'markvault-rel-panel' });
      relPanel.style.display = 'none';

      // #4 fix: 面板本体阻止点击冒泡到卡片（否则点击面板空白区会触发卡片 onJump）
      relPanel.addEventListener('click', (e) => e.stopPropagation());

      relBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        const expanded = relPanel.style.display !== 'none';
        if (expanded) {
          relPanel.style.display = 'none';
          relBadge.classList.remove('expanded');
          relBadge.title = `${activeRelations.length} active relation(s) — click to expand`;
        } else {
          // 延迟渲染：只在首次展开时构建内容
          if (relPanel.childElementCount === 0) {
            // #1 fix: await async renderRelationPanel，先显示 loading 再展开
            // #5 fix: 加载状态指示
            const loadingEl = relPanel.createDiv({ cls: 'markvault-rel-loading', text: 'Loading…' });
            relPanel.style.display = 'block';
            relBadge.classList.add('expanded');
            relBadge.title = `${activeRelations.length} active relation(s) — click to collapse`;
            this.renderRelationPanel(relPanel, annotation, loadingEl);
          } else {
            relPanel.style.display = 'block';
            relBadge.classList.add('expanded');
            relBadge.title = `${activeRelations.length} active relation(s) — click to collapse`;
          }
        }
      });
    }

    // 掌握度徽章
    if (annotation.flags?.mastery) {
      const masteryEmoji: Record<string, string> = {
        unknown: '❓',
        learning: '📖',
        familiar: '✅',
        mastered: '🎯',
      };
      const masteryBadge = metaEl.createSpan({ cls: 'markvault-meta-badge markvault-badge-mastery' });
      masteryBadge.textContent = masteryEmoji[annotation.flags.mastery] || '❓';
      masteryBadge.title = `Mastery: ${MASTERY_LABELS[annotation.flags.mastery]}`;
    }

    // 纠偏标记
    if (annotation.flags?.needsCorrection) {
      const correctionBadge = metaEl.createSpan({ cls: 'markvault-meta-badge markvault-badge-correction' });
      correctionBadge.textContent = '⚠️';
      correctionBadge.title = 'Needs correction';
    }

    // 信心指数
    if (annotation.flags?.confidence) {
      const confBadge = metaEl.createSpan({ cls: 'markvault-meta-badge markvault-badge-confidence' });
      confBadge.textContent = `${annotation.flags.confidence}/5`;
      confBadge.title = `Confidence: ${annotation.flags.confidence}/5`;
    }

    // 复习优先级
    if (annotation.flags?.reviewPriority) {
      const priorityEmoji: Record<string, string> = { low: '🟢', medium: '🟡', high: '🟠', urgent: '🔴' };
      const priorityBadge = metaEl.createSpan({ cls: 'markvault-meta-badge markvault-badge-priority' });
      priorityBadge.textContent = priorityEmoji[annotation.flags.reviewPriority] || '';
      priorityBadge.title = `Priority: ${REVIEW_PRIORITY_LABELS[annotation.flags.reviewPriority]}`;
    }

    // v4.1: Motivation 语义徽章
    if (annotation.motivation) {
      const motBadge = metaEl.createSpan({ cls: 'markvault-meta-badge markvault-badge-motivation' });
      motBadge.textContent = MOTIVATION_LABELS[annotation.motivation];
      motBadge.title = `Motivation: ${annotation.motivation}`;
    }

    // 分组标签
    if (annotation.groups && annotation.groups.length > 0) {
      const groupsEl = metaEl.createDiv({ cls: 'markvault-card-groups' });
      for (const group of annotation.groups) {
        groupsEl.createSpan({ cls: 'markvault-group-tag', text: group });
      }
    }

    // 底部操作
    const actions = card.createDiv({ cls: 'markvault-card-actions' });

    const timeEl = actions.createSpan({ cls: 'markvault-card-time' });
    timeEl.textContent = this.host.formatRelativeTime(new Date(annotation.updatedAt));

    const editBtn = actions.createEl('button', { cls: 'markvault-action-btn', text: '✏️' });
    editBtn.title = 'Edit annotation';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onEdit(annotation);
    });

    const jumpBtn = actions.createEl('button', { cls: 'markvault-action-btn', text: '↩️' });
    jumpBtn.title = 'Jump to source';
    jumpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onJump(annotation);
    });

    const deleteBtn = actions.createEl('button', { cls: 'markvault-action-btn markvault-delete-btn', text: '🗑️' });
    deleteBtn.title = 'Delete annotation';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.host.onDelete(annotation);
    });

    card.addEventListener('click', () => {
      if (this.host.isBatchMode()) {
        const cb = card.querySelector('.markvault-card-checkbox') as HTMLInputElement;
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      } else {
        this.host.onJump(annotation);
      }
    });
  }

  private showQuickColorMenu(anchor: HTMLElement, annotation: Annotation) {
    const menu = new Menu();
    for (const pc of PRESET_COLORS) {
      menu.addItem((item) => {
        item.setTitle(`${pc.label} (${pc.id === annotation.color ? 'current' : ''})`)
          .setChecked(pc.id === annotation.color)
          .onClick(async () => {
            await this.quickChangeColor(annotation, pc.id);
          });
      });
    }
    menu.showAtMouseEvent({ clientX: anchor.getBoundingClientRect().left, clientY: anchor.getBoundingClientRect().bottom } as MouseEvent);
  }

  private async quickChangeColor(annotation: Annotation, colorId: string) {
    const plugin = this.host.getPluginInstance();
    if (!plugin) return;

    const originalColor = annotation.color;
    await updateAnnotation(annotation.uuid, { color: colorId });

    try {
      const file = this.host.app.vault.getAbstractFileByPath(annotation.filePath);
      if (!(file instanceof TFile)) return;
        const content = await this.host.app.vault.read(file);
        let newContent: string;

        if (annotation.format === 'native') {
          newContent = updateNativeAnnotation(content, annotation.uuid, { color: colorId, type: annotation.type }) ?? content;
        } else if (annotation.kind === 'span') {
          newContent = updateSpanAnchor(content, annotation.uuid, { color: colorId });
        } else if (annotation.kind === 'region') {
          newContent = updateRegionAnnotation(content, annotation.uuid, { color: colorId }) ?? content;
        } else if (annotation.kind === 'block') {
          newContent = updateBlockAnchor(content, annotation.uuid, { color: colorId });
        } else {
          newContent = updateMarkTag(content, annotation.uuid, { color: colorId });
        }

        if (newContent !== content) {
          plugin.modifyGuard.acquire(annotation.filePath);
          try {
            await this.host.app.vault.modify(file, newContent);
          } catch (mdErr) {
            console.error('MarkVault: quickChangeColor MD error, rolling back', mdErr);
            await updateAnnotation(annotation.uuid, { color: originalColor });
            throw mdErr;
          } finally {
            plugin.modifyGuard.release(annotation.filePath);
          }
        }

        plugin.markFileSynced(annotation.filePath);
        await plugin.updateSpanCache(annotation.filePath);
        await plugin.updateRegionCache(annotation.filePath);

        // 强制所有打开该文件的阅读视图重新渲染
        this.host.app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view;
          if (view instanceof MarkdownView && view.file?.path === annotation.filePath && view.previewMode) {
            view.previewMode.rerender(true);
          }
        });
    } catch (err) {
      plugin.modifyGuard.releaseNow(annotation.filePath);
      console.error('MarkVault: quick color change error', err);
    }
    await this.host.refreshListOnly();
  }

  /**
   * v5.1: 渲染关联详情面板
   * 展示出边/入边关系，每项显示类型标签 + 目标标注摘要，点击可跳转
   *
   * 先并行加载所有目标标注（避免 async getAnnotationByUuid 未 await 导致 .text 为 undefined），
   * 再同步渲染 DOM。
   *
   * @param panel 面板容器
   * @param annotation 当前标注
   * @param loadingEl 加载指示器元素，渲染完成后移除
   */
  private async renderRelationPanel(panel: HTMLElement, annotation: Annotation, loadingEl?: HTMLElement): Promise<void> {
    try {
      const rels = getRelations(annotation.uuid);
      const plugin = this.host.getPluginInstance();
      const schema = plugin?.getRelationSchema();

      // 收集所有目标 UUID 并并行加载
      const targetUuids = new Set<string>();
      for (const rel of rels.outgoing) targetUuids.add(rel.targetUuid);
      for (const { sourceUuid } of rels.incoming) targetUuids.add(sourceUuid);

      const targetMap = new Map<string, Annotation | undefined>();
      const loadPromises = Array.from(targetUuids, async (uuid) => {
        targetMap.set(uuid, await getAnnotationByUuid(uuid));
      });
      await Promise.all(loadPromises);

      // ── 出边关系（本标注主动建立的） ──
      if (rels.outgoing.length > 0) {
        const outSection = panel.createDiv({ cls: 'markvault-rel-section' });
        outSection.createDiv({ cls: 'markvault-rel-section-header', text: 'Outgoing' });
        for (const rel of rels.outgoing) {
          this.renderRelationItem(outSection, rel, rel.targetUuid, schema?.getLabel(rel.type) ?? rel.type, 'outgoing', targetMap, annotation.filePath);
        }
      }

      // ── 入边关系（其他标注指向本标注的） ──
      if (rels.incoming.length > 0) {
        const inSection = panel.createDiv({ cls: 'markvault-rel-section' });
        inSection.createDiv({ cls: 'markvault-rel-section-header', text: 'Incoming' });
        for (const { sourceUuid, relation } of rels.incoming) {
          // 入边显示反向类型的标签（即对方看到的正向标签）
          const reverseLabel = schema?.getLabel(relation.type) ?? relation.type;
          this.renderRelationItem(inSection, relation, sourceUuid, reverseLabel, 'incoming', targetMap, annotation.filePath);
        }
      }

      // 空状态兜底（理论上不会走到这里）
      if (rels.outgoing.length === 0 && rels.incoming.length === 0) {
        panel.createDiv({ cls: 'markvault-rel-empty', text: 'No active relations' });
      }
    } catch (err) {
      console.error('MarkVault: renderRelationPanel error', err);
      panel.createDiv({ cls: 'markvault-rel-broken', text: 'Failed to load relations' });
    } finally {
      // 移除加载指示器
      loadingEl?.remove();
    }
  }

  /**
   * 渲染单条关联项
   * @param sourceFilePath 当前标注的 filePath，用于判断跨文件时才显示文件名
   */
  private renderRelationItem(
    container: HTMLElement,
    rel: AnnotationRelation,
    targetUuid: string,
    typeLabel: string,
    direction: 'outgoing' | 'incoming',
    targetMap: Map<string, Annotation | undefined>,
    sourceFilePath: string,
  ): void {
    const targetAnn = targetMap.get(targetUuid);
    const item = container.createDiv({ cls: `markvault-rel-item markvault-rel-${direction}` });

    // 类型标签
    const typeEl = item.createSpan({ cls: 'markvault-rel-type-label' });
    typeEl.textContent = typeLabel;

    // 箭头
    item.createSpan({ cls: 'markvault-rel-arrow', text: direction === 'outgoing' ? '→' : '←' });

    // 目标标注摘要
    if (targetAnn) {
      // #2 fix: 防御 text 为 undefined / null
      const rawText = targetAnn.text ?? '';
      const targetText = rawText.length > 40
        ? rawText.substring(0, 40) + '…'
        : rawText;
      const summaryEl = item.createSpan({ cls: 'markvault-rel-summary', title: rawText });
      summaryEl.textContent = targetText ? `"${targetText}"` : '(empty)';

      // #3 fix: 文件名仅在跨文件时显示（同文件冗余）
      if (targetAnn.filePath !== undefined && targetAnn.filePath !== sourceFilePath) {
        const fileName = targetAnn.filePath.split('/').pop()?.replace('.md', '') || targetAnn.filePath;
        item.createSpan({ cls: 'markvault-rel-file', text: `📄 ${fileName}` });
      }

      // 点击跳转到目标标注
      item.addClass('clickable');
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.host.onJump(targetAnn);
      });
    } else {
      // 目标标注不在 Store 中（数据异常）
      item.createSpan({ cls: 'markvault-rel-broken', text: '(annotation not found)' });
      item.title = `UUID: ${targetUuid}`;
    }

    // 关联备注
    if (rel.note) {
      item.createSpan({ cls: 'markvault-rel-note', text: `💬 ${rel.note}` });
    }
  }
}
