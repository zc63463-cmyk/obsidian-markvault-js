/**
 * ActiveAnnotationState — 管理正在编辑的标注保护状态
 *
 * 防止 syncFromMarkdown 覆盖用户正在编辑的标注数据。
 * 维护 uuid ↔ filePath 的双向映射，确保文件级别的编辑保护精确生效。
 */

import type { AnnotationModal } from '../ui/editor/annotation-modal';

export class ActiveAnnotationState {
  /** 正在编辑的标注 uuid 集合 */
  private _activeAnnotationUuids = new Set<string>();

  /** 同步维护的活跃文件路径集合，避免 onFileOpen 中异步查询 DB */
  private _activeAnnotationFilePaths = new Set<string>();

  /** uuid → filePath 反向映射，用于精确维护 _activeAnnotationFilePaths */
  private _activeAnnotationUuidToFilePath = new Map<string, string>();

  /** 当前打开的 AnnotationModal 实例（按 uuid 索引） */
  private _activeAnnotationModals = new Map<string, AnnotationModal>();

  /** 注册一个标注为"正在编辑"状态，防止被 sync 覆盖 */
  markAnnotationActive(uuid: string, filePath?: string): void {
    this._activeAnnotationUuids.add(uuid);
    if (filePath) {
      this._activeAnnotationUuidToFilePath.set(uuid, filePath);
      this._activeAnnotationFilePaths.add(filePath);
    }
  }

  /** 取消标注的"正在编辑"状态 */
  unmarkAnnotationActive(uuid: string, filePath?: string): void {
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
  isAnnotationActive(uuid: string): boolean {
    return this._activeAnnotationUuids.has(uuid);
  }

  /** 检查某个文件是否有正在编辑的标注（同步，无需查询 DB） */
  isFileEditing(filePath: string): boolean {
    return this._activeAnnotationFilePaths.has(filePath);
  }

  /** 注册当前打开的 AnnotationModal */
  registerActiveAnnotationModal(uuid: string, modal: AnnotationModal): void {
    this._activeAnnotationModals.set(uuid, modal);
  }

  /** 注销已关闭的 AnnotationModal */
  unregisterActiveAnnotationModal(uuid: string): void {
    this._activeAnnotationModals.delete(uuid);
  }

  /** 关闭指定文件上所有打开的 AnnotationModal */
  closeActiveModalsForFile(filePath: string): void {
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

  // ─── 供 SyncEngine / 事件处理器读取的访问器 ───

  /** 获取 uuid → filePath 映射（供 rename 事件处理器更新路径） */
  get uuidToFilePath(): Map<string, string> {
    return this._activeAnnotationUuidToFilePath;
  }

  /** 获取活跃文件路径集合（供 onFileOpen 检查） */
  get activeFilePaths(): Set<string> {
    return this._activeAnnotationFilePaths;
  }

  /** 获取活跃标注 uuid 集合（供 delete 事件处理器遍历清理） */
  get activeUuids(): Set<string> {
    return this._activeAnnotationUuids;
  }
}
