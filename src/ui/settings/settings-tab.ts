import { PluginSettingTab, App, Setting } from 'obsidian';
import type MarkVaultPlugin from '../../main';
import { PRESET_COLORS } from '../../types/annotation';
import type { PresetColorId, AnnotationType } from '../../types/annotation';

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
}
