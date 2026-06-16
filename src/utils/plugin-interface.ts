import type { App } from 'obsidian';
import type { ModifyGuard } from './modify-guard';
import type { AnnotationModal } from '../ui/editor/annotation-modal';
import type { Annotation, MarkVaultSettings, RelationSchema } from '../types/annotation';
import type { AnnotationSearchEngine } from '../search/search-engine';

/**
 * MarkVaultPlugin 的公共接口
 * 从 MarkVaultPlugin 中提取，避免 UI 模块直接依赖 main.ts 造成循环引用。
 *
 * 所有 UI 模块应通过此接口访问 Plugin，不再 import MarkVaultPlugin 本身。
 * MarkVaultPlugin（main.ts）implements 此接口以确保编译时类型一致。
 */
export interface MarkVaultPluginInterface {
  // ─── Obsidian Plugin 基类委托 ──────────────────────
  /** Obsidian App 实例 */
  app: App;

  /** 注册事件监听器（委托 Obsidian Plugin.registerEvent） */
  registerEvent(eventRef: any): void;

  /** 注册命令面板命令（委托 Obsidian Plugin.addCommand） */
  addCommand(command: any): void;

  // ─── 防重入保护 ─────────────────────────────────────
  /** 防重入保护 */
  modifyGuard: ModifyGuard;

  // ─── 标注激活状态管理 ────────────────────────────────
  /** 标记标注为"正在编辑"状态，防止被 sync 覆盖 */
  markAnnotationActive(uuid: string, filePath?: string): void;

  /** 取消标注的"正在编辑"状态 */
  unmarkAnnotationActive(uuid: string, filePath?: string): void;

  /** 注册当前打开的 AnnotationModal */
  registerActiveAnnotationModal(uuid: string, modal: AnnotationModal): void;

  /** 注销已关闭的 AnnotationModal */
  unregisterActiveAnnotationModal(uuid: string): void;

  // ─── 缓存管理 ───────────────────────────────────────
  /** 更新指定文件的 span 缓存 */
  updateSpanCache(filePath: string): Promise<void>;

  /** 更新指定文件的 region 缓存 */
  updateRegionCache(filePath: string): Promise<void>;

  /** 立即更新 region 缓存（新标注创建后调用） */
  updateRegionCacheImmediately(filePath: string, newAnnotation: Annotation): void;

  /** 立即更新 block 缓存（新标注创建后调用） */
  updateBlockCacheImmediately(filePath: string, newAnnotation: Annotation): void;

  /** 在编辑模式下选中 region 内容，触发原生选区 */
  selectRegionInEditor(annotation: Annotation): boolean;

  // ─── 侧边栏 / 图谱 ──────────────────────────────────
  /** 刷新侧边栏 */
  refreshSidebar(): Promise<void>;

  /** 激活关系图谱视图 */
  activateGraphView(): Promise<void>;

  // ─── 同步 ──────────────────────────────────────────
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

  // ─── 设置 ──────────────────────────────────────────
  /** 插件设置 */
  settings: MarkVaultSettings;

  /** 保存设置到磁盘 */
  saveSettings(): Promise<void>;

  /** v4.3 关系类型 Schema 实例（设置变更时需重写） */
  relationSchema: RelationSchema;

  // ─── 数据管理 ──────────────────────────────────────
  /** AnnotationStore 是否已就绪 */
  isStoreReady(): boolean;

  /** 重建标注数据库 */
  rebuildDatabase(): Promise<void>;

  /** 导出所有标注为 JSON */
  exportAnnotations(): Promise<void>;

  // ─── 搜索 / 关系 ──────────────────────────────────
  /** 获取搜索引擎实例（供 RelationPicker 等使用） */
  getSearchEngine(): AnnotationSearchEngine;

  /** v4.3: 获取关系类型 Schema 实例 */
  getRelationSchema(): RelationSchema;
}
