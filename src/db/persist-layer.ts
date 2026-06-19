import type { DataAdapter, Vault } from 'obsidian';
import { logger } from '../utils/logger';
import type {
  Annotation,
  IndexData,
  StoreMeta,
} from '../types/annotation';
import { FileEncoder } from './file-encoder';
import type { IndexLayer } from './index-layer';
import { stripExtraFields } from './strip-fields';

/**
 * PersistLayer — 持久化层
 *
 * 负责：
 * - init / shutdown / flush
 * - ensureFileLoaded / ensureFileLoadedForUuid
 * - 分片 JSON 读写（含完整性校验 + 自动恢复）
 * - _index.json / _meta.json 读写（含互斥锁）
 * - rebuildIndex / deleteAnnotationsForFile / renameAnnotationsForFile
 * - markDirty / scheduleFlush / debounce 管理
 */
export class PersistLayer {
  // ─── 依赖 ──────────────────────────────────────────────
  private _indexLayer: IndexLayer;

  // ─── 持久化状态 ────────────────────────────────────────
  /** Obsidian vault.adapter（用于文件读写），通过 init() 设置 */
  private _adapter: DataAdapter | null = null;

  /** 获取 adapter，未初始化时抛出错误 */
  get adapter(): DataAdapter {
    if (!this._adapter) {
      throw new Error('AnnotationStore: not initialized. Call init(vault) first.');
    }
    return this._adapter;
  }

  /** 插件目录路径 */
  private _baseDir: string = '';

  /** 防抖延迟（毫秒） */
  private _flushDebounceMs: number = 2000;

  /** 需要写回的文件集合 */
  private _dirtyFiles: Set<string> = new Set();

  /** 已加载的文件集合 */
  _loadedFiles: Set<string> = new Set();

  /** 每文件防抖计时器 */
  private _debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** 索引是否需要写回 */
  private _indexDirty: boolean = false;

  /** 索引写入互斥锁 */
  private _indexWriting: boolean = false;
  private _indexWaiters: Array<() => void> = [];
  /** meta 写入互斥锁 */
  private _metaWriting: boolean = false;
  private _metaWaiters: Array<() => void> = [];

  // ─── S2-2: 分片写入 per-file 锁 ─────────────────────────
  /** 每文件写入锁：防止 flushAll 与 flushFile 并发写同一分片 */
  private _shardWriteLocks: Map<string, Promise<void>> = new Map();

  /** 元数据 */
  private _meta: StoreMeta = {
    schemaVersion: 1,
    createdAt: 0,
    lastSyncAt: 0,
  };

  /** 索引数据 */
  private _indexData: IndexData = { version: 1, entries: {} };

  /** 是否已完成初始化 */
  private _initialized: boolean = false;

  /** flushFile 回调 — 由 AnnotationStore 注入，用于触发跨层写回 */
  private _flushFileCallback: ((filePath: string) => Promise<void>) | null = null;

  /** 级联删除回调 — 由 AnnotationStore 注入，用于 deleteAnnotationsForFile 中的关系级联清理 */
  private _cascadeDeleteCallback: ((ann: Annotation) => void) | null = null;

  constructor(indexLayer: IndexLayer) {
    this._indexLayer = indexLayer;
  }

  /** 注入 flushFile 回调（避免循环依赖） */
  setFlushFileCallback(cb: (filePath: string) => Promise<void>): void {
    this._flushFileCallback = cb;
  }

  /** 注入级联删除回调 */
  setCascadeDeleteCallback(cb: (ann: Annotation) => void): void {
    this._cascadeDeleteCallback = cb;
  }

  /** 设置已初始化标志 */
  setInitialized(value: boolean): void {
    this._initialized = value;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get dirtyFiles(): Set<string> {
    return this._dirtyFiles;
  }

  get indexDirty(): boolean {
    return this._indexDirty;
  }

  set indexDirty(value: boolean) {
    this._indexDirty = value;
  }

  get meta(): StoreMeta {
    return this._meta;
  }

  set meta(value: StoreMeta) {
    this._meta = value;
  }

  get indexData(): IndexData {
    return this._indexData;
  }

  set indexData(value: IndexData) {
    this._indexData = value;
  }

  get baseDir(): string {
    return this._baseDir;
  }

  get debounceTimers(): Map<string, ReturnType<typeof setTimeout>> {
    return this._debounceTimers;
  }

  // ─── 初始化 / 关闭 ─────────────────────────────────────

  /**
   * 设置 vault 引用。
   */
  init(vault: Vault): void {
    this._adapter = vault.adapter;
    this._baseDir = `${vault.configDir}/plugins/markvault-js`;
  }

  /**
   * 关闭存储（等同 flushAll）。
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
   * 启动初始化：读取元数据和索引文件，预加载所有分片。
   */
  async initialize(): Promise<void> {
    if (!this._adapter) {
      throw new Error('AnnotationStore: init(vault) must be called before initialize()');
    }

    // 清空所有内存状态
    this._indexLayer.clearAll();
    this._loadedFiles.clear();
    this._dirtyFiles.clear();
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    this._indexDirty = false;

    // 确保插件目录和 annotations 子目录存在
    const annotationsDir = `${this._baseDir}/annotations`;
    if (!(await this.adapter.exists(annotationsDir))) {
      await this.adapter.mkdir(annotationsDir);
    }

    // 读取或创建 _meta.json
    try {
      this._meta = await this._readMetaFile();
    } catch (err) {
      console.debug('MarkVault: _meta.json not found, creating default');
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
    } catch (err) {
      console.debug('MarkVault: _index.json not found, creating default');
      this._indexData = { version: 1, entries: {} };
      await this._writeIndexFile();
    }

    // 预加载所有标注数据到内存
    this._indexLayer.byFile.clear();
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
      logger.debug(`MarkVault: preloaded ${loadedCount} annotation files (${this._indexLayer.byUuid.size} total annotations)`);
    }

    // 数据完整性摘要
    const recoveredFromBak: string[] = [];
    const lostShards: string[] = [];
    for (const filePath of filePaths) {
      const uuidSet = this._indexLayer.byFile.get(filePath);
      if (!uuidSet || uuidSet.size === 0) {
        const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);
        if (await this.adapter.exists(shardPath + '.bak')) {
          recoveredFromBak.push(filePath);
        } else if (await this.adapter.exists(shardPath)) {
          lostShards.push(filePath);
        }
      }
    }
    if (recoveredFromBak.length > 0) {
      console.warn(
        `MarkVault: recovered ${recoveredFromBak.length} shard(s) from .bak backup. ` +
        `Affected files: ${recoveredFromBak.join(', ')}`
      );
    }
    if (lostShards.length > 0) {
      console.error(
        `MarkVault: ${lostShards.length} shard(s) are corrupted and could not be recovered. ` +
        `Annotations for these files will be restored from markdown on next sync. ` +
        `Affected files: ${lostShards.join(', ')}`
      );
    }

    // 清理 _indexData 中的孤儿条目
    let orphanCleaned = 0;
    for (const [filePath, uuidSet] of this._indexLayer.byFile) {
      if (uuidSet.size === 0) {
        this._indexLayer.byFile.delete(filePath);
        this._loadedFiles.delete(filePath);
        const key = FileEncoder.encodeFilePath(filePath);
        delete this._indexData.entries[key];
        orphanCleaned++;
      }
    }
    if (orphanCleaned > 0) {
      logger.debug(`MarkVault: cleaned ${orphanCleaned} orphan index entries`);
      await this._writeIndexFile();
    }

    // 清理已被污染的 note 字段
    const dirtyNotePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(highlight|bold|underline):(yellow|green|blue|pink|purple):?$/;
    let cleanedCount = 0;
    for (const [uuid, ann] of this._indexLayer.byUuid) {
      if (ann.note && dirtyNotePattern.test(ann.note.trim())) {
        console.warn(`MarkVault: cleaning corrupted note for annotation ${uuid}: "${ann.note}"`);
        ann.note = '';
        this._dirtyFiles.add(ann.filePath);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      logger.debug(`MarkVault: cleaned ${cleanedCount} corrupted note fields`);
      await this.flushAll();
    }

    this._initialized = true;
  }

  // ─── 公共 API ─────────────────────────────────────────

  /**
   * P4: 标记指定文件为 dirty。
   */
  markFileDirty(filePath: string): void {
    if (this._loadedFiles.has(filePath)) {
      this._markDirty(filePath);
    }
  }

  /**
   * 懒加载：确保指定文件的分片已加载到内存。
   */
  async ensureFileLoaded(filePath: string): Promise<void> {
    if (this._loadedFiles.has(filePath)) return;

    const annotations = await this._readFileShard(filePath);

    // 确保文件有对应的 Set
    if (!this._indexLayer.byFile.has(filePath)) {
      this._indexLayer.byFile.set(filePath, new Set());
    }

    // 逐个添加到内存索引（清理可能残留的非标准字段）
    for (const ann of annotations) {
      const clean = stripExtraFields(ann);
      this._indexLayer.byUuid.set(clean.uuid, clean);
      this._indexLayer.byFile.get(filePath)!.add(clean.uuid);
      this._indexLayer.addToIndex(clean);
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
   */
  async ensureFileLoadedForUuid(uuid: string): Promise<void> {
    if (this._indexLayer.byUuid.has(uuid)) return;

    for (const entry of Object.values(this._indexData.entries)) {
      if (!this._loadedFiles.has(entry.filePath)) {
        await this.ensureFileLoaded(entry.filePath);
        if (this._indexLayer.byUuid.has(uuid)) return;
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
      this._indexDirty = false;
      await this._writeIndexFile();
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

    // S2 审查修复: 快照 dirty 文件列表后立即清空 Set
    // 这样 flush 期间新增的 markDirty 不会被 clear() 吞掉
    const dirtySnapshot = Array.from(this._dirtyFiles);
    this._dirtyFiles.clear();

    // 写回所有 dirty 分片
    for (const filePath of dirtySnapshot) {
      await this._writeFileShard(filePath);
    }

    // 更新 _meta 时间戳
    this._meta.lastSyncAt = Date.now();

    // 写回索引和元数据
    this._indexDirty = false;
    await this._writeIndexFile();
    await this._writeMetaFile();
  }

  /**
   * 重建索引：清空所有内存索引，重新扫描并加载所有分片。
   */
  async rebuildIndex(): Promise<void> {
    this._indexLayer.clearAll();
    this._loadedFiles.clear();
    this._dirtyFiles.clear();

    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    this._indexData = { version: 1, entries: {} };

    const annotationsDir = `${this._baseDir}/annotations`;
    let files: string[] = [];
    try {
      const dirList = await this.adapter.list(annotationsDir);
      files = dirList.files || [];
    } catch (err) {
      console.warn('MarkVault: rebuildIndex failed to list annotations dir', err);
      return;
    }

    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const encoded = fileName.replace(/\.json$/, '');
      let filePath: string;
      try {
        filePath = FileEncoder.decodeFilePath(encoded);
      } catch (err) {
        console.warn('MarkVault: rebuildIndex failed to decode file path', encoded, err);
        continue;
      }

      await this.ensureFileLoaded(filePath);
      this._updateIndexEntry(filePath);
    }

    await this._writeIndexFile();
    await this._writeMetaFile();
  }

  /**
   * 删除指定文件的所有标注。
   * @returns 删除的标注数量
   */
  async deleteAnnotationsForFile(filePath: string): Promise<number> {
    await this.ensureFileLoaded(filePath);

    const uuidSet = this._indexLayer.byFile.get(filePath);

    // 即使 uuidSet 不存在，也要尝试清理磁盘分片和索引条目
    if (!uuidSet || uuidSet.size === 0) {
      this._indexLayer.byFile.delete(filePath);
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
          console.warn(`MarkVault: failed to remove shard ${shardPath}`, err);
        }
        await this._writeIndexFile();
      }
      return 0;
    }

    const deletedCount = uuidSet.size;

    // 先删除分片文件，再清理内存索引
    const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);
    try {
      await this.adapter.remove(shardPath);
    } catch (err) {
      console.warn(`MarkVault: failed to remove shard ${shardPath}`, err);
    }

    // 🔧 Round 6 P1: 级联清理伙伴标注上的反向关系数据
    // 必须在 removeFromIndex 之前执行，因为 removeFromIndex 会清理索引
    // 而级联清理需要通过索引查找伙伴标注
    if (this._cascadeDeleteCallback) {
      for (const uuid of uuidSet) {
        const ann = this._indexLayer.byUuid.get(uuid);
        if (ann) {
          this._cascadeDeleteCallback(ann);
        }
      }
    }

    // 逐个移除索引和标注
    for (const uuid of uuidSet) {
      this._indexLayer.removeFromIndex(uuid);
      this._indexLayer.byUuid.delete(uuid);
    }

    // 清理文件级别索引
    this._indexLayer.byFile.delete(filePath);
    this._loadedFiles.delete(filePath);
    this._dirtyFiles.delete(filePath);

    const timer = this._debounceTimers.get(filePath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._debounceTimers.delete(filePath);
    }

    const key = FileEncoder.encodeFilePath(filePath);
    delete this._indexData.entries[key];

    await this._writeIndexFile();

    return deletedCount;
  }

  /**
   * 文件重命名时同步更新所有相关标注的 filePath。
   */
  async renameAnnotationsForFile(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;

    await this.ensureFileLoaded(oldPath);

    const uuidSet = this._indexLayer.byFile.get(oldPath);
    if (!uuidSet || uuidSet.size === 0) {
      this._indexLayer.byFile.delete(oldPath);
      this._loadedFiles.delete(oldPath);
      const oldKey = FileEncoder.encodeFilePath(oldPath);
      delete this._indexData.entries[oldKey];
      await this._writeIndexFile();
      return;
    }

    // 清理旧的防抖计时器
    const oldTimer = this._debounceTimers.get(oldPath);
    if (oldTimer !== undefined) {
      clearTimeout(oldTimer);
      this._debounceTimers.delete(oldPath);
    }

    // 更新所有标注的 filePath
    const updatedAnnotations: Annotation[] = [];
    for (const uuid of uuidSet) {
      const ann = this._indexLayer.byUuid.get(uuid);
      if (ann) {
        ann.filePath = newPath;
        updatedAnnotations.push(ann);
      }
    }

    // 写入新分片 JSON
    const newShardPath = FileEncoder.getShardPath(this._baseDir, newPath);
    await this.adapter.write(
      newShardPath,
      JSON.stringify({
        filePath: newPath,
        annotations: updatedAnnotations,
      }, null, 2),
    );

    // 删除旧分片
    const oldShardPath = FileEncoder.getShardPath(this._baseDir, oldPath);
    try {
      await this.adapter.remove(oldShardPath);
    } catch (err) {
      // 文件可能不存在，忽略
      console.debug('MarkVault: renameAnnotations old shard remove skipped', oldShardPath, err);
    }

    // 更新 _byFile 映射
    this._indexLayer.byFile.set(newPath, uuidSet);
    this._indexLayer.byFile.delete(oldPath);

    // 更新 _loadedFiles
    this._loadedFiles.delete(oldPath);
    this._loadedFiles.add(newPath);

    // 更新 _indexData
    const oldKey = FileEncoder.encodeFilePath(oldPath);
    const newKey = FileEncoder.encodeFilePath(newPath);
    const entry = this._indexData.entries[oldKey];
    if (entry) {
      entry.filePath = newPath;
      this._indexData.entries[newKey] = entry;
      delete this._indexData.entries[oldKey];
    }

    // 更新 dirty 集合
    if (this._dirtyFiles.has(oldPath)) {
      this._dirtyFiles.delete(oldPath);
      this._dirtyFiles.add(newPath);
    }

    // 立即写回索引
    await this._writeIndexFile();

    logger.debug(`MarkVault: renamed annotations from "${oldPath}" → "${newPath}" (${uuidSet.size} annotations)`);
  }

  // ─── Dirty / Flush 管理 ────────────────────────────────

  /**
   * 标记文件为 dirty + scheduleFlush。
   */
  _markDirty(filePath: string): void {
    this._dirtyFiles.add(filePath);
    this._indexDirty = true;
    this._scheduleFlush(filePath);
  }

  /**
   * 2s 防抖写回。
   */
  private _scheduleFlush(filePath: string): void {
    const existing = this._debounceTimers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this._debounceTimers.delete(filePath);
      if (this._flushFileCallback) {
        this._flushFileCallback(filePath);
      }
    }, this._flushDebounceMs);

    this._debounceTimers.set(filePath, timer);
  }

  // ─── 分片 JSON 读写 ───────────────────────────────────

  /**
   * 写入分片 JSON（原子写入 + 备份 + 完整性校验 + per-file 锁）。
   *
   * S2-2: 加 per-file 写锁，防止 flushAll 与 flushFile 并发写同一分片竞态。
   * 锁机制：每个 filePath 一个 Promise 链，后续调用 await 前一个完成。
   */
  private async _writeFileShard(filePath: string): Promise<void> {
    // 获取 per-file 锁：等待前一个写入完成后再执行
    const prevLock = this._shardWriteLocks.get(filePath) ?? Promise.resolve();
    let resolveLock!: () => void;
    const currentLock = new Promise<void>(resolve => { resolveLock = resolve; });
    // S2 审查修复: 保存 lockPromise 引用用于后续比较清理
    const lockPromise = prevLock.then(() => currentLock);
    this._shardWriteLocks.set(filePath, lockPromise);

    try {
      await prevLock;
      await this._writeFileShardInner(filePath);
    } finally {
      resolveLock();
      // 清理已完成的锁：只有当前锁仍是 Map 中的值时才删除
      // （如果期间有新调用覆盖了 Map，说明有新的写入在排队，不能删）
      if (this._shardWriteLocks.get(filePath) === lockPromise) {
        this._shardWriteLocks.delete(filePath);
      }
    }
  }

  /** 分片写入的实际逻辑（无锁，由 _writeFileShard 保证串行） */
  private async _writeFileShardInner(filePath: string): Promise<void> {
    const uuidSet = this._indexLayer.byFile.get(filePath);
    if (!uuidSet || uuidSet.size === 0) return;

    const annotations: Annotation[] = [];
    for (const uuid of uuidSet) {
      const ann = this._indexLayer.byUuid.get(uuid);
      if (ann) {
        annotations.push({ ...ann });
      }
    }

    const payload = { filePath, annotations };
    const jsonStr = JSON.stringify(payload);
    const checksum = this._computeChecksum(jsonStr);

    const data = {
      filePath,
      annotations,
      _checksum: checksum,
    };

    const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);

    // 确保目录存在
    const dir = shardPath.substring(0, shardPath.lastIndexOf('/'));
    if (!(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir);
    }

    const content = JSON.stringify(data);
    const tmpPath = shardPath + '.tmp';

    try {
      if (await this.adapter.exists(shardPath)) {
        const oldContent = await this.adapter.read(shardPath);
        await this.adapter.write(shardPath + '.bak', oldContent);
      }

      await this.adapter.write(tmpPath, content);
      await this.adapter.write(shardPath, content);

      try {
        await this.adapter.remove(tmpPath);
      } catch (err) {
        // ENOENT: tmp file already cleaned up, safe to ignore
        logger.debug('tmp file cleanup (shard write)', err);
      }
    } catch (err) {
      try { await this.adapter.remove(tmpPath); } catch { /* cleanup best-effort on error path */ }
      throw err;
    }
  }

  /**
   * 读取分片 JSON，返回标注数组（含完整性校验 + 多级自动恢复）。
   */
  private async _readFileShard(filePath: string): Promise<Annotation[]> {
    const shardPath = FileEncoder.getShardPath(this._baseDir, filePath);

    if (!(await this.adapter.exists(shardPath))) {
      return [];
    }

    try {
      const content = await this.adapter.read(shardPath);
      const data = JSON.parse(content);

      if (data._checksum && data.annotations) {
        const payload = { filePath: data.filePath, annotations: data.annotations };
        const expected = this._computeChecksum(JSON.stringify(payload));
        if (data._checksum !== expected) {
          console.warn(
            `MarkVault: checksum mismatch for "${filePath}" — attempting .bak recovery`
          );
          const recovered = await this._recoverFromBak(shardPath);
          if (recovered !== null) {
            const recoveredPayload = { filePath, annotations: recovered };
            const recoveredChecksum = this._computeChecksum(JSON.stringify(recoveredPayload));
            const recoveredShard = { ...recoveredPayload, _checksum: recoveredChecksum };
            await this._atomicWrite(shardPath, JSON.stringify(recoveredShard));
            return recovered;
          }
          console.error(
            `MarkVault: both shard and .bak corrupted for "${filePath}" — ` +
            `annotations will be recovered from markdown on next sync`
          );
          return [];
        }
      }

      if (Array.isArray(data)) {
        return data;
      }
      return data.annotations || [];
    } catch (err) {
      console.warn('MarkVault: _readFileShard failed, attempting .bak recovery', shardPath, err);
      const recovered = await this._recoverFromBak(shardPath);
      if (recovered !== null) return recovered;
      return [];
    }
  }

  /** 从 .bak 文件恢复标注数据，失败返回 null */
  private async _recoverFromBak(shardPath: string): Promise<Annotation[] | null> {
    const bakPath = shardPath + '.bak';
    if (!(await this.adapter.exists(bakPath))) return null;
    try {
      const bakContent = await this.adapter.read(bakPath);
      const bakData = JSON.parse(bakContent);
      if (Array.isArray(bakData)) return bakData;
      return bakData.annotations || null;
    } catch (err) {
      console.warn('MarkVault: _recoverFromBak failed, both shard and backup are corrupt', shardPath, err);
      return null;
    }
  }

  /**
   * 通用原子写入。
   */
  private async _atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + '.tmp';
    try {
      if (await this.adapter.exists(filePath)) {
        const oldContent = await this.adapter.read(filePath);
        await this.adapter.write(filePath + '.bak', oldContent);
      }
      await this.adapter.write(tmpPath, content);
      await this.adapter.write(filePath, content);
      try {
        await this.adapter.remove(tmpPath);
      } catch (err) {
        // ENOENT: tmp file already removed, safe to ignore
        logger.debug('tmp file cleanup (index write)', err);
      }
    } catch (err) {
      try { await this.adapter.remove(tmpPath); } catch { /* cleanup best-effort on error path */ }
      throw err;
    }
  }

  // ─── _index.json / _meta.json 读写 ────────────────────

  /** 读取 _index.json */
  private async _readIndexFile(): Promise<IndexData> {
    const indexPath = `${this._baseDir}/_index.json`;
    const content = await this.adapter.read(indexPath);
    return JSON.parse(content) as IndexData;
  }

  /** 写入 _index.json（原子写入 + 互斥锁） */
  async _writeIndexFile(): Promise<void> {
    if (this._indexWriting) {
      // 🔧 P2-E 修复: 用 Promise 回调替代 setTimeout 轮询
      await new Promise<void>(resolve => this._indexWaiters.push(resolve));
      if (!this._indexDirty) return;
    }

    this._indexWriting = true;
    try {
      const indexPath = `${this._baseDir}/_index.json`;
      const content = JSON.stringify(this._indexData);
      const tmpPath = indexPath + '.tmp';
      try {
        await this.adapter.write(tmpPath, content);
        await this.adapter.write(indexPath, content);
        try {
          await this.adapter.remove(tmpPath);
        } catch (err) {
          // ENOENT: tmp file already removed
          logger.debug('tmp file cleanup (index write inner)', err);
        }
      } catch (err) {
        try {
          await this.adapter.remove(tmpPath);
        } catch {
          /* cleanup best-effort on error path */
        }
        throw err;
      }
    } finally {
      this._indexWriting = false;
      // 唤醒所有等待者
      const waiters = this._indexWaiters.splice(0);
      waiters.forEach(fn => fn());
    }
  }

  /** 读取 _meta.json */
  private async _readMetaFile(): Promise<StoreMeta> {
    const metaPath = `${this._baseDir}/_meta.json`;
    const content = await this.adapter.read(metaPath);
    return JSON.parse(content) as StoreMeta;
  }

  /** 写入 _meta.json（原子写入 + 互斥锁） */
  private async _writeMetaFile(): Promise<void> {
    if (this._metaWriting) {
      // 🔧 P2-E 修复: 用 Promise 回调替代 setTimeout 轮询
      await new Promise<void>(resolve => this._metaWaiters.push(resolve));
    }

    this._metaWriting = true;
    try {
      const metaPath = `${this._baseDir}/_meta.json`;
      const content = JSON.stringify(this._meta);
      const tmpPath = metaPath + '.tmp';
      try {
        await this.adapter.write(tmpPath, content);
        await this.adapter.write(metaPath, content);
        try {
          await this.adapter.remove(tmpPath);
        } catch (err) {
          // ENOENT: tmp file already removed
          logger.debug('tmp file cleanup (meta write inner)', err);
        }
      } catch (err) {
        try {
          await this.adapter.remove(tmpPath);
        } catch {
          /* cleanup best-effort on error path */
        }
        throw err;
      }
    } finally {
      this._metaWriting = false;
      // 唤醒所有等待者
      const waiters = this._metaWaiters.splice(0);
      waiters.forEach(fn => fn());
    }
  }

  // ─── 索引条目更新 ─────────────────────────────────────

  /** 更新 _indexData 中的单个条目 */
  _updateIndexEntry(filePath: string): void {
    const key = FileEncoder.encodeFilePath(filePath);
    const uuidSet = this._indexLayer.byFile.get(filePath);
    const count = uuidSet ? uuidSet.size : 0;

    const existing = this._indexData.entries[key];
    const entry: import('../types/annotation').IndexEntry = {
      filePath,
      count,
      lastModified: existing?.lastModified,
    };

    this._indexData.entries[key] = entry;
  }

  // ─── 工具方法 ─────────────────────────────────────────

  /** 计算简单完整性校验码 */
  private _computeChecksum(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /** 断言已初始化 */
  assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('AnnotationStore has not been initialized. Call initialize() first.');
    }
  }
}
