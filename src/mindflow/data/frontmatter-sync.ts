/**
 * Frontmatter Sync — Free 节点持久化到 .md frontmatter
 *
 * 存储格式：
 * ---
 * mindmap:
 *   structureType: skeleton
 *   layout: tree-right
 *   nodes:
 *     - id: "free-1"
 *       parentId: "md-5"
 *       text: "用户手动添加的节点"
 *       note: ""
 * ---
 *
 * 设计原则：
 *   - 保留文件原有 frontmatter 的其他字段（只操作 mindmap 段）
 *   - 保留 .md 正文完全不变
 *   - MD-Seed 节点不存 frontmatter（它们由正文解析生成）
 */

import { logger } from '../../utils/logger';
import {
  DEFAULT_STRUCTURE_TYPE,
  DEFAULT_LAYOUT_TYPE,
  fromFreeNodeRecord,
  toFreeNodeRecord,
  type FreeNodeRecord,
  type MindNode,
  type MindmapFrontmatter,
  type MindmapMeta,
} from '../types/mind-node';

// ═══════════════════════════════════════════════════════
// 文件级操作：拆分 / 合并 frontmatter 和正文
// ═══════════════════════════════════════════════════════

/** frontmatter 分隔符 */
const FM_DELIMITER = '---';

interface FileParts {
  /** frontmatter 原文（不含分隔符），null 表示无 frontmatter */
  frontmatter: string | null;
  /** 正文原文 */
  body: string;
}

/**
 * 将文件内容拆分为 frontmatter 和正文
 */
function splitFile(content: string): FileParts {
  // 文件必须以 --- 开头（允许前面有 BOM 或空行）
  const trimmed = content.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith(FM_DELIMITER)) {
    return { frontmatter: null, body: content };
  }

  // 找第二个 ---
  const firstDelimEnd = FM_DELIMITER.length;
  const secondDelimIdx = trimmed.indexOf('\n' + FM_DELIMITER, firstDelimEnd);

  if (secondDelimIdx === -1) {
    // 没有闭合的 ---，整个文件当正文
    return { frontmatter: null, body: content };
  }

  const frontmatter = trimmed.slice(firstDelimEnd, secondDelimIdx).trim();
  // 正文从第二个 --- 后的换行开始
  const bodyStart = secondDelimIdx + FM_DELIMITER.length + 1; // +1 for \n
  const body = trimmed.slice(bodyStart);

  return { frontmatter, body };
}

/**
 * 将 frontmatter 和正文合并为完整文件
 */
function joinFile(frontmatter: string | null, body: string): string {
  if (!frontmatter) return body;
  return `${FM_DELIMITER}\n${frontmatter}\n${FM_DELIMITER}\n${body}`;
}

// ═══════════════════════════════════════════════════════
// YAML 解析（轻量级，仅处理 mindmap 段）
// ═══════════════════════════════════════════════════════

/**
 * 从 frontmatter 文本中提取 mindmap 段
 * 返回原始行数组（已去除缩进），供结构化解析
 */
function extractMindmapLines(fmText: string): string[] | null {
  const lines = fmText.split('\n');
  const result: string[] = [];
  let inMindmap = false;
  let mindmapIndent = -1;

  for (const line of lines) {
    if (!inMindmap) {
      // 寻找 mindmap: 行
      const match = line.match(/^(\s*)mindmap:\s*$/);
      if (match) {
        inMindmap = true;
        mindmapIndent = match[1].length;
      }
    } else {
      // 在 mindmap 段内：检查缩进
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      // 空行保留
      if (line.trim() === '') {
        result.push('');
        continue;
      }
      // 缩进 <= mindmapIndent 表示离开了 mindmap 段
      if (leadingSpaces <= mindmapIndent) {
        break;
      }
      // 去除一级缩进（mindmapIndent + 2 或 tab）
      result.push(line.slice(mindmapIndent + 2));
    }
  }

  return inMindmap ? result : null;
}

/**
 * 解析 mindmap frontmatter 为结构化对象
 */
export function parseMindmapFrontmatter(content: string): MindmapFrontmatter | null {
  const { frontmatter } = splitFile(content);
  if (!frontmatter) return null;

  const mindmapLines = extractMindmapLines(frontmatter);
  if (!mindmapLines) return null;

  const result: MindmapFrontmatter = {};
  const nodes: FreeNodeRecord[] = [];
  let inNodes = false;
  let inConnections = false;
  let currentNode: Partial<FreeNodeRecord> | null = null;

  for (const line of mindmapLines) {
    if (line.trim() === '') continue;

    // structureType / layout / nodes (key: value 或 key: 无值)
    // P2-10: 用 !line.startsWith('-') 替代 !line.startsWith(' ')
    //   （mindmap 段去缩进后，顶层 key 可能不含缩进，列表项以 - 开头）
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch && !line.startsWith('-')) {
      // 先保存当前节点
      if (currentNode && currentNode.id) {
        nodes.push(currentNode as FreeNodeRecord);
        currentNode = null;
      }
      inNodes = false;

      const key = kvMatch[1];
      // N5: 顶层字段也走统一的去引号+反转义逻辑 (H1: 复用 unescapeYamlValue)
      const rawValue = kvMatch[2].trim();
      let value: string;
      if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        value = unescapeYamlValue(rawValue.slice(1, -1)).trim();
      } else {
        value = rawValue.replace(/^['"]|['"]$/g, '').trim();
      }
      if (key === 'structureType') result.structureType = value as MindmapFrontmatter['structureType'];
      else if (key === 'layout') result.layout = value as MindmapFrontmatter['layout'];
      else if (key === 'nodes') { inNodes = true; inConnections = false; }
      else if (key === 'boundaries') { inNodes = false; inConnections = false; }
      else if (key === 'connections') { inNodes = false; inConnections = true; }
      else { inNodes = false; inConnections = false; }
      continue;
    }

    // M2: 外框列表项解析
    if (!inNodes && !inConnections) {
      const boundaryMatch = line.match(/^\s*-\s+id:\s*(.+)$/);
      if (boundaryMatch) {
        if (!result.boundaries) result.boundaries = [];
        const bId = unescapeYamlValue(boundaryMatch[1].trim().replace(/^"|"$/g, ''));
        result.boundaries.push({ id: bId, label: '', nodeIds: [] });
        continue;
      }
      if (result.boundaries && result.boundaries.length > 0) {
        const b = result.boundaries[result.boundaries.length - 1];
        const labelMatch = line.match(/^\s+label:\s*(.+)$/);
        const noteMatch = line.match(/^\s+note:\s*(.+)$/);
        const nodeIdsMatch = line.match(/^\s+nodeIds:\s*\[(.+)\]$/);
        if (labelMatch) {
          const rawV = labelMatch[1].trim();
          b.label = rawV.startsWith('"') && rawV.endsWith('"')
            ? unescapeYamlValue(rawV.slice(1, -1))
            : rawV.replace(/^['"]|['"]$/g, '');
        } else if (noteMatch) {
          const rawV = noteMatch[1].trim();
          b.note = rawV.startsWith('"') && rawV.endsWith('"')
            ? unescapeYamlValue(rawV.slice(1, -1))
            : rawV.replace(/^['"]|['"]$/g, '');
        } else if (nodeIdsMatch) {
          b.nodeIds = nodeIdsMatch[1].split(',').map(s => {
            const id = s.trim();
            return (id.startsWith('"') && id.endsWith('"')) ? id.slice(1, -1) : id;
          });
        }
      }
    }

    // Phase A: 自主连线列表项解析
    if (inConnections) {
      const connIdMatch = line.match(/^\s*-\s+id:\s*(.+)$/);
      if (connIdMatch) {
        if (!result.connections) result.connections = [];
        const cId = unescapeYamlValue(connIdMatch[1].trim().replace(/^"|"$/g, ''));
        result.connections.push({ id: cId, sourceId: '', targetId: '', label: '' });
        continue;
      }
      if (result.connections && result.connections.length > 0) {
        const c = result.connections[result.connections.length - 1];
        const fieldMatch = line.match(/^\s+(\w+):\s*(.+)$/);
        if (fieldMatch) {
          const field = fieldMatch[1];
          const rawV = fieldMatch[2].trim();
          const val = rawV.startsWith('"') && rawV.endsWith('"')
            ? unescapeYamlValue(rawV.slice(1, -1))
            : rawV.replace(/^['"]|['"]$/g, '');
          if (field === 'sourceId') c.sourceId = val;
          else if (field === 'targetId') c.targetId = val;
          else if (field === 'label') c.label = val;
          else if (field === 'note') c.note = val;
        }
      }
      continue;
    }

    if (inNodes) {
      // 列表项开头（可能有缩进：`  - id: xxx`）
      const listItemMatch = line.match(/^\s*-\s+(.+)$/);
      if (listItemMatch) {
        // 先保存上一个节点
        if (currentNode && currentNode.id) {
          nodes.push(currentNode as FreeNodeRecord);
        }
        currentNode = {};
        // 解析 `- id: "xxx"` 格式
        const rest = listItemMatch[1];
        const fieldMatch = rest.match(/^(\w+):\s*(.*)$/);
        if (fieldMatch) {
          setNodeField(currentNode, fieldMatch[1], fieldMatch[2]);
        }
      } else if (currentNode) {
        // 节点字段续行（缩进的 `  parentId: xxx`）
        const fieldMatch = line.match(/^\s+(\w+):\s*(.*)$/);
        if (fieldMatch) {
          setNodeField(currentNode, fieldMatch[1], fieldMatch[2]);
        }
      }
    }
  }

  // 保存最后一个节点
  if (currentNode && currentNode.id) {
    nodes.push(currentNode as FreeNodeRecord);
  }

  if (nodes.length > 0) result.nodes = nodes;
  return result;
}

/** 反转义 YAML 双引号字符串中的转义序列
 *
 * H1 修复: 用单次正则遍历替代链式 replace，避免顺序依赖。
 * 例如 `a\nb` 原意为 `a` + `\` + `n` + `b`，链式 replace 会错误转为换行。
 */
function unescapeYamlValue(value: string): string {
  return value.replace(/\\(n|r|t|"|\\)/g, (_, ch) => {
    switch (ch) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case '"': return '"';
      case '\\': return '\\';
    }
    return _;
  });
}

/** 设置节点字段（处理引号、转义和 null） */
function setNodeField(node: Partial<FreeNodeRecord>, key: string, rawValue: string): void {
  // P0-3: 去除引号并反转义特殊字符
  let value = rawValue.trim();
  const isQuoted = value.startsWith('"') && value.endsWith('"');
  if (isQuoted) {
    value = unescapeYamlValue(value.slice(1, -1));
  } else {
    // 单引号字符串
    value = value.replace(/^['"]|['"]$/g, '');
  }
  value = value.trim();

  if (value === 'null' || value === '~') {
    (node as Record<string, unknown>)[key] = null;
    return;
  }
  if (key === 'collapsed') {
    (node as Record<string, unknown>)[key] = value === 'true';
    return;
  }
  (node as Record<string, unknown>)[key] = value;
}

// ═══════════════════════════════════════════════════════
// YAML 序列化（轻量级）
// ═══════════════════════════════════════════════════════

/** 转义 YAML 字符串值 */
function yamlString(value: string): string {
  // 如果包含特殊字符（含换行），用双引号包裹并转义
  if (/[:#\[\]{}&*!|>'"%@`\n]/.test(value)) {
    return `"${value
      .replace(/\\/g, '\\\\')  // 反斜杠先转义
      .replace(/"/g, '\\"')    // 双引号转义
      .replace(/\n/g, '\\n')   // P0-3: 换行符转义
      .replace(/\r/g, '\\r')   // 回车符转义
      .replace(/\t/g, '\\t')   // 制表符转义
    }"`;
  }
  return value;
}

/**
 * 将 MindmapFrontmatter 序列化为 YAML 行（mindmap: 段内容，含缩进）
 */
function serializeMindmap(meta: MindmapMeta, nodes: FreeNodeRecord[]): string {
  const lines: string[] = [];
  lines.push('mindmap:');
  lines.push(`  structureType: ${meta.structureType}`);
  lines.push(`  layout: ${meta.layout ?? DEFAULT_LAYOUT_TYPE}`);

  // M2: 序列化外框
  if (meta.boundaries && meta.boundaries.length > 0) {
    lines.push('  boundaries:');
    for (const b of meta.boundaries) {
      lines.push(`    - id: ${yamlString(b.id)}`);
      lines.push(`      label: ${yamlString(b.label)}`);
      if (b.note) {
        lines.push(`      note: ${yamlString(b.note)}`);
      }
      lines.push(`      nodeIds: [${b.nodeIds.map(id => yamlString(id)).join(', ')}]`);
    }
  }

  // Phase A: 序列化自主连线
  if (meta.connections && meta.connections.length > 0) {
    lines.push('  connections:');
    for (const c of meta.connections) {
      lines.push(`    - id: ${yamlString(c.id)}`);
      lines.push(`      sourceId: ${yamlString(c.sourceId)}`);
      lines.push(`      targetId: ${yamlString(c.targetId)}`);
      lines.push(`      label: ${yamlString(c.label)}`);
      if (c.note) {
        lines.push(`      note: ${yamlString(c.note)}`);
      }
    }
  }

  if (nodes.length > 0) {
    lines.push('  nodes:');
    for (const node of nodes) {
      lines.push(`    - id: ${yamlString(node.id)}`);
      lines.push(`      parentId: ${node.parentId ? yamlString(node.parentId) : 'null'}`);
      lines.push(`      text: ${yamlString(node.text)}`);
      // Phase 3: type 字段（仅 annotation 写入，free 省略保持向后兼容）
      if (node.type === 'annotation') {
        lines.push(`      type: annotation`);
      }
      if (node.note) {
        lines.push(`      note: ${yamlString(node.note)}`);
      }
      if (node.collapsed) {
        lines.push(`      collapsed: true`);
      }
      // Phase 3: annotation 专用字段
      if (node.annotationRef) {
        lines.push(`      annotationRef: ${yamlString(node.annotationRef)}`);
      }
      if (node.annotationSummary) {
        lines.push(`      annotationSummary: ${yamlString(node.annotationSummary)}`);
      }
      // 父子连线语义标注
      if (node.edgeLabel) {
        lines.push(`      edgeLabel: ${yamlString(node.edgeLabel)}`);
      }
      if (node.edgeNote) {
        lines.push(`      edgeNote: ${yamlString(node.edgeNote)}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * 将 mindmap 段写入文件 frontmatter
 * 保留原有其他 frontmatter 字段和正文
 */
export function writeMindmapFrontmatter(
  content: string,
  meta: MindmapMeta,
  freeNodes: FreeNodeRecord[],
): string {
  const { frontmatter, body } = splitFile(content);
  const mindmapYaml = serializeMindmap(meta, freeNodes);

  if (!frontmatter) {
    // 无 frontmatter → 新建
    return joinFile(mindmapYaml, body);
  }

  // 有 frontmatter → 替换或追加 mindmap 段
  const lines = frontmatter.split('\n');
  const result: string[] = [];
  let i = 0;
  let mindmapReplaced = false;

  while (i < lines.length) {
    const line = lines[i];
    const mindmapMatch = line.match(/^(\s*)mindmap:\s*$/);

    if (mindmapMatch) {
      // 找到 mindmap 段 → 替换
      const indent = mindmapMatch[1].length;
      result.push(`${' '.repeat(indent)}mindmap:`);

      // 写入新的 mindmap 内容（缩进对齐）
      for (const yamlLine of mindmapYaml.split('\n').slice(1)) {
        result.push(`${' '.repeat(indent)}${yamlLine}`);
      }

      // 跳过旧的 mindmap 段
      i++;
      while (i < lines.length) {
        const leadingSpaces = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
        if (lines[i].trim() === '') {
          i++;
          continue;
        }
        if (leadingSpaces <= indent) break;
        i++;
      }
      mindmapReplaced = true;
    } else {
      result.push(line);
      i++;
    }
  }

  if (!mindmapReplaced) {
    // 没有 mindmap 段 → 追加
    result.push('');
    result.push(mindmapYaml);
  }

  return joinFile(result.join('\n'), body);
}

// ═══════════════════════════════════════════════════════
// 高级 API：与 MindNode 树交互
// ═══════════════════════════════════════════════════════

/**
 * 从 MindNode 树中提取所有用户节点记录（free + annotation）
 *
 * Phase 3: 泛化 — 不再只提取 'free'，而是提取所有非 md-seed 节点。
 * 旧名称保留为别名。
 */
export function extractFreeNodes(roots: MindNode[]): FreeNodeRecord[] {
  const records: FreeNodeRecord[] = [];

  function walk(node: MindNode): void {
    // Phase 3: 提取 free + annotation（不提取 md-seed）
    if (node.type === 'free' || node.type === 'annotation') {
      records.push(toFreeNodeRecord(node));
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return records;
}

/**
 * 将 Free 节点记录合并到 MD-Seed 树中
 *
 * 策略：遍历 Free 节点，按 parentId 挂载到对应 MD-Seed 节点下。
 * 如果 parentId 为 null → 作为顶层根节点。
 * 如果 parentId 对应的节点不存在 → 保留为孤儿节点（挂载到根）。
 *
 * @param seedRoots MD-Seed 解析出的根节点数组
 * @param freeRecords frontmatter 中的 Free 节点记录
 * @returns 合并后的根节点数组
 */
export function mergeFreeNodes(seedRoots: MindNode[], freeRecords: FreeNodeRecord[]): MindNode[] {
  if (freeRecords.length === 0) return seedRoots;

  // 构建节点 ID → 节点引用 的索引
  const nodeIndex = new Map<string, MindNode>();
  for (const root of seedRoots) {
    indexNodes(root, nodeIndex);
  }

  // 创建 Free 节点并挂载
  // P0 修复: Free→Free 嵌套 — 创建后也加入 nodeIndex, 后续 Free 节点可查找它作为 parent
  const orphanFreeNodes: MindNode[] = [];
  for (const record of freeRecords) {
    const freeNode = fromFreeNodeRecord(record);

    if (record.parentId === null) {
      orphanFreeNodes.push(freeNode);
      // 即使是孤儿也加入索引, 其他 Free 节点可能挂到它下面
      nodeIndex.set(freeNode.id, freeNode);
      continue;
    }

    const parent = nodeIndex.get(record.parentId);
    if (parent) {
      parent.children.push(freeNode);
      freeNode.parentId = parent.id;
      // P0 修复: 新创建的 Free 节点也加入索引
      nodeIndex.set(freeNode.id, freeNode);
    } else {
      // parentId 对应的节点不存在（可能 MD 已编辑删除）→ 挂到根
      orphanFreeNodes.push(freeNode);
      nodeIndex.set(freeNode.id, freeNode);
    }
  }

  // 孤儿 Free 节点作为根级别的节点
  return [...seedRoots, ...orphanFreeNodes];
}

/** 递归索引节点 */
function indexNodes(node: MindNode, index: Map<string, MindNode>): void {
  index.set(node.id, node);
  for (const child of node.children) {
    indexNodes(child, index);
  }
}

/**
 * 从文件内容中读取完整的导图配置
 */
export function readMindmapConfig(content: string): {
  meta: MindmapMeta;
  freeRecords: FreeNodeRecord[];
} {
  const fm = parseMindmapFrontmatter(content);
  return {
    meta: {
      structureType: fm?.structureType ?? DEFAULT_STRUCTURE_TYPE,
      layout: fm?.layout ?? DEFAULT_LAYOUT_TYPE,
      // M2: 从 frontmatter 恢复外框
      boundaries: fm?.boundaries ?? [],
      // Phase A: 从 frontmatter 恢复自主连线
      connections: fm?.connections ?? [],
    },
    freeRecords: fm?.nodes ?? [],
  };
}

/**
 * 将导图配置写入文件内容
 */
export function writeMindmapConfig(
  content: string,
  meta: MindmapMeta,
  roots: MindNode[],
): string {
  const freeRecords = extractFreeNodes(roots);
  return writeMindmapFrontmatter(content, meta, freeRecords);
}
