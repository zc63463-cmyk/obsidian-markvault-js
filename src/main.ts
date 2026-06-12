import { Plugin, MarkdownView, TFile, MarkdownRenderer, Component } from 'obsidian';
import type { MarkVaultSettings } from './types/annotation';
import { DEFAULT_SETTINGS } from './types/annotation';
import { MARKVAULT_SIDEBAR_VIEW_TYPE, AnnotationSidebar } from './ui/sidebar/AnnotationSidebar';
import { registerContextMenu, registerCommands } from './ui/editor/context-menu';
import { MarkVaultSettingTab } from './ui/settings/settings-tab';
import { syncFromMarkdown, recoverAndSyncOffsets, upgradeMarkdownAnnotations } from './core/markdown-sync';
import { markvaultDecorationPlugin, setFilePathResolver } from './core/highlight-applier';
import { createOffsetTrackerExtension, applyIncrementalOffsetFix, type ChangeInfo } from './core/offset-tracker';
import { AnnotationModal } from './ui/editor/annotation-modal';
import { initAnnotationStore, annotationStore } from './db/annotation-store';
import { migrateFromIndexedDB } from './db/migration';
import { removeMarkTag, updateMarkTag, removeBlockAnchor, updateBlockAnchor, removeSpanAnchor, updateSpanAnchor, removeAnyAnchor, updateAnyAnchor, buildSpanAnchor } from './core/annotation-parser';
import { updateSpanCacheForFile, clearSpanCache, type SpanAnnotationData } from './core/highlight-applier';
import { ModifyGuard } from './utils/modify-guard';

export default class MarkVaultPlugin extends Plugin {
  settings: MarkVaultSettings = DEFAULT_SETTINGS;
  private sidebar: AnnotationSidebar | null = null;

  // 当前活跃文件的路径，用于偏移修正
  private activeFilePath: string | null = null;

  // 🆕 防重入保护：当插件自身在修改文件时（创建标注、保存批注），
  // 阻止 onFileOpen() 重新触发 syncFromMarkdown()，避免竞态条件覆盖数据
  // per-file Map + 自动过期，比全局布尔值 + setTimeout 更安全
  public modifyGuard = new ModifyGuard(800);

  // 🆕 防重入扩展：记录正在编辑的标注 uuid 集合
  // 当用户在 Modal 中编辑标注时，即使 modifyGuard 已释放，
  // 也要保护这些标注不被 syncFromMarkdown 覆盖
  private _activeAnnotationUuids = new Set<string>();

  // 🆕 同步维护的活跃文件路径集合，避免 onFileOpen 中异步查询 DB
  private _activeAnnotationFilePaths = new Set<string>();

  /** 注册一个标注为"正在编辑"状态，防止被 sync 覆盖 */
  public markAnnotationActive(uuid: string, filePath?: string) {
    this._activeAnnotationUuids.add(uuid);
    if (filePath) this._activeAnnotationFilePaths.add(filePath);
  }

  /** 取消标注的"正在编辑"状态 */
  public unmarkAnnotationActive(uuid: string, filePath?: string) {
    this._activeAnnotationUuids.delete(uuid);
    // 只有当该文件下没有其他活跃标注时，才移除文件路径
    if (filePath) {
      let hasOtherActive = false;
      // 由于我们无法同步查询 DB，保留文件路径直到 Set 为空
      if (this._activeAnnotationUuids.size === 0) {
        this._activeAnnotationFilePaths.clear();
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
      const migratedCount = await migrateFromIndexedDB();
      if (migratedCount > 0) {
        console.log(`MarkVault: migrated ${migratedCount} annotations from IndexedDB`);
      }
    } catch (err) {
      console.error('MarkVault: failed to initialize AnnotationStore', err);
      // 不阻止插件其余部分加载
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

    // 🆕 当前文件变化时同步（用于切换标签页、重命名等）
    try {
      this.registerEvent(
        this.app.workspace.on('active-leaf-change', async () => {
          const activeFile = this.app.workspace.getActiveFile();
          if (activeFile instanceof TFile && activeFile.extension === 'md') {
            if (activeFile.path !== this.activeFilePath) {
              this.activeFilePath = activeFile.path;
              await this.onFileOpen(activeFile);
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
    // 这是阅读模式点击的【唯一机制】—— post-processor 只负责视觉样式
    // 使用捕获阶段（capture: true），优先于 Highlightr-Plus 等插件的 bubble-phase handler
    try {
      this.registerDomEvent(document, 'click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;

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

        if (!foundMark) return; // 不是点击标注，忽略

        // 🔧 关键修复：判断是否在 CM6 编辑区域中
        // CM6 编辑器的标志：最近的 .cm-editor 祖先
        const isInCmEditor = foundMark.closest('.cm-editor') !== null;

        if (isInCmEditor) {
          // 在 CM6 编辑区域中，不拦截点击（由 CM6 WidgetType 处理）
          return;
        }

        // 在阅读模式或非编辑区域中，拦截点击并打开编辑 Modal
        const uuid = foundMark.getAttribute('data-uuid');
        if (uuid) {
          // 在 capture 阶段拦截，阻止 Highlightr-Plus 等插件处理此点击
          e.stopImmediatePropagation();
          e.preventDefault();
          console.log(`MarkVault: global capture handler caught click for uuid=${uuid}`);
          this.openAnnotationModal(uuid);
          return;
        }
      }, { capture: true });
    } catch (err) {
      console.error('MarkVault: failed to register global click delegate', err);
    }

    console.log('MarkVault: plugin loaded successfully');
  }

  async onunload() {
    console.log('MarkVault: unloading plugin');
    try {
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
      console.log(`MarkVault: onFileOpen skipped — internal modify in progress for ${file.path}`);
      return;
    }

    // 防重入：如果有标注正在被编辑（Modal 打开中），也跳过同步
    // 避免 syncFromMarkdown 在用户编辑 Modal 期间覆盖 DB 数据
    // 🔧 P1 修复：使用同步的 _activeAnnotationFilePaths 替代异步 DB 查询
    if (this._activeAnnotationFilePaths.has(file.path)) {
      console.log(`MarkVault: onFileOpen skipped — annotation being edited for ${file.path}`);
      return;
    }

    if (!this.settings.enableAutoSync) {
      console.log('MarkVault: auto-sync disabled, skipping file-open');
      return;
    }

    try {
      // Phase 2: 确保文件的标注分片已加载到内存
      await annotationStore.ensureFileLoaded(file.path);

      let content = await this.app.vault.read(file);
      console.log(`MarkVault: onFileOpen — ${file.path} (${content.length} chars)`);

      // 0. 自动升级旧格式标注（Highlightr / 纯 <mark>）为 MarkVault 格式
      const upgradedContent = await upgradeMarkdownAnnotations(content, file.path);
      if (upgradedContent !== null && upgradedContent !== content) {
        // 🔧 P1 修复：升级操作触发 vault.modify，需要防重入
        this.modifyGuard.acquire(file.path);
        try {
          await this.app.vault.modify(file, upgradedContent);
        } finally {
          this.modifyGuard.release(file.path);
        }
        content = upgradedContent;
        console.log(`MarkVault: upgraded old-format annotations in ${file.path}`);
      }

      // 1. 从 Markdown 解析标注，同步到 AnnotationStore
      const syncResult = await syncFromMarkdown(content, file.path);
      console.log(`MarkVault: synced ${file.path} — added: ${syncResult.added}, removed: ${syncResult.removed}, updated: ${syncResult.updated}, upgraded: ${syncResult.upgraded}`);

      // 1b. 验证：查询 DB 中当前文件的标注数
      const dbAnnotations = await annotationStore.getAnnotationsForFile(file.path);
      console.log(`MarkVault: DB now has ${dbAnnotations.length} annotations for ${file.path}`);

      // 1c. 检查是否有标注的 note 在 sync 过程中被意外覆盖
      const emptyNotes = dbAnnotations.filter(a => !a.note && a.createdAt > 0);
      if (emptyNotes.length > 0) {
        console.log(`MarkVault: ${emptyNotes.length} annotations have empty notes`);
      }

      // 2. 偏移恢复
      const recovered = await recoverAndSyncOffsets(content, file.path);
      if (recovered > 0) {
        console.log(`MarkVault: recovered ${recovered} annotations offsets in ${file.path}`);
      }

      // 2b. 更新 span 标注缓存（供 CM6 装饰器使用）
      await this.updateSpanCache(file.path);

      // 3. 刷新侧边栏（延迟确保侧边栏已初始化）
      setTimeout(async () => {
        await this.refreshSidebar();
      }, 100);
    } catch (err) {
      console.error('MarkVault: error syncing file', file.path, err);
    }
  }

  // ─── 增量偏移修正 ──────────────────────────────

  private pendingOffsetFix: Promise<void> | null = null;

  private handleDocChange(changes: ChangeInfo[]): void {
    if (!this.activeFilePath) return;

    // 如果已经有待处理的修正，等它完成
    if (this.pendingOffsetFix) return;

    this.pendingOffsetFix = (async () => {
      try {
        const filePath = this.activeFilePath;
        if (!filePath) return;

        const annotations = await annotationStore.getAnnotationsForFile(filePath);
        if (annotations.length === 0) return;

        const result = await applyIncrementalOffsetFix(filePath, changes, annotations);

        if (result.updated > 0 || result.deleted > 0) {
          console.log(`MarkVault: offset fix — updated: ${result.updated}, deleted: ${result.deleted}`);

          // 🔧 BUG-7 修复：偏移修正后刷新 span 缓存，确保 CM6 装饰使用最新偏移
          await this.updateSpanCache(filePath);

          if (result.deleted > 0) {
            await this.refreshSidebar();
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
    // Obsidian 将 %%...%% 注释渲染为 <span class="comment"> 或特定类
    // 遍历所有文本节点查找 markvault 锚点
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
    const anchorNodes: { uuid: string; type: string; color: string; note: string; node: Node; anchorKind: 'block' | 'span' }[] = [];

    let currentNode: Node | null;
    while ((currentNode = walker.nextNode())) {
      if (currentNode.nodeType === Node.COMMENT_NODE) {
        // HTML 注释节点
        const text = currentNode.textContent || '';
        // Block 格式：markvault:uuid:type:color:note
        const blockMatch = text.match(/^markvault:([^:]+):([^:]+):([^:]+):([\s\S]*)$/);
        if (blockMatch) {
          anchorNodes.push({
            uuid: blockMatch[1],
            type: blockMatch[2],
            color: blockMatch[3],
            note: blockMatch[4].replace(/\\c/g, ':'),
            node: currentNode,
            anchorKind: 'block',
          });
        }
        // Span 格式：markvault-span:uuid:type:color:note
        const spanMatch = text.match(/^markvault-span:([^:]+):([^:]+):([^:]+):([\s\S]*)$/);
        if (spanMatch) {
          anchorNodes.push({
            uuid: spanMatch[1],
            type: spanMatch[2],
            color: spanMatch[3],
            note: spanMatch[4].replace(/\\c/g, ':'),
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
        // Obsidian 有时将 %% 注释渲染为特定标记
        const text = htmlEl.textContent || '';
        // Block 格式
        const blockMatch = text.match(/^%%markvault:([^:]+):([^:]+):([^:]+):([\s\S]*)%%$/);
        if (blockMatch) {
          anchorNodes.push({
            uuid: blockMatch[1],
            type: blockMatch[2],
            color: blockMatch[3],
            note: blockMatch[4].replace(/\\c/g, ':'),
            node: currentNode,
            anchorKind: 'block',
          });
          continue;
        }
        // Span 格式
        const spanMatch = text.match(/^%%markvault-span:([^:]+):([^:]+):([^:]+):([\s\S]*)%%$/);
        if (spanMatch) {
          anchorNodes.push({
            uuid: spanMatch[1],
            type: spanMatch[2],
            color: spanMatch[3],
            note: spanMatch[4].replace(/\\c/g, ':'),
            node: currentNode,
            anchorKind: 'span',
          });
        }
      }
    }

    // 给锚点下方的元素添加装饰
    for (const anchor of anchorNodes) {
      const nextSibling = anchor.node.nextSibling;
      if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
        const targetEl = nextSibling as HTMLElement;
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

  async rebuildDatabase() {
    console.log('MarkVault: rebuilding database...');
    try {
      const markdownFiles = this.app.vault.getMarkdownFiles();
      let total = 0;

      for (const file of markdownFiles) {
        try {
          const content = await this.app.vault.read(file);
          const result = await syncFromMarkdown(content, file.path);
          total += result.added;
        } catch {
          // skip files that can't be read
        }
      }

      console.log(`MarkVault: rebuilt database, ${total} annotations added`);
      await this.refreshSidebar();
    } catch (err) {
      console.error('MarkVault: rebuild database error', err);
    }
  }

  async exportAnnotations() {
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
        async (updated) => {
          // 保存回调
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          await this.refreshSidebar();
        },
        async (deletedUuid) => {
          // 删除回调：同时从 Markdown 移除
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          try {
            const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
            if (file instanceof TFile) {
              const content = await this.app.vault.read(file);

              // 根据标注类型选择不同的删除方式
              if (annotation.kind === 'block') {
                // 块级标注：移除 %%markvault:...%% 锚点
                const newContent = removeBlockAnchor(content, deletedUuid);
                if (newContent !== content) {
                  this.modifyGuard.acquire(annotation.filePath);
                  try {
                    await this.app.vault.modify(file, newContent);
                  } finally {
                    this.modifyGuard.release(annotation.filePath);
                  }
                }
              } else if (annotation.kind === 'span') {
                // Span 标注：移除 %%markvault-span:...%% 锚点
                const newContent = removeSpanAnchor(content, deletedUuid);
                if (newContent !== content) {
                  this.modifyGuard.acquire(annotation.filePath);
                  try {
                    await this.app.vault.modify(file, newContent);
                  } finally {
                    this.modifyGuard.release(annotation.filePath);
                  }
                }
              } else {
                // 行内标注：移除 <mark> 标签
                const result = removeMarkTag(content, deletedUuid);
                if (result) {
                  this.modifyGuard.acquire(annotation.filePath);
                  try {
                    await this.app.vault.modify(file, result.content);
                  } finally {
                    this.modifyGuard.release(annotation.filePath);
                  }
                }
              }

              // 更新 span 缓存
              await this.updateSpanCache(annotation.filePath);
            }
          } catch (err) {
            this.modifyGuard.releaseNow(annotation.filePath);
            console.error('MarkVault: failed to remove annotation from markdown', err);
          }
          await this.refreshSidebar();
        },
      );

      // Modal 关闭时如果没有触发回调（如按 Esc），也取消保护
      // 使用 Modal 的 onClose 生命周期钩子
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        this.unmarkAnnotationActive(uuid, annotation.filePath);
        originalOnClose();
      };

      modal.open();
    } catch (err) {
      console.error('MarkVault: failed to open annotation modal', err);
    }
  }
}
