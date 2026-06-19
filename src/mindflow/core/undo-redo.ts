/**
 * Undo/Redo Manager — 撤销/重做栈
 *
 * 参考 mind-elixir 的 undo/redo 设计，为 Free 节点操作维护可逆快照。
 *
 * 策略：操作前快照 → 执行 → 压栈。撤销时回滚到上一快照。
 * 只对 Free 节点操作（add/delete/move/edit）建立快照，
 * MD-Seed 变更来自文件编辑，不走撤销栈（由 Obsidian 自身撤销管理）。
 *
 * 快照内容：Free 节点的 frontmatter 记录列表（序列化后体积小）。
 */

import type { FreeNodeRecord, MindNode, MindmapMeta } from '../types/mind-node';
import { extractFreeNodes } from '../data/frontmatter-sync';

/** 快照：某一时刻的 Free 节点状态 */
interface Snapshot {
  /** 快照描述 */
  label: string;
  /** 序列化的 Free 节点记录 */
  freeRecords: FreeNodeRecord[];
  /** 导图元数据 */
  meta: MindmapMeta;
  /** P2-3: 全局 collapsed 状态（nodeId → collapsed） */
  collapsedStates: Record<string, boolean>;
}

/** 撤销/重做栈最大深度 */
const MAX_STACK = 50;

/**
 * 撤销/重做管理器
 *
 * 用法：
 *   const mgr = new UndoRedoManager();
 *   mgr.snapshot('add node', root, meta);  // 操作前
 *   // ... 执行操作 ...
 *   mgr.undo();  // 返回上一个快照
 *   mgr.redo();  // 重做
 */
export class UndoRedoManager {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  /**
   * 在操作前压入快照
   *
   * @param label 操作描述（如 "add child"）
   * @param root  当前导图根节点
   * @param meta  当前导图元数据
   */
  snapshot(label: string, root: MindNode, meta: MindmapMeta): void {
    const freeRecords = extractFreeNodes([root]);
    const snap: Snapshot = {
      label,
      freeRecords: JSON.parse(JSON.stringify(freeRecords)), // 深拷贝
      // R2-1: boundaries 数组需要深拷贝，否则 undo/redo 后引用共享导致状态错误
      meta: {
        ...meta,
        boundaries: meta.boundaries
          ? JSON.parse(JSON.stringify(meta.boundaries))
          : undefined,
      },
      collapsedStates: collectCollapsedStates(root), // P2-3
    };

    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_STACK) {
      this.undoStack.shift(); // 丢弃最旧的
    }
    // 新操作后清空 redo 栈
    this.redoStack = [];
  }

  /** 是否可撤销 */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 是否可重做 */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * 撤销：返回上一个快照（弹出当前态，压入 redo）
   *
   * @param currentState 当前状态（用于 redo 栈）
   * @returns 上一个快照，或 null 表示无法撤销
   */
  undo(currentState: { root: MindNode; meta: MindmapMeta }): Snapshot | null {
    if (this.undoStack.length === 0) return null;

    // 保存当前状态到 redo
    const currentSnap: Snapshot = {
      label: 'current',
      freeRecords: JSON.parse(JSON.stringify(extractFreeNodes([currentState.root]))),
      meta: { ...currentState.meta },
      collapsedStates: collectCollapsedStates(currentState.root), // P2-3
    };
    this.redoStack.push(currentSnap);

    return this.undoStack.pop()!;
  }

  /**
   * 重做：返回下一个快照（从 redo 弹出，压入 undo）
   *
   * @param currentState 当前状态
   * @returns 下一个快照，或 null 表示无法重做
   */
  redo(currentState: { root: MindNode; meta: MindmapMeta }): Snapshot | null {
    if (this.redoStack.length === 0) return null;

    // 保存当前状态到 undo
    const currentSnap: Snapshot = {
      label: 'current',
      freeRecords: JSON.parse(JSON.stringify(extractFreeNodes([currentState.root]))),
      meta: { ...currentState.meta },
      collapsedStates: collectCollapsedStates(currentState.root), // P2-3
    };
    this.undoStack.push(currentSnap);

    return this.redoStack.pop()!;
  }

  /** 清空所有栈 */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 获取撤销栈深度（调试用） */
  getDepth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}

/** P2-3: 收集树中所有节点的 collapsed 状态 */
export function collectCollapsedStates(root: MindNode): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  function walk(node: MindNode): void {
    if (node.collapsed) {
      states[node.id] = true;
    }
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(root);
  return states;
}

/** P2-3: 将 collapsed 状态应用到树 */
export function applyCollapsedStates(root: MindNode, states: Record<string, boolean>): void {
  function walk(node: MindNode): void {
    node.collapsed = !!states[node.id];
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(root);
}
