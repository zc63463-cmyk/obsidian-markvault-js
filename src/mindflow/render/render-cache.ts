/**
 * Render Cache — 节点内容渲染缓存
 *
 * 缓存 MarkdownRenderer.render() 的结果，避免 text 未变时重复渲染。
 *
 * 缓存 key = nodeId + text 内容哈希
 * 缓存 value = { html, height, width }
 *
 * 当节点 text 变化（编辑/文件同步）时，旧缓存自动失效（key 不同）。
 * 当导图重新加载时，调用 clear() 清空全部缓存。
 */

import { logger } from '../../utils/logger';

/** 缓存条目 */
interface CacheEntry {
  /** 渲染后的 HTML 字符串 */
  html: string;
  /** 渲染后的实际高度 */
  height: number;
  /** 渲染后的实际宽度 */
  width: number;
}

/** 最大缓存条目数（防止内存膨胀） */
const MAX_CACHE_SIZE = 500;

export class RenderCache {
  private cache = new Map<string, CacheEntry>();

  /** 生成缓存 key — P2-2: 使用完整 text 的 djb2 哈希，避免碰撞 */
  private makeKey(nodeId: string, text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash = hash & hash;
    }
    return `${nodeId}:${Math.abs(hash).toString(36)}`;
  }

  /** 查询缓存 */
  get(nodeId: string, text: string): CacheEntry | null {
    const key = this.makeKey(nodeId, text);
    return this.cache.get(key) ?? null;
  }

  /** 写入缓存 */
  set(nodeId: string, text: string, html: string, height: number, width: number): void {
    const key = this.makeKey(nodeId, text);

    // LRU 淘汰：超过上限时删除最旧的
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, { html, height, width });
  }

  /** 判断是否有缓存 */
  has(nodeId: string, text: string): boolean {
    return this.cache.has(this.makeKey(nodeId, text));
  }

  /** 清空全部缓存 */
  clear(): void {
    this.cache.clear();
    logger.debug('RenderCache: cleared');
  }

  /** 获取缓存大小 */
  size(): number {
    return this.cache.size;
  }
}
