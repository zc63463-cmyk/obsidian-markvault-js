import Dexie, { type Table } from 'dexie';
import type { Annotation } from '../types/annotation';

class MarkVaultDB extends Dexie {
  annotations!: Table<Annotation, number>;

  constructor() {
    super('markvault-db');

    // v1: 初始版本
    this.version(1).stores({
      annotations:
        '++id, &uuid, filePath, type, color, startOffset, startLine, createdAt, *tags',
    });

    // 🆕 v2: 增加块级标注和拆分标注支持
    // 新增索引：kind（区分 inline/block）、groupUuid（拆分标注组）
    this.version(2).stores({
      annotations:
        '++id, &uuid, filePath, type, color, startOffset, startLine, createdAt, *tags, kind, groupUuid',
    }).upgrade(tx => {
      // 向后兼容：旧标注自动填充 kind='inline'
      return tx.table('annotations').toCollection().modify(annotation => {
        if (!annotation.kind) {
          annotation.kind = 'inline';
        }
      });
    });

    // 🆕 v3: 增加 span 标注支持
    // kind 字段现在可以是 'inline' | 'block' | 'span'
    // span 标注有额外的 spanRanges 字段
    this.version(3).stores({
      annotations:
        '++id, &uuid, filePath, type, color, startOffset, startLine, createdAt, *tags, kind, groupUuid',
    });
  }
}

/**
 * Lazy-initialized database singleton.
 *
 * CRITICAL: 不能在模块顶层执行 `new MarkVaultDB()`，
 * 因为 Dexie 构造函数会立即打开 IndexedDB 连接。
 * 在 Obsidian 插件加载阶段，如果 IndexedDB 尚未就绪，
 * 整个模块导入链会抛异常，导致插件完全加载失败。
 *
 * 改为首次访问时初始化，确保只在 onload() 之后才打开数据库。
 */
let _db: MarkVaultDB | null = null;

export function getDB(): MarkVaultDB {
  if (!_db) {
    _db = new MarkVaultDB();
  }
  return _db;
}

/** 兼容旧代码：直接导出 db getter（延迟初始化） */
export const db = new Proxy({} as MarkVaultDB, {
  get(_target, prop, receiver) {
    return Reflect.get(getDB(), prop, receiver);
  },
});

/** 剥离 Proxy 等包装，确保存入 DB 的是纯对象 */
export function toPlain<T>(obj: T): T {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}
