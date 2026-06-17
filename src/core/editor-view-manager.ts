/**
 * CM6 EditorView 全局状态管理器
 * 
 * 管理多个活跃 EditorView 的追踪、文件路径解析、点击回调注入。
 * 这些原本是 highlight-applier.ts 中的模块级闭包，现集中管理以解耦。
 * 
 * @module editor-view-manager
 */

import { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

// ─── Region Layer 重绘触发器 ──────────────────────────────

/**
 * 自定义 StateEffect：用于在 region 缓存更新后强制 CM6 layer 重绘。
 *
 * 问题：regionLayerExtension 的 update() 只在 docChanged || viewportChanged 时返回 true。
 * 当 updateRegionCache() 异步填充缓存后，没有任何事件通知 CM6 layer 重新渲染。
 * 发送此 effect 后，layer 的 update() 会返回 true，触发 markers() 重新计算。
 */
export const regionCacheUpdatedEffect = StateEffect.define<void>();

// ─── EditorView 追踪 ──────────────────────────────────────

/** 🔧 P1-22 修复：追踪所有活跃的 EditorView，而非仅一个 */
const activeEditorViews = new Set<EditorView>();

/**
 * 注入当前活跃的 EditorView（在 main.ts 的 active-leaf-change / sync-engine 中调用）
 * 🔧 P0-1 修复：view=null 时清理已销毁的 view，而非静默忽略
 */
export function setActiveEditorView(view: EditorView | null): void {
  if (view) {
    activeEditorViews.add(view);
  } else {
    // 🔧 P0-1：null 表示当前无活跃编辑器，清理所有已销毁的 view
    for (const v of activeEditorViews) {
      try {
        if ((v as any).destroyed || !v.state?.field) {
          activeEditorViews.delete(v);
        }
      } catch {
        activeEditorViews.delete(v);
      }
    }
  }
}

/** 🔧 P1-22 修复：移除已销毁的 EditorView（在 onunload 中调用） */
export function removeEditorView(view: EditorView): void {
  activeEditorViews.delete(view);
}

/** 🔧 P0-1 修复：清除所有活跃的 EditorView（在 plugin onunload 中调用） */
export function clearActiveEditorViews(): void {
  activeEditorViews.clear();
}

/**
 * 在 region 缓存更新后强制 CM6 layer 重绘。
 * 🔧 P1-22 修复：向所有活跃的 EditorView 发送 effect，确保多 leaf 场景下都能重绘。
 * 必须在 updateRegionCache() 完成后调用。
 */
export function requestRegionLayerRedraw(): void {
  for (const view of activeEditorViews) {
    try {
      const v = view as any;
      if (v.destroyed) { activeEditorViews.delete(view); continue; }
      if (!view.state?.field) { activeEditorViews.delete(view); continue; }
      view.dispatch({
        effects: [regionCacheUpdatedEffect.of(undefined)],
      });
    } catch (err) {
      console.debug('MarkVault: regionLayer redraw dispatch failed, view likely destroyed', err);
      activeEditorViews.delete(view);
    }
  }
}

// ─── 外部注入 ──────────────────────────────────────────────

/**
 * 由 main.ts 注入的文件路径解析函数
 * 优先使用 Obsidian API（app.workspace.getActiveFile），
 * DOM 属性作为备用方案
 */
let filePathResolver: (() => string | null) | null = null;

/** 注入文件路径解析器（在 main.ts onload 中调用） */
export function setFilePathResolver(resolver: (() => string | null) | null): void {
  filePathResolver = resolver;
}

/** 获取当前活跃文件路径 */
export function resolveFilePath(): string | null {
  if (filePathResolver) {
    try {
      return filePathResolver();
    } catch (err) {
      console.debug('MarkVault: filePathResolver failed, falling back to DOM', err);
    }
  }
  return null;
}

/**
 * 🔧 P1-17 修复：编辑模式点击标注回调
 * 由 main.ts 注入，当用户在编辑模式下点击 data-uuid 元素时调用。
 */
let annotationClickHandler: ((uuid: string) => void) | null = null;

/** 注入编辑模式点击回调（在 main.ts onload 中调用） */
export function setAnnotationClickHandler(handler: ((uuid: string) => void) | null): void {
  annotationClickHandler = handler;
}

/** 🔧 Phase 5B: 获取当前点击回调（供 Widget 类使用） */
export function getAnnotationClickHandler(): ((uuid: string) => void) | null {
  return annotationClickHandler;
}

// ─── 文件路径推断 ─────────────────────────────────────────

/**
 * 从 CM6 view 推断当前文件路径
 * 通过 Obsidian 的 DOM 结构查找 .workspace-leaf 的 data-path 属性
 */
export function getFilePathFromView(view: EditorView): string | null {
  try {
    const dom = view.dom;
    const leafEl = dom.closest('.workspace-leaf');
    if (leafEl) {
      const contentEl = leafEl.querySelector('.workspace-leaf-content[data-path]');
      if (contentEl) {
        return contentEl.getAttribute('data-path');
      }
      const pathAttr = (leafEl as HTMLElement).getAttribute('data-path');
      if (pathAttr) return pathAttr;
    }
  } catch (err) {
    console.debug('MarkVault: DOM path extraction failed', err);
  }
  return null;
}
