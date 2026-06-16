/**
 * AnnotationCreator — 阅读模式下标注创建 + 文本偏移定位
 *
 * 从 MarkVaultPlugin 提取的方法：
 * - createReadingAnnotation: 阅读模式下创建 inline/block/region 标注
 * - findBestTextOffset: 在源文件中定位选中文本的偏移范围
 * - 辅助方法：buildNormalizedPlainAndMap, findOffsetByDOMContext, findByFuzzySlidingWindow,
 *   tokenizeForFuzzy, normalizeSelectedText, findByTextSnippets, findBlockBoundary
 */

import { MarkdownView, Notice, type App } from 'obsidian';
import type { AnnotationType, Annotation } from '../types/annotation';
import { annotationStore } from '../db/annotation-store';
import { generateId } from '../utils/id';
import { buildBlockAnchorStart, buildBlockAnchorEnd } from '../core/annotation-parser';
import { scanMarkdownContexts, detectBlockAtLine } from '../core/md-context';
import { markdownToPlainWithMap } from '../core/markdown-plain';
import { buildAnnotation, finalizeAnnotation } from '../core/annotation-creator';
import { buildNativeAnnotation } from '../core/native-annotation';
import { buildRegionAnchor } from '../core/region-annotation';
import { computeSignature, computeSpanSignature } from '../core/block-fingerprint';
import {
  getBlockAnchorPrefixesForListItem,
  adjustRegionStartOffsetForListItem,
  adjustRegionEndOffsetForListItem,
} from '../ui/editor/context-menu';
import type { ModifyGuard } from '../utils/modify-guard';

/**
 * Minimal host interface — avoids circular import of MarkVaultPlugin.
 * MarkVaultPlugin satisfies this via structural typing.
 */
export interface CreatorHost {
  readonly app: App;
  readonly modifyGuard: ModifyGuard;
  updateSpanCache(filePath: string): Promise<void>;
  updateRegionCache(filePath: string): Promise<void>;
  markFileSynced(filePath: string): void;
  refreshSidebar(): Promise<void>;
}

export class AnnotationCreator {
  constructor(private host: CreatorHost) {}

  /** 在阅读模式下创建标注 */
  async createReadingAnnotation(selectedText: string, color: string, type: AnnotationType = 'highlight', kind: Annotation['kind'] = 'inline') {
    const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      console.error('MarkVault: no active MarkdownView in reading mode');
      return;
    }

    const filePath = view.file.path;
    const uuid = generateId();

    try {
      const content = await this.host.app.vault.read(view.file);

      // 在源文件中查找选中文本（支持多处相同文本的上下文定位）
      const offsetResult = this.findBestTextOffset(content, selectedText);
      if (!offsetResult) {
        console.error('MarkVault: selected text not found in source file');
        return;
      }
      const { startOffset, endOffset } = offsetResult;

      // 统一加锁，分支内部只执行 modify，锁统一在外层 finally 释放
      this.host.modifyGuard.acquire(filePath);

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
        await this.host.app.vault.modify(view.file, newContent);

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
          updateSpanCache: (fp) => this.host.updateSpanCache(fp),
          updateRegionCache: (fp) => this.host.updateRegionCache(fp),
          markFileSynced: (fp) => this.host.markFileSynced(fp),
          refreshSidebar: () => this.host.refreshSidebar(),
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
          await this.host.app.vault.modify(view.file, newContent);

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
            updateSpanCache: (fp) => this.host.updateSpanCache(fp),
            updateRegionCache: (fp) => this.host.updateRegionCache(fp),
            markFileSynced: (fp) => this.host.markFileSynced(fp),
            refreshSidebar: () => this.host.refreshSidebar(),
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
        await this.host.app.vault.modify(view.file, newContent);

        if (view.previewMode) {
          view.previewMode.rerender(true);
        }

        annotation.endOffset = startOffset + nativeTag.length;

        await finalizeAnnotation(annotation, {
          updateSpanCache: (fp) => this.host.updateSpanCache(fp),
          updateRegionCache: (fp) => this.host.updateRegionCache(fp),
          markFileSynced: (fp) => this.host.markFileSynced(fp),
          refreshSidebar: () => this.host.refreshSidebar(),
        });

        console.log(`MarkVault: created reading-mode native annotation ${uuid} in ${filePath}`);
      }
      }
    } catch (err) {
      console.error('MarkVault: failed to create reading-mode annotation', err);
    } finally {
      this.host.modifyGuard.release(filePath);
      this.host.markFileSynced(filePath);
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
  findBestTextOffset(content: string, selectedText: string): { startOffset: number; endOffset: number } | null {
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
  normalizeSelectedText(text: string): string {
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
