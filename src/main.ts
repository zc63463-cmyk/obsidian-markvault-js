import { Plugin, MarkdownView, TFile, Notice } from 'obsidian';
import type { MarkVaultSettings, AnnotationType, Annotation } from './types/annotation';
import { DEFAULT_SETTINGS } from './types/annotation';
import { MARKVAULT_SIDEBAR_VIEW_TYPE, AnnotationSidebar } from './ui/sidebar/AnnotationSidebar';
import { registerContextMenu, registerCommands } from './ui/editor/context-menu';
import { MarkVaultSettingTab } from './ui/settings/settings-tab';
import { syncFromMarkdown, getPlainTextForOffsetRecovery, extractContextFromContent } from './core/markdown-sync';
import {
  computeBlockSignature,
  computeSpanSignature,
  findBlockLineBySignature,
  findSpanLineBySignature,
  detectBlockTypeAtLine,
} from './core/block-fingerprint';
import { parseBlockAnchors, computeSpanRanges, findSpanEndLine } from './core/annotation-parser';
import { scanMarkdownContexts } from './core/md-context';
import { markvaultDecorationPlugin, setFilePathResolver } from './core/highlight-applier';
import { createOffsetTrackerExtension, applyIncrementalOffsetFix, type ChangeInfo } from './core/offset-tracker';
import { batchRecoverOffsets } from './core/offset-recovery';
import { AnnotationModal } from './ui/editor/annotation-modal';
import { initAnnotationStore, annotationStore } from './db/annotation-store';
import { addAnnotation } from './db/annotation-repo';
import { generateId } from './utils/id';
import { migrateFromIndexedDB } from './db/migration';
import { buildMarkTag, buildBlockAnchor } from './core/annotation-parser';
import { computeSignature } from './core/block-fingerprint';
import { updateSpanCacheForFile, clearSpanCacheForFile, type SpanAnnotationData } from './core/highlight-applier';

import { ModifyGuard } from './utils/modify-guard';
import { ReadingModeToolbar } from './ui/reading/ReadingModeToolbar';
import { ReadingModeClickDelegate } from './ui/reading/ReadingModeClickDelegate';

export default class MarkVaultPlugin extends Plugin {
  settings: MarkVaultSettings = DEFAULT_SETTINGS;
  private sidebar: AnnotationSidebar | null = null;

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

  /** 检查 AnnotationStore 是否已就绪 */
  public isStoreReady(): boolean {
    return this._storeReady;
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
   * 更新 span 标注缓存（供 CM6 装饰器使用）
   * 从 DB 加载指定文件的 span 标注数据到缓存
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
    } catch (err) {
      console.error('MarkVault: updateSpanCache error', err);
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

    // 添加侧边栏图标
    try {
      this.addRibbonIcon('pen-tool', 'MarkVault-JS', () => {
        this.activateSidebar();
      });
    } catch (err) {
      console.error('MarkVault: failed to add ribbon icon', err);
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

    // 🆕 当前文件变化时同步（用于切换标签页、重命名等）
    // ⚠️ 已禁用：active-leaf-change 在 vault.modify 后会被频繁触发，
    // 导致重复 onFileOpen → 重复全量 sync → UI 长时间无响应。
    // file-open 事件本身已覆盖文件打开场景，无需额外监听。
    try {
      // NO-OP: active-leaf-change handler removed for performance
      // (kept as comment to document the decision)
    } catch (err) {
      console.error('MarkVault: failed to register active-leaf-change handler', err);
    }

    // 阅读模式渲染：只负责视觉样式，不绑定点击事件
    // 点击事件统一由全局 capture-phase handler 处理（更可靠，不会被 DOM 重建影响）
    try {
      this.registerMarkdownPostProcessor((el, _ctx) => {
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

          // 🆕 v2.0: 处理块级锚点标注
          // 检测 %%markvault:uuid:type:color:note%% 注释锚点
          // Obsidian 会将 %%...%% 注释渲染为特殊的 comment 节点
          // 我们需要在渲染后的 DOM 中找到这些锚点，给下方的块添加装饰
          this.processBlockAnchors(el);
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
      this.readingToolbar = new ReadingModeToolbar(this, {
        createReadingAnnotation: (req) => this.createReadingAnnotation(req.selectedText, req.color, req.type, req.kind),
      });
      this.readingToolbar.setup();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode toolbar', err);
    }

    console.log('MarkVault: plugin loaded successfully');
  }

  async onunload() {
    console.log('MarkVault: unloading plugin');
    try {
      this.readingToolbar?.destroy();
      this.readingClickDelegate?.destroy();
      this.modifyGuard.releaseAll();
      await annotationStore.shutdown();
    } catch (err) {
      console.error('MarkVault: failed to shutdown AnnotationStore', err);
    }
  }

  // ─── 设置 ──────────────────────────────────────

  async loadSettings() {
    const data = await this.loadData();
    // loadData() 首次返回 null，Object.assign 能正确处理
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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
  }

  // ─── 文件打开时同步 ────────────────────────────

  async onFileOpen(file: TFile) {
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

        for (const ann of blockSpanAnnotations) {
          const anchor = anchorByUuid.get(ann.uuid);
          if (!anchor) {
            // Markdown 中已找不到该锚点，无法自动恢复
            failed++;
            continue;
          }

          if (ann.kind === 'block') {
            const preferredLine = ann.targetLine ?? anchor.anchorLine + 1;
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
                  anchorLine: anchor.anchorLine,
                  blockType: ann.blockType || detectBlockTypeAtLine(lines, foundLine),
                });
                blocksRecovered++;
              } else {
                failed++;
              }
            } else {
              // 指纹一致或没有指纹，仅同步 anchorLine
              if (anchor.anchorLine !== ann.anchorLine) {
                await annotationStore.updateAnnotation(ann.uuid, { anchorLine: anchor.anchorLine });
              }
            }
          } else if (ann.kind === 'span') {
            // 跳过锚点行、空行、特殊围栏，找到 span 实际内容起始行
            let actualTargetLine = anchor.anchorLine + 1;
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
                anchor.anchorLine !== ann.anchorLine ||
                JSON.stringify(newSpanRanges) !== JSON.stringify(ann.spanRanges);

              if (changed) {
                await annotationStore.updateAnnotation(ann.uuid, {
                  targetLine: actualTargetLine,
                  anchorLine: anchor.anchorLine,
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

      // 4. 刷新缓存与 UI
      this.markFileSynced(filePath);
      await this.updateSpanCache(filePath);
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
   * Obsidian 将 %%markvault:uuid:type:color:note%% 渲染为注释节点
   * 我们需要找到这些节点，给下一个兄弟元素添加装饰样式
   * 同时处理 %%markvault-span:uuid:type:color:note%% 格式的 span 锚点
   */
  private processBlockAnchors(el: HTMLElement): void {
    // Obsidian 将 %%...%% 注释渲染为：
    //   - COMMENT_NODE（不可见，理想情况）
    //   - ELEMENT_NODE（可见，需要手动隐藏）
    // 遍历所有节点查找 markvault 锚点
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
    const anchorNodes: { uuid: string; type: string; color: string; note: string; node: Node; anchorKind: 'block' | 'span' }[] = [];

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
        }
      }
    }

    // 给锚点下方的元素添加装饰
    for (const anchor of anchorNodes) {
      // 🔧 修复 Bug 1: 隐藏锚点节点本身，防止 UUID 暴露
      if (anchor.node.nodeType === Node.ELEMENT_NODE) {
        const anchorEl = anchor.node as HTMLElement;
        anchorEl.style.display = 'none';
        anchorEl.addClass('markvault-anchor-hidden');
      }

      // 🔧 修复 Bug 2: 改进下一个兄弟元素查找
      // Obsidian DOM 中锚点和目标元素之间可能有空白文本节点，
      // 也可能锚点在 <p> 内而目标在下一个 <p> 中
      const targetEl = this.findNextContentElement(anchor.node);

      if (targetEl) {
        targetEl.addClass('markvault-block-mark');
        targetEl.addClass(`markvault-block-${anchor.type}`);
        targetEl.addClass(`markvault-block-${anchor.color}`);
        targetEl.style.cursor = 'pointer';
        targetEl.dataset.uuid = anchor.uuid;

        // span 标注的视觉标记
        if (anchor.anchorKind === 'span') {
          targetEl.addClass('markvault-span-mark');
        }

        if (anchor.note) {
          const indicator = document.createElement('span');
          indicator.className = 'markvault-block-note-indicator';
          indicator.textContent = '📝';
          indicator.title = anchor.note;
          targetEl.style.position = 'relative';
          targetEl.appendChild(indicator);
        }
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
      const idx = this.findBestTextOffset(content, selectedText);
      if (idx === -1) {
        console.error('MarkVault: selected text not found in source file');
        return;
      }

      // 统一加锁，分支内部只执行 modify，锁统一在外层 finally 释放
      this.modifyGuard.acquire(filePath);

      if (kind === 'block') {
        // ── 块标注：在选中文本所在块的边界前插入锚点 ──
        // 向前搜索块边界（空行、标题、callout 起始）
        const beforeText = content.substring(0, idx);
        const blockStart = this.findBlockBoundary(beforeText);

        const anchor = buildBlockAnchor({
          uuid,
          type,
          color,
          note: '',
        });

        // 在块边界插入锚点
        const newContent = content.substring(0, blockStart) + anchor + '\n' + content.substring(blockStart);
        await this.app.vault.modify(view.file, newContent);

        const annotation: Annotation = {
          uuid,
          filePath,
          type,
          color,
          text: selectedText,
          note: '',
          tags: [],
          startOffset: blockStart,
          endOffset: blockStart + anchor.length,
          startLine: 0,
          contextBefore: content.substring(Math.max(0, blockStart - 80), blockStart),
          contextAfter: content.substring(blockStart, Math.min(content.length, blockStart + 80)),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          kind: 'block',
          targetHash: computeSignature(selectedText),
        };

        await addAnnotation(annotation);
        console.log(`MarkVault: created reading-mode block annotation ${uuid} in ${filePath}`);
        this.markFileSynced(filePath);
        await this.refreshSidebar();
      } else {
        // ── 行内标注：包裹 <mark> 标签 ──
        const startOffset = idx;
        const endOffset = idx + selectedText.length;

        const annotation: Annotation = {
          uuid,
          filePath,
          type,
          color,
          text: selectedText,
          note: '',
          tags: [],
          startOffset,
          endOffset,
          startLine: 0,
          contextBefore: content.substring(Math.max(0, idx - 40), idx),
          contextAfter: content.substring(endOffset, Math.min(content.length, endOffset + 40)),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          kind: 'inline',
        };

        const markTag = buildMarkTag(annotation);

        const newContent = content.substring(0, idx) + markTag + content.substring(endOffset);
        await this.app.vault.modify(view.file, newContent);

        annotation.endOffset = startOffset + markTag.length;
        await addAnnotation(annotation);

        console.log(`MarkVault: created reading-mode inline annotation ${uuid} in ${filePath}`);
        this.markFileSynced(filePath);
        await this.refreshSidebar();
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
   * 在阅读模式选中的文本中，找到其在 Markdown 源文件中的最佳偏移。
   * 如果文件内只有一处匹配，直接返回；如果有多处匹配，
   * 尝试通过 DOM selection 所在段落上下文定位到 Markdown 中对应段落。
   */
  private findBestTextOffset(content: string, selectedText: string): number {
    const firstIdx = content.indexOf(selectedText);
    const lastIdx = content.lastIndexOf(selectedText);
    if (firstIdx === -1) return -1;
    if (firstIdx === lastIdx) return firstIdx;

    // 多处匹配：尝试通过 DOM selection 的段落上下文定位
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
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
          const paragraphText = el.textContent || '';
          const idxInParagraph = paragraphText.indexOf(selectedText);
          if (idxInParagraph !== -1) {
            // 优先搜索完整段落文本
            const paraIdx = content.indexOf(paragraphText);
            if (paraIdx !== -1) {
              return paraIdx + idxInParagraph;
            }

            // 段落文本可能被截断：用选区及前后一段文本作为上下文匹配
            const contextStart = Math.max(0, idxInParagraph - 20);
            const contextEnd = Math.min(
              paragraphText.length,
              idxInParagraph + selectedText.length + 20,
            );
            const context = paragraphText.substring(contextStart, contextEnd);
            const contextIdx = content.indexOf(context);
            if (contextIdx !== -1) {
              return contextIdx + (idxInParagraph - contextStart);
            }
          }
          break;
        }
        container = container.parentNode;
      }
    }

    console.warn(`MarkVault: multiple matches for "${selectedText}", falling back to first occurrence`);
    return firstIdx;
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
