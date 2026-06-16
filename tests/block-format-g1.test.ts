/**
 * G-1 BlockFormat 双锚点全链路测试
 *
 * 验证 BlockFormat.parse() 对双锚点的解析能力，
 * 以及 FormatRegistry 集成后双锚点标注不丢失。
 */

import { BlockFormat } from '../src/format/block-format';
import { formatRegistry } from '../src/format/format-registry';
import { MarkFormat } from '../src/format/mark-format';
import { NativeFormat } from '../src/format/native-format';
import { RegionFormat } from '../src/format/region-format';

let _c = 0;
function uuid() {
  return `g1-${++_c}`;
}

async function runTests() {
  let passed = 0, failed = 0;
  const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  };

  console.log('\n🧪 G-1 BlockFormat 双锚点全链路测试\n');

  const blockFormat = new BlockFormat();

  // ── parse() 双锚点基础测试 ──

  await test('parse() 解析双锚点 start+end 配对', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:highlight:yellow:start:%%\nSome code block\n%%markvault-block:${id}:highlight:yellow:end:%%`;
    const results = blockFormat.parse(content, 'test.md');
    const found = results.find(r => r.uuid === id);
    if (!found) throw new Error('双锚点标注未解析到');
    if (found.kind !== 'block') throw new Error(`kind 应为 block，实际为 ${found.kind}`);
    if (!found.text.includes('Some code block')) throw new Error(`text 不正确: ${found.text}`);
    if (found.startOffset < 0) throw new Error('startOffset 应为非负值');
  });

  await test('parse() 双锚点含 note 和特殊字符', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:bold:blue:start:hello\\2world%%\nconst x = 1;\n%%markvault-block:${id}:bold:blue:end:hello\\2world%%`;
    const results = blockFormat.parse(content, 'test.md');
    const found = results.find(r => r.uuid === id);
    if (!found) throw new Error('双锚点标注未解析到');
    if (found.note !== 'hello:world') throw new Error(`note 未正确解码: ${found.note}`);
    if (found.type !== 'bold') throw new Error(`type 应为 bold，实际为 ${found.type}`);
    if (found.color !== 'blue') throw new Error(`color 应为 blue，实际为 ${found.color}`);
  });

  await test('parse() 孤立 start 无 end 时不产出结果', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:highlight:yellow:start:%%\nSome text\nNo end anchor`;
    const results = blockFormat.parse(content, 'test.md');
    const found = results.find(r => r.uuid === id);
    if (found) throw new Error('孤立 start 不应产出标注结果');
  });

  await test('parse() 孤立 end 无 start 时不产出结果', () => {
    const id = uuid();
    const content = `No start\n%%markvault-block:${id}:highlight:yellow:end:%%`;
    const results = blockFormat.parse(content, 'test.md');
    const found = results.find(r => r.uuid === id);
    if (found) throw new Error('孤立 end 不应产出标注结果');
  });

  await test('parse() 双锚点包围代码块', () => {
    const id = uuid();
    const content = `before\n%%markvault-block:${id}:highlight:yellow:start:%%\n\`\`\`ts\nconst x = 1;\n\`\`\`\n%%markvault-block:${id}:highlight:yellow:end:%%\nafter`;
    const results = blockFormat.parse(content, 'test.md');
    const found = results.find(r => r.uuid === id);
    if (!found) throw new Error('代码块双锚点未解析到');
    if (!found.text.includes('const x = 1')) throw new Error(`text 不含代码: ${found.text}`);
  });

  await test('parse() 多个双锚点标注并行解析', () => {
    const id1 = uuid();
    const id2 = uuid();
    const content = [
      `%%markvault-block:${id1}:highlight:yellow:start:%%`,
      'Block 1 content',
      `%%markvault-block:${id1}:highlight:yellow:end:%%`,
      `%%markvault-block:${id2}:bold:green:start:%%`,
      'Block 2 content',
      `%%markvault-block:${id2}:bold:green:end:%%`,
    ].join('\n');
    const results = blockFormat.parse(content, 'test.md');
    const found1 = results.find(r => r.uuid === id1);
    const found2 = results.find(r => r.uuid === id2);
    if (!found1) throw new Error('第一个双锚点未解析到');
    if (!found2) throw new Error('第二个双锚点未解析到');
    if (found1.text.includes('Block 2')) throw new Error('第一个标注文本不应含 Block 2');
    if (found2.text.includes('Block 1')) throw new Error('第二个标注文本不应含 Block 1');
  });

  // ── parse() 单锚点 + 双锚点混合测试 ──

  await test('parse() 单锚点和双锚点混合解析', () => {
    const singleId = uuid();
    const doubleId = uuid();
    const content = [
      `%%markvault:${singleId}:highlight:yellow:note1%%`,
      'Single anchor target',
      `%%markvault-block:${doubleId}:bold:blue:start:%%`,
      'Double anchor target',
      `%%markvault-block:${doubleId}:bold:blue:end:%%`,
    ].join('\n');
    const results = blockFormat.parse(content, 'test.md');
    const singleFound = results.find(r => r.uuid === singleId);
    const doubleFound = results.find(r => r.uuid === doubleId);
    if (!singleFound) throw new Error('单锚点标注未解析到');
    if (!doubleFound) throw new Error('双锚点标注未解析到');
    if (singleFound.kind !== 'block') throw new Error(`单锚点 kind 应为 block`);
    if (doubleFound.kind !== 'block') throw new Error(`双锚点 kind 应为 block`);
  });

  // ── FormatRegistry 集成测试 ──

  await test('FormatRegistry.parseAll() 不丢失双锚点标注', () => {
    // 注册所有格式到独立的测试 registry
    const testRegistry = new (formatRegistry.constructor as any)();
    testRegistry.register(new MarkFormat());
    testRegistry.register(new NativeFormat());
    testRegistry.register(new BlockFormat());
    testRegistry.register(new RegionFormat());

    const id = uuid();
    const content = [
      `Some text with <mark data-uuid="m1" data-type="highlight" data-color="yellow" class="markvault-highlight markvault-yellow" data-note="">inline</mark>`,
      `%%markvault-block:${id}:bold:red:start:note%%`,
      'Target block content',
      `%%markvault-block:${id}:bold:red:end:note%%`,
    ].join('\n');

    const results = testRegistry.parseAll(content, 'test.md');
    const doubleFound = results.find(r => r.uuid === id);
    if (!doubleFound) throw new Error('FormatRegistry.parseAll() 丢失了双锚点标注！');
    if (doubleFound.type !== 'bold') throw new Error(`type 应为 bold，实际为 ${doubleFound.type}`);
    if (doubleFound.color !== 'red') throw new Error(`color 应为 red，实际为 ${doubleFound.color}`);
    if (!doubleFound.text.includes('Target block')) throw new Error(`text 不正确: ${doubleFound.text}`);
  });

  // ── CRUD 全链路测试 ──

  await test('update() 更新双锚点属性', () => {
    const id = uuid();
    const content = `%%markvault-block:${id}:highlight:yellow:start:oldnote%%\nblock text\n%%markvault-block:${id}:highlight:yellow:end:oldnote%%`;
    const updated = blockFormat.update(content, id, { color: 'green', note: 'newnote' });
    if (!updated) throw new Error('update 返回 null');
    if (!updated.includes(':green:')) throw new Error('color 未更新');
    if (!updated.includes('newnote')) throw new Error('note 未更新');
    if (updated.split('markvault-block').length - 1 !== 2) throw new Error('锚点数量变化');
  });

  await test('remove() 删除双锚点保留内容', () => {
    const id = uuid();
    const content = `before\n%%markvault-block:${id}:highlight:yellow:start:%%\nblock text\n%%markvault-block:${id}:highlight:yellow:end:%%\nafter`;
    const removed = blockFormat.remove(content, id);
    if (!removed) throw new Error('remove 返回 null');
    if (removed.includes('markvault-block')) throw new Error('双锚点未被移除');
    if (!removed.includes('block text')) throw new Error('内容被删除');
    if (!removed.includes('before') || !removed.includes('after')) throw new Error('周边内容丢失');
  });

  await test('strip() 剥离双锚点标记', () => {
    const id = uuid();
    const content = `text\n%%markvault-block:${id}:highlight:yellow:start:%%\nblock text\n%%markvault-block:${id}:highlight:yellow:end:%%\nmore`;
    const stripped = blockFormat.strip(content);
    if (stripped.includes('markvault-block')) throw new Error('strip 后仍含双锚点');
    if (!stripped.includes('block text')) throw new Error('strip 后内容丢失');
  });

  await test('strip() 同时剥离单锚点和双锚点', () => {
    const id1 = uuid();
    const id2 = uuid();
    const content = [
      `%%markvault:${id1}:highlight:yellow:note%%`,
      'single target',
      `%%markvault-block:${id2}:bold:blue:start:%%`,
      'double target',
      `%%markvault-block:${id2}:bold:blue:end:%%`,
    ].join('\n');
    const stripped = blockFormat.strip(content);
    if (stripped.includes('markvault')) throw new Error('strip 后仍含锚点标记');
    if (!stripped.includes('single target')) throw new Error('strip 后单锚点内容丢失');
    if (!stripped.includes('double target')) throw new Error('strip 后双锚点内容丢失');
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Runner failed:', e); process.exit(1); });
