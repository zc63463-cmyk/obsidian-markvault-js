/**
 * AnnotationRenderer — 渲染层抽象接口
 *
 * v6.0: 将标注渲染从 Markdown 编辑器解耦，支持多文档类型。
 *
 * 不同 DocType 需要不同的渲染策略：
 *   - markdown: CM6 ViewPlugin (编辑模式) + DOM 查询 (阅读模式)
 *   - pdf: PDF.js overlay canvas
 *   - mindmap: MindFlow DOM-Flow 节点高亮
 *
 * 认知层（tags/fields/relations/flags）完全复用，
 * 渲染层各自最优实现，通过 RendererRegistry 按 docType 路由。
 */

import type { Annotation, DocType } from '../types/annotation';

/**
 * 标注渲染器接口 — 每种文档类型实现此接口。
 *
 * 生命周期：
 *   1. mount(container, annotations) — 挂载到容器，渲染初始标注
 *   2. update(annotations) — 标注变更时增量更新
 *   3. unmount() — 卸载，清理 DOM 和事件监听
 */
export interface AnnotationRenderer {
  /** 渲染器对应的文档类型 */
  readonly docType: DocType;

  /** 挂载渲染器到容器元素 */
  mount(container: HTMLElement, annotations: Annotation[]): void;

  /** 标注数据变更时更新渲染 */
  update(annotations: Annotation[]): void;

  /** 卸载渲染器，清理资源 */
  unmount(): void;

  /** 跳转到指定标注（滚动到视图内 + 高亮闪烁） */
  scrollToAnnotation(uuid: string): void;

  /** 获取当前渲染的标注数量 */
  getRenderedCount(): number;
}

/**
 * 渲染器注册表 — 按 docType 路由到对应 Renderer。
 *
 * 使用方式：
 *   const registry = new RendererRegistry();
 *   registry.register(new MarkdownEditorRenderer());
 *   registry.register(new PDFRenderer());
 *   const renderer = registry.get('pdf');
 *   renderer.mount(container, annotations);
 */
export class RendererRegistry {
  private renderers: Map<DocType, AnnotationRenderer> = new Map();

  /** 注册渲染器 */
  register(renderer: AnnotationRenderer): void {
    this.renderers.set(renderer.docType, renderer);
  }

  /** 注销渲染器 */
  unregister(docType: DocType): void {
    const renderer = this.renderers.get(docType);
    if (renderer) {
      renderer.unmount();
      this.renderers.delete(docType);
    }
  }

  /** 获取指定文档类型的渲染器 */
  get(docType: DocType): AnnotationRenderer | undefined {
    return this.renderers.get(docType);
  }

  /** 检查是否已注册指定文档类型的渲染器 */
  has(docType: DocType): boolean {
    return this.renderers.has(docType);
  }

  /** 注销并卸载所有渲染器 */
  clear(): void {
    for (const renderer of this.renderers.values()) {
      renderer.unmount();
    }
    this.renderers.clear();
  }
}
