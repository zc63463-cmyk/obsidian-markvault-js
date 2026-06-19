import { PluginSettingTab, App, Setting, Notice } from 'obsidian';
import type { MarkVaultPluginInterface } from '../../utils/plugin-interface';
import { PRESET_COLORS, DEFAULT_SETTINGS, DEFAULT_RELATION_TYPE_CONFIGS, RelationSchema } from '../../types/annotation';
import type { PresetColorId, AnnotationType, FieldTemplate, RelationTypeConfig, AnnotationTemplate } from '../../types/annotation';
import { generateCognitiveTemplates } from '../../core/template-generator';
import { annotationStore } from '../../db/annotation-store';
import { AddRelationTypeModal } from './add-relation-type-modal';
import { ConfirmModal } from '../confirm-modal';

export class MarkVaultSettingTab extends PluginSettingTab {
  plugin: MarkVaultPluginInterface;

  constructor(app: App, plugin: MarkVaultPluginInterface) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'MarkVault Settings' });

    // 默认高亮颜色
    new Setting(containerEl)
      .setName('Default highlight color')
      .setDesc('Color used when highlighting via command palette')
      .addDropdown((dropdown) => {
        for (const color of PRESET_COLORS) {
          dropdown.addOption(color.id, color.label);
        }
        dropdown.setValue(this.plugin.settings.defaultHighlightColor);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultHighlightColor = value as PresetColorId;
          await this.plugin.saveSettings();
        });
      });

    // 默认标注类型
    new Setting(containerEl)
      .setName('Default annotation type')
      .setDesc('Type used when annotating via command palette')
      .addDropdown((dropdown) => {
        dropdown.addOption('highlight', 'Highlight');
        dropdown.addOption('bold', 'Bold');
        dropdown.addOption('underline', 'Underline');
        dropdown.setValue(this.plugin.settings.defaultAnnotationType);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultAnnotationType = value as AnnotationType;
          await this.plugin.saveSettings();
        });
      });

    // 右键菜单
    new Setting(containerEl)
      .setName('Show context menu')
      .setDesc('Show annotation options in the editor right-click menu')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showContextMenu);
        toggle.onChange(async (value) => {
          this.plugin.settings.showContextMenu = value;
          await this.plugin.saveSettings();
        });
      });

    // 侧边栏默认排序
    new Setting(containerEl)
      .setName('Sidebar default sort')
      .setDesc('How annotations are sorted in the sidebar by default')
      .addDropdown((dropdown) => {
        dropdown.addOption('position', 'Position in document');
        dropdown.addOption('createdAt', 'Newest first');
        dropdown.addOption('updatedAt', 'Recently updated');
        dropdown.setValue(this.plugin.settings.sidebarDefaultSort);
        dropdown.onChange(async (value) => {
          this.plugin.settings.sidebarDefaultSort = value as 'position' | 'createdAt' | 'updatedAt';
          await this.plugin.saveSettings();
        });
      });

    // 上下文窗口大小
    new Setting(containerEl)
      .setName('Context window size')
      .setDesc('Number of characters to capture before/after annotation for offset recovery (default: 50)')
      .addSlider((slider) => {
        slider.setLimits(20, 100, 10);
        slider.setValue(this.plugin.settings.contextWindowSize);
        slider.setDynamicTooltip();
        slider.onChange(async (value) => {
          this.plugin.settings.contextWindowSize = value;
          await this.plugin.saveSettings();
        });
      });

    // 自动同步
    new Setting(containerEl)
      .setName('Auto sync')
      .setDesc('Automatically sync annotations between Markdown and database when opening files')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableAutoSync);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableAutoSync = value;
          await this.plugin.saveSettings();
        });
      });

    // 自然 Markdown 语法（试验）
    new Setting(containerEl)
      .setName('Use native Markdown syntax (experimental)')
      .setDesc('Create annotations as stealth anchors + native Markdown wrappers (==highlight==, **bold**, <u>underline</u>) instead of <mark> tags')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.useNativeSyntax);
        toggle.onChange(async (value) => {
          this.plugin.settings.useNativeSyntax = value;
          await this.plugin.saveSettings();
        });
      });

    // ── 字段模板管理 ──
    containerEl.createEl('h3', { text: 'Field Templates' });

    // 默认模板选择
    new Setting(containerEl)
      .setName('Default template')
      .setDesc('Template used for "Annotate with field" context menu')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'None');
        for (const tpl of this.plugin.settings.fieldTemplates) {
          dropdown.addOption(tpl.id, tpl.name);
        }
        dropdown.setValue(this.plugin.settings.defaultTemplateId);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultTemplateId = value;
          await this.plugin.saveSettings();
        });
      });

    // 模板列表
    const templatesContainer = containerEl.createDiv({ cls: 'markvault-templates-container' });
    this.renderFieldTemplatesSection(templatesContainer);

    // 操作按钮
    const templateActions = containerEl.createDiv({ cls: 'markvault-template-actions' });

    const newTemplateBtn = templateActions.createEl('button', {
      text: '+ New Template',
      cls: 'mod-cta',
    });
    newTemplateBtn.addEventListener('click', async () => {
      const id = 'tpl-' + Date.now();
      this.plugin.settings.fieldTemplates.push({
        id,
        name: 'New Template',
        fields: [],
      });
      await this.plugin.saveSettings();
      // 重新渲染设置页
      this.display();
    });

    const restoreBtn = templateActions.createEl('button', {
      text: 'Restore Default Templates',
    });
    restoreBtn.addEventListener('click', async () => {
      this.plugin.settings.fieldTemplates = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.fieldTemplates));
      await this.plugin.saveSettings();
      this.display();
    });

    // ── Annotation Templates (v5.14: 认知模板 + 用户自定义) ──
    containerEl.createEl('h3', { text: 'Annotation Templates' });
    containerEl.createDiv({ cls: 'markvault-templates-desc', text: 'Predefined type+color+motivation+flags combinations for quick annotation creation.' });

    const annTemplatesContainer = containerEl.createDiv({ cls: 'markvault-annotation-templates-container' });
    this.renderAnnotationTemplatesSection(annTemplatesContainer);

    const annTemplateActions = containerEl.createDiv({ cls: 'markvault-template-actions' });

    const addCognitiveBtn = annTemplateActions.createEl('button', { text: '+ Add Cognitive Templates' });
    addCognitiveBtn.addEventListener('click', async () => {
      const cognitive = generateCognitiveTemplates();
      for (const tpl of cognitive) {
        // 避免重复
        if (!this.plugin.settings.customTemplates.some(t => t.id === tpl.id)) {
          this.plugin.settings.customTemplates.push(tpl);
        }
      }
      await this.plugin.saveSettings();
      this.display();
    });

    const addCustomAnnBtn = annTemplateActions.createEl('button', {
      text: '+ New Custom Template',
      cls: 'mod-cta',
    });
    addCustomAnnBtn.addEventListener('click', async () => {
      this.plugin.settings.customTemplates.push({
        id: 'custom-' + Date.now(),
        name: 'Custom Template',
        type: 'highlight',
        color: 'yellow',
      });
      await this.plugin.saveSettings();
      this.display();
    });

    const restoreAnnBtn = annTemplateActions.createEl('button', { text: 'Clear Custom Templates' });
    restoreAnnBtn.addEventListener('click', async () => {
      this.plugin.settings.customTemplates = [];
      await this.plugin.saveSettings();
      this.display();
    });

    // ── 关系类型管理（v4.3: Schema-First RelationType） ──
    containerEl.createEl('h3', { text: 'Relation Types' });

    const relTypesContainer = containerEl.createDiv({ cls: 'markvault-relation-types-container' });
    this.renderRelationTypesSection(relTypesContainer);

    // 添加自定义类型按钮
    const relTypeActions = containerEl.createDiv({ cls: 'markvault-relation-type-actions' });

    const newRelTypeBtn = relTypeActions.createEl('button', {
      text: '+ Add Custom Type',
      cls: 'mod-cta',
    });
    newRelTypeBtn.addEventListener('click', async () => {
      const existingIds = this.plugin.settings.customRelationTypes.map(t => t.id);
      const modal = new AddRelationTypeModal(this.app, existingIds, async (result) => {
        this.plugin.settings.customRelationTypes.push({
          id: result.id,
          label: result.label,
          reverseId: result.reverseId,
          isSymmetric: result.isSymmetric,
          isActive: true,
          color: '#94a3b8',
        });
        await this.plugin.saveSettings();
        this._rebuildSchemaSync();
        this._markSchemaAffectedDirty();
        this.display();
      });
      modal.open();
    });

    const restoreRelTypesBtn = relTypeActions.createEl('button', {
      text: 'Restore Default Types',
    });
    restoreRelTypesBtn.addEventListener('click', async () => {
      const confirmed = await ConfirmModal.open(this.app, {
        title: 'Restore default relation types',
        message: 'This will reset built-in types to defaults but preserve your custom types.\nContinue?',
        okText: 'Restore',
        dangerous: true,
      });
      if (!confirmed) return;

      // P2-2 修复: 保留用户自定义类型，只重置内置类型
      const customTypes = this.plugin.settings.customRelationTypes.filter(t => !t.isBuiltIn);
      this.plugin.settings.customRelationTypes = [
        ...JSON.parse(JSON.stringify(DEFAULT_RELATION_TYPE_CONFIGS)),
        ...customTypes,
      ];
      await this.plugin.saveSettings();
      this._rebuildSchemaSync();
      this.display();
    });

    // ── 数据管理 ──
    containerEl.createEl('h3', { text: 'Data Management' });

    new Setting(containerEl)
      .setName('Rebuild database')
      .setDesc('Re-scan all Markdown files and rebuild the annotation database')
      .addButton((button) => {
        button.setButtonText('Rebuild');
        button.setWarning();
        button.onClick(async () => {
          await this.plugin.rebuildDatabase();
        });
      });

    new Setting(containerEl)
      .setName('Export annotations')
      .setDesc('Export all annotations as JSON')
      .addButton((button) => {
        button.setButtonText('Export');
        button.onClick(async () => {
          await this.plugin.exportAnnotations();
        });
      });
  }

  private renderFieldTemplatesSection(container: HTMLElement) {
    container.empty();

    for (const template of this.plugin.settings.fieldTemplates) {
      const tplEl = container.createDiv({ cls: 'markvault-template-item' });

      // 模板头
      const header = tplEl.createDiv({ cls: 'markvault-template-header' });
      const nameInput = header.createEl('input', {
        type: 'text',
        value: template.name,
        cls: 'markvault-template-name',
      });
      nameInput.addEventListener('input', async () => {
        template.name = nameInput.value;
        await this.plugin.saveSettings();
      });

      const fieldCount = header.createSpan({
        cls: 'markvault-template-field-count',
        text: `${template.fields.length} fields`,
      });

      // 删除按钮
      const deleteBtn = header.createEl('button', {
        text: '🗑️',
        cls: 'markvault-template-delete',
      });
      deleteBtn.addEventListener('click', async () => {
        const idx = this.plugin.settings.fieldTemplates.findIndex(t => t.id === template.id);
        if (idx !== -1) {
          this.plugin.settings.fieldTemplates.splice(idx, 1);
          await this.plugin.saveSettings();
          this.display();
        }
      });

      // 字段列表
      const fieldsList = tplEl.createDiv({ cls: 'markvault-template-fields' });
      this.renderTemplateFields(fieldsList, template);

      // Add Field 按钮
      const addFieldBtn = tplEl.createEl('button', {
        text: '+ Add Field',
        cls: 'markvault-template-add-field',
      });
      addFieldBtn.addEventListener('click', async () => {
        template.fields.push({
          key: `field${template.fields.length + 1}`,
          values: [],
          allowCustom: true,
        });
        await this.plugin.saveSettings();
        this.renderFieldTemplatesSection(container);
      });
    }
  }

  private renderTemplateFields(container: HTMLElement, template: FieldTemplate) {
    container.empty();

    for (let i = 0; i < template.fields.length; i++) {
      const fieldDef = template.fields[i];
      const row = container.createDiv({ cls: 'markvault-template-field-row' });

      // 字段键名
      const keyInput = row.createEl('input', {
        type: 'text',
        value: fieldDef.key,
        cls: 'markvault-template-field-key',
        attr: { placeholder: 'Key' },
      });
      keyInput.addEventListener('input', async () => {
        fieldDef.key = keyInput.value;
        await this.plugin.saveSettings();
      });

      // 预设值（逗号分隔）
      const valuesInput = row.createEl('input', {
        type: 'text',
        value: fieldDef.values.join(', '),
        cls: 'markvault-template-field-values',
        attr: { placeholder: 'Values (comma-separated)' },
      });
      valuesInput.addEventListener('input', async () => {
        fieldDef.values = valuesInput.value.split(',').map(v => v.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      });

      // 允许自定义输入开关
      const customToggle = row.createEl('input', {
        type: 'checkbox',
        cls: 'markvault-template-field-custom',
      });
      customToggle.checked = fieldDef.allowCustom !== false; // 默认 true
      customToggle.title = 'Allow custom values';
      customToggle.addEventListener('change', async () => {
        fieldDef.allowCustom = customToggle.checked;
        await this.plugin.saveSettings();
      });

      // 删除字段按钮
      const deleteFieldBtn = row.createEl('button', {
        text: '✕',
        cls: 'markvault-template-field-delete',
      });
      deleteFieldBtn.addEventListener('click', async () => {
        template.fields.splice(i, 1);
        await this.plugin.saveSettings();
        this.renderTemplateFields(container, template);
      });
    }
  }

  /** 渲染关系类型管理区段（v4.3: Schema-First RelationType） */
  private renderRelationTypesSection(container: HTMLElement) {
    container.empty();

    const types = this.plugin.settings.customRelationTypes;
    const activeTypes = types.filter(t => t.isActive);
    const passiveTypes = types.filter(t => !t.isActive);

    // ── 主动类型 ──
    container.createEl('h4', { text: 'Active Types (User-selectable)', cls: 'markvault-relation-section-title' });

    for (let i = 0; i < activeTypes.length; i++) {
      const cfg = activeTypes[i];
      // 找到在 customRelationTypes 中的实际索引
      const realIdx = types.indexOf(cfg);
      this._renderRelationTypeRow(container, cfg, realIdx);
    }

    // ── 被动类型（折叠） ──
    const passiveHeader = container.createEl('h4', {
      text: 'Passive Types (Auto-maintained)',
      cls: 'markvault-relation-section-title markvault-relation-passive-title',
    });

    for (let i = 0; i < passiveTypes.length; i++) {
      const cfg = passiveTypes[i];
      const realIdx = types.indexOf(cfg);
      this._renderRelationTypeRow(container, cfg, realIdx);
    }
  }

  /** 渲染单个关系类型行 */
  private _renderRelationTypeRow(container: HTMLElement, cfg: RelationTypeConfig, realIdx: number) {
    const row = container.createDiv({ cls: 'markvault-relation-type-row' });

    // 颜色指示器
    const colorDot = row.createSpan({ cls: 'markvault-relation-color-dot' });
    colorDot.style.backgroundColor = cfg.color || '#94a3b8';

    // 内置类型：ID 只读显示；自定义类型：ID 可编辑
    if (cfg.isBuiltIn) {
      row.createSpan({ text: cfg.id, cls: 'markvault-relation-type-id' });
    } else {
      const idInput = row.createEl('input', {
        type: 'text',
        value: cfg.id,
        cls: 'markvault-relation-type-id markvault-relation-type-id-editable',
        attr: { placeholder: 'Type ID (e.g. inspires)' },
      });
      idInput.addEventListener('change', async () => {
        const newId = idInput.value.trim();
        if (!newId || newId === cfg.id) { idInput.value = cfg.id; return; }
        // 检查唯一性
        if (this.plugin.settings.customRelationTypes.some(t => t.id === newId)) {
          idInput.value = cfg.id;
          new Notice(`Relation type ID "${newId}" already exists`);
          return;
        }
        const oldId = cfg.id;
        // 更新所有引用此 ID 的 reverseId
        for (const t of this.plugin.settings.customRelationTypes) {
          if (t.reverseId === oldId) t.reverseId = newId;
        }
        cfg.id = newId;

        // P2-2 修复: 迁移已存数据中的 relation.type
        await this._migrateRelationTypeId(oldId, newId);

        await this.plugin.saveSettings();
        this._rebuildSchema();
      });
    }

    // 标签编辑
    const labelInput = row.createEl('input', {
      type: 'text',
      value: cfg.label,
      cls: 'markvault-relation-type-label',
    });
    labelInput.addEventListener('input', async () => {
      cfg.label = labelInput.value;
      await this.plugin.saveSettings();
      this._rebuildSchema();
    });

    // 反向类型：内置只读显示；自定义可编辑
    if (cfg.isBuiltIn) {
      row.createSpan({ text: `↔ ${cfg.reverseId}`, cls: 'markvault-relation-type-reverse' });
    } else {
      row.createSpan({ text: '↔ ', cls: 'markvault-relation-type-reverse' });
      const reverseInput = row.createEl('input', {
        type: 'text',
        value: cfg.reverseId,
        cls: 'markvault-relation-type-reverse-editable',
        attr: { placeholder: 'Reverse ID' },
      });
      reverseInput.addEventListener('change', async () => {
        const newReverseId = reverseInput.value.trim();
        if (!newReverseId || newReverseId === cfg.reverseId) { reverseInput.value = cfg.reverseId; return; }

        // P2-2 修复: reverseId 闭环同步 — 双向关系的两端互为 reverseId
        cfg.reverseId = newReverseId;

        // 查找 reverseId 对应的类型，同步其 reverseId 指回本类型
        const reverseType = this.plugin.settings.customRelationTypes.find(t => t.id === newReverseId);
        if (reverseType && reverseType.id !== cfg.id) {
          if (reverseType.reverseId !== cfg.id) {
            reverseType.reverseId = cfg.id;
          }
        }

        // 对称关系: reverseId = 自身
        if (cfg.isSymmetric && newReverseId !== cfg.id) {
          cfg.isSymmetric = false;  // reverseId 不等于自身，不再是对称
        }

        await this.plugin.saveSettings();
        this._rebuildSchema();
        this.display();  // 刷新 UI 显示同步后的状态
      });
    }

    // 对称标记（自定义类型可切换）
    if (cfg.isBuiltIn) {
      if (cfg.isSymmetric) {
        row.createSpan({ text: '⟷ 对称', cls: 'markvault-relation-type-symmetric' });
      }
    } else {
      const symmetricToggle = row.createEl('input', {
        type: 'checkbox',
        cls: 'markvault-relation-type-symmetric-toggle',
      });
      symmetricToggle.checked = cfg.isSymmetric;
      symmetricToggle.title = 'Symmetric';
      symmetricToggle.addEventListener('change', async () => {
        cfg.isSymmetric = symmetricToggle.checked;
        if (cfg.isSymmetric) {
          cfg.reverseId = cfg.id;
        }
        await this.plugin.saveSettings();
        this._rebuildSchema();
        this.display();
      });
      const symmetricLabel = row.createSpan({ text: '对称', cls: 'markvault-relation-type-symmetric-label' });
    }

    // 内置标记
    if (cfg.isBuiltIn) {
      row.createSpan({ text: '内置', cls: 'markvault-relation-type-builtin' });
    }

    // 删除按钮（自定义类型可删除）
    if (!cfg.isBuiltIn) {
      const deleteBtn = row.createEl('button', {
        text: '✕',
        cls: 'markvault-relation-type-delete',
      });
      deleteBtn.addEventListener('click', async () => {
        // v5.0: 提供级联清理选项
        const hasActiveRelations = annotationStore.getAllAnnotations().some(
          ann => ann.relations?.some(r => r.type === cfg.id && !r.invalidAt)
        );

        let shouldCascade = false;
        if (hasActiveRelations) {
          shouldCascade = await ConfirmModal.open(this.app, {
            message: `There are active relations of type "${cfg.id}".\n\nClick OK to also invalidate (soft-delete) those relations.\nClick Cancel to keep the relations as orphans (they will still appear in the graph).`,
            title: 'Delete Relation Type',
            okText: 'OK',
            cancelText: 'Cancel',
          });
        }

        const idx = this.plugin.settings.customRelationTypes.findIndex(t => t.id === cfg.id);
        if (idx !== -1) {
          this.plugin.settings.customRelationTypes.splice(idx, 1);
          await this.plugin.saveSettings();
          this._rebuildSchema();

          if (shouldCascade) {
            await annotationStore.invalidateRelationsByType(cfg.id);
          }

          this.display();
        }
      });
    }
  }

  /** 重建 RelationSchema 并注入到 Store，同时标记受影响文件为 dirty */
  private _rebuildSchema() {
    this._rebuildSchemaSync();
    this._markSchemaAffectedDirty();
  }

  /** 同步重建 Schema */
  private _rebuildSchemaSync() {
    this.plugin.relationSchema = new RelationSchema(this.plugin.settings.customRelationTypes);
    annotationStore.setRelationSchema(this.plugin.relationSchema);
  }

  /**
   * P2-2: 迁移已存数据中的 relation.type 字段。
   * 当用户重命名自定义关系类型 ID 时，遍历所有标注的 relations 数组，
   * 将旧 type 替换为新 type。
   */
  private async _migrateRelationTypeId(oldId: string, newId: string): Promise<void> {
    let migratedCount = 0;
    const allAnnotations = annotationStore.getAllAnnotations();
    for (const ann of allAnnotations) {
      if (!ann.relations || ann.relations.length === 0) continue;
      let changed = false;
      for (const rel of ann.relations) {
        // P2 审查修复: 移除重复的条件判断 — 一个 if 足够
        // 原代码有两个连续的 `if (rel.type === oldId)` 完全相同，第二个永远不会执行
        if (rel.type === oldId) {
          rel.type = newId;
          changed = true;
        }
      }
      if (changed) {
        migratedCount++;
        // 标记 dirty 确保持久化
        (annotationStore as any).persistLayer._markDirty(ann.filePath);
      }
    }
    if (migratedCount > 0) {
      new Notice(`Migrated ${migratedCount} annotations from "${oldId}" to "${newId}"`, 3000);
    }
  }

  /**
   * P4 审计修复：Schema 变更后标记受影响文件为 dirty。
   *
   * 当关系类型配置发生变化时（类型被删除/修改），使用新 Schema 的关系类型
   * 可能与已存储的 .relations 数据不匹配。扫描所有标注，将包含未注册关系
   * 类型的标注所在文件标记为 dirty，确保下次 flush 时写回最新数据。
   *
   * 注意：不修改标注数据本身 — 删除类型不级联删除旧关系，留作数据兼容。
   * 这确保关闭 Obsidian 前这些文件会被持久化。
   */
  private _markSchemaAffectedDirty() {
    const allAnnotations = annotationStore.getAllAnnotations();
    const affectedFiles = new Set<string>();
    for (const ann of allAnnotations) {
      if (ann.relations && ann.relations.length > 0) {
        const hasUnregistered = ann.relations.some(
          r => !this.plugin.relationSchema.isRegistered(r.type)
        );
        if (hasUnregistered) {
          affectedFiles.add(ann.filePath);
        }
      }
    }
    for (const filePath of affectedFiles) {
      annotationStore.markFileDirty(filePath);
    }
  }

  // ── Annotation Templates 渲染 (v5.14) ──

  private renderAnnotationTemplatesSection(container: HTMLElement): void {
    container.empty();

    // 内置模板（只读展示）
    container.createEl('h4', { text: 'Built-in Templates', cls: 'markvault-section-subtitle' });
    const builtInList = container.createDiv({ cls: 'markvault-templates-list' });
    for (const tpl of this.plugin.settings.annotationTemplates) {
      this.renderAnnotationTemplateItem(builtInList, tpl, true);
    }

    // 用户自定义模板（可编辑/删除）
    container.createEl('h4', { text: 'Custom Templates', cls: 'markvault-section-subtitle' });
    const customList = container.createDiv({ cls: 'markvault-templates-list' });

    if (this.plugin.settings.customTemplates.length === 0) {
      customList.createDiv({ text: 'No custom templates. Click "+ New Custom Template" or "+ Add Cognitive Templates" to add.', cls: 'markvault-templates-empty' });
    }

    for (let i = 0; i < this.plugin.settings.customTemplates.length; i++) {
      const tpl = this.plugin.settings.customTemplates[i];
      this.renderAnnotationTemplateItem(customList, tpl, false, i);
    }
  }

  private renderAnnotationTemplateItem(
    container: HTMLElement,
    tpl: AnnotationTemplate,
    readOnly: boolean,
    customIndex?: number,
  ): void {
    const item = container.createDiv({ cls: 'markvault-template-item' });

    // 图标 + 名称
    const header = item.createDiv({ cls: 'markvault-template-item-header' });
    if (tpl.icon) header.createSpan({ text: tpl.icon, cls: 'markvault-template-item-icon' });
    header.createSpan({ text: tpl.name, cls: 'markvault-template-item-name' });

    // 标签
    const tags = item.createDiv({ cls: 'markvault-template-item-tags' });
    tags.createSpan({ text: tpl.type, cls: 'markvault-template-item-tag' });
    tags.createSpan({ text: tpl.color, cls: 'markvault-template-item-tag' });
    if (tpl.motivation) tags.createSpan({ text: tpl.motivation, cls: 'markvault-template-item-tag' });
    if (tpl.flags) {
      const flagStrs: string[] = [];
      if (tpl.flags.mastery) flagStrs.push(`mastery:${tpl.flags.mastery}`);
      if (tpl.flags.confidence !== undefined) flagStrs.push(`confidence:${tpl.flags.confidence}`);
      if (tpl.flags.needsCorrection) flagStrs.push('needsCorrection');
      if (tpl.flags.reviewPriority) flagStrs.push(`priority:${tpl.flags.reviewPriority}`);
      for (const fs of flagStrs) {
        tags.createSpan({ text: `🧠 ${fs}`, cls: 'markvault-template-item-tag markvault-flag-tag' });
      }
    }

    // 操作按钮
    if (!readOnly && customIndex !== undefined) {
      const actions = item.createDiv({ cls: 'markvault-template-item-actions' });

      // 编辑
      const editBtn = actions.createEl('button', { text: 'Edit' });
      editBtn.addEventListener('click', () => {
        this.showEditAnnotationTemplateModal(customIndex);
      });

      // 删除
      const deleteBtn = actions.createEl('button', { text: 'Delete', cls: 'mod-warning' });
      deleteBtn.addEventListener('click', async () => {
        this.plugin.settings.customTemplates.splice(customIndex, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    }
  }

  private showEditAnnotationTemplateModal(index: number): void {
    const tpl = this.plugin.settings.customTemplates[index];
    if (!tpl) return;

    // 简单的 Obsidian Modal 编辑 — 使用 prompt 替代复杂表单
    // 因为 Obsidian Modal 需要大量样板代码，这里用 Settings 内联编辑
    const modal = new (require('obsidian') as any).Modal(this.app);
    modal.titleEl.setText(`Edit Template: ${tpl.name}`);

    const { contentEl } = modal;

    // Name
    contentEl.createDiv({ text: 'Name:' });
    const nameInput = contentEl.createEl('input', { type: 'text', value: tpl.name });
    nameInput.style.width = '100%';
    nameInput.style.marginBottom = '10px';

    // Type
    contentEl.createDiv({ text: 'Type:' });
    const typeSelect = contentEl.createEl('select');
    for (const t of ['highlight', 'bold', 'underline']) {
      typeSelect.createEl('option', { value: t, text: t, attr: t === tpl.type ? { selected: '' } : {} });
    }
    typeSelect.style.marginBottom = '10px';

    // Color
    contentEl.createDiv({ text: 'Color:' });
    const colorSelect = contentEl.createEl('select');
    for (const c of PRESET_COLORS) {
      colorSelect.createEl('option', { value: c.id, text: c.label, attr: c.id === tpl.color ? { selected: '' } : {} });
    }
    colorSelect.style.marginBottom = '10px';

    // Motivation
    contentEl.createDiv({ text: 'Motivation:' });
    const motivationSelect = contentEl.createEl('select');
    motivationSelect.createEl('option', { value: '', text: '(auto)' });
    for (const m of ['highlighting', 'commenting', 'questioning', 'editing', 'bookmarking', 'replying', 'classifying']) {
      motivationSelect.createEl('option', { value: m, text: m, attr: m === tpl.motivation ? { selected: '' } : {} });
    }
    motivationSelect.style.marginBottom = '10px';

    // Icon
    contentEl.createDiv({ text: 'Icon (emoji):' });
    const iconInput = contentEl.createEl('input', { type: 'text', value: tpl.icon || '' });
    iconInput.style.marginBottom = '10px';

    // Save button
    const saveBtn = contentEl.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', async () => {
      this.plugin.settings.customTemplates[index] = {
        ...tpl,
        name: nameInput.value || tpl.name,
        type: typeSelect.value as any,
        color: colorSelect.value,
        motivation: motivationSelect.value as any || undefined,
        icon: iconInput.value || undefined,
      };
      await this.plugin.saveSettings();
      modal.close();
      this.display();
    });

    modal.open();
  }
}
