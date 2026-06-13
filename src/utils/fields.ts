import type { FieldTemplate } from '../types/annotation';

/**
 * 将 Record<string, string> 编码为 URL 查询字符串格式
 * 例: { category: "定义", importance: "高" } → "category=%E5%AE%9A%E4%B9%89&importance=%E9%AB%98"
 */
export function encodeFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([k]) => k.trim() !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * 将 URL 查询字符串格式解码为 Record<string, string>
 * 例: "category=定义&importance=高" → { category: "定义", importance: "高" }
 * 空字符串返回空对象
 */
export function decodeFields(raw: string): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.substring(0, eqIdx));
    const value = decodeURIComponent(pair.substring(eqIdx + 1));
    result[key] = value;
  }
  return result;
}

/**
 * 将模板应用到标注的 fields（合并策略：保留已有的同键值，填充模板中缺失的键）
 */
export function applyTemplate(
  template: FieldTemplate,
  existingFields?: Record<string, string>,
): Record<string, string> {
  const fields: Record<string, string> = { ...existingFields };
  for (const fieldDef of template.fields) {
    if (!(fieldDef.key in fields) && fieldDef.values.length > 0) {
      // 仅当该键不存在时，填入第一个预设值
      fields[fieldDef.key] = fieldDef.values[0];
    }
  }
  return fields;
}
