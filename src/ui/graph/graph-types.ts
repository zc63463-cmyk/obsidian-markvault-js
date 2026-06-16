/**
 * graph-types — 图谱模块共享类型
 *
 * 将 GraphFilter 从 RelationGraphView 中提取出来，
 * 避免 graph-data-builder 与 RelationGraphView 之间的循环依赖。
 */

/** 图谱过滤条件 */
export interface GraphFilter {
  /** 限制关系类型（空 = 全部） */
  relationTypes: string[];
  /** 限制文件路径（空 = 全部） */
  filePaths: string[];
  /** 限制标注类型（空 = 全部） */
  annotationKinds: string[];
  /** 是否显示孤立节点（无任何关系的标注） */
  showIsolated: boolean;
  /** 是否显示已失效的关系（invalidAt != null） */
  showInvalidated: boolean;
  /** 搜索关键词（模糊匹配标签/别名） */
  searchQuery: string;
  /** 邻居深度（0 = 不限，1~5 = 从 focalNode 扩展 N 跳） */
  neighborDepth: number;
  /** 聚焦节点 ID（搜索匹配或用户点击的节点） */
  focalNodeId: string | null;
}
