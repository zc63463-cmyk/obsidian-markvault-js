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
   * 1. TextEncoder 将字符串转为 UTF-8 字节数组
   * 2. 逐字节转成二进制字符串
   * 3. btoa 生成 Base64
   * 4. + → -, / → _, 去掉 = 填充
   */
  static encodeFilePath(filePath: string): string {
    const bytes = new TextEncoder().encode(filePath);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * 将 Base64URL 编码的字符串解码为原始文件路径。
   *
   * 步骤：
   * 1. 补回 = 填充
   * 2. _ → /, - → +
   * 3. atob 解码为二进制字符串
   * 4. 逐字节转为 Uint8Array
   * 5. TextDecoder 还原 UTF-8 字符串
   */
  static decodeFilePath(encoded: string): string {
    // 补回 Base64 填充（长度必须是 4 的倍数）
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (base64.length % 4)) % 4;
    base64 += '='.repeat(padding);

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  /**
   * 获取分片 JSON 文件的完整相对路径（相对于插件根目录）。
   *
   * @param baseDir 插件目录路径（如 .obsidian/plugins/markvault-js）
   * @param filePath 源文件路径（如 notes/Hello.md）
   * @returns 分片文件路径（如 .obsidian/plugins/markvault-js/annotations/bm90ZXMvSGVsbG8.json）
   */
  static getShardPath(baseDir: string, filePath: string): string {
    return `${baseDir}/annotations/${FileEncoder.encodeFilePath(filePath)}.json`;
  }
}
