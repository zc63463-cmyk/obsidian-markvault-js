import { PluginSettingTab, App, Setting } from 'obsidian';
import type MarkVaultPlugin from '../../main';
import { PRESET_COLORS, DEFAULT_SETTINGS } from '../../types/annotation';
import type { PresetColorId, AnnotationType, FieldTemplate } from '../../types/annotation';

export class MarkVaultSettingTab extends PluginSettingTab {
  plugin: MarkVaultPlugin;

  constructor(app: App, plugin: MarkVaultPlugin) {
    super(app, plugin);
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
}
