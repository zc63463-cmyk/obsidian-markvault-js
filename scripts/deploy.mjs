/**
 * Deploy script — 构建后将 main.js / manifest.json / styles.css 复制到 Obsidian vault 插件目录
 *
 * 用法: node scripts/deploy.mjs
 * 或:   npm run deploy (含 tsc + esbuild)
 *
 * 配置: 修改下方 VAULT_PATHS 数组以适配你的 vault 路径
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ═══════════════════════════════════════════════════════
// Vault 路径配置 — 按需修改
// ═══════════════════════════════════════════════════════
const VAULT_PATHS = [
  'E:/Notes/DevNotes/Markvault-js开发/.obsidian/plugins/markvault-js',
  'E:/Notes/数据库系统概论/.obsidian/plugins/markvault-js',
];

const FILES = ['main.js', 'manifest.json', 'styles.css'];

let successCount = 0;
let failCount = 0;

for (const vaultPath of VAULT_PATHS) {
  if (!existsSync(vaultPath)) {
    console.log(`[SKIP] Vault not found: ${vaultPath}`);
    continue;
  }

  console.log(`[DEPLOY] → ${vaultPath}`);
  for (const file of FILES) {
    const src = join(projectRoot, file);
    const dst = join(vaultPath, file);
    if (!existsSync(src)) {
      console.log(`  [SKIP] ${file} not found in build output`);
      continue;
    }
    try {
      copyFileSync(src, dst);
      console.log(`  [OK]   ${file}`);
      successCount++;
    } catch (err) {
      console.error(`  [FAIL] ${file}: ${err.message}`);
      failCount++;
    }
  }
}

console.log(`\nDeploy complete: ${successCount} files copied, ${failCount} failed.`);
if (failCount > 0) process.exit(1);
