import { readFileSync } from 'fs';
import { parseBlockDoubleAnchors, findBlockTargetLine, findBlockContentEndLine } from '../src/core/annotation-parser';

const content = readFileSync('E:/Notes/数据库系统概论/docs/MarkVault-Block-List-Test.md', 'utf-8');
const lines = content.split('\n');

const anchors = parseBlockDoubleAnchors(content);
const byUuid = new Map<string, { start?: typeof anchors[0]; end?: typeof anchors[0] }>();
for (const a of anchors) {
  const entry = byUuid.get(a.uuid) || {};
  if (a.position === 'start') entry.start = a;
  else entry.end = a;
  byUuid.set(a.uuid, entry);
}

console.log('Parsed anchors:', anchors.length);
for (const [uuid, entry] of byUuid.entries()) {
  if (!entry.start || !entry.end) {
    console.log(`  ${uuid}: missing ${entry.start ? 'end' : 'start'}`);
    continue;
  }
  const targetLine = findBlockTargetLine(content, entry.start.anchorLine);
  const endLine = findBlockContentEndLine(content, entry.end.anchorLine);
  const targetText = lines[targetLine]?.trim();
  const ok = targetLine <= endLine && targetText && !targetText.startsWith('%%');
  console.log(
    `  ${uuid}: start=${entry.start.anchorLine}, end=${entry.end.anchorLine}, ` +
    `targetLine=${targetLine}, contentEndLine=${endLine}, target="${targetText}", ok=${ok}`,
  );
}
