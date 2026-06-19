/**
 * MindFlow 全局类型声明
 *
 * 扩展 Window 接口以支持 Obsidian 懒加载的 MathJax 全局变量。
 */

declare global {
  interface Window {
    /** Obsidian 懒加载的 MathJax 全局对象 */
    MathJax?: {
      typeset?: (elements: Element | Element[]) => void;
      typesetPromise?: (elements?: Element | Element[]) => Promise<void>;
      startup?: {
        promise?: Promise<void>;
        ready?: Promise<void>;
      };
      [key: string]: unknown;
    };
  }
}

export {};
