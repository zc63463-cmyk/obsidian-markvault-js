/**
 * ModifyGuard — per-file 防重入保护
 *
 * 替换原来的全局 _isInternalModify 布尔值 + 500ms setTimeout。
 * 每个文件有独立的保护计时器，互不干扰。
 *
 * 用法：
 *   guard.acquire(filePath);            // 标记文件正在被修改
 *   await vault.modify(file, content);  // 修改文件
 *   guard.release(filePath, 800);       // 800ms 后自动清除保护
 *
 *   if (guard.isLocked(filePath)) { ... } // 检查文件是否被保护
 *   guard.releaseNow(filePath);           // 立即清除保护
 */
export class ModifyGuard {
  /** filePath → timeoutId */
  private _locks: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** 默认自动释放延迟（毫秒） */
  private _defaultDelay: number;

  constructor(defaultDelay: number = 800) {
    this._defaultDelay = defaultDelay;
  }

  /**
   * 标记文件正在被修改（acquire lock）。
   * 如果已有锁，先清除旧计时器再重新加锁。
   */
  acquire(filePath: string): void {
    const existing = this._locks.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this._locks.set(filePath, -1 as any); // 占位，表示已加锁但无自动释放
  }

  /**
   * 释放锁，延迟 ms 后自动清除保护。
   * 如果不传 delay，使用默认值。
   * 如果不调用 release()，锁将一直保持（需手动 releaseNow()）。
   */
  release(filePath: string, delay?: number): void {
    const existing = this._locks.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this._locks.delete(filePath);
    }, delay ?? this._defaultDelay);

    this._locks.set(filePath, timer);
  }

  /**
   * 立即释放锁（无延迟）。
   */
  releaseNow(filePath: string): void {
    const existing = this._locks.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this._locks.delete(filePath);
  }

  /**
   * 检查文件是否被保护（正在修改中）。
   */
  isLocked(filePath: string): boolean {
    return this._locks.has(filePath);
  }

  /**
   * 检查是否有任何文件被保护。
   * 兼容旧的 _isInternalModify 全局检查。
   */
  isAnyLocked(): boolean {
    return this._locks.size > 0;
  }

  /**
   * 释放所有锁（用于清理/关闭）。
   */
  releaseAll(): void {
    for (const timer of this._locks.values()) {
      if (typeof timer === 'number') {
        clearTimeout(timer);
      } else if (timer !== undefined && timer !== (null as any)) {
        clearTimeout(timer);
      }
    }
    this._locks.clear();
  }
}
