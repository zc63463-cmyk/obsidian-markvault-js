/**
 * Phase 2: Dexie has been replaced by AnnotationStore (sharded JSON + in-memory index).
 *
 * This file is kept as a stub during the migration period.
 * Only migration.ts references it for the old Dexie schema.
 *
 * TODO: Remove this file entirely after confirming migration works.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = {} as never;

/** 剥离 Proxy 等包装，确保存入 DB 的是纯对象 — 兼容旧代码 */
export function toPlain<T>(obj: T): T {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}
