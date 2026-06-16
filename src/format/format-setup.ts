/**
 * Format setup — 注册所有格式到全局 FormatRegistry
 *
 * 在插件初始化时调用一次即可。
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

  formatRegistry.register(new MarkFormat());
  formatRegistry.register(new NativeFormat());
  formatRegistry.register(new BlockFormat());
  formatRegistry.register(new RegionFormat());
}
