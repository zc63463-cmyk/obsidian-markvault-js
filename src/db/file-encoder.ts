/**
 * FileEncoder — 文件路径与分片 JSON 文件名之间的双向编码
 *
 * 使用 Base64URL 编码（URL-safe Base64）将任意文件路径（包括中文路径）
 * 转换为安全的文件名，作为分片 JSON 的文件名。
 */
export class FileEncoder {
  /**
   * 将文件路径编码为 Base64URL 字符串，用作分片文件名。
   *
   * 步骤：
   * 1. encodeURIComponent 处理 Unicode
   * 2. unescape 将 %XX 序列还原为原始字节
   * 3. btoa 生成 Base64
   * 4. + → -, / → _, 去掉 = 填充
   */
  static encodeFilePath(filePath: string): string {
    const base64 = btoa(unescape(encodeURIComponent(filePath)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * 将 Base64URL 编码的字符串解码为原始文件路径。
   *
   * 步骤：
   * 1. 补回 = 填充
   * 2. _ → /, - → +
   * 3. atob 解码
   * 4. escape + decodeURIComponent 还原 Unicode
   */
  static decodeFilePath(encoded: string): string {
    // 补回 Base64 填充（长度必须是 4 的倍数）
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (base64.length % 4)) % 4;
    base64 += '='.repeat(padding);

    return decodeURIComponent(escape(atob(base64)));
  }

  /**
   * 获取分片 JSON 文件的完整相对路径（相对于插件根目录）。
   *
   * @param baseDir 插件目录路径（如 .obsidian/plugins/obsidian-markvault）
   * @param filePath 源文件路径（如 notes/Hello.md）
   * @returns 分片文件路径（如 .obsidian/plugins/obsidian-markvault/annotations/bm90ZXMvSGVsbG8.json）
   */
  static getShardPath(baseDir: string, filePath: string): string {
    return `${baseDir}/annotations/${FileEncoder.encodeFilePath(filePath)}.json`;
  }
}
