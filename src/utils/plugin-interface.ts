import type { ModifyGuard } from './modify-guard';
import type { AnnotationModal } from '../ui/editor/annotation-modal';

/**
 * 侧边栏需要的 Plugin 接口
 * 从 MarkVaultPlugin 中提取，避免 sidebar 直接依赖 any 类型
 */
export interface MarkVaultPluginInterface {
  /** 防重入保护 */
  modifyGuard: ModifyGuard;

  /** 标记标注为"正在编辑"状态，防止被 sync 覆盖 */
  markAnnotationActive(uuid: string, filePath?: string): void;

  /** 取消标注的"正在编辑"状态 */
  unmarkAnnotationActive(uuid: string, filePath?: string): void;

  /** 注册当前打开的 AnnotationModal */
  registerActiveAnnotationModal(uuid: string, modal: AnnotationModal): void;

  /** 注销已关闭的 AnnotationModal */
  unregisterActiveAnnotationModal(uuid: string): void;

  /** 更新指定文件的 span 缓存 */
  updateSpanCache(filePath: string): Promise<void>;

  /** 刷新侧边栏 */
  refreshSidebar(): Promise<void>;

  /** 标记文件数据已一致，跳过 onFileOpen 的重复 sync */
  markFileSynced(filePath: string): void;
}
