import type { ModifyGuard } from './modify-guard';
import type { AnnotationModal } from '../ui/editor/annotation-modal';
import type { Annotation, MarkVaultSettings, RelationSchema } from '../types/annotation';
import type { AnnotationSearchEngine } from '../search/search-engine';

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

  /** 更新指定文件的 region 缓存 */
  updateRegionCache(filePath: string): Promise<void>;

  /** 在编辑模式下选中 region 内容，触发原生选区 */
  selectRegionInEditor(annotation: Annotation): boolean;

  /** 刷新侧边栏 */
  refreshSidebar(): Promise<void>;

  /** 标记文件数据已一致，跳过 onFileOpen 的重复 sync */
  markFileSynced(filePath: string): void;

  /** 强制同步当前文件：同步元数据并恢复偏移、块/span 目标位置 */
  forceSyncFile(filePath: string): Promise<{
    added: number;
    updated: number;
    inlineRecovered: number;
    blocksRecovered: number;
    spansRecovered: number;
    failed: number;
  }>;

  /** 插件设置 */
  settings: MarkVaultSettings;

  /** AnnotationStore 是否已就绪 */
  isStoreReady(): boolean;

  /** 获取搜索引擎实例（供 RelationPicker 等使用） */
  getSearchEngine(): AnnotationSearchEngine;

  /** v4.3: 获取关系类型 Schema 实例 */
  getRelationSchema(): RelationSchema;
}
