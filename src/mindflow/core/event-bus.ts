/**
 * Event Bus — 导图操作事件总线
 *
 * 参考 mind-elixir 的 bus.addListener 模式，将操作与视图解耦。
 * 所有节点操作（增/删/移/编/折/选）通过事件广播，
 * 外部监听器（如 undo 栈、持久化层）可订阅而不侵入视图代码。
 *
 * 事件类型：
 *   - operation:  节点结构变更（insertChild/insertSibling/removeNode/moveNode）
 *   - edit:       编辑态变更（beginEdit/finishEdit）
 *   - collapse:   折叠/展开
 *   - select:     节点选中
 *   - view:       视图变更（fit/zoom/pan）
 */

import { logger } from '../../utils/logger';

/** 操作事件名称 */
export type OperationName =
  | 'insertChild'
  | 'insertSibling'
  | 'removeNode'
  | 'moveNode'
  | 'beginEdit'
  | 'finishEdit'
  | 'insertAnnotation';  // Phase 3: 创建标注节点时 emit

/** 操作事件载荷 */
export interface OperationEvent {
  name: OperationName;
  /** 目标节点 ID */
  nodeId: string;
  /** 附加数据（如 moveNode 的目标父节点 ID） */
  data?: Record<string, unknown>;
}

/** 折叠事件 */
export interface CollapseEvent {
  nodeId: string;
  collapsed: boolean;
}

/** 选择事件 */
export interface SelectEvent {
  nodeId: string | null;
}

/** 视图事件 */
export type ViewEvent =
  | { type: 'fit' }
  | { type: 'zoom'; scale: number }
  | { type: 'pan'; x: number; y: number }
  | { type: 'reset' };

/** 所有事件类型联合 */
export type MindflowEvent =
  | { channel: 'operation'; payload: OperationEvent }
  | { channel: 'collapse'; payload: CollapseEvent }
  | { channel: 'select'; payload: SelectEvent }
  | { channel: 'view'; payload: ViewEvent };

/** 事件监听器 */
type Listener<T> = (payload: T) => void;

/**
 * 事件总线
 *
 * 用法：
 *   const bus = new MindflowEventBus();
 *   bus.on('operation', (e) => undoStack.push(e));
 *   bus.emit('operation', { name: 'insertChild', nodeId: 'x' });
 */
export class MindflowEventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  /** 订阅事件 */
  on<T extends MindflowEvent['channel']>(
    channel: T,
    listener: Listener<Extract<MindflowEvent, { channel: T }>['payload']>,
  ): () => void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    const set = this.listeners.get(channel)!;
    set.add(listener as Listener<unknown>);

    // 返回取消订阅函数
    return () => {
      set.delete(listener as Listener<unknown>);
    };
  }

  /** 广播事件 */
  emit<T extends MindflowEvent['channel']>(
    channel: T,
    payload: Extract<MindflowEvent, { channel: T }>['payload'],
  ): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<unknown>)(payload);
      } catch (err) {
        logger.error('[MindFlow EventBus] listener error:', err);
      }
    }
  }

  /** 清除所有监听器 */
  clear(): void {
    this.listeners.clear();
  }
}
