import {
  parseBlockDoubleAnchors,
  findBlockTargetLine,
  findBlockContentEndLine,
} from '../src/core/annotation-parser';
import { readFileSync } from 'fs';

async function runTests() {
  const content = readFileSync(
    'E:/Notes/数据库系统概论/docs/MarkVault-Block-List-Test.md',
    'utf-8'
  );
  const lines = content.split('\n');
  const anchors = parseBlockDoubleAnchors(content);
  const map = new Map<string, { start?: typeof anchors[0]; end?: typeof anchors[0] }>();
  for (const a of anchors) {
    const entry = map.get(a.uuid) || {};
    if (a.position === 'start') entry.start = a;
    else entry.end = a;
    map.set(a.uuid, entry);
  }

  console.log('\n🔍 Block double-anchor computed ranges\n');
  for (const [uuid, entry] of map.entries()) {
    if (!entry.start) continue;
    const sLine = findBlockTargetLine(content, entry.start.anchorLine);
    const eLine = entry.end ? findBlockContentEndLine(content, entry.end.anchorLine) : sLine;
    const text = lines.slice(sLine, eLine + 1).join('\n');
    console.log(`uuid: ${uuid}`);
    console.log(`  startAnchorLine=${entry.start.anchorLine}, endAnchorLine=${entry.end?.anchorLine ?? 'none'}`);
    console.log(`  targetLine=${sLine}, endLine=${eLine}`);
    console.log(`  text: ${JSON.stringify(text)}`);
    console.log();
  }
}

runTests().catch(e => { console.error(e); process.exit(1); });
