import { Plugin, MarkdownView, TFile, Notice, type MarkdownPostProcessorContext } from 'obsidian';
import type { MarkVaultSettings, AnnotationType, Annotation, SpanRange } from './types/annotation';
import { DEFAULT_SETTINGS, RelationSchema } from './types/annotation';
import { MARKVAULT_SIDEBAR_VIEW_TYPE, AnnotationSidebar } from './ui/sidebar/AnnotationSidebar';
import { MARKVAULT_GRAPH_VIEW_TYPE, RelationGraphView } from './ui/graph/RelationGraphView';
import { registerContextMenu, registerCommands, getBlockAnchorPrefixesForListItem, adjustRegionStartOffsetForListItem, adjustRegionEndOffsetForListItem } from './ui/editor/context-menu';
import { MarkVaultSettingTab } from './ui/settings/settings-tab';
import { syncFromMarkdown, getPlainTextForOffsetRecovery, extractContextFromContent } from './core/markdown-sync';
import {
  computeBlockSignature,
  computeSpanSignature,
  findBlockLineBySignature,
  findSpanLineBySignature,
  detectBlockTypeAtLine,
} from './core/block-fingerprint';
import {
  parseBlockAnchors,
  parseBlockDoubleAnchors,
  findBlockDoubleAnchorRange,
  findBlockTargetLine,
  findBlockContentEndLine,
  computeSpanRanges,
  findSpanEndLine,
  buildMarkTag,
  buildBlockAnchorStart,
  buildBlockAnchorEnd,
  buildSpanAnchor,
} from './core/annotation-parser';
import { scanMarkdownContexts, detectBlockAtLine, type BlockInfo } from './core/md-context';
import { markdownToPlainWithMap } from './core/markdown-plain';
import { markvaultDecorationPlugin, setFilePathResolver, setActiveEditorView, requestRegionLayerRedraw } from './core/highlight-applier';
import { createOffsetTrackerExtension, applyIncrementalOffsetFix, type ChangeInfo } from './core/offset-tracker';
import { batchRecoverOffsets } from './core/offset-recovery';
import { buildAnnotation, finalizeAnnotation } from './core/annotation-creator';
import { AnnotationModal } from './ui/editor/annotation-modal';
import { initAnnotationStore, annotationStore } from './db/annotation-store';
import { getAnnotationByUuid } from './db/annotation-repo';
import { generateId } from './utils/id';
import { migrateFromIndexedDB } from './db/migration';

import { buildNativeAnnotation } from './core/native-annotation';
import { buildRegionAnchor, parseRegionAnnotations, REGION_ANCHOR_REGEX } from './core/region-annotation';
import { computeSignature } from './core/block-fingerprint';
import { updateSpanCacheForFile, clearSpanCacheForFile, type SpanAnnotationData, updateRegionCacheForFile, clearRegionCacheForFile, type RegionAnnotationData, getRegionCacheForFile, updateBlockCacheForFile, clearBlockCacheForFile, type BlockAnnotationData, getBlockCacheForFile } from './core/highlight-applier';

import { ModifyGuard } from './utils/modify-guard';
import { ReadingModeToolbar } from './ui/reading/ReadingModeToolbar';
import { ReadingModeClickDelegate } from './ui/reading/ReadingModeClickDelegate';
import { AnnotationSearchEngine } from './search/search-engine';

export default class MarkVaultPlugin extends Plugin {
  settings: MarkVaultSettings = DEFAULT_SETTINGS;
  /** v4.3: 关系类型 Schema 实例 — 从 settings 动态构建 */
  relationSchema: RelationSchema = new RelationSchema(DEFAULT_SETTINGS.customRelationTypes);
  private sidebar: AnnotationSidebar | null = null;
  /** v4.3 Phase 2: 关系图谱视图 */
  private graphView: RelationGraphView | null = null;

  // 当前活跃文件的路径，用于偏移修正
  private activeFilePath: string | null = null;

  // 🆕 防重入保护：当插件自身在修改文件时（创建标注、保存批注），
  // 阻止 onFileOpen() 重新触发 syncFromMarkdown()，避免竞态条件覆盖数据
  // per-file Map + 自动过期，比全局布尔值 + setTimeout 更安全
  public modifyGuard = new ModifyGuard(3000);

  // 🆕 防重入扩展：记录正在编辑的标注 uuid 集合
  // 当用户在 Modal 中编辑标注时，即使 modifyGuard 已释放，
  // 也要保护这些标注不被 syncFromMarkdown 覆盖
  private _activeAnnotationUuids = new Set<string>();

  // 🆕 同步维护的活跃文件路径集合，避免 onFileOpen 中异步查询 DB
  private _activeAnnotationFilePaths = new Set<string>();

  // 🆕 uuid → filePath 反向映射，用于精确维护 _activeAnnotationFilePaths
  private _activeAnnotationUuidToFilePath = new Map<string, string>();

  // 🆕 当前打开的 AnnotationModal 实例（按 uuid 索引）
  // 用于在文件被删除/重命名时自动关闭对应 Modal
  private _activeAnnotationModals = new Map<string, AnnotationModal>();

  // 🆕 阅读模式相关模块
  private readingToolbar: ReadingModeToolbar | null = null;
  private readingClickDelegate: ReadingModeClickDelegate | null = null;

  // 🆕 冷却期：文件最近被插件修改过，跳过短时间内重复的 onFileOpen sync
  // 防止 vault.modify 后异步触发的 file-open 事件重复执行昂贵的全量同步
  private _syncCooldown: Map<string, number> = new Map();

  // 🆕 侧边栏刷新去重标志，避免 onFileOpen 高频触发时产生刷新堆积
  private _pendingSidebarRefresh = false;

  // 🆕 AnnotationStore 是否初始化成功
  private _storeReady = false;

  // 🆕 搜索引擎实例（全文搜索 + Relation Picker）
  private _searchEngine: AnnotationSearchEngine | null = null;

  /** 检查 AnnotationStore 是否已就绪 */
  public isStoreReady(): boolean {
    return this._storeReady;
  }

  /** 获取搜索引擎实例（供 RelationPicker 等使用） */
  public getSearchEngine(): AnnotationSearchEngine {
    if (!this._searchEngine) {
      this._searchEngine = new AnnotationSearchEngine(annotationStore);
    }
    return this._searchEngine;
  }

  /** v4.3: 获取关系类型 Schema 实例 */
  public getRelationSchema(): RelationSchema {
    return this.relationSchema;
  }

  /** 注册一个标注为"正在编辑"状态，防止被 sync 覆盖 */
  public markAnnotationActive(uuid: string, filePath?: string) {
    this._activeAnnotationUuids.add(uuid);
    if (filePath) {
      this._activeAnnotationUuidToFilePath.set(uuid, filePath);
      this._activeAnnotationFilePaths.add(filePath);
    }
  }

  /** 取消标注的"正在编辑"状态 */
  public unmarkAnnotationActive(uuid: string, filePath?: string) {
    this._activeAnnotationUuids.delete(uuid);

    // 精确维护文件路径集合：只有当该文件下没有其他活跃标注时才移除
    const storedPath = this._activeAnnotationUuidToFilePath.get(uuid);
    this._activeAnnotationUuidToFilePath.delete(uuid);

    const targetPath = storedPath ?? filePath;
    if (targetPath) {
      let hasOtherActive = false;
      for (const fp of this._activeAnnotationUuidToFilePath.values()) {
        if (fp === targetPath) {
          hasOtherActive = true;
          break;
        }
      }
      if (!hasOtherActive) {
        this._activeAnnotationFilePaths.delete(targetPath);
      }
    }
  }

  /** 检查一个标注是否正在被编辑 */
  public isAnnotationActive(uuid: string): boolean {
    return this._activeAnnotationUuids.has(uuid);
  }

  /** 检查某个文件是否有正在编辑的标注（同步，无需查询 DB） */
  public isFileEditing(filePath: string): boolean {
    return this._activeAnnotationFilePaths.has(filePath);
  }

  /** 注册当前打开的 AnnotationModal */
  public registerActiveAnnotationModal(uuid: string, modal: AnnotationModal): void {
    this._activeAnnotationModals.set(uuid, modal);
  }

  /** 注销已关闭的 AnnotationModal */
  public unregisterActiveAnnotationModal(uuid: string): void {
    this._activeAnnotationModals.delete(uuid);
  }

  /** 关闭指定文件上所有打开的 AnnotationModal */
  public closeActiveModalsForFile(filePath: string): void {
    for (const [uuid, modal] of this._activeAnnotationModals) {
      const fp = this._activeAnnotationUuidToFilePath.get(uuid);
      if (fp === filePath) {
        try {
          modal.close();
        } catch (err) {
          console.error('MarkVault: failed to close active modal for deleted file', uuid, err);
        }
      }
    }
  }

  /** 标记文件数据已一致，跳过 onFileOpen 的重复 sync（30s 冷却） */
  public markFileSynced(filePath: string): void {
    this._syncCooldown.set(filePath, Date.now());
  }

  /**
   * 更新 span / block / region 标注缓存（供 CM6 装饰器使用）
   * 从 DB 加载指定文件的 span/block/region 标注数据到缓存
   */
  public async updateSpanCache(filePath: string): Promise<void> {
    try {
      const annotations = await annotationStore.getAnnotationsForFile(filePath);

      const spanAnnotations = annotations.filter(a => a.kind === 'span' && a.spanRanges && a.spanRanges.length > 0);
      const spanData: SpanAnnotationData[] = spanAnnotations.map(a => ({
        uuid: a.uuid,
        type: a.type,
        color: a.color,
        anchorLine: a.anchorLine ?? a.startLine,
        spanRanges: a.spanRanges!,
        note: a.note,
      }));
      updateSpanCacheForFile(filePath, spanData);

      const blockAnnotations = annotations.filter(a => a.kind === 'block' && a.targetLine !== undefined);
      const blockData: BlockAnnotationData[] = blockAnnotations.map(a => ({
        uuid: a.uuid,
        type: a.type,
        color: a.color,
        targetLine: a.targetLine ?? a.startLine,
        note: a.note,
      }));
      updateBlockCacheForFile(filePath, blockData);
    } catch (err) {
      console.error('MarkVault: updateSpanCache error', err);
    }
  }

  /**
   * 更新 region 标注缓存（供 CM6 layer 使用）
   * 🔧 BUG-5.1 修复：缓存更新后强制 CM6 layer 重绘，解决异步缓存竞态
   */
  public async updateRegionCache(filePath: string): Promise<void> {
    try {
      const annotations = await annotationStore.getAnnotationsForFile(filePath);
      const regionAnnotations = annotations.filter(a => a.kind === 'region');
      const regionData: RegionAnnotationData[] = regionAnnotations.map(a => ({
        uuid: a.uuid,
        type: a.type,
        color: a.color,
        startOffset: a.startOffset,
        endOffset: a.endOffset,
        note: a.note,
      }));
      updateRegionCacheForFile(filePath, regionData);
      // 缓存已更新，通知 CM6 region layer 重新渲染
      requestRegionLayerRedraw();
    } catch (err) {
      console.error('MarkVault: updateRegionCache error', err);
    }
  }

  /**
   * 🔧 BUG-5.1 修复：立即同步更新 region 缓存（预填充）
   *
   * 在 editor.replaceSelection() 之前调用，确保 CM6 layer 首次渲染时
   * 就能看到新创建的 region 标注数据，避免异步缓存竞态导致 layer 为空。
   *
   * @param filePath 文件路径
   * @param newAnnotation 即将创建的标注对象（尚未写入 DB）
   */
  public updateRegionCacheImmediately(filePath: string, newAnnotation: Annotation): void {
    try {
      // 读取当前缓存
      const existingData = getRegionCacheForFile(filePath);
      const newData: RegionAnnotationData[] = [
        ...existingData,
        {
          uuid: newAnnotation.uuid,
          type: newAnnotation.type,
          color: newAnnotation.color,
          startOffset: newAnnotation.startOffset,
          endOffset: newAnnotation.endOffset,
          note: newAnnotation.note,
        },
      ];
      updateRegionCacheForFile(filePath, newData);
      // 预填充后也通知 CM6 重绘
      requestRegionLayerRedraw();
    } catch (err) {
      // 预填充失败不影响主流程，updateRegionCache 会随后修正
      console.warn('MarkVault: updateRegionCacheImmediately failed (will be corrected by updateRegionCache)', err);
    }
  }

  /**
   * 🔧 BUG-5.3 修复：立即同步更新 block 缓存（预填充）
   *
   * 在 editor.replaceRange() 之前调用，确保 CM6 decoration plugin 首次渲染时
   * 就能看到新创建的 block 标注数据，避免异步缓存竞态导致行装饰缺失。
   *
   * @param filePath 文件路径
   * @param newAnnotation 即将创建的标注对象（尚未写入 DB）
   */
  /**
   * 在编辑模式下选中 region 的内容范围，触发 Obsidian 原生选区（外部选框）。
   *
   * 编辑模式下 region 不渲染自定义背景/边框，视觉反馈完全通过原生 selection 完成。
   */
  public selectRegionInEditor(annotation: Annotation): boolean {
    if (annotation.kind !== 'region') return false;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file || view.file.path !== annotation.filePath) return false;
    if (view.getMode() === 'preview') return false;

    const editor = view.editor;
    const content = editor.getValue();

    const startRegex = new RegExp(`%%markvault-region:${annotation.uuid}:([^:%]+):([^:%]+):start:[^%]*%%`);
    const endRegex = new RegExp(`%%markvault-region:${annotation.uuid}:([^:%]+):([^:%]+):end:[^%]*%%`);

    const startMatch = content.match(startRegex);
    const endMatch = content.match(endRegex);
    if (!startMatch || !endMatch) return false;

    const startOffset = startMatch.index! + startMatch[0].length;
    const endOffset = endMatch.index!;
    if (startOffset >= endOffset) return false;

    try {
      const from = editor.offsetToPos(startOffset);
      const to = editor.offsetToPos(endOffset);
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
      return true;
    } catch (err) {
      console.error('MarkVault: selectRegionInEditor error', err);
      return false;
    }
  }

  public updateBlockCacheImmediately(filePath: string, newAnnotation: Annotation): void {
    try {
      // 读取当前缓存
      const existingData = getBlockCacheForFile(filePath);
      const newData: BlockAnnotationData[] = [
        ...existingData,
        {
          uuid: newAnnotation.uuid,
          type: newAnnotation.type,
          color: newAnnotation.color,
          targetLine: newAnnotation.targetLine ?? newAnnotation.startLine,
          note: newAnnotation.note,
        },
      ];
      updateBlockCacheForFile(filePath, newData);
      // 预填充后通知 CM6 重绘（decoration plugin 也会读 block 缓存）
      requestRegionLayerRedraw();
    } catch (err) {
      // 预填充失败不影响主流程，updateSpanCache 会随后修正
      console.warn('MarkVault: updateBlockCacheImmediately failed (will be corrected by updateSpanCache)', err);
    }
  }

  async onload() {
    console.log('MarkVault: loading plugin...');

    // ── 设置加载（最先执行，后续功能依赖设置） ──────────
    try {
      await this.loadSettings();
    } catch (err) {
      console.error('MarkVault: failed to load settings, using defaults', err);
      this.settings = DEFAULT_SETTINGS;
    }

    // ── AnnotationStore 初始化（Phase 2: 分片 JSON + 内存索引） ──
    try {
      initAnnotationStore(this.app.vault);
      // v4.3: 注入关系类型 Schema（在 initialize 之前，确保所有操作使用自定义配置）
      annotationStore.setRelationSchema(this.relationSchema);
      await annotationStore.initialize();
      this._storeReady = true;
      const migratedCount = await migrateFromIndexedDB();
      if (migratedCount > 0) {
        console.log(`MarkVault: migrated ${migratedCount} annotations from IndexedDB`);
      }
    } catch (err) {
      console.error('MarkVault: failed to initialize AnnotationStore', err);
      this._storeReady = false;
      new Notice('MarkVault: failed to initialize annotation database. Some features are disabled.', 8000);
    }

    // ── CM6 扩展注册 ──────────────────────────────
    try {
      // 注入文件路径解析器（供 highlight-applier 使用）
      setFilePathResolver(() => {
        const activeFile = this.app.workspace.getActiveFile();
        return activeFile ? activeFile.path : null;
      });

      // 1. 标注高亮 Decoration Plugin
      this.registerEditorExtension(markvaultDecorationPlugin);

      // 2. 偏移追踪 Extension
      this.registerEditorExtension(
        createOffsetTrackerExtension((changes) => {
          this.handleDocChange(changes);
        }),
      );
    } catch (err) {
      console.error('MarkVault: failed to register CM6 extensions', err);
      // CM6 注册失败不应该阻止整个插件加载
      // 只是编辑模式下不会有高亮渲染
    }

    // ── Obsidian 事件注册 ─────────────────────────

    // 注册侧边栏视图
    try {
      this.registerView(
        MARKVAULT_SIDEBAR_VIEW_TYPE,
        (leaf) => {
          this.sidebar = new AnnotationSidebar(leaf);
          this.sidebar.setPluginInstance(this);
          return this.sidebar;
        },
      );
    } catch (err) {
      console.error('MarkVault: failed to register sidebar view', err);
    }

    // 注册关系图谱视图
    try {
      this.registerView(
        MARKVAULT_GRAPH_VIEW_TYPE,
        (leaf) => {
          this.graphView = new RelationGraphView(leaf);
          this.graphView.setPluginInstance(this);
          return this.graphView;
        },
      );
    } catch (err) {
      console.error('MarkVault: failed to register graph view', err);
    }

    // 添加侧边栏图标
    try {
      this.addRibbonIcon('pen-tool', 'MarkVault-JS', () => {
        this.activateSidebar();
      });
    } catch (err) {
      console.error('MarkVault: failed to add ribbon icon', err);
    }

    // 添加关系图谱图标
    try {
      this.addRibbonIcon('git-branch', 'MarkVault Relation Graph', () => {
        this.activateGraphView();
      });
    } catch (err) {
      console.error('MarkVault: failed to add graph ribbon icon', err);
    }

    // 注册命令（最关键 — 必须成功）
    try {
      registerCommands(this);
      console.log('MarkVault: commands registered');
    } catch (err) {
      console.error('MarkVault: failed to register commands', err);
    }

    // 注册右键菜单
    if (this.settings.showContextMenu) {
      try {
        registerContextMenu(this);
      } catch (err) {
        console.error('MarkVault: failed to register context menu', err);
      }
    }

    // 注册设置页
    try {
      this.addSettingTab(new MarkVaultSettingTab(this.app, this));
    } catch (err) {
      console.error('MarkVault: failed to register settings tab', err);
    }

    // 文件打开时同步标注
    try {
      this.registerEvent(
        this.app.workspace.on('file-open', async (file) => {
          if (file instanceof TFile && file.extension === 'md') {
            this.activeFilePath = file.path;
            await this.onFileOpen(file);
          } else {
            this.activeFilePath = null;
          }
        }),
      );
    } catch (err) {
      console.error('MarkVault: failed to register file-open handler', err);
    }

    // 🆕 文件删除时清理关联标注
    try {
      this.registerEvent(
        this.app.vault.on('delete', async (file) => {
          if (file instanceof TFile && file.extension === 'md') {
            console.log(`MarkVault: file deleted — cleaning up annotations for "${file.path}"`);
            try {
              // 如果当前活跃文件是被删除文件，清空引用
              if (this.activeFilePath === file.path) {
                this.activeFilePath = null;
              }

              // 关闭该文件上所有打开的 AnnotationModal
              this.closeActiveModalsForFile(file.path);

              // 清理该文件的活跃标注保护状态
              const activeUuids = Array.from(this._activeAnnotationUuids);
              for (const uuid of activeUuids) {
                if (this._activeAnnotationUuidToFilePath.get(uuid) === file.path) {
                  this.unmarkAnnotationActive(uuid, file.path);
                }
              }

              const deletedCount = await annotationStore.deleteAnnotationsForFile(file.path);
              clearSpanCacheForFile(file.path);
              await this.refreshSidebar();

              if (deletedCount > 0) {
                new Notice(`Cleaned up ${deletedCount} annotations for deleted file`, 4000);
              }
              console.log(`MarkVault: annotations cleaned up for deleted file "${file.path}" (${deletedCount})`);
            } catch (err) {
              console.error('MarkVault: failed to clean up annotations for deleted file', file.path, err);
              new Notice('Failed to clean up annotations for deleted file', 5000);
            }
          }
        }),
      );
    } catch (err) {
      console.error('MarkVault: failed to register delete handler', err);
    }

    // 🆕 文件重命名时同步更新标注路径
    try {
      this.registerEvent(
        this.app.vault.on('rename', async (file, oldPath) => {
          if (file instanceof TFile && file.extension === 'md') {
            console.log(`MarkVault: file renamed "${oldPath}" → "${file.path}"`);
            try {
              // 关闭旧文件上打开的 Modal，避免保存时路径错误
              this.closeActiveModalsForFile(oldPath);

              await annotationStore.renameAnnotationsForFile(oldPath, file.path);

              // 如果当前活跃文件就是被重命名的文件，更新 activeFilePath
              if (this.activeFilePath === oldPath) {
                this.activeFilePath = file.path;
              }

              // 🔧 审计修复：更新活跃标注的 uuid→filePath 映射
              for (const [uuid, fp] of this._activeAnnotationUuidToFilePath) {
                if (fp === oldPath) {
                  this._activeAnnotationUuidToFilePath.set(uuid, file.path);
                }
              }

              // 🔧 审计修复：更新 _activeAnnotationFilePaths，防止 Modal 编辑保护失效
              if (this._activeAnnotationFilePaths.has(oldPath)) {
                this._activeAnnotationFilePaths.delete(oldPath);
                this._activeAnnotationFilePaths.add(file.path);
              }

              // 🔧 审计修复：更新 _syncCooldown 中的冷却条目
              const cooldownTime = this._syncCooldown.get(oldPath);
              if (cooldownTime !== undefined) {
                this._syncCooldown.delete(oldPath);
                this._syncCooldown.set(file.path, cooldownTime);
              }

              await this.refreshSidebar();
              new Notice(`Annotations migrated for renamed file`, 4000);
              console.log(`MarkVault: annotations migrated for renamed file`);
            } catch (err) {
              console.error('MarkVault: failed to migrate annotations for renamed file', oldPath, '→', file.path, err);
            }
          }
        }),
      );
    } catch (err) {
      console.error('MarkVault: failed to register rename handler', err);
    }

    // 🆕 当前文件/视图变化时刷新缓存（用于切换标签页、阅读/编辑模式切换）
    // 只做轻量级缓存刷新，不做全量 sync，避免 vault.modify 后重复昂贵同步。
    try {
      this.registerEvent(
        this.app.workspace.on('active-leaf-change', async () => {
          // 🔧 BUG-5.1 修复：注入当前活跃的 EditorView，用于 region 缓存更新后强制 layer 重绘
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (activeView && activeView.editor) {
            // Obsidian 的 Editor 对象可能包含 CM6 EditorView
            const cmView = (activeView.editor as any).cm as import('@codemirror/view').EditorView | undefined;
            setActiveEditorView(cmView || null);
          } else {
            setActiveEditorView(null);
          }

          const file = this.app.workspace.getActiveFile();
          if (file instanceof TFile && file.extension === 'md') {
            // 文件真正切换时由 file-open 处理；这里主要处理同文件不同视图切换
            if (this.activeFilePath === file.path) {
              try {
                await annotationStore.ensureFileLoaded(file.path);
                await this.updateSpanCache(file.path);
                await this.updateRegionCache(file.path);
                requestRegionLayerRedraw();
                this.scheduleSidebarRefresh();
              } catch (err) {
                console.error('MarkVault: active-leaf-change cache refresh failed', err);
              }
            }
          }
        }),
      );
    } catch (err) {
      console.error('MarkVault: failed to register active-leaf-change handler', err);
    }

    // 阅读模式渲染：只负责视觉样式，不绑定点击事件
    // 点击事件统一由全局 capture-phase handler 处理（更可靠，不会被 DOM 重建影响）
    try {
      this.registerMarkdownPostProcessor(async (el, ctx) => {
        try {
          // 1. 处理 <mark> 标注
          const marks = el.findAll('mark[data-uuid]');
          marks.forEach((mark) => {
            const htmlEl = mark as HTMLElement;
            const type = (htmlEl.getAttribute('data-type') || 'highlight') as import('./types/annotation').AnnotationType;
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

          // 🆕 v3.0: 处理自然语法标注（隐身锚点 + 原生 Markdown 包裹）
          await this.processNativeAnnotations(el, ctx.sourcePath);

          // 🆕 v2.0: 处理块级锚点标注
          // 检测 %%markvault:uuid:type:color:note%% 注释锚点
          // Obsidian 会将 %%...%% 注释渲染为特殊的 comment 节点
          // 我们需要在渲染后的 DOM 中找到这些锚点，给下方的块添加装饰
          await this.processBlockAnchors(el, ctx);

          // 🆕 v3.x: 处理区域标注（双锚点包围）
          await this.processRegionAnnotations(el, ctx);

          // 🔧 防御性清理：隐藏阅读模式中泄漏的锚点文本
          // 某些情况下 Obsidian 未将 %%...%% 渲染为 Comment 节点（如内联锚点、
          // note 中含特殊字符导致格式损坏等），导致锚点元数据以纯文本暴露
          this.hideLeakedAnchorText(el);
        } catch (err) {
          console.error('MarkVault: post processor error', err);
        }
      });
    } catch (err) {
      console.error('MarkVault: failed to register markdown post processor', err);
    }

    // 🆕 全局事件委托：捕获阅读模式下对 markvault 标注的点击
    try {
      this.readingClickDelegate = new ReadingModeClickDelegate(this, {
        onOpenAnnotation: (uuid) => this.openAnnotationModal(uuid),
      });
      this.readingClickDelegate.setup();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode click delegate', err);
    }

    // ── 阅读模式：选中文本浮动工具条 ──
    try {
      const readingHost = {
        createReadingAnnotation: (req: { selectedText: string; color: string; type: AnnotationType; kind: Annotation['kind'] }) =>
          this.createReadingAnnotation(req.selectedText, req.color, req.type, req.kind),
        getDefaultColor: () => this.settings.defaultHighlightColor,
      };

      this.readingToolbar = new ReadingModeToolbar(this, readingHost);
      this.readingToolbar.setup();

      // 阅读模式右键竖排菜单已移除：功能与浮动工具条重复。
    } catch (err) {
      console.error('MarkVault: failed to register reading mode toolbar/context menu', err);
    }

    // 🆕 尝试从磁盘加载搜索引擎索引（避免启动时全量重建）
    await this._loadSearchIndex();

    console.log('MarkVault: plugin loaded successfully');
  }

  async onunload() {
    console.log('MarkVault: unloading plugin');
    // 🔧 BUG-8 修复：立即清除 CM6 EditorView 引用，防止异步 dispatch 到已销毁的 view
    // 避免 Obsidian 关闭标签页时 saveHistory→field() 触发 RangeError
    setActiveEditorView(null);
    try {
      // 🆕 持久化搜索引擎索引
      await this._saveSearchIndex();
      this.readingToolbar?.destroy();
      this.readingClickDelegate?.destroy();
      this.modifyGuard.releaseAll();
      await annotationStore.shutdown();
    } catch (err) {
      console.error('MarkVault: failed to shutdown AnnotationStore', err);
    }
  }

  // 🆕 搜索引擎索引持久化（避免启动时全量重建倒排索引）

  /** 索引文件路径（插件目录下） */
  private get _searchIndexPath(): string {
    return `${(this.app.vault.adapter as any).getBasePath?.() ?? ''}.obsidian/plugins/markvault-js/search-index.json`;
  }

  /** 从磁盘加载搜索索引快照 */
  private async _loadSearchIndex(): Promise<void> {
    try {
      const indexPath = '.obsidian/plugins/markvault-js/search-index.json';
      if (!(await this.app.vault.adapter.exists(indexPath))) return;

      const raw = await this.app.vault.adapter.read(indexPath);
      const snapshot = JSON.parse(raw);
      if (snapshot?.version !== 1) return; // 版本不匹配

      this.getSearchEngine().importIndex(snapshot);
      console.log(`MarkVault: loaded search index (${snapshot.indexedCount} annotations)`);
    } catch (err) {
      // 加载失败非致命——走正常的 _ensureIndex 延迟重建
      console.warn('MarkVault: failed to load search index, will rebuild on first search', err);
    }
  }

  /** 保存搜索索引快照到磁盘 */
  private async _saveSearchIndex(): Promise<void> {
    if (!this._searchEngine) return;
    try {
      const snapshot = this._searchEngine.exportIndex();
      const indexPath = '.obsidian/plugins/markvault-js/search-index.json';
      await this.app.vault.adapter.write(indexPath, JSON.stringify(snapshot));
      console.log('MarkVault: saved search index');
    } catch (err) {
      console.error('MarkVault: failed to save search index', err);
    }
  }

  // ─── 设置 ──────────────────────────────────────

  async loadSettings() {
    const data = await this.loadData();
    // loadData() 首次返回 null，Object.assign 能正确处理
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // v4.3: 兼容旧设置 — 如果没有 customRelationTypes，填充默认值
    if (!this.settings.customRelationTypes || this.settings.customRelationTypes.length === 0) {
      this.settings.customRelationTypes = DEFAULT_SETTINGS.customRelationTypes;
    }

    // v4.3: 重建 RelationSchema（设置加载后必须重建）
    this.relationSchema = new RelationSchema(this.settings.customRelationTypes);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ─── 侧边栏 ───────────────────────────────────

  async activateSidebar() {
    try {
      const existing = this.app.workspace.getLeavesOfType(MARKVAULT_SIDEBAR_VIEW_TYPE);
      if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        return;
      }
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: MARKVAULT_SIDEBAR_VIEW_TYPE,
          active: true,
        });
        this.app.workspace.revealLeaf(rightLeaf);
      }
    } catch (err) {
      console.error('MarkVault: failed to activate sidebar', err);
    }
  }

  async refreshSidebar() {
    try {
      if (this.sidebar) {
        await this.sidebar.refresh();
      }
    } catch (err) {
      console.error('MarkVault: failed to refresh sidebar', err);
    }
    // P2-7: 标注变更后同时刷新关系图谱
    this.refreshGraphView();
  }

  /** 激活关系图谱视图 */
  async activateGraphView() {
    try {
      const existing = this.app.workspace.getLeavesOfType(MARKVAULT_GRAPH_VIEW_TYPE);
      if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        if (this.graphView) {
          this.graphView.refresh();
        }
        return;
      }
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: MARKVAULT_GRAPH_VIEW_TYPE,
          active: true,
        });
        this.app.workspace.revealLeaf(leaf);
      }
    } catch (err) {
      console.error('MarkVault: failed to activate graph view', err);
    }
  }

  /** 刷新关系图谱视图 */
  refreshGraphView() {
    try {
      if (this.graphView) {
        this.graphView.refresh();
      }
    } catch (err) {
      console.error('MarkVault: failed to refresh graph view', err);
    }
  }

  // ─── 文件打开时同步 ────────────────────────────

  async onFileOpen(file: TFile) {
    // 🔧 BUG-5.1 修复：更新活跃的 EditorView 引用
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      const cmView = (activeView.editor as any).cm as import('@codemirror/view').EditorView | undefined;
      setActiveEditorView(cmView || null);
    }

    // 防重入：如果当前文件正在被插件自身修改，跳过此次同步
    if (this.modifyGuard.isLocked(file.path)) {
      return;
    }

    // 防重入：如果有标注正在被编辑（Modal 打开中），也跳过同步
    if (this._activeAnnotationFilePaths.has(file.path)) {
      return;
    }

    // 冷却期检查：文件最近被插件修改过，跳过短时间内重复的 sync
    // 大文件 vault.modify 后 Obsidian 的元数据重解析可能耗时 30s+，
    // 期间/之后触发的 file-open 事件不应再执行昂贵的全量同步
    const lastSync = this._syncCooldown.get(file.path);
    if (lastSync && (Date.now() - lastSync) < 30000) {
      return;
    }

    if (!this.settings.enableAutoSync) {
      return;
    }

    // 🔧 P1 修复：冷却期在 sync 开始前设置，防止并发 onFileOpen
    this._syncCooldown.set(file.path, Date.now());

    // 🔧 性能修复：onFileOpen 只做轻量级同步。
    // 分片 JSON 已在 initialize() 预加载，ensureFileLoaded 只读单文件分片；
    // 全量 syncFromMarkdown + recoverAndSyncOffsets + upgradeMarkdownAnnotations
    // 改由 rebuildDatabase 命令手动触发，避免大文件打开/修改后阻塞 UI 40s+。
    try {
      await annotationStore.ensureFileLoaded(file.path);
      await this.updateSpanCache(file.path);
      await this.updateRegionCache(file.path);

      // 刷新侧边栏调度到下一帧，避免阻塞当前事件循环并去重
      this.scheduleSidebarRefresh();
    } catch (err) {
      console.error('MarkVault: error in lightweight file open sync', file.path, err);
    }
  }

  /**
   * 强制同步当前文件：
   * 1. 从 Markdown 同步元数据（note / tags / color / type / fields / targetHash）
   * 2. 对行内标注执行偏移恢复
   * 3. 对 block/span 标注执行目标位置恢复（基于 targetHash 指纹）
   * 4. 更新 span 缓存并刷新侧边栏
   */
  async forceSyncFile(filePath: string): Promise<{
    added: number;
    updated: number;
    inlineRecovered: number;
    blocksRecovered: number;
    spansRecovered: number;
    failed: number;
  }> {
    if (!this._storeReady) {
      throw new Error('MarkVault: annotation database not initialized');
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`MarkVault: file not found: ${filePath}`);
    }

    // 防重入：文件正在被插件修改或 Modal 编辑中时跳过
    if (this.modifyGuard.isLocked(filePath)) {
      throw new Error('MarkVault: file is currently being modified by the plugin');
    }
    if (this._activeAnnotationFilePaths.has(filePath)) {
      throw new Error('MarkVault: an annotation modal is open for this file');
    }

    let added = 0;
    let updated = 0;
    let inlineRecovered = 0;
    let blocksRecovered = 0;
    let spansRecovered = 0;
    let failed = 0;

    this.modifyGuard.acquire(filePath);
    try {
      const content = await this.app.vault.read(file);

      // 1. 元数据同步
      const syncResult = await syncFromMarkdown(content, filePath);
      added = syncResult.added;
      updated = syncResult.updated;

      // 2. 行内标注偏移恢复
      const plainText = getPlainTextForOffsetRecovery(content);
      const inlineAnnotations = (await annotationStore.getAnnotationsForFile(filePath)).filter(
        (a) => !a.kind || a.kind === 'inline',
      );

      if (inlineAnnotations.length > 0 && plainText.length > 0) {
        const recoverResults = batchRecoverOffsets(plainText, inlineAnnotations);
        for (const r of recoverResults) {
          const ann = inlineAnnotations.find((a) => a.uuid === r.uuid);
          if (!ann) continue;

          const offsetChanged = r.startOffset !== ann.startOffset || r.endOffset !== ann.endOffset;
          if (offsetChanged) {
            const { contextBefore, contextAfter } = extractContextFromContent(
              plainText,
              r.startOffset,
              ann.text,
              this.settings.contextWindowSize,
            );
            await annotationStore.updateAnnotation(r.uuid, {
              startOffset: r.startOffset,
              endOffset: r.endOffset,
              contextBefore,
              contextAfter,
            });
            inlineRecovered++;
          }
        }
        failed += inlineAnnotations.length - recoverResults.length;
      }

      // 3. block / span 目标位置恢复
      const blockSpanAnnotations = (await annotationStore.getAnnotationsForFile(filePath)).filter(
        (a) => a.kind === 'block' || a.kind === 'span',
      );

      if (blockSpanAnnotations.length > 0) {
        const lines = content.split('\n');
        const anchors = parseBlockAnchors(content);
        const anchorByUuid = new Map(anchors.map((a) => [a.uuid, a]));
        const doubleRanges = new Map<string, ReturnType<typeof findBlockDoubleAnchorRange>>();
        for (const ann of blockSpanAnnotations) {
          if (ann.kind !== 'block') continue;
          const range = findBlockDoubleAnchorRange(content, ann.uuid);
          if (range) doubleRanges.set(ann.uuid, range);
        }

        for (const ann of blockSpanAnnotations) {
          const anchor = anchorByUuid.get(ann.uuid);
          const doubleRange = doubleRanges.get(ann.uuid);

          if (!anchor && !doubleRange) {
            // Markdown 中已找不到该锚点，无法自动恢复
            failed++;
            continue;
          }

          if (ann.kind === 'block') {
            // 优先使用新的双锚点范围进行精确恢复
            if (doubleRange) {
              const changed =
                doubleRange.targetLine !== ann.targetLine ||
                doubleRange.anchorLine !== ann.anchorLine ||
                doubleRange.startLine !== ann.startLine ||
                doubleRange.endLine !== ann.endLine ||
                doubleRange.text !== ann.text;
              if (changed) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: doubleRange.targetLine,
                  anchorLine: doubleRange.anchorLine,
                  startLine: doubleRange.startLine,
                  endLine: doubleRange.endLine,
                  text: doubleRange.text,
                  blockType: ann.blockType || detectBlockTypeAtLine(lines, doubleRange.targetLine),
                  targetHash: computeBlockSignature(lines, doubleRange.targetLine, ann.blockType) || computeSignature(doubleRange.text),
                });
                blocksRecovered++;
              }
              continue;
            }

            // 旧单锚点恢复逻辑
            const preferredLine = ann.targetLine ?? anchor!.anchorLine + 1;
            const currentSig = computeBlockSignature(lines, preferredLine, ann.blockType);

            if (ann.targetHash && currentSig && currentSig !== ann.targetHash) {
              const foundLine = findBlockLineBySignature(
                lines,
                ann.blockType || 'paragraph',
                ann.targetHash,
                preferredLine,
              );
              if (foundLine !== null) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: foundLine,
                  anchorLine: anchor!.anchorLine,
                  blockType: ann.blockType || detectBlockTypeAtLine(lines, foundLine),
                });
                blocksRecovered++;
              } else {
                failed++;
              }
            } else {
              // 指纹一致或没有指纹，仅同步 anchorLine
              if (anchor!.anchorLine !== ann.anchorLine) {
                await annotationStore.updateAnnotation(ann.uuid, { anchorLine: anchor!.anchorLine });
              }
            }
          } else if (ann.kind === 'span') {
            // 跳过锚点行、空行、特殊围栏，找到 span 实际内容起始行
            let actualTargetLine = anchor!.anchorLine + 1;
            for (let i = actualTargetLine; i < lines.length; i++) {
              const trimmed = lines[i].trim();
              if (
                trimmed.startsWith('%%markvault') ||
                trimmed === '$$' ||
                trimmed === '$$$' ||
                trimmed.startsWith('```') ||
                trimmed === ''
              ) {
                actualTargetLine = i + 1;
                continue;
              }
              actualTargetLine = i;
              break;
            }

            if (actualTargetLine < lines.length) {
              const endLine = findSpanEndLine(lines, actualTargetLine);
              const fullSpanText = lines.slice(actualTargetLine, endLine + 1).join('\n');
              const currentSig = computeSpanSignature(fullSpanText);

              // 如果指纹不匹配，在附近搜索
              if (ann.targetHash && currentSig && currentSig !== ann.targetHash) {
                const foundLine = findSpanLineBySignature(
                  lines,
                  ann.targetHash,
                  actualTargetLine,
                );
                if (foundLine !== null) {
                  actualTargetLine = foundLine;
                } else {
                  failed++;
                  continue;
                }
              }

              const newSpanRanges = computeSpanRanges(content, actualTargetLine, fullSpanText);
              const changed =
                actualTargetLine !== ann.targetLine ||
                anchor!.anchorLine !== ann.anchorLine ||
                JSON.stringify(newSpanRanges) !== JSON.stringify(ann.spanRanges);

              if (changed) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: actualTargetLine,
                  anchorLine: anchor!.anchorLine,
                  spanRanges: newSpanRanges,
                });
                spansRecovered++;
              }
            } else {
              failed++;
            }
          }
        }
      }

      // 3.5 region 标注位置恢复
      const regionAnnotations = (await annotationStore.getAnnotationsForFile(filePath)).filter(
        (a) => a.kind === 'region',
      );
      if (regionAnnotations.length > 0) {
        const parsedRegions = parseRegionAnnotations(content, filePath);
        const regionByUuid = new Map(parsedRegions.map((r) => [r.uuid, r]));

        for (const ann of regionAnnotations) {
          const parsed = regionByUuid.get(ann.uuid);
          if (!parsed) {
            failed++;
            continue;
          }

          const newEndLine = content.substring(0, parsed.endOffset).split('\n').length - 1;
          const changed =
            parsed.startOffset !== ann.startOffset ||
            parsed.endOffset !== ann.endOffset ||
            parsed.text !== ann.text;

          if (changed) {
            await annotationStore.updateAnnotation(ann.uuid, {
              startOffset: parsed.startOffset,
              endOffset: parsed.endOffset,
              startLine: parsed.startLine,
              endLine: newEndLine,
              text: parsed.text,
              targetHash: computeSpanSignature(parsed.text),
            });
          }
        }
      }

      // 4. 刷新缓存与 UI
      this.markFileSynced(filePath);
      await this.updateSpanCache(filePath);
      await this.updateRegionCache(filePath);
      this.scheduleSidebarRefresh();
    } finally {
      this.modifyGuard.release(filePath);
    }

    return { added, updated, inlineRecovered, blocksRecovered, spansRecovered, failed };
  }

  /** 调度侧边栏刷新，使用 requestAnimationFrame 并去重 */
  private scheduleSidebarRefresh(): void {
    if (this._pendingSidebarRefresh) return;
    this._pendingSidebarRefresh = true;

    requestAnimationFrame(() => {
      this._pendingSidebarRefresh = false;
      this.refreshSidebar().catch((err) => {
        console.error('MarkVault: scheduled sidebar refresh failed', err);
      });
    });
  }

  // ─── 增量偏移修正 ──────────────────────────────

  private pendingOffsetFix: Promise<void> | null = null;
  private pendingChanges: ChangeInfo[] = [];

  private handleDocChange(changes: ChangeInfo[]): void {
    if (!this.activeFilePath) return;

    // 累积变更，避免连续编辑时丢失中间变更
    this.pendingChanges.push(...changes);

    // 如果已经有处理任务在运行，直接返回；队列会被该任务消费
    if (this.pendingOffsetFix) return;

    this.pendingOffsetFix = (async () => {
      try {
        while (this.pendingChanges.length > 0) {
          // 取出当前队列中的所有变更
          const batch = this.pendingChanges.splice(0);

          const filePath = this.activeFilePath;
          if (!filePath) return;

          const annotations = await annotationStore.getAnnotationsForFile(filePath);
          if (annotations.length === 0) continue;

          const result = await applyIncrementalOffsetFix(filePath, batch, annotations);

          if (result.updated > 0 || result.deleted > 0) {
            console.log(`MarkVault: offset fix — updated: ${result.updated}, deleted: ${result.deleted}`);

            // 🔧 BUG-7 修复：偏移修正后刷新 span 缓存，确保 CM6 装饰使用最新偏移
            await this.updateSpanCache(filePath);
      await this.updateRegionCache(filePath);

            if (result.deleted > 0) {
              await this.refreshSidebar();
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

  // ─── 数据管理 ──────────────────────────────────

  /**
   * 处理块级锚点标注的阅读模式渲染
   * 支持三种锚点格式：
   * - %%markvault:uuid:type:color:note%%         旧单锚点 block
   * - %%markvault-span:uuid:type:color:note%%    span
   * - %%markvault-block:uuid:type:color:start|end:note%%  新双锚点 block
   *
   * 对单锚点和双锚点的 start 锚点，找到其后第一个内容块并添加装饰样式。
   */
  private async processBlockAnchors(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const sourcePath = ctx.sourcePath;
    // Obsidian 将 %%...%% 注释渲染为：
    //   - COMMENT_NODE（不可见，理想情况）
    //   - ELEMENT_NODE（可见，需要手动隐藏）
    // 遍历所有节点查找 markvault 锚点
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
    const anchorNodes: { uuid: string; type: string; color: string; note: string; node: Node; anchorKind: 'block' | 'span' }[] = [];
    const doubleAnchors = new Map<string, { start?: Node; end?: Node; type: string; color: string; note: string }>();

    const decodeNote = (raw: string) => raw.replace(/\\p/g, '%').replace(/\\c/g, ':');

    let currentNode: Node | null;
    while ((currentNode = walker.nextNode())) {
      if (currentNode.nodeType === Node.COMMENT_NODE) {
        // HTML 注释节点 — 天然不可见，无需隐藏
        const text = currentNode.textContent || '';
        // Block 格式：markvault:uuid:type:color:note
        const blockMatch = text.match(/^markvault:([^:]+):([^:]+):([^:]+):?([\s\S]*)$/);
        if (blockMatch) {
          anchorNodes.push({
            uuid: blockMatch[1],
            type: blockMatch[2],
            color: blockMatch[3],
            note: blockMatch[4] ? blockMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'block',
          });
        }
        // Span 格式：markvault-span:uuid:type:color:note
        const spanMatch = text.match(/^markvault-span:([^:]+):([^:]+):([^:]+):?([\s\S]*)$/);
        if (spanMatch) {
          anchorNodes.push({
            uuid: spanMatch[1],
            type: spanMatch[2],
            color: spanMatch[3],
            note: spanMatch[4] ? spanMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'span',
          });
        }
        // 双锚点 block 格式：markvault-block:uuid:type:color:start|end:note
        const doubleMatch = text.match(/^markvault-block:([^:]+):([^:]+):([^:]+):(start|end):?([\s\S]*)$/);
        if (doubleMatch) {
          const uuid = doubleMatch[1];
          const entry = doubleAnchors.get(uuid) || {
            type: doubleMatch[2],
            color: doubleMatch[3],
            note: doubleMatch[5] ? decodeNote(doubleMatch[5]) : '',
          };
          if (doubleMatch[4] === 'start') entry.start = currentNode;
          else entry.end = currentNode;
          doubleAnchors.set(uuid, entry);
        }
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
        // 检查是否有 Obsidian 的 comment 类名
        const htmlEl = currentNode as HTMLElement;
        if (htmlEl.className && typeof htmlEl.className === 'string' && htmlEl.className.includes('cm-')) {
          continue; // 跳过 CM6 元素
        }
        // Obsidian 有时将 %% 注释渲染为可见的 element
        // 需要检测并隐藏，否则 UUID 会暴露给用户
        const text = htmlEl.textContent || '';
        // Block 格式
        const blockMatch = text.match(/^%%markvault:([^:]+):([^:]+):([^:]+):?([\s\S]*)%%$/);
        if (blockMatch) {
          anchorNodes.push({
            uuid: blockMatch[1],
            type: blockMatch[2],
            color: blockMatch[3],
            note: blockMatch[4] ? blockMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'block',
          });
          continue;
        }
        // Span 格式
        const spanMatch = text.match(/^%%markvault-span:([^:]+):([^:]+):([^:]+):?([\s\S]*)%%$/);
        if (spanMatch) {
          anchorNodes.push({
            uuid: spanMatch[1],
            type: spanMatch[2],
            color: spanMatch[3],
            note: spanMatch[4] ? spanMatch[4].replace(/\\c/g, ':') : '',
            node: currentNode,
            anchorKind: 'span',
          });
          continue;
        }
        // 双锚点 block 格式
        const doubleMatch = text.match(/^%%markvault-block:([^:]+):([^:]+):([^:]+):(start|end):?([\s\S]*)%%$/);
        if (doubleMatch) {
          const uuid = doubleMatch[1];
          const entry = doubleAnchors.get(uuid) || {
            type: doubleMatch[2],
            color: doubleMatch[3],
            note: doubleMatch[5] ? decodeNote(doubleMatch[5]) : '',
          };
          if (doubleMatch[4] === 'start') entry.start = currentNode;
          else entry.end = currentNode;
          doubleAnchors.set(uuid, entry);
          // 可见锚点需要隐藏
          htmlEl.style.display = 'none';
          htmlEl.addClass('markvault-anchor-hidden');
          continue;
        }
      }
    }

    // 给 span 锚点下方的元素添加装饰（block 改走源码行号映射，避免 DOM 偏移）
    for (const anchor of anchorNodes) {
      // 隐藏锚点节点本身，防止 UUID 暴露
      if (anchor.node.nodeType === Node.ELEMENT_NODE) {
        const anchorEl = anchor.node as HTMLElement;
        anchorEl.style.display = 'none';
        anchorEl.addClass('markvault-anchor-hidden');
      }

      // span 仍使用 DOM 下一个内容元素；block 统一按源码行号映射
      if (anchor.anchorKind === 'span') {
        const targetEl = this.findNextContentElement(anchor.node);
        if (targetEl) {
          this.applyBlockDecoration(targetEl, anchor.uuid, anchor.type, anchor.color, anchor.note, anchor.anchorKind, sourcePath);
        }
      }
    }

    // 处理 block 锚点（旧单锚点 + 新双锚点）：统一按源码行号映射到当前 section 的叶子块。
    // 即使 Obsidian 把 %%...%% 注释剥离，也能正确高亮。
    const decoratedUuids = await this.applyBlockDecorationsFromSource(el, ctx, sourcePath);

    // 安全网：源码行号映射未覆盖的 block 锚点，回退到 DOM 下一个内容元素
    for (const anchor of anchorNodes) {
      if (anchor.anchorKind === 'block' && !decoratedUuids.has(anchor.uuid)) {
        const targetEl = this.findNextContentElement(anchor.node);
        if (targetEl) {
          this.applyBlockDecoration(targetEl, anchor.uuid, anchor.type, anchor.color, anchor.note, 'block', sourcePath);
        }
      }
    }
    for (const [uuid, entry] of doubleAnchors.entries()) {
      if (entry.start && !decoratedUuids.has(uuid)) {
        const targetEl = this.findNextContentElement(entry.start);
        if (targetEl) {
          this.applyBlockDecoration(targetEl, uuid, entry.type, entry.color, entry.note, 'block', sourcePath);
        }
      }
    }
  }

  /**
   * 给阅读模式下的目标块元素添加 block/span 装饰、徽章与批注指示器
   */
  private applyBlockDecoration(
    targetEl: HTMLElement,
    uuid: string,
    type: string,
    color: string,
    note: string,
    anchorKind: 'block' | 'span',
    sourcePath: string,
  ): void {
    targetEl.addClass('markvault-block-mark');
    targetEl.addClass(`markvault-block-${type}`);
    targetEl.addClass(`markvault-block-${color}`);
    targetEl.style.cursor = 'pointer';
    targetEl.dataset.uuid = uuid;

    if (anchorKind === 'span') {
      targetEl.addClass('markvault-span-mark');
      this.highlightSpanFragments(targetEl, uuid, type, color, sourcePath).catch((err) => {
        console.error('MarkVault: failed to highlight span fragments', err);
      });
    }

    if (anchorKind === 'block') {
      const typeIcon = type === 'bold' ? '𝗕' : type === 'underline' ? 'U̲' : '🎨';
      const badge = document.createElement('span');
      badge.className = `markvault-block-type-badge markvault-block-badge-type-${type} markvault-block-badge-color-${color}`;
      const iconSpan = document.createElement('span');
      iconSpan.className = 'markvault-block-type-badge-icon';
      iconSpan.textContent = typeIcon;
      const dot = document.createElement('span');
      dot.className = 'markvault-block-type-badge-dot';
      badge.appendChild(iconSpan);
      badge.appendChild(dot);
      targetEl.style.position = 'relative';
      targetEl.appendChild(badge);
    }

    if (note) {
      const indicator = document.createElement('span');
      indicator.className = 'markvault-block-note-indicator';
      indicator.textContent = '📝';
      indicator.title = note;
      targetEl.style.position = 'relative';
      targetEl.appendChild(indicator);
    }
  }

  /**
   * 判断 a 是否在 b 之前（按文档顺序）
   */
  private isNodeBefore(a: Node, b: Node): boolean {
    const position = a.compareDocumentPosition(b);
    return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  /**
   * 从源码行号映射，给当前 section 内的 block 锚点（旧单锚点 + 新双锚点）
   * 添加阅读模式装饰。即使 Obsidian 把 %%...%% 注释剥离，也能正确高亮。
   */
  private async applyBlockDecorationsFromSource(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    sourcePath: string,
  ): Promise<Set<string>> {
    const decorated = new Set<string>();
    const info = ctx.getSectionInfo(el);
    if (!info) return decorated;

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return decorated;

    try {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split('\n');
      const sectionStart = info.lineStart;
      const sectionEnd = info.lineEnd;

      interface BlockAnchorMatch {
        uuid: string;
        type: string;
        color: string;
        note: string;
        startLine: number;
        endLine: number;
      }
      const matches: BlockAnchorMatch[] = [];

      // 旧单锚点 %%markvault:uuid:type:color:note%%
      // 整篇扫描：锚点可能在目标块之前的 section 里（如列表首项）
      const oldRegex = /^%%markvault:([^:%]+):([^:%]+):([^:%]+):([^%]*)%%$/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trim().match(oldRegex);
        if (!m) continue;
        const targetLine = findBlockTargetLine(content, i);
        if (targetLine > sectionEnd || targetLine < sectionStart) continue;
        matches.push({
          uuid: m[1],
          type: m[2],
          color: m[3],
          note: m[4].replace(/\\c/g, ':').replace(/\\p/g, '%'),
          startLine: targetLine,
          endLine: targetLine,
        });
      }

      // 新双锚点 %%markvault-block:uuid:type:color:start|end:note%%
      // 整篇扫描；只要目标区间与当前 section 有重叠就处理
      const doubleAnchors = parseBlockDoubleAnchors(content);
      const doubleByUuid = new Map<string, { start?: typeof doubleAnchors[0]; end?: typeof doubleAnchors[0] }>();
      for (const a of doubleAnchors) {
        const entry = doubleByUuid.get(a.uuid) || {};
        if (a.position === 'start') {
          if (!entry.start) entry.start = a;
        } else {
          if (!entry.end) entry.end = a;
        }
        doubleByUuid.set(a.uuid, entry);
      }
      for (const [uuid, entry] of doubleByUuid.entries()) {
        if (!entry.start) continue;
        const startLine = findBlockTargetLine(content, entry.start.anchorLine);
        const endLine = entry.end ? findBlockContentEndLine(content, entry.end.anchorLine) : startLine;
        if (endLine < startLine) continue;
        if (endLine < sectionStart || startLine > sectionEnd) continue;
        matches.push({
          uuid,
          type: entry.start.type,
          color: entry.start.color,
          note: entry.start.note,
          startLine,
          endLine,
        });
      }

      if (matches.length === 0) return decorated;

      const leafBlocks = this.collectLeafBlocks(el);
      if (leafBlocks.length === 0) return decorated;

      const blockStarts = this.computeBlockStarts(lines, sectionStart, sectionEnd);

      // 🔧 DEBUG: 打印当前 section 的映射关系
      console.log('[MarkVault DEBUG] applyBlockDecorationsFromSource', {
        sourcePath,
        sectionStart,
        sectionEnd,
        blockStarts,
        leafBlocks: leafBlocks.map(b => ({ tag: b.tagName, text: (b.textContent ?? '').slice(0, 60).replace(/\n/g, '\\n') })),
        matches: matches.map(m => ({ uuid: m.uuid, startLine: m.startLine, endLine: m.endLine })),
      });

      for (const match of matches) {
        // 收集所有 blockStart 落在 [startLine, endLine] 区间内的叶子块
        const targetIndices: number[] = [];
        for (let i = 0; i < blockStarts.length; i++) {
          const absLine = sectionStart + blockStarts[i];
          if (absLine >= match.startLine && absLine <= match.endLine) {
            targetIndices.push(i);
          }
        }
        if (targetIndices.length > 0) {
          decorated.add(match.uuid);
        }

        // 找不到精确区间时，退而求其次：找最近的前一个块
        if (targetIndices.length === 0) {
          let nearest = -1;
          for (let i = 0; i < blockStarts.length; i++) {
            if (sectionStart + blockStarts[i] <= match.startLine) {
              nearest = i;
            } else {
              break;
            }
          }
          if (nearest !== -1) targetIndices.push(nearest);
        }

        console.log('[MarkVault DEBUG] decorate uuid', match.uuid, 'targetIndices', targetIndices, 'targetElements',
          targetIndices.map(i => leafBlocks[i]?.tagName + ':' + (leafBlocks[i]?.textContent ?? '').slice(0, 40).replace(/\n/g, '\\n')));

        for (let k = 0; k < targetIndices.length; k++) {
          const idx = targetIndices[k];
          const targetEl = leafBlocks[idx];
          if (!targetEl) continue;

          targetEl.addClass('markvault-block-mark');
          targetEl.addClass(`markvault-block-${match.type}`);
          targetEl.addClass(`markvault-block-${match.color}`);
          targetEl.style.cursor = 'pointer';
          targetEl.dataset.uuid = match.uuid;

          // 仅在第一个目标块上添加徽章和批注指示器，
          // 避免跨多个 <li>/段落 的块出现多个重叠徽章。
          if (k === 0) {
            const typeIcon = match.type === 'bold' ? '𝗕' : match.type === 'underline' ? 'U̲' : '🎨';
            const badge = document.createElement('span');
            badge.className = `markvault-block-type-badge markvault-block-badge-type-${match.type} markvault-block-badge-color-${match.color}`;
            const iconSpan = document.createElement('span');
            iconSpan.className = 'markvault-block-type-badge-icon';
            iconSpan.textContent = typeIcon;
            const dot = document.createElement('span');
            dot.className = 'markvault-block-type-badge-dot';
            badge.appendChild(iconSpan);
            badge.appendChild(dot);
            targetEl.style.position = 'relative';
            targetEl.appendChild(badge);

            if (match.note) {
              const indicator = document.createElement('span');
              indicator.className = 'markvault-block-note-indicator';
              indicator.textContent = '📝';
              indicator.title = match.note;
              targetEl.style.position = 'relative';
              targetEl.appendChild(indicator);
            }
          }
        }
      }
    } catch (err) {
      console.error('MarkVault: block decoration from source failed', err);
    }
    return decorated;
  }

  /**
   * 收集当前 section 内可作为块级标注目标的叶子块元素（按文档顺序）。
   * <li> / .callout 被视为叶子，避免整个列表/Callout 被染色。
   */
  private collectLeafBlocks(root: HTMLElement): HTMLElement[] {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    const candidates: HTMLElement[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const el = node as HTMLElement;
      if (
        el.hasClass('markvault-anchor-hidden') ||
        el.hasClass('markvault-leaked-anchor-hidden') ||
        el.hasClass('markvault-region-anchor-hidden')
      ) continue;
      // 已经 inline 隐藏的锚点容器（如阅读模式尚未走到隐藏逻辑的 region 锚点）直接跳过
      if (el.style.display === 'none') continue;

      const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');
      if (!isBlock) continue;

      // 跳过仅包含锚点文本的容器，避免其进入 leaf 索引导致行号映射错位
      const text = (el.textContent ?? '').trim();
      if (/^%%(markvault|markvault-span|markvault-region|markvault-block):/.test(text) && text.endsWith('%%')) {
        continue;
      }

      if (el.tagName === 'LI' || el.hasClass('callout')) {
        candidates.push(el);
        continue;
      }

      const hasBlockChild = Array.from(el.children).some(
        child => blockTags.has((child as HTMLElement).tagName) || (child as HTMLElement).hasClass?.('callout')
      );
      if (!hasBlockChild) {
        candidates.push(el);
      }
    }

    return candidates
      .filter((el) => !candidates.some(other => other !== el && other.contains(el)))
      // 过滤掉只包含隐藏锚点或完全为空的叶子块，避免行号映射时指到空段落
      .filter((el) => (el.innerText ?? el.textContent ?? '').trim().length > 0);
  }

  /**
   * 计算 section 内各内容块的起始行（相对于 sectionStart 的偏移）。
   * 用于把源码行号映射到 DOM 中的第几个叶子块。
   */
  private computeBlockStarts(lines: string[], sectionStart: number, sectionEnd: number): number[] {
    const starts: number[] = [];
    let inParagraph = false;
    let inCode = false;
    let inCallout = false;
    let inQuote = false;
    let inTable = false;

    for (let i = sectionStart; i <= sectionEnd && i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trimStart();
      const trimmed = raw.trim();
      const isBlank = trimmed === '';
      const isAnchor = /^%%(markvault|markvault-span|markvault-region|markvault-block):/.test(trimmed);

      if (isBlank) {
        inParagraph = false;
        if (!inCode) {
          inCallout = false;
          inQuote = false;
          inTable = false;
        }
        continue;
      }

      if (isAnchor) {
        inParagraph = false;
        if (!inCode) {
          inCallout = false;
          inQuote = false;
          inTable = false;
        }
        continue;
      }

      if (/^\s*```/.test(raw)) {
        if (!inCode) {
          starts.push(i - sectionStart);
          inCode = true;
        } else {
          inCode = false;
        }
        inParagraph = false;
        inCallout = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (inCode) continue;

      if (/^\s*#{1,6}\s/.test(line)) {
        starts.push(i - sectionStart);
        inParagraph = false;
        inCallout = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (/^\s*([-]{3,}|[*]{3,}|[_]{3,})\s*$/.test(trimmed)) {
        starts.push(i - sectionStart);
        inParagraph = false;
        continue;
      }

      if (/^\s*>\s*\[!/.test(line)) {
        starts.push(i - sectionStart);
        inCallout = true;
        inParagraph = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (inCallout) continue;

      if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
        starts.push(i - sectionStart);
        inParagraph = false;
        inQuote = false;
        inTable = false;
        continue;
      }

      if (/^\s*>/.test(line)) {
        if (!inQuote) starts.push(i - sectionStart);
        inQuote = true;
        inParagraph = false;
        inTable = false;
        continue;
      }

      if (inQuote) continue;

      if (/^\s*\|/.test(line)) {
        if (!inTable) starts.push(i - sectionStart);
        inTable = true;
        inParagraph = false;
        continue;
      }

      if (inTable) continue;

      if (!inParagraph) {
        starts.push(i - sectionStart);
        inParagraph = true;
      }
    }

    return starts;
  }

  /**
   * 处理自然 Markdown 语法标注（隐身锚点 + 原生包裹）
   * 在阅读模式 DOM 中，Obsidian 会将 %%mv:i:uuid:type:color%% 渲染为 COMMENT 节点。
   * 我们找到该注释节点，给紧随其后的原生元素（<mark>/<strong>/<u>）加上颜色、点击等样式。
   */
  private async processNativeAnnotations(el: HTMLElement, sourcePath: string): Promise<void> {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT);
    const anchors: { node: Comment; uuid: string; type: AnnotationType; color: string }[] = [];

    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const text = node.textContent || '';
      const match = text.match(/^mv:i:([^:]+):([^:]+):([^:]+)$/);
      if (match) {
        anchors.push({
          node: node as Comment,
          uuid: match[1],
          type: match[2] as AnnotationType,
          color: match[3],
        });
      }
    }

    for (const anchor of anchors) {
      const targetEl = this.findNextContentElement(anchor.node);
      if (!targetEl) continue;

      const annotation = await getAnnotationByUuid(anchor.uuid);
      const type = anchor.type;
      const color = anchor.color;

      // 确保 wrapper 元素携带识别 class 与 data-uuid
      // 视觉样式完全由 CSS class（markvault-<type> + markvault-<color>）控制
      targetEl.addClass('markvault-native', `markvault-${type}`, `markvault-${color}`, 'markvault-clickable');
      targetEl.dataset.uuid = anchor.uuid;
      targetEl.dataset.type = type;
      targetEl.dataset.color = color;
      targetEl.style.cursor = 'pointer';

      if (annotation?.note) {
        targetEl.setAttribute('title', annotation.note);
        targetEl.addClass('markvault-has-note');
      }
    }
  }

  /**
   * 在阅读模式下处理 region 标注（双锚点包围区域）
   *
   * 🔧 BUG-5.2 修复：支持跨 section 的 region 标注
   *
   * Obsidian 的 post-processor 每个 section 调用一次。
   * 如果 region 跨多个 section，start/end Comment 会在不同的 el 中。
   *
   * 策略：
   * A. 当前 section 内同时有 start + end → 精确高亮
   * B. 当前 section 只有 start → 高亮 start 到 section 末尾
   * C. 当前 section 只有 end → 高亮 section 开头到 end
   * D. 当前 section 完全在 region 内（无 start 也无 end）→ 高亮整个 section
   * E. Comment 节点被 Obsidian 剥离 → fallback 用 section 行范围匹配
   */
  /**
   * Region 标注阅读模式渲染（基于 Block 架构重写）
   *
   * 核心思路：Region 是 Block 的异化版本。
   * - Block：光标命中块 → 标记整块；Region：选中文本 → 标记文本所在连续行
   * - 复用 Block 的源码行号映射 + collectLeafBlocks + computeBlockStarts 管线
   * - 差异：Region 用 markvault-region-block-mark 样式 + 首尾 ▸/◂ 标记
   *   annotation.text 存精确选中文本（非整行）
   */
  private async processRegionAnnotations(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const sourcePath = ctx.sourcePath;
    const info = ctx.getSectionInfo(el);
    if (!info) return;

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split('\n');
      const sectionStart = info.lineStart;
      const sectionEnd = info.lineEnd;

      // 1. 用现有 parseRegionAnnotations 解析全文件（支持内联锚点、跨行等）
      const regions = parseRegionAnnotations(content, sourcePath);
      if (regions.length === 0) return;

      // 2. 过滤：只保留与当前 section 有重叠的 region
      const matched = regions.filter(r => {
        const rs = r.startLine ?? 0;
        const re = r.endLine ?? rs;
        return rs <= sectionEnd && re >= sectionStart;
      });
      if (matched.length === 0) return;

      // 3. 复用 Block 的基础设施（为 Region 补充被跳过的锚点行）
      const leafBlocks = this.collectLeafBlocks(el);
      if (leafBlocks.length === 0) return;
      const blockStarts = this.computeBlockStarts(lines, sectionStart, sectionEnd);

      // 补充：computeBlockStarts 会跳过以 %%markvault-region: 开头的行，
      // 但单行 region 的锚点行本身就是内容行，必须纳入映射。
      // 注意：callout 内 > 开头的锚点行会导致 blockStarts 比 leafBlocks 多，
      // 所以只补充非 callout 内的锚点行
      for (let i = sectionStart; i <= sectionEnd && i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (/^%%markvault-region:/.test(trimmed) && !trimmed.startsWith('>')) {
          const rel = i - sectionStart;
          if (!blockStarts.includes(rel)) blockStarts.push(rel);
        }
      }
      blockStarts.sort((a, b) => a - b);

      // 4. 行号映射到叶子块 + Block 风格背景渲染
      for (const region of matched) {
        const rs = region.startLine ?? 0;
        const re = region.endLine ?? rs;

        let targetIndices: number[] = [];
        for (let i = 0; i < blockStarts.length; i++) {
          const absLine = sectionStart + blockStarts[i];
          if (absLine >= rs && absLine <= re) {
            targetIndices.push(i);
          }
        }

        // 过滤：只保留在 leafBlocks 范围内的索引
        targetIndices = targetIndices.filter(i => i < leafBlocks.length);

        // 兜底：Callout/blockquote 内锚点行（> 开头），锚点行本身不在 blockStarts，
        // 向上一行偏移到 Callout 头部行重新匹配
        if (targetIndices.length === 0 && rs > 0 && lines[rs]?.trimStart().startsWith('>')) {
          const adjustedRs = rs - 1;
          for (let i = 0; i < blockStarts.length; i++) {
            const absLine = sectionStart + blockStarts[i];
            if (absLine >= adjustedRs && absLine <= re) {
              targetIndices.push(i);
            }
          }
          targetIndices = targetIndices.filter(i => i < leafBlocks.length);
        }
        if (targetIndices.length === 0) continue;

        for (let k = 0; k < targetIndices.length; k++) {
          const idx = targetIndices[k];
          const targetEl = leafBlocks[idx];
          if (!targetEl) continue;

          const isFirst = k === 0;
          const isLast = k === targetIndices.length - 1;

          targetEl.addClass(
            'markvault-region-block-mark',
            `markvault-region-${region.type}`,
            `markvault-region-${region.color}`,
            'markvault-clickable',
          );
          if (isFirst) targetEl.addClass('markvault-region-block-first');
          if (isLast) targetEl.addClass('markvault-region-block-last');
          if (!isFirst && !isLast) targetEl.addClass('markvault-region-block-middle');
          targetEl.dataset.uuid = region.uuid;
          targetEl.dataset.type = region.type;
          targetEl.dataset.color = region.color;
          targetEl.style.cursor = 'pointer';

          if (k === 0) {
            this.addRegionBadge(targetEl, region.type as AnnotationType, region.color, region.note);
            if (region.note) {
              targetEl.setAttribute('title', region.note);
              targetEl.addClass('markvault-has-note');
            }
          }
        }
      }
    } catch (err) {
      console.error('MarkVault: region decoration failed', err);
    }
  }

  /**
   * 高亮 region 两个锚点之间的 DOM 节点
   *
   * 🔧 关键修复：当 start/end 在同一块元素（如 <li>）内时，
   * 不给任何块级元素添加 markvault-region 背景类（会导致整块染色）。
   * 只精确包裹文本节点为带背景的 <span>。
   */
  /**
   * 🔧 NEW: Region 段落级整块高亮
   *
   * 选中文字所在段落（或列表项）作为一个整体块进行高亮，行为与 Block 标注类似。
   * 如果 start/end 跨越多个段落，则高亮中间所有叶子块级元素。
   */
  private highlightRegionBlocks(
    root: HTMLElement,
    start: Node,
    end: Node,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): HTMLElement | null {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    const startBlock = this.findNearestBlockAncestor(start, blockTags);
    const endBlock = this.findNearestBlockAncestor(end, blockTags);
    if (!startBlock || !endBlock) return null;

    // 收集从 startBlock 到 endBlock 之间的所有叶子块级元素
    const targets: HTMLElement[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let collecting = false;
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const el = node as HTMLElement;
      if (!blockTags.has(el.tagName) && !el.hasClass('callout')) continue;

      // 跳过容器块（如包含其他块的 <div>、<ul>、<ol>）
      const hasBlockChildren = Array.from(el.children).some(
        child => blockTags.has((child as HTMLElement).tagName) || (child as HTMLElement).hasClass?.('callout')
      );
      if (hasBlockChildren) continue;

      if (el === startBlock || el.contains(startBlock) || startBlock.contains(el)) {
        collecting = true;
      }
      if (collecting && !targets.includes(el)) {
        targets.push(el);
      }
      if (el === endBlock || el.contains(endBlock) || endBlock.contains(el)) {
        break;
      }
    }

    // 兜底：至少高亮 startBlock
    if (targets.length === 0) {
      targets.push(startBlock);
    }

    for (let i = 0; i < targets.length; i++) {
      const el = targets[i];
      const positionClass = i === 0 && targets.length === 1
        ? 'markvault-region-block-first markvault-region-block-last'
        : i === 0
          ? 'markvault-region-block-first'
          : i === targets.length - 1
            ? 'markvault-region-block-last'
            : 'markvault-region-block-middle';
      el.addClass('markvault-region-block-mark', positionClass, `markvault-region-${type}`, `markvault-region-${color}`, 'markvault-clickable');
      el.dataset.uuid = uuid;
      el.dataset.type = type;
      el.dataset.color = color;
      el.style.cursor = 'pointer';
    }

    return targets[0] ?? null;
  }

  /**
   * 🔧 NEW: 找到节点的最近块级祖先元素
   */
  private findNearestBlockAncestor(node: Node, blockTags: Set<string>): HTMLElement | null {
    let current: Node | null = node.parentNode;
    while (current && current !== document.body) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as HTMLElement;
        if (blockTags.has(el.tagName) || el.hasClass('callout')) return el;
      }
      current = current.parentNode;
    }
    return null;
  }

  /**
   * 🔧 防御性清理：隐藏阅读模式中泄漏的 markvault 锚点文本
   *
   * 某些情况下 Obsidian 未将 %%...%% 渲染为 Comment 节点：
   * - 内联锚点（不在独立行上）
   * - note 中含特殊字符导致锚点格式损坏
   * - Obsidian 版本差异
   *
   * 结果是锚点元数据以纯文本暴露在阅读视图中。
   * 此方法遍历 DOM 文本节点，找到匹配的锚点文本并隐藏。
   *
   * 🔧 关键修复：使用 [^\n]*? 替代 [^%]*，能匹配含 % 的锚点文本。
   */
  private hideLeakedAnchorText(root: HTMLElement): void {
    // 匹配所有可能的 markvault 锚点文本模式
    // 🔧 关键修复：使用 [^\n]*? 替代 [^%]*，能匹配含 % 的锚点文本
    const ANCHOR_PATTERNS = [
      /%%markvault-region:[^\n]*?%%/g,          // 完整 region 锚点
      /%%markvault(-span|-block)?:[^\n]*?%%/g,  // 完整 block/span/双锚点 block 锚点
      /%%mv:i:[^\n]*?%%/g,                     // 完整 native 锚点
      /%+markvault[^\n]*?%+/g,                 // 损坏的锚点（分隔符不完整）
    ];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      textNodes.push(node as Text);
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || '';
      if (!text.includes('markvault') && !text.includes('mv:i')) continue;

      // 检查是否匹配任何锚点模式
      for (const pattern of ANCHOR_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          // 找到泄漏的锚点文本 → 隐藏整个文本节点
          const wrapper = document.createElement('span');
          wrapper.className = 'markvault-leaked-anchor-hidden';
          wrapper.style.display = 'none';
          wrapper.textContent = text;
          textNode.parentNode?.replaceChild(wrapper, textNode);
          console.debug('MarkVault: hid leaked anchor text in reading mode');
          break; // 已经隐藏，不需要检查其他 pattern
        }
      }
    }
  }

  /**
   * 🔧 NEW: 从文本节点中提取内联的 region 锚点，替换为隐藏 span 并记录位置。
   * 这是让内联 region 锚点（锚点与正文在同一行）也能走段落级整块渲染的关键。
   */
  private extractInlineRegionAnchors(
    root: HTMLElement,
    regionAnchors: Map<string, { start?: Node; end?: Node; type: AnnotationType; color: string }>,
    anchorNodesToHide: Set<Node>,
  ): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const text = node.textContent || '';
      if (text.includes('markvault-region')) textNodes.push(node as Text);
    }

    for (const textNode of textNodes) {
      const parentEl = textNode.parentElement;
      if (
        parentEl?.hasClass('markvault-region-anchor-hidden') ||
        parentEl?.hasClass('markvault-anchor-hidden') ||
        parentEl?.hasClass('markvault-leaked-anchor-hidden')
      ) {
        continue;
      }
      this.extractInlineRegionAnchorsFromTextNode(textNode, regionAnchors, anchorNodesToHide);
    }
  }

  private extractInlineRegionAnchorsFromTextNode(
    textNode: Text,
    regionAnchors: Map<string, { start?: Node; end?: Node; type: AnnotationType; color: string }>,
    anchorNodesToHide: Set<Node>,
  ): void {
    const text = textNode.textContent || '';
    const regex = /%%markvault-region:([^:%]+):([^:%]+):([^:%]+):(start|end):([^%]*)%%/g;
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push(match);
    }
    if (matches.length === 0) return;

    const parent = textNode.parentNode;
    if (!parent) return;

    let lastIndex = 0;
    for (const m of matches) {
      if (m.index > lastIndex) {
        parent.insertBefore(document.createTextNode(text.substring(lastIndex, m.index)), textNode);
      }

      const span = document.createElement('span');
      span.className = 'markvault-region-anchor-hidden';
      span.style.display = 'none';
      span.textContent = m[0];
      parent.insertBefore(span, textNode);

      const uuid = m[1];
      const type = m[2] as AnnotationType;
      const color = m[3];
      const pos = m[4] as 'start' | 'end';
      const entry = regionAnchors.get(uuid) || { type, color };
      if (pos === 'start') entry.start = span;
      else entry.end = span;
      regionAnchors.set(uuid, entry);
      anchorNodesToHide.add(span);

      lastIndex = m.index + m[0].length;
    }

    if (lastIndex < text.length) {
      parent.insertBefore(document.createTextNode(text.substring(lastIndex)), textNode);
    }
    parent.removeChild(textNode);
  }

  /**
   * 给整个 section 加 region 样式（fallback 用，不依赖 comment 节点）
   *
   * 🔧 关键修复：不给容器块元素（如 <ul>/<ol>）添加 markvault-region 背景类。
   * 容器块包含多个子块（如多个 <li>），给容器加背景会导致整个列表被染色。
   * 只给叶子块元素（不包含其他块级子元素的块）添加背景。
   */
  private applyRegionStyleToSection(root: HTMLElement, uuid: string, type: AnnotationType, color: string, regionText?: string): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const styledAncestors = new Set<Element>();
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    const normalizedRegionText = regionText ? this.normalizeRegionMatchText(regionText) : undefined;
    const regionTokens = normalizedRegionText ? this.tokenizeRegionMatchText(normalizedRegionText) : [];

    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      // 跳过不可见/无意义节点
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as HTMLElement).tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      }

      // 如果已经在某个被样式化的祖先内部，跳过避免重复处理
      let ancestor: Element | null = node.parentElement;
      let skip = false;
      while (ancestor && ancestor !== root) {
        if (styledAncestors.has(ancestor)) {
          skip = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (skip) continue;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');

        // 🔧 关键修复：跳过容器块元素（包含其他块级子元素的块）
        // 容器块（如 <ul>/<ol>）加背景会导致整段列表被染色
        if (isBlock) {
          const hasBlockChildren = Array.from(el.children).some(
            child => blockTags.has(child.tagName) || (child as HTMLElement).hasClass?.('callout')
          );
          if (hasBlockChildren) {
            // 容器块：不在这里加样式，让 TreeWalker 继续遍历其子节点，
            // 避免整段列表/嵌套块被染色，同时保证内部叶子块能被正确处理。
            continue;
          }
        }

        // 🔧 fallback 限域：只有块文本与 region 文本相关时才染色，避免扩到整段/整列表
        if (normalizedRegionText) {
          const blockText = this.normalizeRegionMatchText(el.textContent || '');
          const containsRegion = blockText.includes(normalizedRegionText);
          const containedByRegion = normalizedRegionText.includes(blockText) && blockText.length > 0;
          if (!containsRegion && !containedByRegion) {
            const matchedTokens = regionTokens.filter(t => blockText.includes(t)).length;
            if (regionTokens.length === 0 || matchedTokens / regionTokens.length < 0.5) {
              continue;
            }
          }
        }

        // 块级元素只加左侧竖线，文本节点包裹为 inline span，避免整块大色块
        this.styleRegionBlockBorderAndText(el, uuid, type, color);
        styledAncestors.add(el);
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (!text.trim()) continue;
        const parent = node.parentElement;
        if (parent?.hasClass('markvault-region')) continue;
        const span = document.createElement('span');
        span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
        span.dataset.uuid = uuid;
        span.dataset.type = type;
        span.dataset.color = color;
        span.style.cursor = 'pointer';
        span.textContent = text;
        node.parentNode?.replaceChild(span, node);
      }
    }
  }

  /**
   * 给块级元素加左侧竖线，并把其内部文本节点包裹为 inline span
   * 用于阅读模式 fallback，避免整块大色块。
   */
  private styleRegionBlockBorderAndText(
    el: HTMLElement,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    el.addClass('markvault-region-block-border', `markvault-region-${color}`, 'markvault-clickable');
    el.dataset.uuid = uuid;
    el.dataset.type = type;
    el.dataset.color = color;
    el.style.cursor = 'pointer';

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode()) !== null) {
      textNodes.push(n as Text);
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || '';
      if (!text.trim()) continue;
      const parent = textNode.parentElement;
      if (parent?.hasClass('markvault-region')) continue;

      const span = document.createElement('span');
      span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
      span.dataset.uuid = uuid;
      span.dataset.type = type;
      span.dataset.color = color;
      span.style.cursor = 'pointer';
      span.textContent = text;
      textNode.parentNode?.replaceChild(span, textNode);
    }
  }

  /**
   * 归一化 region/块文本，用于 fallback 限域匹配
   */
  private normalizeRegionMatchText(text: string): string {
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[*=_~`#\[\]()|<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 把 region 文本拆成可用于限域匹配的词元
   */
  private tokenizeRegionMatchText(text: string): string[] {
    return text
      .split(/[\s,.;:!?，。；：！？、（）()\[\]【】《》""''「」『』—–\-\/\\]+/)
      .filter(token => token.length >= 2);
  }

  /**
   * 精确匹配 section 内的 region 内容并高亮，避免把整个 section（如一整个 <ol>）染色。
   * 返回第一个被包裹的元素（用于后续加徽章）；失败返回 null。
   *
   * 🔧 关键修复：使用 REGION_ANCHOR_REGEX 搜索锚点位置，而非 buildRegionAnchor。
   * buildRegionAnchor 会生成转义后的锚点字符串（如 \p 替换 %），
   * 与源文件中的原始锚点不匹配，导致精确匹配失败回退到 applyRegionStyleToSection。
   */
  private applyRegionStyleToSectionPrecise(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
    // 用 REGION_ANCHOR_REGEX 在 section 源文本中搜索 start/end 锚点位置
    let srcStart = -1;
    let srcEnd = sectionSource.length;

    REGION_ANCHOR_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REGION_ANCHOR_REGEX.exec(sectionSource)) !== null) {
      const uuid = m[1];
      const pos = m[4] as 'start' | 'end';
      if (uuid === region.uuid && pos === 'start') {
        srcStart = m.index + m[0].length;
      } else if (uuid === region.uuid && pos === 'end') {
        srcEnd = m.index;
      }
    }

    if (srcStart === -1) {
      // 未能找到 start 锚点，用 buildRegionAnchor 兜底尝试
      const startAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'start');
      const endAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'end');

      const startIdx = sectionSource.indexOf(startAnchor);
      if (startIdx !== -1) srcStart = startIdx + startAnchor.length;

      const endIdx = sectionSource.indexOf(endAnchor);
      if (endIdx !== -1) srcEnd = endIdx;
    }

    if (srcStart === -1 || srcStart >= srcEnd) return null;

    const { plain, map } = markdownToPlainWithMap(sectionSource);
    const plainStart = map.findIndex(offset => offset >= srcStart);
    let plainEnd = map.findIndex(offset => offset >= srcEnd);
    if (plainStart === -1 || plainStart >= plain.length) return null;
    if (plainEnd === -1) plainEnd = plain.length;
    const searchText = plain.substring(plainStart, plainEnd).trim();
    if (!searchText) return null;

    const rootText = root.textContent || '';
    const idx = rootText.indexOf(searchText);
    if (idx === -1) return null;

    const firstWrapped = this.wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
    if (firstWrapped) {
      this.styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
    }
    return firstWrapped;
  }

  /**
   * 把 root 内 [startChar, endChar) 范围内的文本节点包裹成 region span
   */
  private wrapTextRange(
    root: HTMLElement,
    startChar: number,
    endChar: number,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): HTMLElement | null {
    let current = 0;
    let firstWrapped: HTMLElement | null = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const ranges: { node: Text; start: number; end: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const textNode = node as Text;
      const text = textNode.textContent || '';
      const nodeStart = current;
      const nodeEnd = current + text.length;
      current = nodeEnd;
      if (nodeEnd <= startChar || nodeStart >= endChar) continue;
      ranges.push({
        node: textNode,
        start: Math.max(0, startChar - nodeStart),
        end: Math.min(text.length, endChar - nodeStart),
      });
    }

    for (const { node, start, end } of ranges) {
      const text = node.textContent || '';
      const before = text.substring(0, start);
      const middle = text.substring(start, end);
      const after = text.substring(end);
      const span = document.createElement('span');
      span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
      span.dataset.uuid = uuid;
      span.dataset.type = type;
      span.dataset.color = color;
      span.style.cursor = 'pointer';
      span.textContent = middle;
      if (!firstWrapped) firstWrapped = span;

      const parent = node.parentNode;
      if (!parent) continue;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    }

    return firstWrapped;
  }

  /**
   * 找到 startEl 的最近块级祖先，给它加上点击事件和徽章（但不加背景色）
   *
   * 🔧 修复：不再给块祖先加 markvault-region 背景色类，
   * 因为 wrapTextRange 已经精确包裹了文本节点为带背景的 <span>。
   * 如果再给块祖先加背景，会导致整个块被染色。
   */
  private styleRegionBlockAncestor(startEl: HTMLElement, type: AnnotationType, color: string, note?: string): void {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    let target: HTMLElement | null = startEl;
    while (target && target !== document.body) {
      if (blockTags.has(target.tagName) || target.hasClass('callout')) break;
      target = target.parentElement;
    }
    if (!target || target === document.body) return;

    // 🔧 只添加左侧竖线标识、点击事件和元数据，不加背景色相关类
    target.addClass('markvault-region-block-border', `markvault-region-${color}`, 'markvault-clickable');
    target.dataset.uuid = startEl.dataset.uuid || '';
    target.dataset.type = type;
    target.dataset.color = color;
    target.style.cursor = 'pointer';
    this.addRegionBadge(target, type, color, note);
  }

  /**
   * 给 region 标注的目标元素添加右上角类型徽章
   */
  private addRegionBadge(targetEl: HTMLElement, type: AnnotationType, color: string, note?: string): void {
    targetEl.style.position = 'relative';
    const badge = document.createElement('span');
    badge.className = `markvault-region-type-badge markvault-region-badge-type-${type} markvault-region-badge-color-${color}`;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'markvault-region-type-badge-icon';
    iconSpan.textContent = '▭';
    const dot = document.createElement('span');
    dot.className = 'markvault-region-type-badge-dot';
    badge.appendChild(iconSpan);
    badge.appendChild(dot);
    targetEl.appendChild(badge);

    if (note) {
      const indicator = document.createElement('span');
      indicator.className = 'markvault-region-note-indicator';
      indicator.textContent = '📝';
      indicator.title = note;
      targetEl.appendChild(indicator);
    }
  }

  /**
   * 找到 region 两个锚点之间的第一个元素节点
   */
  private findFirstRegionElement(start: Node, end: Node | null): HTMLElement | null {
    let node: Node | null = start.nextSibling;
    while (node && node !== end) {
      if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
      if (node.firstChild) {
        node = node.firstChild;
      } else {
        while (node && !node.nextSibling && node !== start) {
          node = node.parentNode;
        }
        node = node && node !== start ? node.nextSibling : null;
      }
    }
    return null;
  }

  // ─── BUG-5.2 修复：跨 section region 的辅助方法 ────────────

  /**
   * 高亮从 start Comment 到 el 末尾的 DOM 节点
   * 用于跨 section region 的起始 section（只有 start，end 在另一个 section）
   */
  private highlightRegionFromStart(
    root: HTMLElement,
    start: Node,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    walker.currentNode = start;
    const nodes: Node[] = [];
    let n: Node | null;
    while ((n = walker.nextNode()) !== null) {
      nodes.push(n);
    }

    this.applyRegionStyleToNodes(root, nodes, uuid, type, color);
  }

  /**
   * 高亮从 el 开头到 end Comment 的 DOM 节点
   * 用于跨 section region 的结束 section（只有 end，start 在另一个 section）
   */
  private highlightRegionToEnd(
    root: HTMLElement,
    end: Node,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    const nodes: Node[] = [];
    let n: Node | null;
    while ((n = walker.nextNode()) !== null && n !== end) {
      nodes.push(n);
    }

    this.applyRegionStyleToNodes(root, nodes, uuid, type, color);
  }

  /**
   * 给一组 DOM 节点批量应用 region 样式
   * 提取自 highlightRegionNodes 的通用逻辑
   *
   * 🔧 关键修复：不给容器块元素（如 <ul>/<ol>）添加 markvault-region 背景类。
   */
  private applyRegionStyleToNodes(
    root: HTMLElement,
    nodes: Node[],
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    const styledAncestors = new Set<Element>();

    for (const node of nodes) {
      // 如果已经在某个被样式化的祖先内部，跳过避免重复处理
      let ancestor: Element | null = node.parentElement;
      let skip = false;
      while (ancestor && ancestor !== root) {
        if (styledAncestors.has(ancestor)) {
          skip = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (skip) continue;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');

        if (isBlock) {
          const hasBlockChildren = Array.from(el.children).some(
            c => blockTags.has(c.tagName) || (c as HTMLElement).hasClass?.('callout')
          );
          if (hasBlockChildren) {
            // 容器块：不染色，继续处理其内部叶子块
            continue;
          }

          // 叶子块：左侧竖线 + inline 文本包裹，不整块染色
          this.styleRegionBlockBorderAndText(el, uuid, type, color);
          styledAncestors.add(el);
        }
        // 行内元素跳过，其文本节点会在下面 TEXT_NODE 分支被包裹
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (!text.trim()) continue;
        const parent = node.parentElement;
        if (parent?.hasClass('markvault-region')) continue;
        const span = document.createElement('span');
        span.className = `markvault-region markvault-region-${type} markvault-region-${color} markvault-${type} markvault-${color} markvault-clickable`;
        span.dataset.uuid = uuid;
        span.dataset.type = type;
        span.dataset.color = color;
        span.style.cursor = 'pointer';
        span.textContent = text;
        node.parentNode?.replaceChild(span, node);
      }
    }
  }

  /**
   * 精确匹配 section 中从 start 锚点到 section 末尾的内容并高亮
   * 用于跨 section region 的起始 section（fallback 路径，Comment 节点不可用时）
   *
   * 🔧 关键修复：使用 REGION_ANCHOR_REGEX 搜索锚点位置，而非 buildRegionAnchor。
   */
  private applyRegionStyleFromStartAnchor(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
    let srcStart = -1;

    // 先用 REGION_ANCHOR_REGEX 搜索（能匹配含 % 的旧版锚点）
    REGION_ANCHOR_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REGION_ANCHOR_REGEX.exec(sectionSource)) !== null) {
      if (m[1] === region.uuid && m[4] === 'start') {
        srcStart = m.index + m[0].length;
        break;
      }
    }

    // 兜底用 buildRegionAnchor
    if (srcStart === -1) {
      const startAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'start');
      const startIdx = sectionSource.indexOf(startAnchor);
      if (startIdx === -1) return null;
      srcStart = startIdx + startAnchor.length;
    }

    // end 到 section 末尾
    const srcEnd = sectionSource.length;

    const { plain, map } = markdownToPlainWithMap(sectionSource);
    const plainStart = map.findIndex(offset => offset >= srcStart);
    let plainEnd = map.findIndex(offset => offset >= srcEnd);
    if (plainStart === -1 || plainStart >= plain.length) return null;
    if (plainEnd === -1) plainEnd = plain.length;
    const searchText = plain.substring(plainStart, plainEnd).trim();
    if (!searchText) return null;

    const rootText = root.textContent || '';
    const idx = rootText.indexOf(searchText);
    if (idx === -1) return null;

    const firstWrapped = this.wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
    if (firstWrapped) {
      this.styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
    }
    return firstWrapped;
  }

  /**
   * 精确匹配 section 中从 section 开头到 end 锚点的内容并高亮
   * 用于跨 section region 的结束 section（fallback 路径，Comment 节点不可用时）
   *
   * 🔧 关键修复：使用 REGION_ANCHOR_REGEX 搜索锚点位置，而非 buildRegionAnchor。
   */
  private applyRegionStyleToEndAnchor(root: HTMLElement, sectionSource: string, region: Annotation): HTMLElement | null {
    let srcEnd = -1;

    // 先用 REGION_ANCHOR_REGEX 搜索（能匹配含 % 的旧版锚点）
    REGION_ANCHOR_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REGION_ANCHOR_REGEX.exec(sectionSource)) !== null) {
      if (m[1] === region.uuid && m[4] === 'end') {
        srcEnd = m.index;
        break;
      }
    }

    // 兜底用 buildRegionAnchor
    if (srcEnd === -1) {
      const endAnchor = buildRegionAnchor({ uuid: region.uuid, type: region.type, color: region.color, note: region.note }, 'end');
      const endIdx = sectionSource.indexOf(endAnchor);
      if (endIdx === -1) return null;
      srcEnd = endIdx;
    }

    // 从 section 开头到 end 锚点
    const srcStart = 0;

    const { plain, map } = markdownToPlainWithMap(sectionSource);
    const plainStart = 0;
    let plainEnd = map.findIndex(offset => offset >= srcEnd);
    if (plainEnd === -1) plainEnd = plain.length;
    if (plainEnd <= 0) return null;
    const searchText = plain.substring(plainStart, plainEnd).trim();
    if (!searchText) return null;

    const rootText = root.textContent || '';
    const idx = rootText.indexOf(searchText);
    if (idx === -1) return null;

    const firstWrapped = this.wrapTextRange(root, idx, idx + searchText.length, region.uuid, region.type, region.color);
    if (firstWrapped) {
      this.styleRegionBlockAncestor(firstWrapped, region.type, region.color, region.note);
    }
    return firstWrapped;
  }

  /**
   * 给完全在 region 内的 section 的所有块级子元素加样式
   *
   * 🔧 关键修复：不给容器块（如 <ul>/<ol>）添加 markvault-region 背景类，
   * 只给叶子块元素（如 <li>/<p>）添加，避免整段列表被染色。
   */
  private applyRegionStyleToMiddleSection(
    root: HTMLElement,
    uuid: string,
    type: AnnotationType,
    color: string,
  ): void {
    const blockTags = new Set([
      'P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
      'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
      'OL', 'UL', 'DL', 'DT', 'DD', 'HR',
    ]);

    // 只给直接块级子元素加样式，不递归进入子节点
    for (const child of Array.from(root.children)) {
      const el = child as HTMLElement;
      const isBlock = blockTags.has(el.tagName) || el.hasClass('callout');
      if (isBlock) {
        // 🔧 跳过容器块（包含其他块级子元素的块）
        const hasBlockChildren = Array.from(el.children).some(
          c => blockTags.has(c.tagName) || (c as HTMLElement).hasClass?.('callout')
        );
        if (hasBlockChildren) {
          // 容器块：只添加点击事件和元数据，不加背景类
          el.addClass('markvault-clickable');
          el.dataset.uuid = uuid;
          el.dataset.type = type;
          el.dataset.color = color;
          el.style.cursor = 'pointer';
          // 递归处理子块
          this.applyRegionStyleToMiddleSection(el, uuid, type, color);
          continue;
        }

        // 叶子块：左侧竖线 + inline 文本包裹，不整块染色
        this.styleRegionBlockBorderAndText(el, uuid, type, color);
      }
    }
  }

  /**
   * 在阅读模式下高亮 span 标注的文本片段
   * span 标注不修改原文，只通过 spanRanges 记录纯文本片段位置。
   * 这里根据 spanRanges 从源文件提取文本，然后在渲染后的 DOM 中包裹对应文本。
   */
  private async highlightSpanFragments(
    targetEl: HTMLElement,
    uuid: string,
    type: string,
    color: string,
    sourcePath: string,
  ): Promise<void> {
    const annotation = await annotationStore.getAnnotationByUuid(uuid);
    if (!annotation || annotation.kind !== 'span' || !annotation.spanRanges || annotation.spanRanges.length === 0) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.cachedRead(file);
    const fragments: string[] = [];

    for (const range of annotation.spanRanges) {
      const slice = content.substring(range.from, range.to);
      const scan = scanMarkdownContexts(slice);
      for (const seg of scan.segments) {
        if (seg.type === 'text' && seg.content.trim().length > 0) {
          fragments.push(seg.content.trim());
        }
      }
    }

    if (fragments.length === 0) return;
    this.wrapTextFragments(targetEl, fragments, type, color);
  }

  /**
   * 在容器内查找并包裹指定的文本片段
   */
  private wrapTextFragments(
    container: HTMLElement,
    fragments: string[],
    type: string,
    color: string,
  ): void {
    const preset = DEFAULT_SETTINGS.presetColors.find((c) => c.id === color);
    const hex = preset ? preset.hex : color;

    for (const raw of fragments) {
      const frag = raw.trim();
      if (!frag) continue;

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode()) !== null) {
        textNodes.push(node as Text);
      }

      for (const textNode of textNodes) {
        const parent = textNode.parentElement;
        if (parent?.hasClass('markvault-span-fragment')) continue;

        const text = textNode.textContent || '';
        const idx = text.indexOf(frag);
        if (idx === -1) continue;

        const before = text.substring(0, idx);
        const after = text.substring(idx + frag.length);

        const span = document.createElement('span');
        span.className = `markvault-span-fragment markvault-${type} markvault-${color}`;
        span.textContent = frag;

        switch (type) {
          case 'bold':
            span.style.fontWeight = 'bold';
            span.style.borderBottom = `2px solid ${hex}`;
            break;
          case 'underline':
            span.style.textDecoration = 'underline';
            span.style.textDecorationColor = hex;
            span.style.textUnderlineOffset = '2px';
            break;
          case 'highlight':
            span.style.backgroundColor = `${hex}66`;
            span.style.borderRadius = '2px';
            break;
        }

        const containerNode = textNode.parentNode!;
        if (before) containerNode.insertBefore(document.createTextNode(before), textNode);
        containerNode.insertBefore(span, textNode);
        if (after) containerNode.insertBefore(document.createTextNode(after), textNode);
        containerNode.removeChild(textNode);
        break;
      }
    }
  }

  /**
   * 🔧 修复 Bug 2: 从锚点节点查找下一个可装饰的内容元素
   * Obsidian 阅读模式的 DOM 结构中：
   * - 锚点节点和目标元素之间可能有空白文本节点
   * - 锚点可能在 <p> 内，目标在下一个兄弟 <p> 中
   * - 需要向上查找到合适的容器层级再找下一个兄弟
   */
  private findNextContentElement(anchorNode: Node): HTMLElement | null {
    // 策略1: 直接向后遍历 nextSibling，跳过空白文本节点
    let sibling: Node | null = anchorNode.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE) {
        const el = sibling as HTMLElement;
        // 跳过空元素
        if (el.textContent?.trim()) {
          return el;
        }
      }
      // 跳过纯空白文本节点
      if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent?.trim()) {
        // 文本节点后面可能跟着元素，继续查找
      }
      sibling = sibling.nextSibling;
    }

    // 策略2: 向上查找到段落级容器（<p>, <div> 等），找下一个兄弟元素
    let parent: Node | null = anchorNode.parentNode;
    while (parent && parent !== document.body) {
      if (parent.nodeType === Node.ELEMENT_NODE) {
        const parentEl = parent as HTMLElement;
        // 到达段落级元素时停止向上
        const blockTags = ['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION'];
        if (blockTags.includes(parentEl.tagName) || parentEl.hasClass('markdown-preview-sizer') || parentEl.hasClass('markdown-reading-view')) {
          // 找下一个兄弟元素
          let nextEl: Element | null = parentEl.nextElementSibling;
          while (nextEl) {
            // 跳过隐藏的锚点元素
            if ((nextEl as HTMLElement).style.display === 'none' || nextEl.hasClass('markvault-anchor-hidden')) {
              nextEl = nextEl.nextElementSibling;
              continue;
            }
            // 找到有内容的元素
            if (nextEl.textContent?.trim()) {
              return nextEl as HTMLElement;
            }
            nextEl = nextEl.nextElementSibling;
          }
          break;
        }
      }
      parent = parent.parentNode;
    }

    return null;
  }

  async rebuildDatabase() {
    if (!this._storeReady) {
      new Notice('MarkVault: annotation database not initialized', 5000);
      return;
    }

    console.log('MarkVault: rebuilding database...');
    let total = 0;
    let skipped = 0;

    try {
      const markdownFiles = this.app.vault.getMarkdownFiles();

      for (const file of markdownFiles) {
        try {
          const content = await this.app.vault.read(file);
          const result = await syncFromMarkdown(content, file.path);
          total += result.added;
        } catch (err) {
          skipped++;
          console.warn(`MarkVault: rebuild skipped ${file.path}`, err);
        }
      }

      console.log(`MarkVault: rebuilt database, ${total} annotations added, ${skipped} files skipped`);
      new Notice(`MarkVault: rebuilt database — ${total} added, ${skipped} skipped`, 4000);
      await this.refreshSidebar();
    } catch (err) {
      console.error('MarkVault: rebuild database error', err);
      new Notice('MarkVault: failed to rebuild database', 5000);
    }
  }

  async exportAnnotations() {
    if (!this._storeReady) {
      new Notice('MarkVault: annotation database not initialized', 5000);
      return;
    }

    try {
      const annotations = await annotationStore.getAllAnnotations();
      const json = JSON.stringify(annotations, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `markvault-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('MarkVault: export error', err);
    }
  }

  // ─── 标注交互 ──────────────────────────────────

  /**
   * 通过 uuid 打开标注编辑 Modal
   * 支持阅读模式点击标注 → 编辑批注
   */
  async openAnnotationModal(uuid: string) {
    try {
      const annotation = await annotationStore.getAnnotationByUuid(uuid);
      if (!annotation) {
        console.warn('MarkVault: annotation not found for uuid', uuid);
        return;
      }

      // 标记此标注为"正在编辑"状态
      this.markAnnotationActive(uuid, annotation.filePath);

      const modal = new AnnotationModal(
        this.app,
        this,
        annotation,
        async (_updated) => {
          // 保存回调
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          await this.refreshSidebar();
        },
        async (_deletedUuid) => {
          // 🔧 审计修复：Modal 已处理 MD 移除，回调只做清理
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          // 标记文件已同步（Modal 中 modifyGuard 已释放）
          this.markFileSynced(annotation.filePath);
          await this.updateSpanCache(annotation.filePath);
      await this.updateRegionCache(annotation.filePath);
          await this.refreshSidebar();
        },
      );

      // 注册打开的 Modal，便于文件删除/重命名时自动关闭
      this.registerActiveAnnotationModal(uuid, modal);

      // Modal 关闭时如果没有触发回调（如按 Esc），也取消保护
      // 使用 Modal 的 onClose 生命周期钩子
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        this.unregisterActiveAnnotationModal(uuid);
        this.unmarkAnnotationActive(uuid, annotation.filePath);
        originalOnClose();
      };

      modal.open();
    } catch (err) {
      console.error('MarkVault: failed to open annotation modal', err);
    }
  }

  // ─── 阅读模式创建标注 ──────────────────────

  /** 在阅读模式下创建标注 */
  private async createReadingAnnotation(selectedText: string, color: string, type: AnnotationType = 'highlight', kind: Annotation['kind'] = 'inline') {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      console.error('MarkVault: no active MarkdownView in reading mode');
      return;
    }

    const filePath = view.file.path;
    const uuid = generateId();

    try {
      const content = await this.app.vault.read(view.file);

      // 在源文件中查找选中文本（支持多处相同文本的上下文定位）
      const offsetResult = this.findBestTextOffset(content, selectedText);
      if (!offsetResult) {
        console.error('MarkVault: selected text not found in source file');
        return;
      }
      const { startOffset, endOffset } = offsetResult;

      // 统一加锁，分支内部只执行 modify，锁统一在外层 finally 释放
      this.modifyGuard.acquire(filePath);

      if (kind === 'block') {
        // ── 块标注：用双锚点包围选中文本所在的块 ──
        const startLine = content.substring(0, startOffset).split('\n').length - 1;
        let blockInfo = detectBlockAtLine(content, startLine);
        const lines = content.split('\n');

        // 如果光标不在特殊块上，退而求其次把当前行当作一个 paragraph 块包围
        if (!blockInfo && startLine >= 0 && startLine < lines.length && lines[startLine].trim().length > 0) {
          blockInfo = {
            type: 'paragraph',
            startLine,
            endLine: startLine,
            content: lines[startLine],
          };
        }
        if (!blockInfo) {
          console.warn('MarkVault: reading-mode block annotation target is not a recognized block');
          new Notice('MarkVault: selected text is not in a block element (formula, code, image, etc.)', 4000);
          return;
        }


        const blockStartOffset = lines.slice(0, blockInfo.startLine).reduce((sum, l) => sum + l.length + 1, 0);
        const blockEndOffset = lines.slice(0, blockInfo.endLine + 1).reduce((sum, l) => sum + l.length + 1, 0);
        const blockContent = content.substring(blockStartOffset, blockEndOffset);

        const startAnchor = buildBlockAnchorStart({ uuid, type, color, note: '' });
        const endAnchor = buildBlockAnchorEnd({ uuid, type, color, note: '' });

        // 如果目标块是列表项，把锚点缩进到列表层级，避免打断列表结构和阅读模式 section 切割
        const { startAnchorPrefix, endAnchorPrefix } = getBlockAnchorPrefixesForListItem(lines, blockInfo.startLine);

        const replacement = startAnchorPrefix || endAnchorPrefix
          ? startAnchorPrefix + startAnchor + '\n' + blockContent + '\n' + endAnchorPrefix + endAnchor + '\n'
          : startAnchor + '\n' + blockContent + endAnchor + '\n';

        const newContent = content.substring(0, blockStartOffset) + replacement + content.substring(blockEndOffset);
        await this.app.vault.modify(view.file, newContent);

        if (view.previewMode) {
          view.previewMode.rerender(true);
        }

        const annotation = buildAnnotation({
          uuid,
          filePath,
          type,
          color,
          text: blockContent,
          kind: 'block',
          startOffset: blockStartOffset,
          endOffset: blockStartOffset + replacement.length,
          startLine: blockInfo.startLine,
          endLine: blockInfo.endLine + 2,
          contextBefore: content.substring(Math.max(0, blockStartOffset - 80), blockStartOffset),
          contextAfter: content.substring(blockEndOffset, Math.min(content.length, blockEndOffset + 80)),
          blockType: blockInfo.type,
          targetLine: blockInfo.startLine + 1,
          anchorLine: blockInfo.startLine,
          targetHash: computeSignature(blockContent),
        });

        await finalizeAnnotation(annotation, {
          updateSpanCache: (fp) => this.updateSpanCache(fp),
          updateRegionCache: (fp) => this.updateRegionCache(fp),
          markFileSynced: (fp) => this.markFileSynced(fp),
          refreshSidebar: () => this.refreshSidebar(),
        });
        console.log(`MarkVault: created reading-mode block annotation ${uuid} in ${filePath}`);
      } else {
        const sourceSelected = content.substring(startOffset, endOffset);
        const scan = scanMarkdownContexts(sourceSelected);
        const spansBlocks = sourceSelected.includes('\n');

        // 显式指定 kind === 'region' 时，强制走双锚点区域标注
        if (kind === 'region' || scan.hasSpecialContent || spansBlocks) {
          // —— 区域标注：双锚点包围原选区 ——
          const regionStartOffset = adjustRegionStartOffsetForListItem(content, startOffset);
          const regionEndOffset = adjustRegionEndOffsetForListItem(content, endOffset);
          const safeStartOffset = Math.min(regionStartOffset, regionEndOffset);
          const safeEndOffset = Math.max(regionStartOffset, regionEndOffset);
          const regionSelected = content.substring(safeStartOffset, safeEndOffset);

          const startAnchor = buildRegionAnchor({ uuid, type, color, note: '' }, 'start');
          const endAnchor = buildRegionAnchor({ uuid, type, color, note: '' }, 'end');
          const replacement = startAnchor + regionSelected + endAnchor;
          const newContent = content.substring(0, safeStartOffset) + replacement + content.substring(safeEndOffset);
          await this.app.vault.modify(view.file, newContent);

          if (view.previewMode) {
            view.previewMode.rerender(true);
          }

          const startLine = content.substring(0, safeStartOffset).split('\n').length - 1;
          const endLine = content.substring(0, safeEndOffset).split('\n').length - 1;

          const annotation = buildAnnotation({
            uuid,
            filePath,
            type,
            color,
            text: regionSelected,
            kind: 'region',
            startOffset: safeStartOffset,
            endOffset: safeStartOffset + replacement.length,
            startLine,
            endLine,
            contextBefore: content.substring(Math.max(0, safeStartOffset - 40), safeStartOffset),
            contextAfter: content.substring(safeEndOffset, Math.min(content.length, safeEndOffset + 40)),
            targetHash: computeSpanSignature(regionSelected),
          });

          await finalizeAnnotation(annotation, {
            updateSpanCache: (fp) => this.updateSpanCache(fp),
            updateRegionCache: (fp) => this.updateRegionCache(fp),
            markFileSynced: (fp) => this.markFileSynced(fp),
            refreshSidebar: () => this.refreshSidebar(),
          });
          console.log(`MarkVault: created reading-mode region annotation ${uuid} in ${filePath}`);
        } else {
        // ── 自然语法行内标注：隐身锚点 + 原生 HTML 包裹 ──
        const annotation = buildAnnotation({
          uuid,
          filePath,
          type,
          color,
          text: selectedText,
          kind: 'inline',
          startOffset,
          endOffset,
          startLine: 0,
          contextBefore: content.substring(Math.max(0, startOffset - 40), startOffset),
          contextAfter: content.substring(endOffset, Math.min(content.length, endOffset + 40)),
          format: 'native',
        });

        const nativeTag = buildNativeAnnotation(annotation);
        const newContent = content.substring(0, startOffset) + nativeTag + content.substring(endOffset);
        await this.app.vault.modify(view.file, newContent);

        if (view.previewMode) {
          view.previewMode.rerender(true);
        }

        annotation.endOffset = startOffset + nativeTag.length;

        await finalizeAnnotation(annotation, {
          updateSpanCache: (fp) => this.updateSpanCache(fp),
          updateRegionCache: (fp) => this.updateRegionCache(fp),
          markFileSynced: (fp) => this.markFileSynced(fp),
          refreshSidebar: () => this.refreshSidebar(),
        });

        console.log(`MarkVault: created reading-mode native annotation ${uuid} in ${filePath}`);
      }
      }
    } catch (err) {
      console.error('MarkVault: failed to create reading-mode annotation', err);
    } finally {
      this.modifyGuard.release(filePath);
      this.markFileSynced(filePath);
      window.getSelection()?.removeAllRanges();
    }
  }

  /**
   * 在阅读模式选中的文本中，找到其在 Markdown 源文件中的最佳偏移范围。
   *
   * 返回源文件中的 [startOffset, endOffset)，用于包裹 <mark> 或定位块边界。
   * 阅读模式下用户看到的是渲染后的纯文本，因此先把 Markdown 源文本转成纯文本
   * 并维护偏移映射。
   *
   * 🔧 修复：阅读模式选中跨段落文本创建 region 标注时，normalizeSelectedText 把
   * 换行压缩为空格，但 plain 保留原始换行符导致匹配失败。
   * 解决方案：同时生成空白规范化的 plain（normalizedPlain）和映射，所有匹配
   * 都在 normalizedPlain 上进行，通过 normalizedMap → map → 源文件偏移 回溯。
   */
  private findBestTextOffset(content: string, selectedText: string): { startOffset: number; endOffset: number } | null {
    const { plain, map } = markdownToPlainWithMap(content);
    const normalizedSelected = this.normalizeSelectedText(selectedText);

    // 🔧 生成空白规范化版本的 plain 和映射
    // normalizedPlain: 与 normalizedSelected 一样把 \s+ 压缩为单个空格
    // normalizedMap: normalizedPlain[i] → plain 中的索引 → map[plainIdx] → 源文件偏移
    const { normalizedPlain, normalizedMap } = this.buildNormalizedPlainAndMap(plain);

    // 1. 完整匹配（在规范化空间中搜索）
    let normIdx = normalizedPlain.indexOf(normalizedSelected);
    if (normIdx !== -1) {
      const startPlainIdx = normalizedMap[normIdx];
      const endPlainIdx = normalizedMap[normIdx + normalizedSelected.length - 1];
      return { startOffset: map[startPlainIdx], endOffset: map[endPlainIdx] + 1 };
    }

    // 2. 用首尾片段匹配（对长选区/含特殊格式的情况更鲁棒）
    const snippetMatch = this.findByTextSnippets(normalizedPlain, normalizedMap, map, normalizedSelected);
    if (snippetMatch) return snippetMatch;

    // 3. 通过 DOM 段落上下文定位
    const domMatch = this.findOffsetByDOMContext(normalizedPlain, normalizedMap, map, normalizedSelected);
    if (domMatch) return domMatch;

    // 4. 模糊匹配兜底 — 逐词滑动窗口
    // 用于处理 Obsidian 渲染后标点/空格差异导致精确匹配失败的情况
    const fuzzyMatch = this.findByFuzzySlidingWindow(normalizedPlain, normalizedMap, map, normalizedSelected);
    if (fuzzyMatch) return fuzzyMatch;

    console.warn(`MarkVault: selected text not found in source file: "${selectedText}"`);
    return null;
  }

  /**
   * 🔧 NEW: 构建空白规范化版本的 plain 和映射
   *
   * 将 plain 中的 \s+ 压缩为单个空格，生成 normalizedPlain。
   * normalizedMap[i] = plain 中的原始索引，即 normalizedPlain[i] 对应 plain[normalizedMap[i]]。
   */
  private buildNormalizedPlainAndMap(plain: string): { normalizedPlain: string; normalizedMap: number[] } {
    const normalizedPlainChars: string[] = [];
    const normalizedMap: number[] = [];
    let i = 0;
    while (i < plain.length) {
      if (/\s/.test(plain[i])) {
        // 把连续空白压缩为一个空格
        normalizedPlainChars.push(' ');
        // 映射到第一个空白字符在 plain 中的位置
        normalizedMap.push(i);
        // 跳过所有连续空白
        while (i < plain.length && /\s/.test(plain[i])) i++;
      } else {
        normalizedPlainChars.push(plain[i]);
        normalizedMap.push(i);
        i++;
      }
    }
    return { normalizedPlain: normalizedPlainChars.join(''), normalizedMap };
  }

  /**
   * 🔧 NEW: 通过 DOM 段落上下文定位（从 findBestTextOffset 提取）
   * 用选区所在块级元素的文本内容作为上下文在 normalizedPlain 中定位
   *
   * @param normalizedPlain 空白规范化后的纯文本
   * @param normalizedMap normalizedPlain 索引 → plain 索引的映射
   * @param srcMap plain 索引 → 源文件偏移的映射
   */
  private findOffsetByDOMContext(
    normalizedPlain: string,
    normalizedMap: number[],
    srcMap: number[],
    normalizedSelected: string,
  ): { startOffset: number; endOffset: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    let container: Node | null = range.commonAncestorContainer;
    const blockTags = ['P', 'LI', 'DIV', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION'];

    while (container && container !== document.body) {
      const el = container.nodeType === Node.ELEMENT_NODE
        ? (container as HTMLElement)
        : container.parentElement;
      if (
        el &&
        (blockTags.includes(el.tagName) || el.hasClass?.('markdown-preview-sizer'))
      ) {
        const paragraphText = this.normalizeSelectedText(el.textContent || '');
        const idxInParagraph = paragraphText.indexOf(normalizedSelected);
        if (idxInParagraph !== -1) {
          const contextStart = Math.max(0, idxInParagraph - 30);
          const contextEnd = Math.min(
            paragraphText.length,
            idxInParagraph + normalizedSelected.length + 30,
          );
          const context = paragraphText.substring(contextStart, contextEnd);
          const contextIdx = normalizedPlain.indexOf(context);
          if (contextIdx !== -1) {
            const innerIdx = idxInParagraph - contextStart;
            const startPlainIdx = normalizedMap[contextIdx + innerIdx];
            const endPlainIdx = normalizedMap[contextIdx + innerIdx + normalizedSelected.length - 1];
            return { startOffset: srcMap[startPlainIdx], endOffset: srcMap[endPlainIdx] + 1 };
          }
        }
        break;
      }
      container = container.parentNode;
    }
    return null;
  }

  /**
   * 🔧 NEW: 模糊滑动窗口匹配
   *
   * 当精确匹配失败时（Obsidian 渲染后标点/空格/Unicode 与源文件有差异），
   * 使用滑动窗口在 normalizedPlain 文本中寻找与选中文本最相似的片段。
   *
   * @param normalizedPlain 空白规范化后的纯文本
   * @param normalizedMap normalizedPlain 索引 → plain 索引的映射
   * @param srcMap plain 索引 → 源文件偏移的映射
   */
  private findByFuzzySlidingWindow(
    normalizedPlain: string,
    normalizedMap: number[],
    srcMap: number[],
    normalizedSelected: string,
  ): { startOffset: number; endOffset: number } | null {
    // 太短的选区不做模糊匹配（误匹配风险高）
    if (normalizedSelected.length < 8) return null;

    const selectedTokens = this.tokenizeForFuzzy(normalizedSelected);
    if (selectedTokens.length < 2) return null;

    // 在 normalizedPlain 中搜索第一个词元出现的位置，作为候选起点
    const firstToken = selectedTokens[0];
    const secondToken = selectedTokens.length > 1 ? selectedTokens[1] : null;
    const lastToken = selectedTokens[selectedTokens.length - 1];

    // 搜索窗口：选中文本长度的 ±50%
    const estLen = normalizedSelected.length;
    const windowSize = Math.round(estLen * 1.5);

    let bestStart = -1;
    let bestScore = 0;

    // 在 normalizedPlain 中找所有 firstToken 出现的位置
    let searchFrom = 0;
    while (searchFrom < normalizedPlain.length) {
      const firstIdx = normalizedPlain.indexOf(firstToken, searchFrom);
      if (firstIdx === -1) break;

      // 候选窗口：[firstIdx, firstIdx + windowSize)
      const windowEnd = Math.min(firstIdx + windowSize, normalizedPlain.length);
      const windowText = normalizedPlain.substring(firstIdx, windowEnd);

      // 计算词元匹配得分
      let score = 0;
      let matchedLength = firstToken.length; // 已匹配的字符数

      for (let t = 1; t < selectedTokens.length; t++) {
        const token = selectedTokens[t];
        const tokenIdx = windowText.indexOf(token, matchedLength - firstIdx > 0 ? matchedLength - firstIdx : 0);
        if (tokenIdx !== -1) {
          score++;
          matchedLength = firstIdx + tokenIdx + token.length;
        }
      }

      // 额外检查：lastToken 应该在窗口内
      if (lastToken !== firstToken) {
        const lastIdx = windowText.lastIndexOf(lastToken);
        if (lastIdx !== -1) {
          score += 2; // 最后一个词元匹配权重更高
        }
      }

      // 也检查第二个词元是否在 firstToken 附近
      if (secondToken && secondToken !== firstToken) {
        const secondIdx = windowText.indexOf(secondToken, firstToken.length);
        if (secondIdx !== -1 && secondIdx < firstToken.length * 3) {
          score += 1;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestStart = firstIdx;
      }

      searchFrom = firstIdx + 1;
    }

    if (bestStart === -1 || bestScore < Math.min(selectedTokens.length * 0.3, 2)) {
      return null;
    }

    // 用 lastToken 确定终点
    const searchEnd = Math.min(bestStart + windowSize, normalizedPlain.length);
    const windowFromBest = normalizedPlain.substring(bestStart, searchEnd);
    const lastIdx = windowFromBest.lastIndexOf(lastToken);

    let endNormIdx: number;
    if (lastIdx !== -1) {
      endNormIdx = bestStart + lastIdx + lastToken.length;
    } else {
      // 估算终点
      endNormIdx = bestStart + estLen;
    }

    if (endNormIdx > normalizedPlain.length) endNormIdx = normalizedPlain.length;
    if (bestStart >= endNormIdx) return null;

    // 安全检查：normalizedMap 索引越界
    if (bestStart >= normalizedMap.length || endNormIdx - 1 >= normalizedMap.length) return null;

    // 通过 normalizedMap → srcMap 回溯到源文件偏移
    const startPlainIdx = normalizedMap[bestStart];
    const endPlainIdx = normalizedMap[endNormIdx - 1];
    return {
      startOffset: srcMap[startPlainIdx],
      endOffset: srcMap[endPlainIdx] + 1,
    };
  }

  /**
   * 🔧 NEW: 将文本拆分为可用于模糊匹配的词元
   * 按标点和空格拆分，过滤掉过短的片段
   */
  private tokenizeForFuzzy(text: string): string[] {
    // 按空格和常见标点拆分，保留 2 字符以上的片段
    return text
      .split(/[\s,.;:!?，。；：！？、（）()\[\]【】《》""''「」『』—–\-\/\\]+/)
      .filter(token => token.length >= 2);
  }

  /**
   * 规范化阅读模式选中的文本：统一空白、去除零宽字符
   */
  private normalizeSelectedText(text: string): string {
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 用选区的前缀 + 后缀片段在 normalizedPlain 中定位，适应中间有格式差异的情况
   *
   * @param normalizedPlain 空白规范化后的纯文本
   * @param normalizedMap normalizedPlain 索引 → plain 索引的映射
   * @param srcMap plain 索引 → 源文件偏移的映射
   */
  private findByTextSnippets(
    normalizedPlain: string,
    normalizedMap: number[],
    srcMap: number[],
    normalizedSelected: string,
  ): { startOffset: number; endOffset: number } | null {
    if (normalizedSelected.length < 10) return null;

    const snippetLen = Math.min(30, Math.floor(normalizedSelected.length / 3));
    const prefix = normalizedSelected.slice(0, snippetLen);
    const suffix = normalizedSelected.slice(-snippetLen);

    const prefixIdx = normalizedPlain.indexOf(prefix);
    if (prefixIdx === -1) return null;

    const suffixIdx = normalizedPlain.indexOf(suffix, prefixIdx + prefix.length);
    if (suffixIdx === -1) {
      // 只有前缀找到：按选区长度估算终点
      const endNormIdx = prefixIdx + normalizedSelected.length;
      if (endNormIdx > normalizedPlain.length) return null;
      const startPlainIdx = normalizedMap[prefixIdx];
      const endPlainIdx = normalizedMap[endNormIdx - 1];
      return {
        startOffset: srcMap[startPlainIdx],
        endOffset: srcMap[endPlainIdx] + 1,
      };
    }

    const startPlainIdx = normalizedMap[prefixIdx];
    const endPlainIdx = normalizedMap[suffixIdx + suffix.length - 1];
    return {
      startOffset: srcMap[startPlainIdx],
      endOffset: srcMap[endPlainIdx] + 1,
    };
  }

  /** 向前查找块边界位置（空行、标题行、callout行 之后） */
  private findBlockBoundary(beforeText: string): number {
    let pos = beforeText.length;
    // 跳过 trailing 空白
    while (pos > 0 && (beforeText[pos - 1] === '\n' || beforeText[pos - 1] === '\r')) pos--;

    // 回退到上一个双换行（块边界）
    const doubleNewline = beforeText.lastIndexOf('\n\n', pos - 1);
    if (doubleNewline !== -1) return doubleNewline + 1;

    // 如果没有双换行，找最近的标题或 callout 行
    const lines = beforeText.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('#') || line.startsWith('> [!')){
        // 从这行开始
        let offset = 0;
        for (let j = 0; j < i; j++) offset += lines[j].length + 1;
        return offset;
      }
    }

    // 都没有 → 文件开头
    return 0;
  }
}
