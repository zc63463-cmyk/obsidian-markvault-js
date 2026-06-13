import { Plugin, MarkdownView, TFile, MarkdownRenderer, Component } from 'obsidian';
import type { MarkVaultSettings, AnnotationType, PresetColorId, Annotation } from './types/annotation';
import { DEFAULT_SETTINGS, PRESET_COLORS } from './types/annotation';
import { MARKVAULT_SIDEBAR_VIEW_TYPE, AnnotationSidebar } from './ui/sidebar/AnnotationSidebar';
import { registerContextMenu, registerCommands } from './ui/editor/context-menu';
import { MarkVaultSettingTab } from './ui/settings/settings-tab';
import { syncFromMarkdown, recoverAndSyncOffsets, upgradeMarkdownAnnotations } from './core/markdown-sync';
import { markvaultDecorationPlugin, setFilePathResolver } from './core/highlight-applier';
import { createOffsetTrackerExtension, applyIncrementalOffsetFix, type ChangeInfo } from './core/offset-tracker';
import { AnnotationModal } from './ui/editor/annotation-modal';
import { initAnnotationStore, annotationStore } from './db/annotation-store';
import { addAnnotation } from './db/annotation-repo';
import { generateId } from './utils/id';
import { migrateFromIndexedDB } from './db/migration';
import { removeMarkTag, updateMarkTag, removeBlockAnchor, updateBlockAnchor, removeSpanAnchor, updateSpanAnchor, removeAnyAnchor, updateAnyAnchor, buildSpanAnchor, buildMarkTag, buildBlockAnchor } from './core/annotation-parser';
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
  public modifyGuard = new ModifyGuard(3000);

  // 🆕 防重入扩展：记录正在编辑的标注 uuid 集合
  // 当用户在 Modal 中编辑标注时，即使 modifyGuard 已释放，
  // 也要保护这些标注不被 syncFromMarkdown 覆盖
  private _activeAnnotationUuids = new Set<string>();

  // 🆕 同步维护的活跃文件路径集合，避免 onFileOpen 中异步查询 DB
  private _activeAnnotationFilePaths = new Set<string>();

  // 🆕 uuid → filePath 反向映射，用于精确维护 _activeAnnotationFilePaths
  private _activeAnnotationUuidToFilePath = new Map<string, string>();

  // 🆕 冷却期：文件最近被插件修改过，跳过短时间内重复的 onFileOpen sync
  // 防止 vault.modify 后异步触发的 file-open 事件重复执行昂贵的全量同步
  private _syncCooldown: Map<string, number> = new Map();

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

  /** 标记文件数据已一致，跳过 onFileOpen 的重复 sync（5s 冷却） */
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

    // 🆕 文件删除时清理关联标注
    try {
      this.registerEvent(
        this.app.vault.on('delete', async (file) => {
          if (file instanceof TFile && file.extension === 'md') {
            console.log(`MarkVault: file deleted — cleaning up annotations for "${file.path}"`);
            try {
              await annotationStore.deleteAnnotationsForFile(file.path);
              await this.refreshSidebar();
              console.log(`MarkVault: annotations cleaned up for deleted file "${file.path}"`);
            } catch (err) {
              console.error('MarkVault: failed to clean up annotations for deleted file', file.path, err);
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
              await annotationStore.renameAnnotationsForFile(oldPath, file.path);
              // 如果当前活跃文件就是被重命名的文件，更新 activeFilePath
              if (this.activeFilePath === oldPath) {
                this.activeFilePath = file.path;
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

    // ── 阅读模式：选中文本浮动工具条 ──
    try {
      this.setupReadingModeToolbar();
    } catch (err) {
      console.error('MarkVault: failed to register reading mode toolbar', err);
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
      return;
    }

    // 防重入：如果有标注正在被编辑（Modal 打开中），也跳过同步
    if (this._activeAnnotationFilePaths.has(file.path)) {
      return;
    }

    // 冷却期检查：文件最近被同步过，避免短时间内重复 sync
    const lastSync = this._syncCooldown.get(file.path);
    if (lastSync && (Date.now() - lastSync) < 5000) {
      return;
    }

    if (!this.settings.enableAutoSync) {
      return;
    }

    // 🔧 P1 修复：冷却期在 sync 开始前设置，防止并发 onFileOpen
    this._syncCooldown.set(file.path, Date.now());

    try {
      await annotationStore.ensureFileLoaded(file.path);

      let content = await this.app.vault.read(file);

      // 0. 自动升级旧格式标注
      const upgradedContent = await upgradeMarkdownAnnotations(content, file.path);
      if (upgradedContent !== null && upgradedContent !== content) {
        this.modifyGuard.acquire(file.path);
        try {
          await this.app.vault.modify(file, upgradedContent);
        } finally {
          this.modifyGuard.release(file.path);
        }
        content = upgradedContent;
      }

      // 1. syncFromMarkdown
      const syncResult = await syncFromMarkdown(content, file.path);

      // 2. 偏移恢复
      const recovered = await recoverAndSyncOffsets(content, file.path);

      // 3. span 缓存
      await this.updateSpanCache(file.path);

      // 4. 刷新侧边栏
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
          // 🔧 审计修复：Modal 已处理 MD 移除，回调只做清理
          this.unmarkAnnotationActive(uuid, annotation.filePath);
          // 标记文件已同步（Modal 中 modifyGuard 已释放）
          this.markFileSynced(annotation.filePath);
          await this.updateSpanCache(annotation.filePath);
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

  // ─── 阅读模式浮动工具条 ──────────────────────

  private _readingToolbar: HTMLElement | null = null;
  private _readingToolbarTimeout: ReturnType<typeof setTimeout> | null = null;

  /** 注册阅读模式选中文本事件 */
  private setupReadingModeToolbar() {
    this.registerDomEvent(document, 'mouseup', (e: MouseEvent) => {
      // 忽略在工具栏自身上的点击
      if (this._readingToolbar && this._readingToolbar.contains(e.target as Node)) return;

      // 延迟一帧，等 selection 更新
      if (this._readingToolbarTimeout) clearTimeout(this._readingToolbarTimeout);
      this._readingToolbarTimeout = setTimeout(() => this.handleReadingSelection(e), 50);
    });

    // 滚动或窗口大小变化时隐藏工具栏
    this.registerDomEvent(document, 'selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        this.hideReadingToolbar();
      }
    });
  }

  /** 处理阅读模式文本选择 */
  private handleReadingSelection(e: MouseEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      this.hideReadingToolbar();
      return;
    }

    // 检查是否在 CM6 编辑器中（编辑模式有自己的右键菜单）
    const target = e.target as HTMLElement;
    if (target.closest('.cm-editor') || target.closest('.cm-content')) return;
    if (target.closest('.markdown-source-view')) return;

    // 必须选中了文本
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (text.length === 0) return;

    // 检查是否在预览区域（阅读模式）
    if (!target.closest('.markdown-preview-view') && !target.closest('.markdown-reading-view')) {
      this.hideReadingToolbar();
      return;
    }

    this.showReadingToolbar(range, text);
  }

  /** 显示浮动工具条 */
  private showReadingToolbar(range: Range, selectedText: string) {
    this.hideReadingToolbar();

    const toolbar = document.createElement('div');
    toolbar.className = 'markvault-reading-toolbar';
    toolbar.setAttribute('data-markvault', 'reading-toolbar');

    toolbar.style.position = 'absolute';
    toolbar.style.zIndex = '9999';

    // 当前选中的标注类型
    let currentType: AnnotationType = 'highlight';
    let currentKind: Annotation['kind'] = 'inline';

    // ── 左侧：类型选择按钮 ──
    const typeGroup = document.createElement('div');
    typeGroup.className = 'markvault-reading-type-group';

    const types: Array<{ type: AnnotationType; label: string; icon: string; kind?: Annotation['kind'] }> = [
      { type: 'highlight', label: 'Highlight', icon: '🎨' },
      { type: 'bold', label: 'Bold', icon: 'B' },
      { type: 'underline', label: 'Underline', icon: 'U̲' },
      { type: 'highlight', label: 'Block', icon: '⬜', kind: 'block' },
    ];

    const typeBtns: HTMLElement[] = [];
    for (const t of types) {
      const btn = document.createElement('button');
      btn.className = 'markvault-reading-type-btn';
      btn.textContent = t.icon;
      btn.title = t.label;
      if (t.type === 'highlight' && !t.kind) btn.classList.add('active');

      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        currentType = t.type;
        currentKind = t.kind || 'inline';
        // 切换 active 状态
        typeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      typeGroup.appendChild(btn);
      typeBtns.push(btn);
    }

    toolbar.appendChild(typeGroup);

    // 分隔线
    const sep = document.createElement('span');
    sep.className = 'markvault-reading-toolbar-sep';
    toolbar.appendChild(sep);

    // ── 右侧：颜色圆点 ──
    const colorGroup = document.createElement('div');
    colorGroup.className = 'markvault-reading-color-group';

    for (const c of PRESET_COLORS) {
      const btn = document.createElement('button');
      btn.className = 'markvault-reading-color-btn';
      btn.style.backgroundColor = c.hex;
      btn.title = `${c.label} (${currentType})`;
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.createReadingAnnotation(selectedText, c.id, currentType, currentKind);
        this.hideReadingToolbar();
      });
      colorGroup.appendChild(btn);
    }

    toolbar.appendChild(colorGroup);

    document.body.appendChild(toolbar);

    // 定位：选中文本上方
    const rect = range.getBoundingClientRect();
    const toolbarHeight = 36; // 预估高度
    let left = rect.left + rect.width / 2;
    let top = rect.top - toolbarHeight - 6 + window.scrollY;

    // 如果上方空间不足，放下方
    if (rect.top < toolbarHeight + 10) {
      top = rect.bottom + 6 + window.scrollY;
    }

    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
    toolbar.style.transform = this._readingToolbar ? 'translate(-50%, 0)' : 'translate(-50%, 0)';

    this._readingToolbar = toolbar;

    // 动画进入
    requestAnimationFrame(() => {
      toolbar.style.opacity = '1';
      toolbar.style.transform = 'translate(-50%, 0) scale(1)';
    });
  }

  /** 隐藏工具条 */
  private hideReadingToolbar() {
    if (this._readingToolbar) {
      const t = this._readingToolbar;
      t.style.opacity = '0';
      t.style.transform = 'translate(-50%, 0) scale(0.8)';
      setTimeout(() => {
        if (t.parentElement) {
          t.remove();
        }
      }, 150);
      this._readingToolbar = null;
    }
  }

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

      // 在源文件中查找选中文本
      const idx = content.indexOf(selectedText);
      if (idx === -1) {
        console.error('MarkVault: selected text not found in source file');
        return;
      }

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
        this.modifyGuard.acquire(filePath);
        try {
          await this.app.vault.modify(view.file, newContent);
        } finally {
          this.modifyGuard.release(filePath);
        }

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
        this.modifyGuard.acquire(filePath);
        try {
          await this.app.vault.modify(view.file, newContent);
        } finally {
          this.modifyGuard.release(filePath);
        }

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
