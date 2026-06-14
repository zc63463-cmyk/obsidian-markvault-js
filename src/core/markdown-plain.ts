/**
 * 将 Markdown 源文本转换为可用于阅读模式选区定位的“纯文本”，
 * 同时维护纯文本偏移 → 源文本偏移的映射。
 *
 * 处理：
 * - 加粗 **...**、斜体 *...*
 * - 高亮 ==...==、删除线 ~~...~~
 * - 行内代码 `...`（保留代码内容，去掉反引号）
 * - Wiki 链接 [[file]] / [[alias|file]]（保留显示文本）
 * - Markdown 链接 [text](url)（保留显示文本）
 * - 块级/span 锚点注释 %%...%%（忽略）
 * - HTML 标签 <...>（忽略标签本身）
 * - Callout 前缀 >（忽略）
 */
export function markdownToPlainWithMap(content: string): { plain: string; map: number[] } {
  const map: number[] = [];
  let plain = '';
  let i = 0;

  const push = (char: string, srcIndex: number) => {
    plain += char;
    map.push(srcIndex);
  };

  while (i < content.length) {
    // 块级/span 锚点注释
    if (content.startsWith('%%', i)) {
      const end = content.indexOf('%%', i + 2);
      i = end === -1 ? i + 2 : end + 2;
      continue;
    }

    // 块级公式 $$...$$
    if (content.startsWith('$$', i)) {
      const end = content.indexOf('$$', i + 2);
      if (end !== -1) {
        // 保留内部文本，跳过 $$ 标记
        for (let k = i + 2; k < end; k++) {
          push(content[k], k);
        }
        i = end + 2;
        continue;
      }
    }

    // 行内公式 $...$（简化处理：匹配最近的下一个 $）
    if (content[i] === '$') {
      const end = content.indexOf('$', i + 1);
      if (end !== -1) {
        for (let k = i + 1; k < end; k++) {
          push(content[k], k);
        }
        i = end + 1;
        continue;
      }
    }

    // 代码围栏 ```...``` — 跳过开闭围栏，保留内部代码文本
    if (content.startsWith('```', i)) {
      // 找到行尾（跳过语言标识，如 ```python）
      const lineEnd = content.indexOf('\n', i);
      if (lineEnd !== -1) {
        // 跳过开围栏行
        i = lineEnd + 1;
        // 保留内部代码文本
        const closeFence = content.indexOf('\n```', i);
        if (closeFence !== -1) {
          for (let k = i; k < closeFence; k++) {
            push(content[k], k);
          }
          i = closeFence + 4; // 跳过 \n```
          continue;
        } else {
          // 没有闭合围栏：保留剩余文本
          for (let k = i; k < content.length; k++) {
            push(content[k], k);
          }
          i = content.length;
          continue;
        }
      }
    }

    // 行内代码 `...`
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1);
      if (end === -1) {
        push(content[i], i);
        i++;
        continue;
      }
      for (let k = i + 1; k < end; k++) {
        push(content[k], k);
      }
      i = end + 1;
      continue;
    }

    // 加粗 **...**
    if (content.startsWith('**', i)) {
      const end = content.indexOf('**', i + 2);
      if (end !== -1) {
        // 保留内部文本，跳过开闭 ** 标记
        for (let k = i + 2; k < end; k++) {
          push(content[k], k);
        }
        i = end + 2;
        continue;
      }
      push(content[i], i);
      i++;
      continue;
    }

    // 删除线 ==...== / ~~...~~
    if (content.startsWith('==', i) || content.startsWith('~~', i)) {
      const marker = content.slice(i, i + 2);
      const end = content.indexOf(marker, i + 2);
      if (end !== -1) {
        // 保留内部文本，跳过开闭标记
        for (let k = i + 2; k < end; k++) {
          push(content[k], k);
        }
        i = end + 2;
      } else {
        i += 2;
      }
      continue;
    }

    // 标题行 # Title
    if (content[i] === '#' && (i === 0 || content[i - 1] === '\n')) {
      let j = i;
      while (j < content.length && content[j] === '#') j++;
      if (j < content.length && content[j] === ' ') j++;
      i = j;
      continue;
    }

    // 无序列表项 - / * / + （必须带空格，避免误吞普通星号）
    if (
      (content[i] === '-' || content[i] === '*' || content[i] === '+') &&
      (i === 0 || content[i - 1] === '\n') &&
      content[i + 1] === ' '
    ) {
      i += 2;
      // 任务列表 - [ ] / - [x]
      if (content[i] === '[' && (content[i + 1] === ' ' || content[i + 1] === 'x' || content[i + 1] === 'X') && content[i + 2] === ']') {
        i += 3;
        if (content[i] === ' ') i++;
      }
      continue;
    }

    // 有序列表项 1. / 2. 
    if (/\d/.test(content[i]) && (i === 0 || content[i - 1] === '\n')) {
      let j = i;
      while (j < content.length && /\d/.test(content[j])) j++;
      if (content[j] === '.' && content[j + 1] === ' ') {
        i = j + 2;
        continue;
      }
    }

    // 斜体 *...*（避免与 **、列表项 * 冲突）
    if (content[i] === '*') {
      const end = content.indexOf('*', i + 1);
      if (end !== -1 && end === i + 1) {
        // 这是 **，已经处理过；fallback
        push(content[i], i);
        i++;
        continue;
      }
      if (end !== -1) {
        // 保留内部文本，跳过开闭 * 标记
        for (let k = i + 1; k < end; k++) {
          push(content[k], k);
        }
        i = end + 1;
        continue;
      }
      push(content[i], i);
      i++;
      continue;
    }

    // Wiki 链接 [[alias|file]] / [[file]]
    if (content.startsWith('[[', i)) {
      const end = content.indexOf(']]', i + 2);
      if (end !== -1) {
        const inner = content.slice(i + 2, end);
        const pipe = inner.indexOf('|');
        const display = pipe !== -1 ? inner.slice(0, pipe) : inner;
        for (let k = 0; k < display.length; k++) {
          push(display[k], i + 2 + k);
        }
        i = end + 2;
        continue;
      }
    }

    // Markdown 链接 [text](url)
    if (content[i] === '[') {
      const endText = content.indexOf(']', i);
      if (endText !== -1 && content[endText + 1] === '(') {
        const endUrl = content.indexOf(')', endText + 2);
        if (endUrl !== -1) {
          for (let k = i + 1; k < endText; k++) {
            push(content[k], k);
          }
          i = endUrl + 1;
          continue;
        }
      }
    }

    // HTML 标签 <...>（包括 <mark>）
    if (content[i] === '<') {
      const end = content.indexOf('>', i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }

    // Callout 前缀 > 及紧跟的空格
    if (content[i] === '>' && (i === 0 || content[i - 1] === '\n')) {
      i++;
      if (content[i] === ' ') i++;
      continue;
    }

    // 默认字符
    push(content[i], i);
    i++;
  }

  return { plain, map };
}
