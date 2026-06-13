import type { Vault, DataAdapter } from 'obsidian';
import type {
  Annotation,
  AnnotationFilter,
  AnnotationStats,
  BatchUpdateItem,
  IndexData,
  IndexEntry,
  StoreMeta,
} from '../types/annotation';
import { FileEncoder } from './file-encoder';

/**
 * AnnotationStore — 分片 JSON + 内存索引 标注存储
 *
 * 核心架构：
 * - 每个笔记文件对应一个分片 JSON（annotations/{encodedPath}.json）
 * - 内存中维护 6 个倒排索引 Map/Set，支持 O(1) ~ O(log n) 查询
 * - 懒加载：只有访问过的文件才加载到内存
 * - 防抖写回：修改后 2s 自动持久化，避免频繁 I/O
 */
export class AnnotationStore {
  // ─── 内存索引层 ─────────────────────────────────────────
  /** uuid → Annotation，O(1) 精确查找 */
  private _byUuid: Map<string, Annotation> = new Map();

  /** filePath → Set<uuid>，按文件索引 */
  private _byFile: Map<string, Set<string>> = new Map();

  /** kind → Set<uuid>，按标注类型索引（inline/block/span） */
  private _byKind: Map<string, Set<string>> = new Map();

  /** type → Set<uuid>，按标注样式索引（highlight/bold/underline） */
  private _byType: Map<string, Set<string>> = new Map();

  /** color → Set<uuid>，按颜色索引 */
  private _byColor: Map<string, Set<string>> = new Map();

  /** tag → Set<uuid>，按标签索引 */
  private _byTag: Map<string, Set<string>> = new Map();

  /** fieldKey → (fieldValue → Set<uuid>)，按自定义字段索引 */
  private _byField: Map<string, Map<string, Set<string>>> = new Map();

  // ─── 其他内部状态 ───────────────────────────────────────
  /** 需要写回的文件集合 */
  private _dirtyFiles: Set<string> = new Set();

  /** 已加载的文件集合 */
  private _loadedFiles: Set<string> = new Set();

  /** 每文件防抖计时器 */
  private _debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Obsidian vault.adapter（用于文件读写），通过 init() 设置 */
  private _adapter: DataAdapter | null = null;

  /** 获取 adapter，未初始化时抛出错误 */
  private get adapter(): DataAdapter {
    if (!this._adapter) {
      throw new Error('AnnotationStore: not initialized. Call init(vault) first.');
    }
    return this._adapter;
  }

  /** 插件目录路径（如 .obsidian/plugins/markvault-js） */
  private _baseDir: string = '';

  /** 防抖延迟（毫秒） */
  private _flushDebounceMs: number = 2000;

  /** 索引是否需要写回 */
  private _indexDirty: boolean = false;

  /** 元数据 */
  private _meta: StoreMeta = {
    schemaVersion: 1,
    createdAt: 0,
    lastSyncAt: 0,
  };

  /** 索引数据（内存中的 _index.json 映射） */
  private _indexData: IndexData = { version: 1, entries: {} };

  /** 是否已完成初始化 */
  private _initialized: boolean = false;

  constructor() {
    // 默认构造，使用 initAnnotationStore() 设置 vault
  }

  /**
   * 初始化 AnnotationStore，设置 vault 引用。
   * 必须在插件 onload 时调用，且只调用一次。
   */
  init(vault: Vault): void {
    this._adapter = vault.adapter;
    // vault.configDir 通常是 '.obsidian'
    // 使用 Obsidian 的 plugin 路径规范
    this._baseDir = `${vault.configDir}/plugins/markvault-js`;
  }

  // ═══════════════════════════════════════════════════════
  // 公共方法
  // ═══════════════════════════════════════════════════════

  /**
   * 启动初始化：读取元数据和索引文件，不加载分片。
   */
  async initialize(): Promise<void> {
    if (!this._adapter) {
      throw new Error('AnnotationStore: init(vault) must be called before initialize()');
    }

    // 确保插件目录和 annotations 子目录存在
    const annotationsDir = `${this._baseDir}/annotations`;
    if (!(await this.adapter.exists(annotationsDir))) {
      await this.adapter.mkdir(annotationsDir);
    }

    // 读取或创建 _meta.json
    try {
      this._meta = await this._readMetaFile();
    } catch {
      // 文件不存在，使用默认 meta 并写入
      this._meta = {
        schemaVersion: 1,
        createdAt: Date.now(),
        lastSyncAt: Date.now(),
      };
      await this._writeMetaFile();
    }

    // 读取或创建 _index.json
    try {
      this._indexData = await this._readIndexFile();
    } catch {
      // 文件不存在，使用空索引
      this._indexData = { version: 1, entries: {} };
      await this._writeIndexFile();
    }

    // 🔧 修复：预加载所有标注数据到内存，确保 getAllAnnotations() 无需打开文件即可返回结果
    this._byFile.clear();
    const filePaths = Object.values(this._indexData.entries).map(e => e.filePath);
    let loadedCount = 0;
    for (const filePath of filePaths) {
      try {
        if (!this._loadedFiles.has(filePath)) {
          await this.ensureFileLoaded(filePath);
          loadedCount++;
        }
      } catch (err) {
        console.warn(`MarkVault: failed to preload annotations for ${filePath}`, err);
      }
    }
    if (loadedCount > 0) {
      console.log(`MarkVault: preloaded ${loadedCount} annotation files (${this._byUuid.size} total annotations)`);
    }

    // 🔧 审计修复：清理 _indexData 中的孤儿条目
    // 如果 index 中有条目但分片文件已被删除，ensureFileLoaded 会创建空的 byFile entry
    // 这些空 entry 应该被清理，防止 _index.json 膨胀
    let orphanCleaned = 0;
    for (const [filePath, uuidSet] of this._byFile) {
      if (uuidSet.size === 0) {
        this._byFile.delete(filePath);
        this._loadedFiles.delete(filePath);
        const key = FileEncoder.encodeFilePath(filePath);
        delete this._indexData.entries[key];
        orphanCleaned++;
      }
    }
    if (orphanCleaned > 0) {
      console.log(`MarkVault: cleaned ${orphanCleaned} orphan index entries`);
      await this._writeIndexFile();
    }

    // 🔧 修复：清理已被污染的 note 字段
    // 某些标注的 note 字段被错误写入了其他标注的 uuid:type:color 格式
    // 检测并清理这些污染数据
    const dirtyNotePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(highlight|bold|underline):(yellow|green|blue|pink|purple):?$/;
    let cleanedCount = 0;
    for (const [uuid, ann] of this._byUuid) {
      if (ann.note && dirtyNotePattern.test(ann.note.trim())) {
        console.warn(`MarkVault: cleaning corrupted note for annotation ${uuid}: "${ann.note}"`);
        ann.note = '';
        this._dirtyFiles.add(ann.filePath);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`MarkVault: cleaned ${cleanedCount} corrupted note fields`);
      await this.flushAll();
    }

    this._initialized = true;
  }

  /**
   * 关闭存储（等同 flushAll）。
   * 安全处理：未初始化或 adapter 不可用时静默返回。
   */
  async shutdown(): Promise<void> {
    if (!this._initialized || !this._adapter) {
      return;
    }
    try {
      await this.flushAll();
    } catch (err) {
      console.error('MarkVault: AnnotationStore shutdown flush failed', err);
    }
  }

  /**
   * O(1) 按 UUID 精确查找标注。
   */
  getAnnotationByUuid(uuid: string): Annotation | undefined {
    return this._byUuid.get(uuid);
  }

  /**
   * 获取指定文件的所有标注，按 startOffset 排序。
   */
  getAnnotationsForFile(filePath: string): Annotation[] {
    const uuidSet = this._byFile.get(filePath);
    if (!uuidSet) return [];

    const annotations: Annotation[] = [];
    for (const uuid of uuidSet) {
      const ann = this._byUuid.get(uuid);
      if (ann) annotations.push(ann);
    }

    return annotations.sort((a, b) => a.startOffset - b.startOffset);
  }

  /**
   * 获取所有已加载的标注。
   *
   * 注意：只返回已加载文件中的标注，未加载的分片不会被读取。
   */
  getAllAnnotations(): Annotation[] {
    const result: Annotation[] = [];
    for (const ann of this._byUuid.values()) {
      result.push(ann);
    }
    return result;
  }

  /**
   * 添加标注，更新索引并标记 dirty。
   * 自动过滤非标准字段（如 _source、_needsUpgrade）。
   */
  async addAnnotation(annotation: Annotation): Promise<void> {
    this._assertInitialized();

    // 确保文件已加载
    await this.ensureFileLoaded(annotation.filePath);

    // 过滤非标准字段，防止 _source/_needsUpgrade 等临时标记写入存储
    const clean = AnnotationStore._stripExtraFields(annotation);

    // 存入索引
    this._byUuid.set(clean.uuid, clean);
    this._addToIndex(clean);

    // 更新 _indexData
    this._updateIndexEntry(clean.filePath);

    this._markDirty(clean.filePath);
  }

  /**
   * 更新标注。
   *
   * 注意：updatedAt 不会自动设置，由调用方决定是否更新时间戳。
   * 这是因为系统操作（如 offset fix）不应更新 updatedAt。
   */
  async updateAnnotation(uuid: string, changes: Partial<Annotation>): Promise<void> {
    this._assertInitialized();

    const oldAnn = this._byUuid.get(uuid);
    if (!oldAnn) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    // 移除旧索引
    this._removeFromIndex(uuid);

    // 合并变更
    const newAnn: Annotation = AnnotationStore._stripExtraFields({ ...oldAnn, ...changes });
    this._byUuid.set(uuid, newAnn);

    // 处理 filePath 变更（标注移动到另一个文件）
    if (changes.filePath && changes.filePath !== oldAnn.filePath) {
      // 从旧文件的 Set 中移除
      const oldFileSet = this._byFile.get(oldAnn.filePath);
      if (oldFileSet) {
        oldFileSet.delete(uuid);
        // 如果旧文件没有标注了，清理索引
        if (oldFileSet.size === 0) {
          this._byFile.delete(oldAnn.filePath);
          this._loadedFiles.delete(oldAnn.filePath);
          const oldKey = FileEncoder.encodeFilePath(oldAnn.filePath);
          delete this._indexData.entries[oldKey];
          this._indexDirty = true;
          // 删除旧分片文件
          const oldShardPath = FileEncoder.getShardPath(this._baseDir, oldAnn.filePath);
          try {
            await this.adapter.remove(oldShardPath);
          } catch {
            // 文件可能不存在，忽略
          }
        } else {
          this._updateIndexEntry(oldAnn.filePath);
        }
      }

      // 确保新文件已加载
      await this.ensureFileLoaded(newAnn.filePath);

      // 添加到新文件的 Set
      let newFileSet = this._byFile.get(newAnn.filePath);
      if (!newFileSet) {
        newFileSet = new Set();
        this._byFile.set(newAnn.filePath, newFileSet);
      }
      newFileSet.add(uuid);

      this._updateIndexEntry(newAnn.filePath);
      this._markDirty(newAnn.filePath);
    }

    // 重建索引
    this._addToIndex(newAnn);

    // 标记 dirty（如果 filePath 没变，只标记一个文件；如果变了，新旧都要标记）
    if (!changes.filePath || changes.filePath === oldAnn.filePath) {
      this._updateIndexEntry(newAnn.filePath);
      this._markDirty(newAnn.filePath);
    } else {
      // 旧文件的 dirty 已在上方处理
      // 新文件也需要标记
      this._markDirty(newAnn.filePath);
    }
  }

  /**
   * 删除标注，移除索引并标记 dirty。
   * 如果删除后文件标注数为 0，从 _indexData 移除 entry 并删除分片文件。
   */
  async deleteAnnotation(uuid: string): Promise<void> {
    this._assertInitialized();

    const ann = this._byUuid.get(uuid);
    if (!ann) return;

    const filePath = ann.filePath;

    // 移除索引
    this._removeFromIndex(uuid);
    this._byUuid.delete(uuid);

    // 从 _byFile 中移除
    const fileSet = this._byFile.get(filePath);
    const hadFileEntry = fileSet !== undefined;
    const wasInFileSet = fileSet?.delete(uuid) ?? false;

    if (fileSet && fileSet.size === 0) {
      // 文件没有标注了，清理所有关联资源
      this._byFile.delete(filePath);
      this._loadedFiles.delete(filePath);
      const key = FileEncoder.encodeFilePath(filePath);
      delete this._indexData.entries[key];

      // 🔧 审计修复：清除脏数据和防抖计时器，防止残留 flush 重建分片
      this._dirtyFiles.delete(filePath);
      const timer = this._debounceTimers.get(filePath);
      if (timer !== undefined) {
        clearTimeout(timer);
        this._debounceTimers.delete(filePath);
      }

      // 删除分片文件
      const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);
      try {
        await this.adapter.remove(shardPath);
      } catch {
        // 文件可能不存在，忽略
      }

      // 🔧 P0 修复：立即写回 _index.json，防止重启后残留孤儿条目
      await this._writeIndexFile();

      console.log(`MarkVault: deleted last annotation for file "${filePath}" — shard removed, index updated`);
    } else {
      // 🔧 P1 修复：即使 fileSet 不存在或不包含 uuid（内存索引不一致），
      // 也要更新索引并标记 dirty，确保分片文件能正确反映删除
      this._updateIndexEntry(filePath);
      this._markDirty(filePath);

      if (!hadFileEntry) {
        console.warn(`MarkVault: deleteAnnotation — fileSet missing for ${filePath}, recovered index entry`);
      } else if (!wasInFileSet) {
        console.warn(`MarkVault: deleteAnnotation — uuid ${uuid} not in fileSet for ${filePath}, recovered index entry`);
      }
    }
  }

  /**
   * 基于内存索引的查询，支持多维度过滤。
   */
  queryAnnotations(filter?: AnnotationFilter): Annotation[] {
    if (!filter) {
      return this.getAllAnnotations();
    }

    // 收集候选 uuid 集合（取交集）
    let candidateUuids: Set<string> | null = null;

    // 按样式类型过滤（使用 _byType 索引：highlight/bold/underline）
    if (filter.type && filter.type !== 'all') {
      const typeSet = this._byType.get(filter.type);
      if (!typeSet) return [];
      candidateUuids = new Set(typeSet);
    }

    // 按颜色过滤（使用 _byColor 索引）
    if (filter.color && filter.color !== 'all') {
      const colorSet = this._byColor.get(filter.color);
      if (!colorSet) return [];
      if (candidateUuids) {
        candidateUuids = intersection(candidateUuids, colorSet);
      } else {
        candidateUuids = new Set(colorSet);
      }
    }

    // 按自定义字段过滤（使用 _byField 索引）
    if (filter.fieldFilters && Object.keys(filter.fieldFilters).length > 0) {
      for (const [fieldKey, fieldValue] of Object.entries(filter.fieldFilters)) {
        const fieldMap = this._byField.get(fieldKey);
        if (!fieldMap) return [];
        const valueSet = fieldMap.get(fieldValue);
        if (!valueSet) return [];
        if (candidateUuids) {
          candidateUuids = intersection(candidateUuids, valueSet);
        } else {
          candidateUuids = new Set(valueSet);
        }
      }
    }

    // 如果没有任何索引过滤，使用全部标注
    let results: Annotation[];
    if (candidateUuids) {
      results = [];
      for (const uuid of candidateUuids) {
        const ann = this._byUuid.get(uuid);
        if (ann) results.push(ann);
      }
    } else {
      results = this.getAllAnnotations();
    }

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
        a.tags.some(t => t.toLowerCase().includes(q)) ||
        (a.fields && Object.entries(a.fields).some(([k, v]) =>
          k.toLowerCase().includes(q) || v.toLowerCase().includes(q)
        ))
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

  /**
   * 获取标注统计。
   * 如果指定 filePath，只统计该文件；否则统计所有已加载标注。
   */
  getAnnotationStats(filePath?: string): AnnotationStats {
    const annotations = filePath
      ? this.getAnnotationsForFile(filePath)
      : this.getAllAnnotations();

    const byType: Record<string, number> = {};
    const byColor: Record<string, number> = {};
    let withNotes = 0;
    let withTags = 0;
    let withFields = 0;

    for (const a of annotations) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      byColor[a.color] = (byColor[a.color] || 0) + 1;
      if (a.note && a.note.trim()) withNotes++;
      if (a.tags.length > 0) withTags++;
      if (a.fields && Object.keys(a.fields).length > 0) withFields++;
    }

    return { total: annotations.length, byType, byColor, withNotes, withTags, withFields };
  }

  /**
   * 批量更新偏移量（文件打开时 offset 修正使用）。
   */
  async batchUpdateOffsets(updates: BatchUpdateItem[]): Promise<void> {
    this._assertInitialized();

    // 按文件分组，减少 dirty 标记次数
    const filesAffected = new Set<string>();

    for (const item of updates) {
      const ann = this._byUuid.get(item.uuid);
      if (!ann) continue;

      // 移除旧索引
      this._removeFromIndex(item.uuid);

      // 更新偏移
      ann.startOffset = item.startOffset;
      ann.endOffset = item.endOffset;
      if (item.spanRanges !== undefined) {
        ann.spanRanges = item.spanRanges;
      }

      // 重建索引
      this._addToIndex(ann);

      filesAffected.add(ann.filePath);
    }

    // 标记所有受影响文件为 dirty
    for (const filePath of filesAffected) {
      this._updateIndexEntry(filePath);
      this._markDirty(filePath);
    }
  }

  /**
   * 懒加载：确保指定文件的分片已加载到内存。
   * 如果已加载则直接返回。
   */
  async ensureFileLoaded(filePath: string): Promise<void> {
    if (this._loadedFiles.has(filePath)) return;

    const annotations = await this._readFileShard(filePath);

    // 确保文件有对应的 Set
    if (!this._byFile.has(filePath)) {
      this._byFile.set(filePath, new Set());
    }

    // 逐个添加到内存索引（清理可能残留的非标准字段）
    for (const ann of annotations) {
      const clean = AnnotationStore._stripExtraFields(ann);
      this._byUuid.set(clean.uuid, clean);
      this._byFile.get(filePath)!.add(clean.uuid);
      this._addToIndex(clean);
    }

    this._loadedFiles.add(filePath);

    // 如果分片有标注但 _indexData 中没有条目，更新索引并标记 dirty
    if (annotations.length > 0) {
      const key = FileEncoder.encodeFilePath(filePath);
      if (!this._indexData.entries[key]) {
        this._updateIndexEntry(filePath);
        this._indexDirty = true;
      }
    }
  }

  /**
   * 通过 UUID 查找标注时，确保标注所在文件已加载。
   * 如果标注不在内存中，尝试从 _indexData 中找到它可能所在的文件并加载。
   */
  async ensureFileLoadedForUuid(uuid: string): Promise<void> {
    // 如果已在内存中，无需加载
    if (this._byUuid.has(uuid)) return;

    // 遍历 _indexData 中所有未加载的文件，尝试加载
    for (const entry of Object.values(this._indexData.entries)) {
      if (!this._loadedFiles.has(entry.filePath)) {
        await this.ensureFileLoaded(entry.filePath);
        // 加载后再次检查
        if (this._byUuid.has(uuid)) return;
      }
    }
  }

  /**
   * 强制写回单个文件的脏数据。
   */
  async flushFile(filePath: string): Promise<void> {
    // 清除该文件的防抖计时器
    const timer = this._debounceTimers.get(filePath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._debounceTimers.delete(filePath);
    }

    if (this._dirtyFiles.has(filePath)) {
      await this._writeFileShard(filePath);
      this._dirtyFiles.delete(filePath);
    }

    // 如果索引也需要写回，一并处理
    if (this._indexDirty) {
      await this._writeIndexFile();
      this._indexDirty = false;
    }
  }

  /**
   * 写回所有脏数据。
   * 顺序：分片 → _index.json → _meta.json
   */
  async flushAll(): Promise<void> {
    // 清除所有防抖计时器
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    // 写回所有 dirty 分片
    for (const filePath of this._dirtyFiles) {
      await this._writeFileShard(filePath);
    }
    this._dirtyFiles.clear();

    // 更新 _meta 时间戳
    this._meta.lastSyncAt = Date.now();

    // 写回索引（无论是否 dirty，flushAll 都保证索引落盘）
    await this._writeIndexFile();
    this._indexDirty = false;
    await this._writeMetaFile();
  }

  /**
   * 重建索引：清空所有内存索引，重新扫描并加载所有分片。
   */
  async rebuildIndex(): Promise<void> {
    // 清空所有内存索引
    this._byUuid.clear();
    this._byFile.clear();
    this._byKind.clear();
    this._byType.clear();
    this._byColor.clear();
    this._byTag.clear();
    this._byField.clear();
    this._loadedFiles.clear();
    this._dirtyFiles.clear();

    // 清除所有防抖计时器
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    // 重置索引数据
    this._indexData = { version: 1, entries: {} };

    // 扫描 annotations/ 目录下所有 .json 文件
    const annotationsDir = `${this._baseDir}/annotations`;
    let files: string[] = [];
    try {
      const dirList = await this.adapter.list(annotationsDir);
      files = dirList.files || [];
    } catch {
      // 目录不存在，无数据可加载
      return;
    }

    // 过滤 .json 文件
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      // 从文件名反推 filePath
      const encoded = fileName.replace(/\.json$/, '');
      let filePath: string;
      try {
        filePath = FileEncoder.decodeFilePath(encoded);
      } catch {
        // 无法解码的文件名，跳过
        continue;
      }

      // 加载分片
      await this.ensureFileLoaded(filePath);

      // 更新索引条目
      this._updateIndexEntry(filePath);
    }

    // 写回索引和元数据
    await this._writeIndexFile();
    await this._writeMetaFile();
  }

  /**
   * 删除指定文件的所有标注。
   */
  async deleteAnnotationsForFile(filePath: string): Promise<void> {
    this._assertInitialized();

    await this.ensureFileLoaded(filePath);

    const uuidSet = this._byFile.get(filePath);

    // 🔧 P1 修复：即使 uuidSet 不存在，也要尝试清理磁盘分片和索引条目
    if (!uuidSet || uuidSet.size === 0) {
      this._byFile.delete(filePath);
      this._loadedFiles.delete(filePath);
      this._dirtyFiles.delete(filePath);
      const timer = this._debounceTimers.get(filePath);
      if (timer !== undefined) {
        clearTimeout(timer);
        this._debounceTimers.delete(filePath);
      }
      const key = FileEncoder.encodeFilePath(filePath);
      if (this._indexData.entries[key]) {
        delete this._indexData.entries[key];
        const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);
        try {
          await this.adapter.remove(shardPath);
        } catch (err) {
          // 文件可能不存在，忽略；其他错误记录日志
          console.warn(`MarkVault: failed to remove shard ${shardPath}`, err);
        }
        await this._writeIndexFile();
      }
      return;
    }

    // 🔧 审计修复：先删除分片文件，再清理内存索引
    // 这样即使后续内存清理失败，重启后 ensureFileLoaded 读取失败时也能恢复
    const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);
    try {
      await this.adapter.remove(shardPath);
    } catch (err) {
      // 文件可能不存在，忽略；其他错误记录日志
      console.warn(`MarkVault: failed to remove shard ${shardPath}`, err);
    }

    // 逐个移除索引和标注
    for (const uuid of uuidSet) {
      this._removeFromIndex(uuid);
      this._byUuid.delete(uuid);
    }

    // 清理文件级别索引
    this._byFile.delete(filePath);
    this._loadedFiles.delete(filePath);

    // 从 dirty 集合中移除（文件已删除，无需写回）
    this._dirtyFiles.delete(filePath);

    // 清除防抖计时器
    const timer = this._debounceTimers.get(filePath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._debounceTimers.delete(filePath);
    }

    // 从 _indexData 中移除
    const key = FileEncoder.encodeFilePath(filePath);
    delete this._indexData.entries[key];

    // 🔧 P0 修复：立即写回 _index.json，防止重启后残留孤儿条目
    await this._writeIndexFile();
  }

  /**
   * 文件重命名时同步更新所有相关标注的 filePath。
   * 将旧分片 JSON 文件重命名为新路径 + 更新索引。
   *
   * 执行顺序（磁盘优先，避免崩溃丢数据）：
   * 1. 写入新分片 JSON → 2. 删除旧分片 → 3. 更新内存索引 → 4. 写回 _index.json
   */
  async renameAnnotationsForFile(oldPath: string, newPath: string): Promise<void> {
    this._assertInitialized();

    if (oldPath === newPath) return;

    // 1. 确保旧文件数据已加载
    await this.ensureFileLoaded(oldPath);

    const uuidSet = this._byFile.get(oldPath);
    if (!uuidSet || uuidSet.size === 0) {
      // 旧文件没有标注，也要清理残留的空索引条目
      this._byFile.delete(oldPath);
      this._loadedFiles.delete(oldPath);
      const oldKey = FileEncoder.encodeFilePath(oldPath);
      delete this._indexData.entries[oldKey];
      await this._writeIndexFile();
      return;
    }

    // 🔧 审计修复：先清理旧的防抖计时器，防止回调中的闭包引用 oldPath
    const oldTimer = this._debounceTimers.get(oldPath);
    if (oldTimer !== undefined) {
      clearTimeout(oldTimer);
      this._debounceTimers.delete(oldPath);
    }

    // 2. 收集并更新所有标注的 filePath（在内存中修改引用）
    const updatedAnnotations: Annotation[] = [];
    for (const uuid of uuidSet) {
      const ann = this._byUuid.get(uuid);
      if (ann) {
        ann.filePath = newPath;
        updatedAnnotations.push(ann);
      }
    }

    // 3. 写入新分片 JSON（磁盘优先，确保数据不丢）
    const newShardPath = FileEncoder.getShardPath(this._baseDir, newPath);
    await this.adapter.write(
      newShardPath,
      JSON.stringify({
        filePath: newPath,
        annotations: updatedAnnotations,
      }, null, 2),
    );

    // 4. 删除旧分片
    const oldShardPath = FileEncoder.getShardPath(this._baseDir, oldPath);
    try {
      await this.adapter.remove(oldShardPath);
    } catch {
      // 文件可能不存在，忽略
    }

    // 5. 更新 _byFile 映射
    this._byFile.set(newPath, uuidSet);
    this._byFile.delete(oldPath);

    // 6. 更新 _loadedFiles
    this._loadedFiles.delete(oldPath);
    this._loadedFiles.add(newPath);

    // 7. 更新 _indexData
    const oldKey = FileEncoder.encodeFilePath(oldPath);
    const newKey = FileEncoder.encodeFilePath(newPath);
    const entry = this._indexData.entries[oldKey];
    if (entry) {
      entry.filePath = newPath;
      this._indexData.entries[newKey] = entry;
      delete this._indexData.entries[oldKey];
    }

    // 8. 更新 dirty 集合（如果旧路径在 flush 队列中）
    if (this._dirtyFiles.has(oldPath)) {
      this._dirtyFiles.delete(oldPath);
      this._dirtyFiles.add(newPath);
    }

    // 9. 立即写回索引（确保后续 onFileOpen 能找到新路径）
    await this._writeIndexFile();

    console.log(`MarkVault: renamed annotations from "${oldPath}" → "${newPath}" (${uuidSet.size} annotations)`);
  }

  /**
   * 给标注添加标签。
   */
  async addTagToAnnotation(uuid: string, tag: string): Promise<void> {
    this._assertInitialized();

    const ann = this._byUuid.get(uuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    if (ann.tags.includes(tag)) return; // 已存在

    // 移除旧索引
    this._removeFromIndex(uuid);

    // 添加标签
    ann.tags.push(tag);

    // 重建索引
    this._addToIndex(ann);

    this._markDirty(ann.filePath);
  }

  /**
   * 从标注移除标签。
   */
  async removeTagFromAnnotation(uuid: string, tag: string): Promise<void> {
    this._assertInitialized();

    const ann = this._byUuid.get(uuid);
    if (!ann) {
      throw new Error(`Annotation not found: ${uuid}`);
    }

    const idx = ann.tags.indexOf(tag);
    if (idx === -1) return; // 不存在

    // 移除旧索引
    this._removeFromIndex(uuid);

    // 移除标签
    ann.tags.splice(idx, 1);

    // 重建索引
    this._addToIndex(ann);

    this._markDirty(ann.filePath);
  }

  /**
   * 获取所有已加载标注中出现过的字段键名列表
   * 遍历 _byField 索引的 key 集合
   * @returns 去重排序后的字段键名数组
   */
  getFieldKeys(): string[] {
    return Array.from(this._byField.keys()).sort();
  }

  /**
   * 获取指定字段键的所有已出现值列表
   * @param key 字段键名
   * @returns 去重排序后的字段值数组
   */
  getFieldValues(key: string): string[] {
    const fieldMap = this._byField.get(key);
    if (!fieldMap) return [];
    return Array.from(fieldMap.keys()).sort();
  }

  // ═══════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════

  /**
   * 将标注添加到所有倒排索引。
   */
  private _addToIndex(annotation: Annotation): void {
    const { uuid } = annotation;

    // _byFile
    let fileSet = this._byFile.get(annotation.filePath);
    if (!fileSet) {
      fileSet = new Set();
      this._byFile.set(annotation.filePath, fileSet);
    }
    fileSet.add(uuid);

    // _byKind（kind 可选，默认 inline）
    const kind = annotation.kind || 'inline';
    let kindSet = this._byKind.get(kind);
    if (!kindSet) {
      kindSet = new Set();
      this._byKind.set(kind, kindSet);
    }
    kindSet.add(uuid);

    // _byType（highlight/bold/underline）
    let typeSet = this._byType.get(annotation.type);
    if (!typeSet) {
      typeSet = new Set();
      this._byType.set(annotation.type, typeSet);
    }
    typeSet.add(uuid);

    // _byColor
    let colorSet = this._byColor.get(annotation.color);
    if (!colorSet) {
      colorSet = new Set();
      this._byColor.set(annotation.color, colorSet);
    }
    colorSet.add(uuid);

    // _byTag
    for (const tag of annotation.tags) {
      let tagSet = this._byTag.get(tag);
      if (!tagSet) {
        tagSet = new Set();
        this._byTag.set(tag, tagSet);
      }
      tagSet.add(uuid);
    }

    // _byField
    if (annotation.fields) {
      for (const [key, value] of Object.entries(annotation.fields)) {
        let fieldMap = this._byField.get(key);
        if (!fieldMap) {
          fieldMap = new Map();
          this._byField.set(key, fieldMap);
        }
        let valueSet = fieldMap.get(value);
        if (!valueSet) {
          valueSet = new Set();
          fieldMap.set(value, valueSet);
        }
        valueSet.add(uuid);
      }
    }
  }

  /**
   * 从所有倒排索引中移除标注。
   */
  private _removeFromIndex(uuid: string): void {
    const ann = this._byUuid.get(uuid);
    if (!ann) return;

    // _byFile
    const fileSet = this._byFile.get(ann.filePath);
    if (fileSet) {
      fileSet.delete(uuid);
      if (fileSet.size === 0) {
        this._byFile.delete(ann.filePath);
      }
    }

    // _byKind
    const kind = ann.kind || 'inline';
    const kindSet = this._byKind.get(kind);
    if (kindSet) {
      kindSet.delete(uuid);
      if (kindSet.size === 0) {
        this._byKind.delete(kind);
      }
    }

    // _byType
    const typeSet = this._byType.get(ann.type);
    if (typeSet) {
      typeSet.delete(uuid);
      if (typeSet.size === 0) {
        this._byType.delete(ann.type);
      }
    }

    // _byColor
    const colorSet = this._byColor.get(ann.color);
    if (colorSet) {
      colorSet.delete(uuid);
      if (colorSet.size === 0) {
        this._byColor.delete(ann.color);
      }
    }

    // _byTag
    for (const tag of ann.tags) {
      const tagSet = this._byTag.get(tag);
      if (tagSet) {
        tagSet.delete(uuid);
        if (tagSet.size === 0) {
          this._byTag.delete(tag);
        }
      }
    }

    // _byField
    if (ann.fields) {
      for (const [key, value] of Object.entries(ann.fields)) {
        const fieldMap = this._byField.get(key);
        if (fieldMap) {
          const valueSet = fieldMap.get(value);
          if (valueSet) {
            valueSet.delete(uuid);
            if (valueSet.size === 0) {
              fieldMap.delete(value);
            }
          }
          if (fieldMap.size === 0) {
            this._byField.delete(key);
          }
        }
      }
    }
  }

  /**
   * 便捷方法：先移除旧索引再添加新索引。
   */
  private _updateIndex(oldAnn: Annotation, newAnn: Annotation): void {
    this._removeFromIndex(oldAnn.uuid);
    this._addToIndex(newAnn);
  }

  /**
   * 标记文件为 dirty + scheduleFlush。
   * 同时标记索引需要写回（因为索引包含 count 信息）。
   */
  private _markDirty(filePath: string): void {
    this._dirtyFiles.add(filePath);
    this._indexDirty = true;
    this._scheduleFlush(filePath);
  }

  /**
   * 2s 防抖写回：避免短时间内多次修改导致频繁 I/O。
   */
  private _scheduleFlush(filePath: string): void {
    // 清除已有的计时器
    const existing = this._debounceTimers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    // 设置新计时器
    const timer = setTimeout(() => {
      this._debounceTimers.delete(filePath);
      this.flushFile(filePath);
    }, this._flushDebounceMs);

    this._debounceTimers.set(filePath, timer);
  }

  /**
   * 写入分片 JSON。
   *
   * 从 _byUuid 和 _byFile 收集该文件的所有标注，
   * 移除 `id` 字段（Dexie 遗留），格式化写入。
   */
  private async _writeFileShard(filePath: string): Promise<void> {
    const uuidSet = this._byFile.get(filePath);
    if (!uuidSet || uuidSet.size === 0) return;

    const annotations: Annotation[] = [];
    for (const uuid of uuidSet) {
      const ann = this._byUuid.get(uuid);
      if (ann) {
        // 深拷贝标注（id 字段已在 Phase 2 移除，无需额外清理）
        annotations.push({ ...ann });
      }
    }

    const data = {
      filePath,
      annotations,
    };

    const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);

    // 确保目录存在
    const dir = shardPath.substring(0, shardPath.lastIndexOf('/'));
    if (!(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir);
    }

    await this.adapter.write(shardPath, JSON.stringify(data, null, 2));
  }

  /**
   * 读取分片 JSON，返回标注数组。
   */
  private async _readFileShard(filePath: string): Promise<Annotation[]> {
    const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);

    if (!(await this.adapter.exists(shardPath))) {
      return [];
    }

    try {
      const content = await this.adapter.read(shardPath);
      const data = JSON.parse(content);
      // 兼容两种格式：{ filePath, annotations } 或直接数组
      if (Array.isArray(data)) {
        return data;
      }
      return data.annotations || [];
    } catch {
      return [];
    }
  }

  /**
   * 读取 _index.json。
   */
  private async _readIndexFile(): Promise<IndexData> {
    const indexPath = `${this._baseDir}/_index.json`;
    const content = await this.adapter.read(indexPath);
    return JSON.parse(content) as IndexData;
  }

  /**
   * 写入 _index.json。
   */
  private async _writeIndexFile(): Promise<void> {
    const indexPath = `${this._baseDir}/_index.json`;
    await this.adapter.write(indexPath, JSON.stringify(this._indexData, null, 2));
  }

  /**
   * 读取 _meta.json。
   */
  private async _readMetaFile(): Promise<StoreMeta> {
    const metaPath = `${this._baseDir}/_meta.json`;
    const content = await this.adapter.read(metaPath);
    return JSON.parse(content) as StoreMeta;
  }

  /**
   * 写入 _meta.json。
   */
  private async _writeMetaFile(): Promise<void> {
    const metaPath = `${this._baseDir}/_meta.json`;
    await this.adapter.write(metaPath, JSON.stringify(this._meta, null, 2));
  }

  /**
   * 更新 _indexData 中的单个条目。
   */
  private _updateIndexEntry(filePath: string): void {
    const key = FileEncoder.encodeFilePath(filePath);
    const uuidSet = this._byFile.get(filePath);
    const count = uuidSet ? uuidSet.size : 0;

    const existing = this._indexData.entries[key];
    const entry: IndexEntry = {
      filePath,
      count,
      lastModified: existing?.lastModified,
    };

    this._indexData.entries[key] = entry;
  }

  /**
   * 过滤非标准字段（以 _ 开头的临时标记如 _source、_needsUpgrade），
   * 防止解析器的临时标记被写入分片 JSON。
   */
  private static _stripExtraFields(annotation: Annotation): Annotation {
    const clean: Annotation = {
      uuid: annotation.uuid,
      filePath: annotation.filePath,
      type: annotation.type,
      color: annotation.color,
      text: annotation.text,
      note: annotation.note,
      tags: annotation.tags,
      startOffset: annotation.startOffset,
      endOffset: annotation.endOffset,
      startLine: annotation.startLine,
      contextBefore: annotation.contextBefore,
      contextAfter: annotation.contextAfter,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
    };
    // 可选字段
    if (annotation.kind !== undefined) clean.kind = annotation.kind;
    if (annotation.groupUuid !== undefined) clean.groupUuid = annotation.groupUuid;
    if (annotation.blockType !== undefined) clean.blockType = annotation.blockType;
    if (annotation.targetLine !== undefined) clean.targetLine = annotation.targetLine;
    if (annotation.anchorLine !== undefined) clean.anchorLine = annotation.anchorLine;
    if (annotation.spanRanges !== undefined) clean.spanRanges = annotation.spanRanges;
    if (annotation.fields !== undefined) {
      // 空对象 → 不持久化，与 undefined 语义一致
      if (Object.keys(annotation.fields).length > 0) {
        clean.fields = annotation.fields;
      }
    }
    return clean;
  }

  /**
   * 断言已初始化。
   */
  private _assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('AnnotationStore has not been initialized. Call initialize() first.');
    }
  }
}

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

/** 计算两个 Set 的交集 */
function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  // 遍历较小的集合以提高性能
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) {
      result.add(item);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════
// 单例导出
// ═══════════════════════════════════════════════════════

/** 全局 AnnotationStore 单例，在插件 onload 时通过 initAnnotationStore(vault) 初始化 */
export const annotationStore = new AnnotationStore();

/**
 * 初始化全局 AnnotationStore 单例。
 * 必须在插件 onload 时调用，且只调用一次。
 */
export function initAnnotationStore(vault: import('obsidian').Vault): AnnotationStore {
  annotationStore.init(vault);
  return annotationStore;
}
