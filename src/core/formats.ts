/**
 * 导入导出格式的**元数据** (纯数据, 零 Node 依赖).
 *
 * 为什么单独一个文件: 设置页要渲染格式下拉框, 只需要这份清单;
 * 而真正的解析/生成在 ./portable.ts 里 (用了 node:crypto)。
 * 如果 UI 直接从 portable.ts 取 FORMATS, Vite 会把 node:crypto 打进前端产物,
 * 违反本项目「前端零 Node API」的硬约束 (见 docs/OPENSOURCE_REFS.md §2)。
 */

export type FormatId =
  | "aegis-json"
  | "bitwarden-json"
  | "bitwarden-csv"
  | "keepass-xml"
  | "keepass-csv"
  | "lastpass-csv"
  | "chrome-csv"
  | "plain-csv";

export interface FormatInfo {
  id: FormatId;
  /** 显示名 */
  label: string;
  /** 归属工具 */
  source: string;
  ext: string;
  /** in = 只能导入, out = 只能导出, both = 双向 */
  dir: "in" | "out" | "both";
  /** 是否明文（导出时需二次确认） */
  plaintext: boolean;
}

export const FORMATS: FormatInfo[] = [
  { id: "aegis-json", label: "神盾可移植 JSON", source: "神盾 Aegis", ext: "json", dir: "both", plaintext: true },
  { id: "bitwarden-json", label: "Bitwarden JSON (未加密)", source: "Bitwarden", ext: "json", dir: "both", plaintext: true },
  { id: "bitwarden-csv", label: "Bitwarden CSV", source: "Bitwarden", ext: "csv", dir: "both", plaintext: true },
  { id: "keepass-xml", label: "KeePass 2 XML", source: "KeePass / KeePassXC", ext: "xml", dir: "both", plaintext: true },
  { id: "keepass-csv", label: "KeePass 2 CSV", source: "KeePass / KeePassXC", ext: "csv", dir: "both", plaintext: true },
  { id: "lastpass-csv", label: "LastPass CSV", source: "LastPass", ext: "csv", dir: "in", plaintext: true },
  { id: "chrome-csv", label: "Chrome / Edge CSV", source: "Chrome / Edge / Safari", ext: "csv", dir: "both", plaintext: true },
  { id: "plain-csv", label: "通用明文 CSV", source: "神盾 Aegis", ext: "csv", dir: "both", plaintext: true },
];

export function formatInfo(id: FormatId): FormatInfo {
  const f = FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`未知格式: ${id}`);
  return f;
}
