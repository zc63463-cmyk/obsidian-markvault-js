import type { Editor } from 'obsidian';

/** 上下文窗口大小 */
const DEFAULT_CONTEXT_WINDOW = 50;

/**
 * 从 Editor 中截取标注前后的上下文文本
 * 移植自 note-vault textSelection.ts，适配 Obsidian Editor API
 */
export function extractContext(
  editor: Editor,
  from: { line: number; ch: number },
  to: { line: number; ch: number },
  windowSize: number = DEFAULT_CONTEXT_WINDOW,
): { contextBefore: string; contextAfter: string } {
  const fullText = editor.getValue();
  const startOffset = editor.posToOffset(from);
  const endOffset = editor.posToOffset(to);

  // 不跨 block 边界（以 \n\n 分隔）截取上下文
  const contextBefore = extractContextBefore(fullText, startOffset, windowSize);
  const contextAfter = extractContextAfter(fullText, endOffset, windowSize);

  return { contextBefore, contextAfter };
}

function extractContextBefore(fullText: string, offset: number, windowSize: number): string {
  const start = Math.max(0, offset - windowSize);
  const raw = fullText.substring(start, offset);
  // 不跨段落边界
  const lastParagraphBreak = raw.lastIndexOf('\n\n');
  if (lastParagraphBreak !== -1) {
    return raw.substring(lastParagraphBreak + 2);
  }
  return raw;
}

function extractContextAfter(fullText: string, offset: number, windowSize: number): string {
  const end = Math.min(fullText.length, offset + windowSize);
  const raw = fullText.substring(offset, end);
  // 不跨段落边界
  const firstParagraphBreak = raw.indexOf('\n\n');
  if (firstParagraphBreak !== -1) {
    return raw.substring(0, firstParagraphBreak);
  }
  return raw;
}
