import { type MarkdownPostProcessorContext } from 'obsidian';
import { logger } from '../utils/logger';
import type { AnnotationType, Annotation } from '../types/annotation';
import { DEFAULT_SETTINGS } from '../types/annotation';
import { annotationStore } from '../db/annotation-store';
import type { ChangeInfo } from '../core/offset-tracker';
import { applyIncrementalOffsetFix } from '../core/offset-tracker';
import { ModifyGuard } from '../utils/modify-guard';
import { ReadingModeToolbar } from '../ui/reading/ReadingModeToolbar';
import { ReadingModeClickDelegate } from '../ui/reading/ReadingModeClickDelegate';
// 🔧 Phase 5B: 自然语法标注处理提取到独立模块
import { processNativeAnnotations } from './reading-native-processor';
// 🔧 Phase 5B: block/span 锚点标注处理提取到独立模块
import { processBlockAnchors } from './reading-block-processor';
// 🔧 Phase 5B Step 8: region 标注处理提取到独立模块
import { processRegionAnnotations, hideLeakedAnchorText, clearRegionParseCache } from './reading-region-processor';

/**
 * Minimal interface that MarkVaultPlugin must satisfy for ReadingModeProcessor.
 * Uses TypeScript structural typing — no explicit `implements` needed.
 */
export interface ReadingHost {
  readonly app: import('obsidian').App;
  readonly settings: import('../types/annotation').MarkVaultSettings;
  readonly modifyGuard: ModifyGuard;
  activeFilePath: string | null;
  isStoreReady(): boolean;
  updateSpanCache(filePath: string): Promise<void>;
  updateRegionCache(filePath: string): Promise<void>;
  refreshSidebar(): Promise<void>;
  scheduleSidebarRefresh(): void;
  markFileSynced(filePath: string): void;
  openAnnotationModal(uuid: string): Promise<void>;
  createReadingAnnotation(text: string, color: string, type: AnnotationType, kind: Annotation['kind']): Promise<void>;
  getDefaultColor(): string;
}

export class ReadingModeProcessor {
  private readingToolbar: ReadingModeToolbar | null = null;
  private readingClickDelegate: ReadingModeClickDelegate | null = null;

  // Fields for handleDocChange
  private pendingOffsetFix: Promise<void> | null = null;
  private pendingChanges: ChangeInfo[] = [];

  constructor(private plugin: ReadingHost) {}

  /** Register the markdown post processor — call from plugin.onload() */
  registerPostProcessor(): void {
    try {
      (this.plugin as any).registerMarkdownPostProcessor(async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        try {
          // 1. 处理 <mark> 标注
          const marks = el.findAll('mark[data-uuid]');
          marks.forEach((mark) => {
            const htmlEl = mark as HTMLElement;
            const type = (htmlEl.getAttribute('data-type') || 'highlight') as import('../types/annotation').AnnotationType;
            const color = htmlEl.getAttribute('data-color') || 'yellow';
            const preset = DEFAULT_SETTINGS.presetColors.find(c => c.id === color);
            const hex = preset ? preset.hex : color;

            // 添加标识 class（供全局事件委托识别 + CSS 样式）
            htmlEl.addClass('markvault-mark');
            htmlEl.addClass(`markvault-${type}`);
            htmlEl.addClass(`markvault-${color}`);
            htmlEl.addClass('markvault-clickable');
            htmlEl.style.cursor = 'pointer';

            switch (type) {
              case 'highlight':
                htmlEl.style.backgroundColor = `${hex}66`;
                htmlEl.style.borderRadius = '2px';
                htmlEl.style.padding = '1px 0';
                break;
              case 'bold':
                htmlEl.style.fontWeight = 'bold';
                htmlEl.style.borderBottom = `2px solid ${hex}`;
                htmlEl.style.padding = '1px 0';
                break;
              case 'underline':
                htmlEl.style.textDecoration = 'underline';
                htmlEl.style.textDecorationColor = hex;
                htmlEl.style.textUnderlineOffset = '2px';
                break;
            }

            const note = htmlEl.getAttribute('data-note');
            if (note) {
              htmlEl.setAttribute('title', note);
              htmlEl.addClass('markvault-has-note');
            }
          });

          // 处理自然语法标注（隐身锚点 + 原生 Markdown 包裹）
          await processNativeAnnotations(el, ctx.sourcePath);

          // 处理块级锚点标注
          await processBlockAnchors(el, ctx, this.plugin);

          // 处理区域标注（双锚点包围）
          await processRegionAnnotations(el, ctx, this.plugin);

          // 防御性清理：隐藏阅读模式中泄漏的锚点文本
          hideLeakedAnchorText(el);
        } catch (err) {
          console.error('MarkVault: post processor error', err);
        }
      });
    } catch (err) {
      console.error('MarkVault: failed to register markdown post processor', err);
    }
  }

  /** Set up reading mode toolbar and click delegate — call from plugin.onload() */
  setupReadingModeUI(): void {
    // 全局事件委托：捕获阅读模式下对 markvault 标注的点击
    try {
      this.readingClickDelegate = new ReadingModeClickDelegate(this.plugin as any, {
        onOpenAnnotation: (uuid: string) => this.plugin.openAnnotationModal(uuid),
      });
      this.readingClickDelegate.setup();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode click delegate', err);
    }

    // 阅读模式：选中文本浮动工具条
    try {
      const readingHost = {
        createReadingAnnotation: (req: { selectedText: string; color: string; type: AnnotationType; kind: Annotation['kind'] }) =>
          this.plugin.createReadingAnnotation(req.selectedText, req.color, req.type, req.kind),
        getDefaultColor: () => this.plugin.getDefaultColor(),
      };

      this.readingToolbar = new ReadingModeToolbar(this.plugin as any, readingHost);
      this.readingToolbar.setup();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode toolbar/context menu', err);
    }
  }

  /** Destroy reading mode UI — call from plugin.onunload() */
  destroy(): void {
    this.readingToolbar?.destroy();
    this.readingClickDelegate?.destroy();
    clearRegionParseCache();
  }

  /** Handle CM6 document changes for offset tracking */
  handleDocChange(changes: ChangeInfo[]): void {
    if (!this.plugin.activeFilePath) return;

    // 累积变更，避免连续编辑时丢失中间变更
    this.pendingChanges.push(...changes);

    // 如果已经有处理任务在运行，直接返回；队列会被该任务消费
    if (this.pendingOffsetFix) return;

    this.pendingOffsetFix = (async () => {
      try {
        while (this.pendingChanges.length > 0) {
          // 取出当前队列中的所有变更
          const batch = this.pendingChanges.splice(0);

          const filePath = this.plugin.activeFilePath;
          if (!filePath) return;

          const annotations = await annotationStore.getAnnotationsForFile(filePath);
          if (annotations.length === 0) continue;

          const result = await applyIncrementalOffsetFix(filePath, batch, annotations);

          if (result.updated > 0 || result.deleted > 0) {
            logger.debug(`MarkVault: offset fix — updated: ${result.updated}, deleted: ${result.deleted}`);

            // 偏移修正后刷新 span 缓存，确保 CM6 装饰使用最新偏移
            await this.plugin.updateSpanCache(filePath);
            await this.plugin.updateRegionCache(filePath);

            if (result.deleted > 0) {
              await this.plugin.refreshSidebar();
            }
          }
        }
      } catch (err) {
        console.error('MarkVault: offset fix error', err);
      } finally {
        this.pendingOffsetFix = null;
      }
    })();
  }

  // ─── 阅读模式渲染方法 ──────────────────────────────────────
  // 🔧 Phase 5B: block/span → reading-block-processor.ts
  // 🔧 Phase 5B Step 8: region → reading-region-processor.ts
  // 🔧 Phase 5B: native → reading-native-processor.ts
  // 🔧 Phase 5B: highlightSpanFragments/wrapTextFragments → reading-block-processor.ts
}
