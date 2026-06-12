import { db, toPlain } from './database';
import type { Annotation, AnnotationFilter } from '../types/annotation';

// ─── CRUD ──────────────────────────────────────────────

/** 添加标注 */
export async function addAnnotation(annotation: Annotation): Promise<number> {
  return db.annotations.add(toPlain(annotation));
}

/** 通过 uuid 获取标注 */
export async function getAnnotationByUuid(uuid: string): Promise<Annotation | undefined> {
  return db.annotations.where('uuid').equals(uuid).first();
}

/** 通过 id 获取标注 */
export async function getAnnotationById(id: number): Promise<Annotation | undefined> {
  return db.annotations.get(id);
}

/** 更新标注 */
export async function updateAnnotation(uuid: string, changes: Partial<Annotation>): Promise<number> {
  return db.annotations.where('uuid').equals(uuid).modify({
    ...changes,
    updatedAt: Date.now(),
  });
}

/** 删除标注 */
export async function deleteAnnotation(uuid: string): Promise<void> {
  await db.annotations.where('uuid').equals(uuid).delete();
}

// ─── 批量查询 ─────────────────────────────────────────

/** 获取指定笔记的所有标注（按文档顺序） */
export async function getAnnotationsForFile(filePath: string): Promise<Annotation[]> {
  return db.annotations
    .where('filePath')
    .equals(filePath)
    .sortBy('startOffset');
}

/** 获取所有标注 */
export async function getAllAnnotations(): Promise<Annotation[]> {
  return db.annotations.orderBy('createdAt').reverse().toArray();
}

/** 删除指定笔记的所有标注 */
export async function deleteAnnotationsForFile(filePath: string): Promise<void> {
  await db.annotations.where('filePath').equals(filePath).delete();
}

// ─── 过滤查询 ─────────────────────────────────────────

/** 按过滤条件查询标注 */
export async function queryAnnotations(filter: AnnotationFilter): Promise<Annotation[]> {
  let collection = db.annotations.toCollection();

  // 按类型过滤
  if (filter.type && filter.type !== 'all') {
    collection = db.annotations.where('type').equals(filter.type);
  }

  // 按颜色过滤
  if (filter.color && filter.color !== 'all') {
    const colorResults = await db.annotations.where('color').equals(filter.color).toArray();
    const typeResults = await collection.toArray();
    const colorSet = new Set(colorResults.map(a => a.uuid));
    const filtered = typeResults.filter(a => colorSet.has(a.uuid));
    collection = db.annotations.filter(a => (filtered.some(f => f.uuid === a.uuid)));
  }

  let results = await collection.toArray();

  // 有批注过滤
  if (filter.hasNote) {
    results = results.filter(a => a.note && a.note.trim().length > 0);
  }

  // 搜索查询
  if (filter.searchQuery && filter.searchQuery.trim()) {
    const q = filter.searchQuery.toLowerCase();
    results = results.filter(a =>
      a.text.toLowerCase().includes(q) ||
      a.note.toLowerCase().includes(q) ||
      a.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  // 排序
  const sortBy = filter.sortBy || 'position';
  switch (sortBy) {
    case 'position':
      results.sort((a, b) => a.startOffset - b.startOffset);
      break;
    case 'createdAt':
      results.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'updatedAt':
      results.sort((a, b) => b.updatedAt - a.updatedAt);
      break;
  }

  return results;
}

// ─── 统计 ─────────────────────────────────────────────

/** 获取指定笔记的标注统计 */
export async function getAnnotationStats(filePath: string): Promise<{
  total: number;
  byType: Record<string, number>;
  byColor: Record<string, number>;
  withNotes: number;
  withTags: number;
}> {
  const annotations = await getAnnotationsForFile(filePath);
  const byType: Record<string, number> = {};
  const byColor: Record<string, number> = {};
  let withNotes = 0;
  let withTags = 0;

  for (const a of annotations) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    byColor[a.color] = (byColor[a.color] || 0) + 1;
    if (a.note && a.note.trim()) withNotes++;
    if (a.tags.length > 0) withTags++;
  }

  return { total: annotations.length, byType, byColor, withNotes, withTags };
}

// ─── 偏移修正 ─────────────────────────────────────────

/** 批量修正偏移量（文件打开时使用） */
export async function batchUpdateOffsets(
  updates: Array<{ uuid: string; startOffset: number; endOffset: number }>
): Promise<void> {
  await db.transaction('rw', db.annotations, async () => {
    for (const u of updates) {
      await db.annotations.where('uuid').equals(u.uuid).modify({
        startOffset: u.startOffset,
        endOffset: u.endOffset,
        updatedAt: Date.now(),
      });
    }
  });
}

/** 增量偏移修正：编辑后对变更位置之后的标注做偏移调整 */
export async function adjustOffsetsAfterEdit(
  filePath: string,
  changeStart: number,
  changeEnd: number,
  insertedLen: number,
): Promise<void> {
  const deletedLen = changeEnd - changeStart;
  const delta = insertedLen - deletedLen;

  if (delta === 0) return; // 替换等长文本，偏移不变

  await db.annotations
    .where('filePath')
    .equals(filePath)
    .filter(a => a.startOffset > changeStart)
    .modify(a => {
      a.startOffset += delta;
      a.endOffset += delta;
      a.updatedAt = Date.now();
    });
}
