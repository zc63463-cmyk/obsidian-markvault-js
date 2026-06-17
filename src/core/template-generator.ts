/**
 * template-generator.ts — 动态模板生成器
 *
 * Phase C-4.1: 将 FieldTemplate × AnnotationMotivation 组合自动生成 AnnotationTemplate。
 * 合并三层模板：base (5个预设) + dynamic (fieldTemplate×motivation) + custom (用户自定义)
 */

import type {
  AnnotationTemplate,
  FieldTemplate,
  AnnotationMotivation,
  AnnotationFlag,
} from '../types/annotation';
import { DEFAULT_ANNOTATION_TEMPLATES } from '../types/annotation';

/** 动态模板配色方案 — 每种 motivation 对应默认颜色 */
const MOTIVATION_COLORS: Record<AnnotationMotivation, { type: string; color: string }> = {
  highlighting: { type: 'highlight', color: 'yellow' },
  commenting:   { type: 'highlight', color: 'green' },
  questioning:  { type: 'highlight', color: 'pink' },
  editing:      { type: 'highlight', color: 'red' },
  bookmarking:  { type: 'underline', color: 'blue' },
  replying:     { type: 'highlight', color: 'orange' },
  classifying:  { type: 'highlight', color: 'purple' },
};

/** 动态模板图标 */
const MOTIVATION_ICONS: Record<AnnotationMotivation, string> = {
  highlighting: '🖍️',
  commenting:   '💬',
  questioning:  '❓',
  editing:      '✏️',
  bookmarking:  '🔖',
  replying:     '↩️',
  classifying:  '🏷️',
};

/**
 * 从 FieldTemplate × AnnotationMotivation 生成动态模板
 *
 * 为每个 fieldTemplate 生成 2~3 个常用 motivation 组合，
 * 每个组合自动填充 fields 预设值。
 */
export function generateTemplatesFromFieldTemplates(
  fieldTemplates: FieldTemplate[],
  motivations: AnnotationMotivation[],
): AnnotationTemplate[] {
  const templates: AnnotationTemplate[] = [];

  for (const ft of fieldTemplates) {
    for (const motivation of motivations) {
      const colorScheme = MOTIVATION_COLORS[motivation];
      const icon = MOTIVATION_ICONS[motivation];

      // 生成 fields：取每个 FieldDef 的第一个预设值
      const fields: Record<string, string> = {};
      for (const fd of ft.fields) {
        if (fd.values.length > 0) {
          fields[fd.key] = fd.values[0];
        }
      }

      templates.push({
        id: `${ft.id}-${motivation}`,
        name: `${ft.name}${motivationLabel(motivation)}`,
        type: colorScheme.type as any,
        color: colorScheme.color,
        motivation,
        fields: Object.keys(fields).length > 0 ? fields : undefined,
        icon,
      });
    }
  }

  return templates;
}

/** motivation 的中文短标签 */
function motivationLabel(m: AnnotationMotivation): string {
  const labels: Record<AnnotationMotivation, string> = {
    highlighting: '高亮',
    commenting:   '评论',
    questioning:  '提问',
    editing:      '修正',
    bookmarking:  '收藏',
    replying:     '回复',
    classifying:  '分类',
  };
  return labels[m] || m;
}

/**
 * 合并三层模板：base + dynamic + custom
 *
 * - base: DEFAULT_ANNOTATION_TEMPLATES (5 个静态预设)
 * - dynamic: generateTemplatesFromFieldTemplates(fieldTemplates, motivations)
 * - custom: 用户在 Settings 中保存的自定义模板
 *
 * ID 重复时：base < dynamic < custom（后层覆盖前层）
 */
export function mergeTemplates(
  fieldTemplates: FieldTemplate[],
  motivations: AnnotationMotivation[],
  customTemplates: AnnotationTemplate[],
): AnnotationTemplate[] {
  const base = DEFAULT_ANNOTATION_TEMPLATES;
  const dynamic = generateTemplatesFromFieldTemplates(fieldTemplates, motivations);

  // 按 id 去重：后层覆盖前层
  const byId = new Map<string, AnnotationTemplate>();
  for (const t of base) byId.set(t.id, t);
  for (const t of dynamic) byId.set(t.id, t);
  for (const t of customTemplates) byId.set(t.id, t);

  return [...byId.values()];
}

/**
 * 生成认知维度模板 (C-4.3)
 *
 * 3 个认知模板，自动填充 flags 维度
 */
export function generateCognitiveTemplates(): AnnotationTemplate[] {
  return [
    {
      id: 'mastery-review',
      name: '掌握度复查',
      type: 'highlight',
      color: 'green',
      motivation: 'commenting',
      icon: '🎯',
      hotkey: 'Mod+Shift+m',
      flags: { mastery: 'reviewing', reviewPriority: 'high' },
    },
    {
      id: 'needs-correction',
      name: '待纠偏',
      type: 'highlight',
      color: 'red',
      motivation: 'editing',
      icon: '✏️',
      hotkey: 'Mod+Shift+c',
      flags: { needsCorrection: true, reviewPriority: 'high' },
    },
    {
      id: 'confidence-check',
      name: '置信度标记',
      type: 'underline',
      color: 'orange',
      motivation: 'questioning',
      icon: '📊',
      hotkey: 'Mod+Shift+x',
      flags: { confidence: 2 },
    },
  ];
}