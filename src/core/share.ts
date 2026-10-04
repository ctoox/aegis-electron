/**
 * 神盾「加密分享包」(Share Bundle) —— **线格式与 Python 版 aegis-share v1 互通**.
 *
 * 核心思路 (信封加密的"子集授权"):
 *
 *     发送方                                    接收方
 *     -------                                   --------
 *     选中 N 条条目                              拿到 bundle.json + 分享口令
 *         |                                          |
 *         |  分享口令 --Argon2id--> 分享KEK            |
 *         |                                          |
 *     随机 DEK --+-- 用 分享KEK 包裹 --> 写入槽        |
 *                |                                   |
 *                +-- AES-256-GCM 逐条加密条目         v
 *                     (AAD 绑定 entry_id|type)   Argon2id 派生同一个 KEK
 *                                               解包 DEK -> 解密条目
 *     -------------------------------------------------------------
 *     发送方的主 DEK / 主密码 / 其余条目           接收方**永远拿不到**
 *
 * 安全性质:
 *  - **零知识**: 分享包用**独立随机 DEK**, 不复用库内 DEK, 泄露它不影响原库
 *  - **最小授权**: 只包含被选中的条目, 其余条目根本不在文件里
 *  - **可审计**: meta.title 明文可见, 接收方导入前就知道这是什么
 *  - **抗重放**: AAD 绑定 entry_id|type, 条目密文不能互换/重排
 *
 * 互通性: 为了让 Python 版导出的分享包能被这里解开 (反之亦然), 以下四项
 * 必须逐字节对齐 —— KDF 参数、AAD 字符串、b64(nonce‖ct‖tag) 合并布局、
 * UTF-8 JSON。改动任何一个都会破坏跨版本互通, 改动前请先跑 tests/share.test.ts
 * 里的跨语言往返用例。
 */
import * as crypto from "node:crypto";
import {
  deriveKekWith,
  openJson,
  sealJson,
  unwrapKeyB64,
  wrapKeyB64,
  type KdfParams,
} from "./crypto";
import type { Entry, EntryType } from "./types";

export const SHARE_FORMAT = "aegis-share";
export const SHARE_VERSION = 1;
export const MIN_SHARE_PASSWORD = 8;

/** 包裹分享 DEK 的 AAD (Python: AAD_DEK) */
const AAD_DEK = "aegis/v1/dek";

/**
 * 分享口令的 Argon2id 参数. 数值与 Python 版 SHARE_KDF_DEFAULT 完全一致,
 * 且**随包携带** —— 以后单独调参不会让旧包失效.
 *
 * 注意 parallelism 是 1 (库内是 4): Python 的分享包这么定的, 对齐它才能互通.
 */
export const SHARE_KDF_DEFAULT = {
  time_cost: 3,
  memory_cost: 65536,
  parallelism: 1,
  hash_len: 32,
} as const;

export interface ShareMeta {
  title: string;
  /** 生成时间, **秒** (与 Python 的 int(time.time()) 对齐) */
  created_at: number;
  /** 条目数 (便于接收方不看密文就能预览) */
  entries: number;
  sender: string;
  note: string;
  hint: string;
}

export interface ShareBundle {
  format: typeof SHARE_FORMAT;
  version: number;
  meta: ShareMeta;
  kdf: { type: string; params: Record<string, number>; salt: string };
  /** b64(nonce ‖ ct ‖ tag) */
  wrapped_key: string;
  entries: { id: string; type: string; data: string }[];
  signature?: { alg: string; signer: string; value: string };
}

export class ShareError extends Error {}

// ---------------------------------------------------------------- 导出

export interface ExportOptions {
  title?: string;
  sender?: string;
  note?: string;
  hint?: string;
  kdfParams?: Record<string, number>;
}

export async function exportBundle(
  entries: Entry[],
  password: string,
  opts: ExportOptions = {},
): Promise<ShareBundle> {
  if (!entries.length) throw new ShareError("没有可分享的条目");
  if (password.length < MIN_SHARE_PASSWORD) {
    throw new ShareError(`分享口令至少 ${MIN_SHARE_PASSWORD} 位`);
  }

  const params = { ...SHARE_KDF_DEFAULT, ...(opts.kdfParams ?? {}) };
  const salt = crypto.randomBytes(16);
  const kek = await deriveKekWith(password, salt, toKdfParams(params));
  const dek = crypto.randomBytes(32); // 独立 DEK, 与主库无关

  const wrapped = wrapKeyB64(dek, kek, AAD_DEK);
  kek.fill(0); // KEK 用完立刻清; DEK 还要用来加密下面每一条, 不能清

  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    meta: {
      title: opts.title?.trim() || "神盾分享包",
      created_at: Math.floor(Date.now() / 1000),
      entries: entries.length,
      sender: opts.sender ?? "",
      note: opts.note ?? "",
      hint: opts.hint ?? "",
    },
    kdf: { type: "argon2id", params, salt: salt.toString("base64") },
    wrapped_key: wrapped,
    entries: entries.map((e) => ({
      id: e.id,
      type: e.type,
      data: sealJson(sealEntryPayload(e), dek, entryAad(e)),
    })),
  };
}

/**
 * 包内条目的载荷. 字段集与 Python 的 `Entry.to_dict()` 对齐 (id/type/…/extra/
 * created_at/updated_at), 外加可选的 history —— Python 的 from_dict 会过滤掉
 * 不认识的键, 所以多带 history 不会让旧版 Python 炸, 但能让新版本双向保真.
 */
function sealEntryPayload(e: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: e.id,
    type: e.type,
    title: e.title ?? "",
    username: e.username ?? "",
    password: e.password ?? "",
    url: e.url ?? "",
    notes: e.notes ?? "",
    favorite: !!e.favorite,
    extra: e.extra ?? {},
    created_at: e.created_at ?? 0,
    updated_at: e.updated_at ?? 0,
  };
  if (e.history?.length) out.history = e.history;
  return out;
}

function entryAad(e: Entry): string {
  return `${e.id}|${e.type}`;
}

function toKdfParams(p: Record<string, number>): KdfParams {
  return {
    memoryKiB: Number(p.memory_cost ?? SHARE_KDF_DEFAULT.memory_cost),
    iterations: Number(p.time_cost ?? SHARE_KDF_DEFAULT.time_cost),
    parallelism: Number(p.parallelism ?? SHARE_KDF_DEFAULT.parallelism),
  };
}

export function bundleToJson(bundle: ShareBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** 生成一个安全的默认文件名, 如 `aegis-share-网络设备账号-20261004.json` */
export function defaultShareFilename(title: string, now = new Date()): string {
  const safe =
    (title || "")
      .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 32) || "bundle";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `aegis-share-${safe}-${stamp}.json`;
}

// ---------------------------------------------------------------- 校验

export function validateBundle(doc: unknown): ShareBundle {
  if (!doc || typeof doc !== "object") throw new ShareError("分享包格式不正确");
  const b = doc as ShareBundle;
  if (b.format !== SHARE_FORMAT) throw new ShareError("这不是神盾分享包");
  if ((b.version ?? 0) > SHARE_VERSION) {
    throw new ShareError("分享包版本过新, 请升级神盾");
  }
  for (const key of ["kdf", "wrapped_key", "entries"] as const) {
    if (!(key in b)) throw new ShareError(`分享包缺少必要字段: ${key}`);
  }
  if (!Array.isArray(b.entries)) throw new ShareError("分享包的 entries 字段不正确");
  return b;
}

// ---------------------------------------------------------------- 预览

export interface BundleInfo {
  title: string;
  sender: string;
  note: string;
  hint: string;
  /** 秒 */
  created_at: number;
  /** 本地时间字符串, 空表示无时间 */
  createdText: string;
  entry_count: number;
  type_counts: Record<string, number>;
}

/** 读分享包的**明文**元信息 (不需要口令, 不需要密钥) */
export function describeBundle(doc: unknown): BundleInfo {
  const b = validateBundle(doc);
  const meta = (b.meta ?? {}) as Partial<ShareMeta>;
  const counts: Record<string, number> = {};
  for (const item of b.entries) {
    const t = item?.type || "unknown";
    counts[t] = (counts[t] ?? 0) + 1;
  }
  const sec = Number(meta.created_at ?? 0) || 0;
  return {
    title: meta.title ?? "",
    sender: meta.sender ?? "",
    note: meta.note ?? "",
    hint: meta.hint ?? "",
    created_at: sec,
    createdText: sec ? formatLocal(sec * 1000) : "",
    entry_count: b.entries.length,
    type_counts: counts,
  };
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** 内容指纹 (SHA-256 前 32 个十六进制字符), 不含 signature 本身.
 *  用途: 口头核对 ("我这边显示 3f9a…") 确认拿到的是同一个包。 */
export function bundleFingerprint(doc: ShareBundle): string {
  const payload: Record<string, unknown> = { ...doc };
  delete payload.signature;
  const raw = JSON.stringify(sortKeysDeep(payload));
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

/** 递归按 key 排序 —— Python 的 json.dumps(sort_keys=True) 等价物 */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep(o[k]);
        return acc;
      }, {});
  }
  return v;
}

// ---------------------------------------------------------------- 导入

export interface ShareImportResult {
  entries: Entry[];
  title: string;
  sender: string;
  note: string;
  /** 解密失败/损坏而跳过的条目数 */
  skipped: number;
  /** 因 id 冲突被改成新 id 的条目数 */
  rekeyed: number;
}

export interface ImportOptions {
  /** 目标库已有条目 id; 冲突时改发新 id (避免覆盖) */
  existingIds?: Iterable<string>;
  /** 无条件给所有条目换新 id (生成"副本"而非"更新") */
  forceNewIds?: boolean;
}

/**
 * 用分享口令解开分享包, 返回**独立的 Entry 列表**。
 *
 * 本函数不碰任何密码库文件 —— 调用方拿到 Entry 后自行决定写进哪个库.
 */
export async function importBundle(
  doc: unknown,
  password: string,
  opts: ImportOptions = {},
): Promise<ShareImportResult> {
  const b = validateBundle(doc);
  const params = (b.kdf?.params ?? SHARE_KDF_DEFAULT) as Record<string, number>;

  let dek: Buffer | null = null;
  try {
    const kek = await deriveKekWith(
      password,
      Buffer.from(String(b.kdf.salt ?? ""), "base64"),
      toKdfParams(params),
    );
    try {
      dek = unwrapKeyB64(String(b.wrapped_key), kek, AAD_DEK);
    } catch {
      throw new ShareError("分享口令错误, 或分享包被篡改");
    } finally {
      kek.fill(0);
    }

    const taken = new Set<string>(opts.existingIds ?? []);
    const result: ShareImportResult = {
      entries: [],
      title: b.meta?.title ?? "",
      sender: b.meta?.sender ?? "",
      note: b.meta?.note ?? "",
      skipped: 0,
      rekeyed: 0,
    };

    for (const item of b.entries) {
      let entry: Entry;
      try {
        const id = String(item?.id ?? "");
        const type = String(item?.type ?? "");
        if (!id || !type) throw new Error("缺 id/type");
        const raw = openJson<Record<string, unknown>>(
          String(item.data),
          dek,
          `${id}|${type}`,
        );
        entry = normalizeImported(raw, id, type);
      } catch {
        result.skipped += 1;
        continue;
      }

      if (opts.forceNewIds || taken.has(entry.id)) {
        entry.id = freshId(taken);
        result.rekeyed += 1;
      }
      taken.add(entry.id);
      result.entries.push(entry);
    }

    if (!result.entries.length && result.skipped) {
      throw new ShareError("分享包中的所有条目都已损坏, 无法导入");
    }
    return result;
  } finally {
    dek?.fill(0);
  }
}

function freshId(taken: Set<string>): string {
  let id = crypto.randomUUID();
  while (taken.has(id)) id = crypto.randomUUID();
  return id;
}

/** 把包内 JSON 收敛成我们认可的 Entry (多余字段丢掉, 缺的给默认值) */
function normalizeImported(
  raw: Record<string, unknown>,
  id: string,
  type: string,
): Entry {
  const now = Date.now();
  const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const n = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  return {
    id,
    type: (["login", "note", "bank", "id"].includes(type) ? type : "login") as EntryType,
    title: s(raw.title),
    username: s(raw.username),
    password: s(raw.password),
    url: s(raw.url),
    notes: s(raw.notes),
    favorite: !!raw.favorite,
    extra: (raw.extra && typeof raw.extra === "object"
      ? (raw.extra as Record<string, string>)
      : {}),
    created_at: n(raw.created_at, now),
    updated_at: n(raw.updated_at, now),
    ...(Array.isArray(raw.history)
      ? { history: raw.history as Entry["history"] }
      : {}),
  };
}

// ---------------------------------------------------------------- 可选: 来源签名

/**
 * 用 `secret` 给分享包加上来源证明 (HMAC-SHA256), 返回新对象。
 *
 * 这是**对称**签名: 只有同样知道 `secret` 的人能验证。适合"团队共享一个
 * 校验口令"的场景 (证明包没被中间人替换)。对机密性不是必需的 ——
 * 机密性由分享口令保证。
 */
export function signBundle(
  doc: ShareBundle,
  secret: string,
  signer = "",
): ShareBundle {
  const value = crypto
    .createHmac("sha256", secret)
    .update(bundleFingerprint(doc), "ascii")
    .digest("hex");
  return { ...doc, signature: { alg: "hmac-sha256", signer, value } };
}

/** 校验来源签名. 无签名字段返回 false */
export function verifySignature(doc: unknown, secret: string): boolean {
  const sig = (doc as ShareBundle | null)?.signature;
  if (!sig?.value) return false;
  const expect = crypto
    .createHmac("sha256", secret)
    .update(bundleFingerprint(doc as ShareBundle), "ascii")
    .digest("hex");
  const a = Buffer.from(expect, "utf8");
  const b = Buffer.from(String(sig.value), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
