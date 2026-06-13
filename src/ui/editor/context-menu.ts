import { Editor, MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type MarkVaultPlugin from '../../main';
import type { AnnotationType, PresetColorId, Annotation, SpanRange } from '../../types/annotation';
import { PRESET_COLORS } from '../../types/annotation';
import { addAnnotation, getAnnotationByUuid, updateAnnotation, cleanOrphanAnnotations } from '../../db/annotation-repo';
import { buildMarkTag, buildBlockAnchor, buildSpanAnchor, updateMarkTag } from '../../core/annotation-parser';
import { computeSignature, computeSpanSignature } from '../../core/block-fingerprint';
import { generateId } from '../../utils/id';
import { extractContext } from '../../utils/context';
import { scanMarkdownContexts, detectBlockAtLine, type BlockInfo } from '../../core/md-context';
import { encodeFields, applyTemplate } from '../../utils/fields';
import { AnnotationModal } from './annotation-modal';

/**
 * 右键菜单：选中文本后右键显示标注选项
 * 使用扁平菜单项（Obsidian API 的 setSubmenu 在类型定义中不稳定）
 *
 * 🆕 v2.0 增强：
 * - 无选中文本时，如果光标在块级元素上，显示"标注此块"菜单
 * - 有选中文本时，自动检测是否包含特殊内容（公式/代码等），
 *   如有则自动走 Track A（拆分标注）或 Track B（块级锚点）
 */
export function registerContextMenu(plugin: MarkVaultPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
      const selection = editor.getSelection();

      // ── 无选中文本：检测块级元素 ──
      if (!selection || selection.trim().length === 0) {
        const cursor = editor.getCursor();
        const fullContent = editor.getValue();
        const blockInfo = detectBlockAtLine(fullContent, cursor.line);
        if (blockInfo) {
          menu.addSeparator();
          menu.addItem((item) => {
            item.setTitle('📝 Annotate this block')
              .setIcon('pencil')
              .onClick(async () => {
                await createBlockAnnotation(plugin, editor, view, 'highlight', plugin.settings.defaultHighlightColor, blockInfo);
              });
          });
        }
        return;
      }

      // 添加分隔线
      menu.addSeparator();

      // 📝 Annotate — 默认高亮
      menu.addItem((item) => {
        item.setTitle('📝 Annotate')
          .setIcon('pen-tool')
          .onClick(async () => {
            await createAnnotation(plugin, editor, view, 'highlight', plugin.settings.defaultHighlightColor);
          });
      });

      // 颜色选择（扁平展示，视觉分组）
      menu.addItem((item) => {
        item.setTitle('   ── Colors ──')
          .setDisabled(true);
      });
      for (const color of PRESET_COLORS) {
        menu.addItem((item) => {
          item.setTitle(`   ${color.emoji} ${color.label}`)
            .onClick(async () => {
              await createAnnotation(plugin, editor, view, 'highlight', color.id);
            });
        });
      }

      menu.addSeparator();

      // 📝 Annotate + Note
      menu.addItem((item) => {
        item.setTitle('📝 Annotate + Note')
          .setIcon('pen-tool')
          .onClick(async () => {
            await createAnnotationWithNote(plugin, editor, view);
          });
      });

      // 🆕 Phase 3: Annotate with field（仅当有默认模板时显示）
      if (plugin.settings.defaultTemplateId) {
        const defaultTemplate = plugin.settings.fieldTemplates.find(t => t.id === plugin.settings.defaultTemplateId);
        if (defaultTemplate) {
          menu.addSeparator();

          menu.addItem((item) => {
            item.setTitle('🏷️ Annotate with field')
              .setIcon('tag')
              .onClick(async () => {
                // 先创建标注，再打开 Modal 让用户编辑 fields
                const annotation = await createAnnotation(plugin, editor, view, 'highlight', plugin.settings.defaultHighlightColor);
                if (annotation) {
                  // 自动应用默认模板的 fields
                  annotation.fields = applyTemplate(defaultTemplate, {});
                  await updateAnnotation(annotation.uuid, { fields: annotation.fields });

                  // 更新 inline 标注的 Markdown（写入 data-fields）
                  if (annotation.kind === 'inline' || !annotation.kind) {
                    const file = view.file;
                    if (file instanceof TFile) {
                      const content = await plugin.app.vault.read(file);
                      const encodedFields = encodeFields(annotation.fields);
                      const newContent = updateMarkTag(content, annotation.uuid, { fields: encodedFields });
                      if (newContent !== content) {
                        plugin.modifyGuard.acquire(file.path);
                        try {
                          await plugin.app.vault.modify(file, newContent);
                        } finally {
                          plugin.modifyGuard.release(file.path);
                        }
                      }
                    }
                  }

                  // 打开编辑 Modal
                  plugin.markAnnotationActive(annotation.uuid, annotation.filePath);
                  const modal = new AnnotationModal(
                    plugin.app,
                    plugin,
                    annotation,
                    async (updated) => {
                      plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
                      await plugin.refreshSidebar();
                    },
                    async (uuid) => {
                      plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
                      await plugin.refreshSidebar();
                    },
                  );
                  const originalOnClose = modal.onClose.bind(modal);
                  modal.onClose = () => {
                    plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
                    originalOnClose();
                  };
                  modal.open();
                }
              });
          });

          // 展示默认模板的每个字段每个值的快捷菜单项
          for (const fieldDef of defaultTemplate.fields) {
            for (const val of fieldDef.values) {
              menu.addItem((item) => {
                item.setTitle(`   ${fieldDef.key}: ${val}`)
                  .onClick(async () => {
                    const annotation = await createAnnotation(plugin, editor, view, 'highlight', plugin.settings.defaultHighlightColor);
                    if (annotation) {
                      const fields = applyTemplate(defaultTemplate, {});
                      fields[fieldDef.key] = val;
                      annotation.fields = fields;
                      await updateAnnotation(annotation.uuid, { fields });

                      // 更新 Markdown
                      if (annotation.kind === 'inline' || !annotation.kind) {
                        const file = view.file;
                        if (file instanceof TFile) {
                          const content = await plugin.app.vault.read(file);
                          const encodedFields = encodeFields(fields);
                          const newContent = updateMarkTag(content, annotation.uuid, { fields: encodedFields });
                          if (newContent !== content) {
                            plugin.modifyGuard.acquire(file.path);
                            try {
                              await plugin.app.vault.modify(file, newContent);
                            } finally {
                              plugin.modifyGuard.release(file.path);
                            }
                          }
                        }
                      }

                      await plugin.refreshSidebar();
                    }
                  });
              });
            }
          }
        }
      }

      menu.addSeparator();

      // 𝗕 Bold
      menu.addItem((item) => {
        item.setTitle('𝗕 Bold')
          .setIcon('bold')
          .onClick(async () => {
            await createAnnotation(plugin, editor, view, 'bold', plugin.settings.defaultHighlightColor);
          });
      });

      // U̲ Underline
      menu.addItem((item) => {
        item.setTitle('U̲ Underline')
          .setIcon('underline')
          .onClick(async () => {
            await createAnnotation(plugin, editor, view, 'underline', plugin.settings.defaultHighlightColor);
          });
      });
    }),
  );
}

/**
 * 创建标注并立即打开批注编辑 Modal
 * 用于右键菜单 "Annotate" 选项
 */
export async function createAnnotationWithNote(
  plugin: MarkVaultPlugin,
  editor: Editor,
  view: MarkdownView,
): Promise<Annotation | null> {
  // 1. 先创建标注（使用默认高亮）
  const annotation = await createAnnotation(
    plugin,
    editor,
    view,
    'highlight',
    plugin.settings.defaultHighlightColor,
  );
  if (!annotation) return null;

  // 2. 标记此标注为"正在编辑"状态
  plugin.markAnnotationActive(annotation.uuid, annotation.filePath);

  // 3. 立即打开批注编辑 Modal
  const modal = new AnnotationModal(
    plugin.app,
    plugin,
    annotation,
    async (updated) => {
      // 保存回调：取消保护 + 刷新侧边栏
      plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
      await plugin.refreshSidebar();
    },
    async (uuid) => {
      // 删除回调：取消保护 + 刷新侧边栏
      plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
      await plugin.refreshSidebar();
    },
  );

  // Modal 关闭时如果没有触发回调（如按 Esc），也取消保护
  const originalOnClose = modal.onClose.bind(modal);
  modal.onClose = () => {
    plugin.unmarkAnnotationActive(annotation.uuid, annotation.filePath);
    originalOnClose();
  };

  modal.open();

  return annotation;
}

/**
 * 创建标注：双写 Markdown + AnnotationStore
 *
 * 🆕 v2.0 智能路由：
 * - 纯文本 → 原逻辑（单个 <mark> 包裹）
 * - 混合内容（文本 + 公式/代码穿插） → Track A 拆分包裹
 * - 纯特殊内容（整个选区都是公式/代码） → Track B 块级锚点
 *
 * 流程：
 * 1. 扫描选区上下文 → 2. 路由选择 → 3. 写入 Markdown + AnnotationStore
 */
export async function createAnnotation(
  plugin: MarkVaultPlugin,
  editor: Editor,
  view: MarkdownView,
  type: AnnotationType,
  color: PresetColorId | string,
): Promise<Annotation | null> {
  const selection = editor.getSelection();
  if (!selection || !view.file) return null;

  // 🆕 扫描 Markdown 上下文边界
  const scanResult = scanMarkdownContexts(selection);
  console.log(`MarkVault: smart routing — hasSpecial=${scanResult.hasSpecialContent}, isAllSpecial=${scanResult.isAllSpecial}, segments=${scanResult.segments.length}`);

  if (!scanResult.hasSpecialContent) {
    // 纯文本：走原有逻辑
    return createSimpleAnnotation(plugin, editor, view, type, color);
  }

  if (scanResult.isAllSpecial) {
    // 全部为特殊内容（纯公式/代码）：降级为块级锚点标注
    console.log('MarkVault: selection is all special content, using block annotation');
    const fullContent = editor.getValue();
    const from = editor.getCursor('from');
    const blockInfo = detectBlockAtLine(fullContent, from.line);
    if (blockInfo) {
      return createBlockAnnotation(plugin, editor, view, type, color, blockInfo);
    }
    // 如果无法检测块级元素，仍然尝试 span 标注
    // （极端情况：行内公式全部选中但没有 text 段）
    return createSpanAnnotation(plugin, editor, view, type, color, scanResult);
  }

  // 混合内容：走 span 标注逻辑（方案C：单锚点 + spanRanges）
  console.log('MarkVault: selection contains special content, using span annotation');
  return createSpanAnnotation(plugin, editor, view, type, color, scanResult);
}

/**
 * 纯文本标注 — 原逻辑（单个 <mark> 包裹）
 */
async function createSimpleAnnotation(
  plugin: MarkVaultPlugin,
  editor: Editor,
  view: MarkdownView,
  type: AnnotationType,
  color: PresetColorId | string,
): Promise<Annotation | null> {
  const selection = editor.getSelection();
  if (!selection || !view.file) return null;

  const from = editor.getCursor('from');
  const to = editor.getCursor('to');
  const startOffset = editor.posToOffset(from);
  const endOffset = editor.posToOffset(to);

  const uuid = generateId();
  const filePath = view.file.path;

  // 提取上下文
  const { contextBefore, contextAfter } = extractContext(editor, from, to, plugin.settings.contextWindowSize);

  // 构建 Annotation 对象
  const annotation: Annotation = {
    uuid,
    filePath,
    type,
    color,
    text: selection,
    note: '',
    tags: [],
    startOffset,
    endOffset,
    startLine: from.line,
    contextBefore,
    contextAfter,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    kind: 'inline',
  };

  plugin.modifyGuard.acquire(filePath);

  try {
    const markTag = buildMarkTag(annotation);
    editor.replaceSelection(markTag);
    annotation.endOffset = startOffset + markTag.length;

    console.log(`MarkVault: created inline annotation ${uuid} in ${filePath}`);

    await addAnnotation(annotation);
    plugin.markFileSynced(filePath);
    await plugin.refreshSidebar();
  } finally {
    plugin.modifyGuard.release(filePath);
  }

  return annotation;
}

/**
 * Span 标注 — 方案C (Block-like Split Annotation)
 *
 * 当选区包含公式/代码等特殊内容时，不修改选区本身，
 * 而是在选区起始行前插入 %%markvault:%% 锚点，
 * 将文本片段的偏移范围记录在 spanRanges[] 中供 CM6 装饰使用。
 *
 * 优势：
 * - 单条 DB 记录，侧边栏不碎片化
 * - text 保存完整选区（含特殊内容），语义完整
 * - 删除只需移除锚点行，不修改原文
 * - CM6 用 spanRanges 精确高亮文本片段，特殊内容保持原样
 */
async function createSpanAnnotation(
  plugin: MarkVaultPlugin,
  editor: Editor,
  view: MarkdownView,
  type: AnnotationType,
  color: PresetColorId | string,
  scanResult: ReturnType<typeof scanMarkdownContexts>,
): Promise<Annotation | null> {
  if (!view.file) return null;

  const uuid = generateId();
  const filePath = view.file.path;
  const selection = editor.getSelection();
  const from = editor.getCursor('from');
  const to = editor.getCursor('to');

  // 计算文本片段的文档绝对偏移
  const baseOffset = editor.posToOffset(from);
  const spanRanges: SpanRange[] = [];

  for (const seg of scanResult.segments) {
    if (seg.type === 'text' && seg.content.trim().length > 0) {
      spanRanges.push({
        from: baseOffset + seg.startOffset,
        to: baseOffset + seg.endOffset,
      });
    }
  }

  if (spanRanges.length === 0) {
    // 全部是特殊内容，回退到 block 标注
    const fullContent = editor.getValue();
    const blockInfo = detectBlockAtLine(fullContent, from.line);
    if (blockInfo) {
      return createBlockAnnotation(plugin, editor, view, type, color, blockInfo);
    }
    new Notice('MarkVault: cannot annotate pure special content inline', 3000);
    return null;
  }

  // 构建 span 锚点（使用 markvault-span: 前缀区分于 block 标注）
  const anchor = buildSpanAnchor({ uuid, type, color, note: '' });
  const anchorWithNewline = anchor + '\n';

  // 锚点插入位置：选区起始行行首
  const anchorLine = from.line;
  const anchorOffset = editor.posToOffset({ line: anchorLine, ch: 0 });

  // 提取上下文
  const { contextBefore, contextAfter } = extractContext(editor, from, to, plugin.settings.contextWindowSize);

  const annotation: Annotation = {
    uuid,
    filePath,
    type,
    color,
    text: selection,              // 完整选区文本（含特殊内容）
    note: '',
    tags: [],
    startOffset: anchorOffset,
    endOffset: anchorOffset,     // span 标注的 endOffset 不重要，由 spanRanges 决定
    startLine: anchorLine + 1,   // 跳转到内容起始行（锚点行不可见，+1 跳到实际内容）
    contextBefore,
    contextAfter,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    kind: 'span',
    anchorLine,
    spanRanges,
    targetHash: computeSpanSignature(selection),
  };

  plugin.modifyGuard.acquire(filePath);

  try {
    // 在选区起始行前插入锚点（不修改选区内容！）
    editor.replaceRange(anchorWithNewline, { line: anchorLine, ch: 0 });

    // 修正 spanRanges：锚点插入导致所有偏移后移
    const insertedLen = anchorWithNewline.length;
    for (const range of annotation.spanRanges!) {
      range.from += insertedLen;
      range.to += insertedLen;
    }

    console.log(`MarkVault: created span annotation ${uuid} with ${spanRanges.length} ranges in ${filePath}`);

    await addAnnotation(annotation);

    // 更新 span 缓存供 CM6 装饰使用
    plugin.updateSpanCache(filePath);
    plugin.markFileSynced(filePath);

    await plugin.refreshSidebar();
  } finally {
    plugin.modifyGuard.release(filePath);
  }

  return annotation;
}

/**
 * 从选区创建块级标注（当选区全部为特殊内容时的降级路径）
 * 尝试检测光标所在行的块级元素类型
 */
async function createBlockAnnotationFromSelection(
  plugin: MarkVaultPlugin,
  editor: Editor,
  view: MarkdownView,
  type: AnnotationType,
  color: PresetColorId | string,
): Promise<Annotation | null> {
  const fullContent = editor.getValue();
  const from = editor.getCursor('from');
  const blockInfo = detectBlockAtLine(fullContent, from.line);
  if (blockInfo) {
    return createBlockAnnotation(plugin, editor, view, type, color, blockInfo);
  }
  // 无法检测块级元素，通知用户
  new Notice('MarkVault: cannot annotate this content type inline. Try "Annotate this block" from right-click menu.', 4000);
  return null;
}

/**
 * 块级锚点标注 — Track B
 *
 * 在目标块上方插入 %%markvault:uuid:type:color:note%% 注释锚点，
 * CM6 装饰器和 PostProcessor 检测锚点后给下方块添加视觉效果。
 */
async function createBlockAnnotation(
  plugin: MarkVaultPlugin,
  editor: Editor,
  view: MarkdownView,
  type: AnnotationType,
  color: PresetColorId | string,
  blockInfo: BlockInfo,
): Promise<Annotation | null> {
  if (!view.file) return null;

  const uuid = generateId();
  const filePath = view.file.path;

  // 构建锚点字符串
  const anchor = buildBlockAnchor({ uuid, type, color, note: '' });
  const anchorWithNewline = anchor + '\n';

  // 在块起始行上方插入锚点
  const anchorLine = blockInfo.startLine;
  const anchorOffset = editor.posToOffset({ line: anchorLine, ch: 0 });

  const annotation: Annotation = {
    uuid,
    filePath,
    type,
    color,
    text: blockInfo.content,
    note: '',
    tags: [],
    startOffset: anchorOffset,
    endOffset: anchorOffset + anchorWithNewline.length,
    startLine: anchorLine,
    contextBefore: '',
    contextAfter: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    kind: 'block',
    blockType: blockInfo.type,
    targetLine: anchorLine + 1, // 锚点下一行是目标块
    anchorLine,
    targetHash: computeSignature(blockInfo.content),
  };

  plugin.modifyGuard.acquire(filePath);

  try {
    // 在目标行上方插入锚点
    editor.replaceRange(
      anchorWithNewline,
      { line: anchorLine, ch: 0 },
    );

    console.log(`MarkVault: created block annotation ${uuid} for ${blockInfo.type} at line ${anchorLine}`);

    await addAnnotation(annotation);
    plugin.markFileSynced(filePath);
    await plugin.refreshSidebar();
  } finally {
    plugin.modifyGuard.release(filePath);
  }

  return annotation;
}

/**
 * 注册命令面板命令
 */
export function registerCommands(plugin: MarkVaultPlugin): void {
  const defaultColor = plugin.settings.defaultHighlightColor;

  // 高亮命令
  plugin.addCommand({
    id: 'annotate-highlight',
    name: 'Highlight selection',
    icon: 'pen-tool',
    editorCallback: async (editor: Editor, view: MarkdownView) => {
      await createAnnotation(plugin, editor, view, 'highlight', defaultColor);
    },
  });

  // 加粗命令
  plugin.addCommand({
    id: 'annotate-bold',
    name: 'Bold selection',
    icon: 'bold',
    editorCallback: async (editor: Editor, view: MarkdownView) => {
      await createAnnotation(plugin, editor, view, 'bold', defaultColor);
    },
  });

  // 下划线命令
  plugin.addCommand({
    id: 'annotate-underline',
    name: 'Underline selection',
    icon: 'underline',
    editorCallback: async (editor: Editor, view: MarkdownView) => {
      await createAnnotation(plugin, editor, view, 'underline', defaultColor);
    },
  });

  // 每种颜色的快捷高亮
  for (const color of PRESET_COLORS) {
    plugin.addCommand({
      id: `annotate-highlight-${color.id}`,
      name: `Highlight (${color.label})`,
      icon: 'pen-tool',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await createAnnotation(plugin, editor, view, 'highlight', color.id);
      },
    });
  }

  // 高亮 + 批注命令
  plugin.addCommand({
    id: 'annotate-with-note',
    name: 'Annotate and add note',
    icon: 'pen-tool',
    editorCallback: async (editor: Editor, view: MarkdownView) => {
      await createAnnotationWithNote(plugin, editor, view);
    },
  });

  // 🆕 标注当前块（块级锚点标注）
  plugin.addCommand({
    id: 'annotate-block',
    name: 'Annotate current block (formula/code/image)',
    icon: 'code-2',
    editorCallback: async (editor: Editor, view: MarkdownView) => {
      const cursor = editor.getCursor();
      const fullContent = editor.getValue();
      const blockInfo = detectBlockAtLine(fullContent, cursor.line);
      if (blockInfo) {
        await createBlockAnnotation(plugin, editor, view, 'highlight', defaultColor, blockInfo);
      } else {
        new Notice('MarkVault: cursor is not on a block element (formula, code, image, etc.)', 3000);
      }
    },
  });

  // 🆕 强制同步当前文件（调试/修复用）
  plugin.addCommand({
    id: 'markvault-force-sync',
    name: 'Force sync current file annotations',
    icon: 'sync',
    editorCallback: async (_editor: Editor, view: MarkdownView) => {
      if (view.file) {
        try {
          const result = await plugin.forceSyncFile(view.file.path);
          const parts = [
            result.added > 0 ? `${result.added} added` : '',
            result.updated > 0 ? `${result.updated} updated` : '',
            result.inlineRecovered > 0 ? `${result.inlineRecovered} inline offsets recovered` : '',
            result.blocksRecovered > 0 ? `${result.blocksRecovered} blocks recovered` : '',
            result.spansRecovered > 0 ? `${result.spansRecovered} spans recovered` : '',
            result.failed > 0 ? `${result.failed} failed` : '',
          ].filter(Boolean);
          const msg = parts.length > 0 ? parts.join(', ') : 'no changes detected';
          new Notice(`MarkVault: synced (${msg})`, 4000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`MarkVault: sync failed — ${msg}`, 5000);
        }
      }
    },
  });

  // 🆕 重建整个数据库（调试/修复用）
  plugin.addCommand({
    id: 'markvault-rebuild-db',
    name: 'Rebuild annotation database',
    icon: 'database',
    callback: async () => {
      await plugin.rebuildDatabase();
      new Notice('MarkVault: database rebuilt', 3000);
    },
  });

  // 🆕 清理孤儿标注（DB 有但 MD 无）
  plugin.addCommand({
    id: 'markvault-clean-orphans',
    name: 'Clean orphan annotations',
    icon: 'trash-2',
    callback: async () => {
      if (!plugin.isStoreReady()) {
        new Notice('MarkVault: annotation database not initialized', 5000);
        return;
      }
      const cleaned = await cleanOrphanAnnotations(plugin.app);
      await plugin.refreshSidebar();
      new Notice(`MarkVault: cleaned ${cleaned} orphan annotations`, 4000);
    },
  });
}
