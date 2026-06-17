/**
 * Format setup — 注册所有格式到全局 FormatRegistry
 *
 * 在插件初始化时调用一次即可。
 * 🔧 Phase H 修复：幂等设计，热重载时先清空再注册，避免重复注册异常。
 */

import { formatRegistry } from './format-registry';
import { MarkFormat } from './mark-format';
import { NativeFormat } from './native-format';
import { BlockFormat } from './block-format';
import { RegionFormat } from './region-format';

let _initialized = false;

export function initFormatRegistry(): void {
  if (_initialized) return;
  _initialized = true;

  // 幂等：热重载场景下先清空旧注册
  formatRegistry.clear();
  formatRegistry.register(new MarkFormat());
  formatRegistry.register(new NativeFormat());
  formatRegistry.register(new BlockFormat());
  formatRegistry.register(new RegionFormat());
}

/** 重置初始化状态，供 onunload 调用 */
export function resetFormatSetup(): void {
  _initialized = false;
  formatRegistry.clear();
}
