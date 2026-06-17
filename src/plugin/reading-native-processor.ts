/**
 * 自然语法标注阅读模式处理器
 * 
 * 处理 `%%mv:i:uuid:type:color%%` 格式的自然语法标注（隐身锚点 + 原生包裹）。
 * 在 Obsidian 阅读模式下给标注目标元素添加可视化样式。
 * 
 * @module reading-native-processor
 */

import type { AnnotationType } from '../types/annotation';
import { getAnnotationByUuid } from '../db/annotation-repo';

/**
 * 处理自然语法标注的阅读模式渲染
 * 
 * 从 HTML 注释节点中查找 mv:i: 锚点，给后续的内容元素添加高亮样式。
 */
export async function processNativeAnnotations(el: HTMLElement, sourcePath: string): Promise<void> {
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
    const targetEl = findNextContentElement(anchor.node);
    if (!targetEl) continue;

    const annotation = await getAnnotationByUuid(anchor.uuid);
    const type = anchor.type;
    const color = anchor.color;

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
 * 找到锚点注释节点之后的下一个有效内容元素
 * 策略1: 直接向后遍历 nextSibling
 * 策略2: 向上查找段落容器，找下一个兄弟元素
 */
export function findNextContentElement(anchorNode: Node): HTMLElement | null {
  // 策略1: 直接向后遍历 nextSibling，跳过空白文本节点
  let sibling: Node | null = anchorNode.nextSibling;
  while (sibling) {
    if (sibling.nodeType === Node.ELEMENT_NODE) {
      const el = sibling as HTMLElement;
      if (el.textContent?.trim()) {
        return el;
      }
    }
    sibling = sibling.nextSibling;
  }

  // 策略2: 向上查找到段落级容器，找下一个兄弟元素
  let parent: Node | null = anchorNode.parentNode;
  while (parent && parent !== document.body) {
    if (parent.nodeType === Node.ELEMENT_NODE) {
      const parentEl = parent as HTMLElement;
      const blockTags = ['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION'];
      if (blockTags.includes(parentEl.tagName) || parentEl.hasClass('markdown-preview-sizer') || parentEl.hasClass('markdown-reading-view')) {
        let nextEl: Element | null = parentEl.nextElementSibling;
        while (nextEl) {
          if ((nextEl as HTMLElement).style.display === 'none' || nextEl.hasClass('markvault-anchor-hidden')) {
            nextEl = nextEl.nextElementSibling;
            continue;
          }
          if (nextEl.textContent?.trim()) {
            return nextEl as HTMLElement;
          }
          nextEl = nextEl.nextElementSibling;
        }
        return null;
      }
    }
    parent = parent.parentNode;
  }
  return null;
}
