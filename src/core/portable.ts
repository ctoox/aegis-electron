/**
 * 可移植数据层: 导入 / 导出各家密码管理器格式.
 *
 * 支持 (规格详见 docs/OPENSOURCE_FEATURES.md):
 *   读  aegis-portable JSON / Bitwarden JSON / Bitwarden CSV / KeePass 2 XML
 *       KeePass 2 CSV (KeePassXC) / LastPass CSV / Chrome·Edge CSV / 通用明文 CSV
 *   写  上述除 LastPass 外的全部 (LastPass 官方无导入器, 仅供读)
 *
 * 设计:
 *   - CSV 用自己写的 RFC 4180 解析器 (引号转义 / 内嵌换行 / CRLF / BOM)
 *   - KeePass XML 用极简 DOM 解析器 (够用即可, 不做 DTD / 外部实体 → 无 XXE 风险)
 *   - CSV 一律走**表头别名映射**, 而不是按列序读 —— 各家列序不同且会变
 *   - 分组信息落在 entry.extra.group, 自定义字段落在 entry.extra["field:名称"],
 *     保证「导入再导出」不丢结构
 *
 * **零 Node 依赖**: 随机 id 用 globalThis.crypto (浏览器与 Node 19+ 都有),
 * base64 自己编码, 不碰 Buffer —— 这样渲染层 import 本模块也不会把 node:* 打进产物
 * (约束见 docs/OPENSOURCE_REFS.md §2「前端零 Node API」)。
 * 格式清单等纯数据另放在 ./formats.ts, 两边各自取用。
 */
import type { Entry, EntryType } from "./types";
import { FORMATS, formatInfo, type FormatId, type FormatInfo } from "./formats";

// 既有调用点 (main/index.ts、tests) 一直是从本文件取这些名字, 继续 re-export
export { FORMATS, formatInfo };
export type { FormatId, FormatInfo };

// ============================================================ CSV

/** RFC 4180 解析: 处理 BOM / 双引号转义 / 引号内逗号与换行 / CRLF */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvCell(v: string): string {
  const s = v ?? "";
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ============================================================ 极简 XML

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const n = Number.parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    switch (ent) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return " ";
      default: return whole;
    }
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

/**
 * 极简 XML → DOM. 只支持元素/属性/文本/CDATA/注释, 够解析 KeePass 导出文件.
 * 刻意**不实现** DOCTYPE 与外部实体 → 天然免疫 XXE.
 * 注释与处理指令 (<?xml ...?>, <!DOCTYPE ...>) 直接跳过.
 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) break;
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith("/")) {
      const tag = inner.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClose = inner.endsWith("/");
    const body = (selfClose ? inner.slice(0, -1) : inner).trim();
    const sp = body.search(/[\s/]/);
    const tag = sp < 0 ? body : body.slice(0, sp);
    if (!tag) continue;
    const node: XmlNode = {
      tag,
      attrs: sp < 0 ? {} : parseAttrs(body.slice(sp)),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function xmlEscape(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ============================================================ 字段归一化

/** CSV 表头别名表 (全部小写比较; 覆盖 Bitwarden / KeePass / LastPass / Chrome / 中文) */
const ALIASES: Record<string, string[]> = {
  title: ["title", "name", "account", "item name", "entry name", "标题", "名称", "条目名称"],
  username: ["username", "user name", "user", "login", "login_username", "login name", "用户名", "账号", "账户"],
  password: ["password", "pass", "pwd", "passwd", "login_password", "密码"],
  url: ["url", "uri", "login_uri", "website", "web site", "web address", "link", "网址", "链接"],
  notes: ["notes", "note", "comment", "comments", "extra", "备注", "注释", "说明"],
  totp: ["totp", "otp", "login_totp", "one-time password", "authenticator key", "otpauth", "两步验证", "动态口令"],
  group: ["folder", "group", "grouping", "category", "folder name", "分组", "文件夹"],
  favorite: ["favorite", "fav", "starred", "收藏"],
  type: ["type", "kind", "类型"],
  created: ["created", "created at", "created time", "creation time", "createdate", "创建时间"],
  modified: ["last modified", "modified", "modification time", "updated", "updated at", "更新时间", "最后修改"],
  fields: ["fields", "custom fields", "自定义字段"],
};

function buildHeaderMap(header: string[]): Map<number, string> {
  const map = new Map<number, string>();
  header.forEach((raw, idx) => {
    const h = raw.trim().toLowerCase();
    for (const [canon, list] of Object.entries(ALIASES)) {
      if (list.includes(h)) {
        if (![...map.values()].includes(canon)) map.set(idx, canon);
        return;
      }
    }
  });
  return map;
}

/** `otpauth://totp/Label?secret=XXX&...` → `XXX`; 已是裸 Base32 就原样返回 */
export function normalizeTotp(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const sec = u.searchParams.get("secret");
      if (sec) return sec.trim().toUpperCase();
    } catch {
      const m = /[?&]secret=([^&]+)/i.exec(s);
      if (m) return decodeURIComponent(m[1]).trim().toUpperCase();
    }
    return "";
  }
  return s;
}

function parseTime(v: string | undefined, dflt: number): number {
  const s = (v ?? "").trim();
  if (!s) return dflt;
  // Bitwarden/KeePass 常见 "2026-01-02 03:04:05" (本地时区) 与 ISO 8601
  const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(" ", "T") : s;
  const t = Date.parse(norm);
  if (Number.isFinite(t)) return t;
  const n = Number(s);
  return Number.isFinite(n) && n > 1e11 ? n : dflt;
}

function parseFavorite(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "是" || s === "★";
}

function mapType(v: string | undefined): EntryType {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "note" || s === "secure note" || s === "securenote" || s === "2" || s === "笔记") return "note";
  if (s === "card" || s === "credit card" || s === "3" || s === "银行卡") return "bank";
  if (s === "identity" || s === "4" || s === "身份") return "id";
  return "login";
}

/** Bitwarden CSV `fields` 列 → extra: 多行 `名称: 值` */
function parseBitwardenFields(raw: string, extra: Record<string, string>): void {
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) extra[`field:${k}`] = v;
  }
}

/**
 * 生成条目 id. 用平台自带的 randomUUID (浏览器 / Node 19+ 都有),
 * 没有就退回 Math.random 版本 —— 这里只是**导入阶段的临时标识**:
 * 提交入库时主进程会丢掉它, 由 VaultStore 重新发正式 UUID。
 */
function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") return g.crypto.randomUUID();
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
    else if (i === 14) s += "4";
    else s += h[Math.floor(Math.random() * 16)];
  }
  return s;
}

function makeEntry(fields: Partial<Entry> & { extra?: Record<string, string> }): Entry {
  const now = Date.now();
  return {
    id: newId(),
    type: fields.type ?? "login",
    title: (fields.title ?? "").trim(),
    username: fields.username ?? "",
    password: fields.password ?? "",
    url: (fields.url ?? "").trim(),
    notes: fields.notes ?? "",
    favorite: fields.favorite ?? false,
    created_at: fields.created_at ?? now,
    updated_at: fields.updated_at ?? fields.created_at ?? now,
    extra: fields.extra ?? {},
  };
}

// ============================================================ 导入

export interface ImportPreview {
  format: FormatId;
  label: string;
  entries: Entry[];
  /** 逐条问题 (跳过某行 / 字段缺失), 用于 UI 展示 */
  warnings: string[];
  /** 源文件里读到的分组名 (去重), 仅展示用 */
  groups: string[];
}

/** 识别文本属于哪种格式 */
export function detectFormat(text: string): FormatId | null {
  const head = text.slice(0, 4096).trimStart();
  if (!head) return null;

  if (head.startsWith("{")) {
    try {
      const doc = JSON.parse(text);
      if (doc?.format === "aegis-vault") return null; // 加密库文件, 不是可移植格式
      if (doc?.format === "aegis-portable") return "aegis-json";
      if (Array.isArray(doc?.entries) && doc?.format === undefined) return "aegis-json";
      if (Array.isArray(doc?.items)) return "bitwarden-json";
      // 加密导出也归到 bitwarden-json, 让 fromBitwardenJson 抛出「请在 Bitwarden 里导未加密格式」的针对性错误
      if (doc?.encrypted === true) return "bitwarden-json";
    } catch {
      return null;
    }
    return null;
  }

  if (head.startsWith("<")) {
    if (/<KeePassFile[\s>]/i.test(head)) return "keepass-xml";
    return null;
  }

  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  if (header.length === 0) return null;
  const has = (k: string) => header.includes(k);
  if (has("login_password") || has("login_uri")) return "bitwarden-csv";
  if (has("grouping")) return "lastpass-csv";
  // KeePass 2 CSV 的特征是 Icon / Last Modified 列 (通用 CSV 没有)
  if (has("title") && has("username") && (has("icon") || has("last modified"))) return "keepass-csv";
  if (has("name") && has("url") && has("username")) return "chrome-csv";
  if (has("title") && has("username") && has("password")) return "plain-csv";
  // 兜底: 表头能对上 ≥2 个已知字段(且含标题/用户名/密码之一)就按通用明文 CSV 收,
  // 这样缺密码列、列序古怪或有额外列的导出文件也能进来 (由 fromCsv 给出警告)
  const mapped = new Set(buildHeaderMap(rows[0] ?? []).values());
  if (mapped.size >= 2 && (mapped.has("title") || mapped.has("username") || mapped.has("password"))) {
    return "plain-csv";
  }
  return null;
}

/** 统一入口: 按格式解析. format 为 null 时自动识别. */
export function parseImport(text: string, format?: FormatId | null): ImportPreview {
  const id = format ?? detectFormat(text);
  if (!id) {
    if (text.includes('"aegis-vault"')) {
      throw new Error(
        "这是神盾的加密库文件（aegis.vault.json），不是可导入的明文格式。" +
          "要恢复到新机器，请把它放回数据目录再解锁；要迁移条目，请先用「导出」生成可移植格式。",
      );
    }
    throw new Error(
      "无法识别文件格式。支持 Bitwarden (JSON/CSV)、KeePass 2 (XML/CSV)、LastPass CSV、Chrome CSV、神盾 JSON。",
    );
  }
  switch (id) {
    case "aegis-json": return fromAegisJson(text);
    case "bitwarden-json": return fromBitwardenJson(text);
    case "keepass-xml": return fromKeepassXml(text);
    default: return fromCsv(text, id);
  }
}

function fromAegisJson(text: string): ImportPreview {
  const doc = JSON.parse(text);
  const raw = Array.isArray(doc) ? doc : doc.entries;
  if (!Array.isArray(raw)) throw new Error("神盾 JSON 缺少 entries 数组");
  const warnings: string[] = [];
  const entries: Entry[] = [];
  raw.forEach((r: any, i: number) => {
    if (!r || typeof r !== "object") {
      warnings.push(`第 ${i + 1} 条不是对象，已跳过`);
      return;
    }
    if (!r.title && !r.username && !r.password) {
      warnings.push(`第 ${i + 1} 条无有效字段，已跳过`);
      return;
    }
    entries.push(
      makeEntry({
        type: mapType(r.type),
        title: String(r.title ?? ""),
        username: String(r.username ?? ""),
        password: String(r.password ?? ""),
        url: String(r.url ?? ""),
        notes: String(r.notes ?? ""),
        favorite: Boolean(r.favorite),
        created_at: Number(r.created_at) || undefined,
        updated_at: Number(r.updated_at) || undefined,
        extra: normalizeExtra(r.extra),
      }),
    );
  });
  return { format: "aegis-json", label: formatInfo("aegis-json").label, entries, warnings, groups: collectGroups(entries) };
}

function normalizeExtra(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    const key = k === "totp" ? "totp" : k.startsWith("field:") ? k : k;
    out[key] = String(v);
  }
  if (out.totp) {
    const t = normalizeTotp(out.totp);
    if (t) out.totp = t;
    else delete out.totp;
  }
  return out;
}

function fromBitwardenJson(text: string): ImportPreview {
  const doc = JSON.parse(text);
  if (doc?.encrypted === true) {
    throw new Error("这是 Bitwarden 的加密导出，无法直接读取。请在 Bitwarden 里导出为「.json（未加密）」或 CSV。");
  }
  const items: any[] = Array.isArray(doc?.items) ? doc.items : [];
  const folderName = new Map<string, string>();
  for (const f of doc?.folders ?? []) if (f?.id) folderName.set(String(f.id), String(f.name ?? ""));

  const warnings: string[] = [];
  const entries: Entry[] = [];
  const skipped: Record<string, number> = {};

  for (const it of items) {
    const t = Number(it?.type);
    if (t !== 1 && t !== 2) {
      const k = t === 3 ? "银行卡" : t === 4 ? "身份" : `类型 ${it?.type}`;
      skipped[k] = (skipped[k] ?? 0) + 1;
      continue;
    }
    const extra: Record<string, string> = {};
    const g = folderName.get(String(it?.folderId ?? ""));
    if (g) extra.group = g;
    const totp = normalizeTotp(String(it?.login?.totp ?? ""));
    if (totp) extra.totp = totp;
    for (const f of it?.fields ?? []) {
      if (f?.name) extra[`field:${String(f.name)}`] = String(f.value ?? "");
    }
    const uri = it?.login?.uris?.[0]?.uri ?? "";
    entries.push(
      makeEntry({
        type: t === 2 ? "note" : "login",
        title: String(it?.name ?? ""),
        username: String(it?.login?.username ?? ""),
        password: String(it?.login?.password ?? ""),
        url: String(uri ?? ""),
        notes: String(it?.notes ?? ""),
        favorite: Boolean(it?.favorite),
        created_at: parseTime(it?.creationDate, Date.now()),
        updated_at: parseTime(it?.revisionDate, Date.now()),
        extra,
      }),
    );
  }
  for (const [k, n] of Object.entries(skipped)) warnings.push(`${k} × ${n} 条不在本格式支持范围，已跳过`);

  return { format: "bitwarden-json", label: formatInfo("bitwarden-json").label, entries, warnings, groups: collectGroups(entries) };
}

function fromCsv(text: string, id: FormatId): ImportPreview {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSV 是空的");
  const header = rows[0];
  const col = buildHeaderMap(header);
  const warnings: string[] = [];
  if (col.size === 0) {
    throw new Error(`表头无法识别：${header.join(", ")}。请确认导出格式，或改用通用明文 CSV（表头 Title,Username,Password,URL,Notes）。`);
  }
  const idx = (canon: string) => {
    for (const [i, c] of col) if (c === canon) return i;
    return -1;
  };
  const iTitle = idx("title");
  const iUser = idx("username");
  const iPw = idx("password");
  const iUrl = idx("url");
  const iNotes = idx("notes");
  const iTotp = idx("totp");
  const iGroup = idx("group");
  const iFav = idx("favorite");
  const iType = idx("type");
  const iCreated = idx("created");
  const iModified = idx("modified");
  const iFields = idx("fields");

  const pick = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "") : "");
  const entries: Entry[] = [];
  let blank = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !c.trim())) continue;
    const extra: Record<string, string> = {};
    const totp = normalizeTotp(pick(row, iTotp));
    if (totp) extra.totp = totp;
    const grp = pick(row, iGroup).trim();
    if (grp) extra.group = grp;
    if (iFields >= 0) parseBitwardenFields(pick(row, iFields), extra);

    const e = makeEntry({
      type: mapType(pick(row, iType)),
      title: pick(row, iTitle),
      username: pick(row, iUser),
      password: pick(row, iPw),
      url: pick(row, iUrl),
      notes: pick(row, iNotes),
      favorite: parseFavorite(pick(row, iFav)),
      created_at: parseTime(pick(row, iCreated), Date.now()),
      updated_at: parseTime(pick(row, iModified), Date.now()),
      extra,
    });
    if (!e.title && !e.username && !e.password && !e.url) {
      blank++;
      continue;
    }
    if (!e.title) e.title = e.url || e.username || "(无标题)";
    entries.push(e);
  }
  if (blank > 0) warnings.push(`${blank} 行内容为空，已跳过`);
  if (iPw < 0) warnings.push("表头里没有密码列，导入的条目都是空密码");
  if (entries.length === 0) throw new Error("没有解析出任何条目");

  return { format: id, label: formatInfo(id).label, entries, warnings, groups: collectGroups(entries) };
}

function fromKeepassXml(text: string): ImportPreview {
  const doc = parseXml(text);
  const file = findChild(doc, "KeePassFile");
  if (!file) throw new Error("不是 KeePass 2 XML（缺少 KeePassFile 根节点）");
  const root = findChild(file, "Root");
  if (!root) throw new Error("KeePass XML 缺少 Root 节点");

  const warnings: string[] = [];
  const entries: Entry[] = [];
  let protectedValues = 0;

  const walk = (group: XmlNode, path: string[]) => {
    const name = childText(group, "Name").trim();
    const cur = name ? [...path, name] : path;
    for (const c of group.children) {
      if (c.tag === "Entry") {
        const e = keepassEntry(c, cur, warnings);
        if (e) {
          if (e.extra?.["__protected"]) {
            protectedValues++;
            delete e.extra["__protected"];
          }
          entries.push(e);
        }
      } else if (c.tag === "Group") {
        walk(c, cur);
      } else if (c.tag === "DeletedObjects") {
        warnings.push("已跳过「回收站」里的条目");
      }
    }
  };
  walk(root, []);

  if (entries.length === 0) throw new Error("KeePass XML 里没有找到任何条目");
  if (protectedValues > 0) {
    warnings.push(`${protectedValues} 条密码是 KDBX 内部加密流（base64），需在 KeePass 里「导出为 XML」而非直接改后缀`);
  }
  return { format: "keepass-xml", label: formatInfo("keepass-xml").label, entries, warnings, groups: collectGroups(entries) };
}

function findChild(node: XmlNode, tag: string): XmlNode | null {
  for (const c of node.children) if (c.tag === tag) return c;
  return null;
}

function childText(node: XmlNode, tag: string): string {
  const c = findChild(node, tag);
  return c ? c.text : "";
}

function keepassEntry(node: XmlNode, groupPath: string[], _warnings: string[]): Entry | null {
  const vals = new Map<string, string>();
  let protectedSeen = false;
  for (const s of node.children) {
    if (s.tag !== "String") continue;
    const key = childText(s, "Key").trim();
    const vNode = findChild(s, "Value");
    if (!key || !vNode) continue;
    if (vNode.attrs?.["Protected"] === "True") protectedSeen = true;
    vals.set(key, vNode.text);
  }
  // 常见键名大小写不一 (KeePassXC 是 Title/UserName/Password/URL/Notes/otp)
  const get = (...keys: string[]) => {
    for (const k of keys) {
      for (const [vk, vv] of vals) if (vk.toLowerCase() === k.toLowerCase()) return vv;
    }
    return "";
  };

  const title = get("Title", "Name");
  const username = get("UserName", "Username", "User");
  const password = get("Password");
  const url = get("URL", "Url", "Website");
  if (!title && !username && !password && !url) return null;

  const extra: Record<string, string> = {};
  const totp = normalizeTotp(get("otp", "TOTP", "TOTP Seed", "TimeOtp-Secret-Base32"));
  if (totp) extra.totp = totp;
  if (groupPath.length) extra.group = groupPath.join("/");
  if (protectedSeen) extra["__protected"] = "1";
  // TOTP 之外的额外 String 项当作自定义字段保留 (KeePass 的备用字段)
  const known = new Set(["title", "name", "username", "user", "password", "url", "notes", "otp", "totp"]);
  for (const [k, v] of vals) {
    if (known.has(k.toLowerCase()) || !v) continue;
    extra[`field:${k}`] = v;
  }

  const times = findChild(node, "Times");
  const created = times ? parseTime(childText(times, "CreationTime"), Date.now()) : Date.now();
  const modified = times ? parseTime(childText(times, "LastModificationTime"), created) : created;

  return makeEntry({
    type: "login",
    title,
    username,
    password,
    url,
    notes: get("Notes", "Note"),
    favorite: false,
    created_at: created,
    updated_at: modified,
    extra,
  });
}

function collectGroups(entries: Entry[]): string[] {
  const s = new Set<string>();
  for (const e of entries) if (e.extra?.group) s.add(e.extra.group);
  return [...s].sort();
}

// ============================================================ 导出

export interface ExportResult {
  format: FormatId;
  label: string;
  ext: string;
  content: string;
  count: number;
}

export function buildExport(entries: Entry[], format: FormatId): ExportResult {
  const info = formatInfo(format);
  const content = EXPORTERS[format](entries);
  return { format, label: info.label, ext: info.ext, content, count: entries.length };
}

function totpOf(e: Entry): string {
  return e.extra?.totp ?? "";
}

/** 自定义字段: extra 里 `field:名称` 的部分 */
function customFields(e: Entry): [string, string][] {
  return Object.entries(e.extra ?? {})
    .filter(([k]) => k.startsWith("field:"))
    .map(([k, v]) => [k.slice(6), v] as [string, string]);
}

const EXPORTERS: Record<FormatId, (entries: Entry[]) => string> = {
  "aegis-json": (entries) =>
    JSON.stringify(
      {
        format: "aegis-portable",
        version: 1,
        generator: "神盾 Aegis (Electron)",
        exported_at: Date.now(),
        count: entries.length,
        entries,
      },
      null,
      2,
    ),

  "bitwarden-json": (entries) => {
    const folders = [...new Set(entries.map((e) => e.extra?.group).filter(Boolean))] as string[];
    const folderId = new Map<string, string>();
    folders.forEach((f, i) => folderId.set(f, `folder-${i + 1}`));
    const typeCode: Record<EntryType, number> = { login: 1, note: 2, bank: 3, id: 4 };
    return JSON.stringify(
      {
        encrypted: false,
        folders: folders.map((f) => ({ id: folderId.get(f), name: f })),
        items: entries.map((e) => ({
          id: e.id,
          organizationId: null,
          folderId: e.extra?.group ? folderId.get(e.extra.group) ?? null : null,
          type: typeCode[e.type] ?? 1,
          reprompt: 0,
          name: e.title,
          notes: e.notes || null,
          favorite: e.favorite,
          fields: customFields(e).map(([name, value]) => ({ name, value, type: 0 })),
          login:
            e.type === "login"
              ? {
                  fido2Credentials: null,
                  uris: e.url ? [{ match: null, uri: e.url }] : [],
                  username: e.username || null,
                  password: e.password || null,
                  totp: totpOf(e) || null,
                }
              : null,
          creationDate: new Date(e.created_at).toISOString(),
          revisionDate: new Date(e.updated_at).toISOString(),
        })),
      },
      null,
      2,
    );
  },

  "bitwarden-csv": (entries) => {
    const rows: string[][] = [
      ["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"],
    ];
    for (const e of entries) {
      rows.push([
        e.extra?.group ?? "",
        e.favorite ? "1" : "0",
        e.type === "note" ? "note" : "login",
        e.title,
        e.notes,
        customFields(e).map(([k, v]) => `${k}: ${v}`).join("\n"),
        "0",
        e.url,
        e.username,
        e.password,
        totpOf(e),
      ]);
    }
    return toCsv(rows);
  },

  "keepass-csv": (entries) => {
    const rows: string[][] = [
      ["Group", "Title", "Username", "Password", "URL", "Notes", "TOTP", "Icon", "Last Modified", "Created"],
    ];
    const fmt = (ts: number) => {
      const d = new Date(ts);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    for (const e of entries) {
      rows.push([
        e.extra?.group ?? "aegis",
        e.title,
        e.username,
        e.password,
        e.url,
        e.notes,
        totpOf(e),
        "0",
        fmt(e.updated_at),
        fmt(e.created_at),
      ]);
    }
    return toCsv(rows);
  },

  "chrome-csv": (entries) => {
    const rows: string[][] = [["name", "url", "username", "password", "note"]];
    for (const e of entries) rows.push([e.title, e.url, e.username, e.password, e.notes]);
    return toCsv(rows);
  },

  "lastpass-csv": (entries) => {
    // LastPass 只有导入器, 但还是给一个同构输出便于互转
    const rows: string[][] = [["url", "username", "password", "totp", "extra", "name", "grouping", "fav"]];
    for (const e of entries) {
      rows.push([e.url, e.username, e.password, totpOf(e), e.notes, e.title, e.extra?.group ?? "", e.favorite ? "1" : "0"]);
    }
    return toCsv(rows);
  },

  // 通用明文 CSV: 表头即别名, 再导入能被 buildHeaderMap 认回来 (含 Type → 可无损往返)
  "plain-csv": (entries) => {
    const rows: string[][] = [
      [
        "Title", "Username", "Password", "URL", "Notes",
        "TOTP", "Group", "Favorite", "Type", "Created", "Modified",
      ],
    ];
    for (const e of entries) {
      rows.push([
        e.title,
        e.username,
        e.password,
        e.url,
        e.notes,
        totpOf(e),
        e.extra?.group ?? "",
        e.favorite ? "1" : "0",
        e.type,
        new Date(e.created_at).toISOString(),
        new Date(e.updated_at).toISOString(),
      ]);
    }
    return toCsv(rows);
  },

  "keepass-xml": (entries) => {
    const root: GroupNode = { name: "aegis", children: new Map(), entries: [] };
    for (const e of entries) {
      const g = e.extra?.group;
      if (!g) {
        // 没有分组信息的条目直接挂在根组下
        root.entries.push(e);
        continue;
      }
      // 分组路径可能形如 "工作/生产环境" 或 LastPass 的 "工作\\生产环境"
      let node = root;
      for (const p of g.split(/[\\/]+/).filter(Boolean)) {
        let c = node.children.get(p);
        if (!c) {
          c = { name: p, children: new Map(), entries: [] };
          node.children.set(p, c);
        }
        node = c;
      }
      node.entries.push(e);
    }
    // 关键: 不能把整棵树包在一个合成的根组里 —— 那样再导入时会凭空多出一层
    // 分组 ("aegis/工作/生产环境")。KeePass 要求 Root 下至少有一个 Group,
    // 所以只有存在"无分组"条目时才补一个「未分组」组, 顶层分组直接挂在 Root 下。
    const chunks: string[] = [];
    if (root.entries.length > 0) {
      chunks.push(
        renderGroup({ name: "未分组", children: new Map<string, GroupNode>(), entries: root.entries }, 1),
      );
    }
    for (const c of root.children.values()) chunks.push(renderGroup(c, 1));
    const body = chunks.join("\n");
    return [
      '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
      "<KeePassFile>",
      "\t<Meta>",
      "\t\t<Generator>神盾 Aegis</Generator>",
      `\t\t<DatabaseName>神盾 Aegis 导出 ${new Date().toISOString()}</DatabaseName>`,
      "\t\t<DatabaseDescription>由 神盾 Aegis (Electron) 导出</DatabaseDescription>",
      "\t</Meta>",
      "\t<Root>",
      body,
      "\t</Root>",
      "</KeePassFile>",
      "",
    ].join("\n");
  },
};

interface GroupNode {
  name: string;
  children: Map<string, GroupNode>;
  entries: Entry[];
}

function renderGroup(g: GroupNode, depth: number): string {
  const t = "\t".repeat(depth);
  const out: string[] = [`${t}<Group>`, `${t}\t<Name>${xmlEscape(g.name)}</Name>`];
  for (const e of g.entries) out.push(renderEntry(e, depth + 1));
  for (const c of g.children.values()) out.push(renderGroup(c, depth + 1));
  out.push(`${t}</Group>`);
  return out.join("\n");
}

function renderEntry(e: Entry, depth: number): string {
  const t = "\t".repeat(depth);
  const s = (key: string, value: string, protect = false) =>
    [
      `${t}\t<String${protect ? ' Protected="True"' : ""}>`,
      `${t}\t\t<Key>${xmlEscape(key)}</Key>`,
      `${t}\t\t<Value>${xmlEscape(value)}</Value>`,
      `${t}\t</String>`,
    ].join("\n");
  const iso = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
  const parts = [`${t}<Entry>`];
  parts.push(`${t}\t<UUID>${uuidBase64(e.id)}</UUID>`);
  if (e.title) parts.push(s("Title", e.title));
  if (e.username) parts.push(s("UserName", e.username));
  if (e.password) parts.push(s("Password", e.password, true));
  if (e.url) parts.push(s("URL", e.url));
  if (e.notes) parts.push(s("Notes", e.notes));
  const totp = e.extra?.totp;
  if (totp) parts.push(s("otp", totp));
  for (const [k, v] of Object.entries(e.extra ?? {})) {
    if (!k.startsWith("field:")) continue; // 自定义字段写回 String 节点
    parts.push(s(k.slice(6), v));
  }
  parts.push(
    [
      `${t}\t<Times>`,
      `${t}\t\t<CreationTime>${iso(e.created_at)}</CreationTime>`,
      `${t}\t\t<LastModificationTime>${iso(e.updated_at)}</LastModificationTime>`,
      `${t}\t</Times>`,
    ].join("\n"),
  );
  parts.push(`${t}</Entry>`);
  return parts.join("\n");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 纯 TS 的 hex → base64 (不用 Buffer, 保持本模块零 Node 依赖) */
function hexToBase64(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16) & 0xff);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

/** KeePass 的 UUID 是 16 字节 base64; 用条目 id 的第一个 UUID 段转出来 */
function uuidBase64(id: string): string {
  const hex = id.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
  return hexToBase64(hex);
}

/** 建议文件名 (渲染层拿去做默认值) */
export function suggestFileName(format: FormatId, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  return `aegis-${format}-${stamp}.${formatInfo(format).ext}`;
}
