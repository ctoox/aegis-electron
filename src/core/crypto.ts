/**
 * 加密原语: Argon2id 派生 KEK + AES-256-GCM 信封加密.
 *
 * 安全基线 (对齐 Python 版 docs/TECH_POINTS.md §2):
 *  - 主密码 --Argon2id(m=64MiB, t=3, p=4)--> KEK (32B)
 *  - 随机 DEK (32B) 由 KEK 包裹存储; 每条条目用 DEK 独立加密
 *  - 每条密文 AAD 绑定 "entryId|type", 防密文挪用/置换
 *  - 错误主密码 = KEK 错 = 解包 DEK 时 GCM 认证失败
 *  - hash-wasm 纯 WASM: Windows / UOS (x64+ARM64) 免原生编译
 */
import { argon2id } from "hash-wasm";
import crypto from "node:crypto";

export const KDF_PARAMS = {
  algo: "argon2id",
  memoryKiB: 65536, // 64 MiB
  iterations: 3,
  parallelism: 4,
} as const;

/** 可调 Argon2id 参数 (分享包会随包携带自己的参数, 便于将来单独调参) */
export interface KdfParams {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** 主密码 -> 32 字节 KEK (Key Encryption Key), 参数由调用方给 */
export async function deriveKekWith(
  password: string,
  salt: Buffer,
  p: KdfParams,
): Promise<Buffer> {
  const out = await argon2id({
    password,
    salt,
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
  return Buffer.from(out);
}

export async function deriveKek(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return deriveKekWith(password, salt, KDF_PARAMS);
}

// ---------- DEK 信封 ----------

export function newDek(): Buffer {
  return crypto.randomBytes(32);
}

export function wrapDek(
  dek: Buffer,
  kek: Buffer,
): { nonce: Buffer; wrapped: Buffer } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, nonce);
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { nonce, wrapped: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function unwrapDek(wrapped: Buffer, nonce: Buffer, kek: Buffer): Buffer {
  const tag = wrapped.subarray(wrapped.length - 16);
  const body = wrapped.subarray(0, wrapped.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ---------- 条目密文 (AAD 绑定 id|type) ----------

export function encryptEntry(
  entry: object,
  dek: Buffer,
  aad: string,
): { nonce: string; data: string } {
  const n = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, n);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(entry), "utf8"),
    cipher.final(),
  ]);
  return {
    nonce: n.toString("base64"),
    data: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
}

export function decryptEntry(
  nonceB64: string,
  dataB64: string,
  dek: Buffer,
  aad: string,
): object {
  const n = Buffer.from(nonceB64, "base64");
  const blob = Buffer.from(dataB64, "base64");
  const tag = blob.subarray(blob.length - 16);
  const body = blob.subarray(0, blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, n);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"),
  );
}

// ---------- 「合并布局」原语: b64(nonce ‖ ct ‖ tag) ----------
//
// 分享包 (core/share.ts) 要与 Python 版 aegis-share v1 **线格式互通**,
// 而 Python 侧用的就是这种把 nonce 和 tag 拼进同一个 base64 串的布局
// (库文件里是拆成两个字段存的, 两者不同, 别混用).
// AAD 也按 Python 的约定传入, 这样两边导出的包能互相解开.

const SHARE_NONCE_LEN = 12;

/** 用 KEK 包裹密钥 → b64(nonce ‖ ct ‖ tag). 对应 Python 的 wrap_key */
export function wrapKeyB64(key: Buffer, kek: Buffer, aad: string): string {
  const nonce = crypto.randomBytes(SHARE_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** 解开 b64(nonce ‖ ct ‖ tag). AAD 不符 / 数据被篡改 → GCM 认证失败抛错 */
export function unwrapKeyB64(blobB64: string, kek: Buffer, aad: string): Buffer {
  const raw = Buffer.from(blobB64, "base64");
  const nonce = raw.subarray(0, SHARE_NONCE_LEN);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(SHARE_NONCE_LEN, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** 加密任意 JSON 对象 → b64(nonce ‖ ct ‖ tag). 对应 Python 的 encrypt_json */
export function sealJson(obj: unknown, key: Buffer, aad: string): string {
  const nonce = crypto.randomBytes(SHARE_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(obj), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** 解开 b64(nonce ‖ ct ‖ tag) 并解析 JSON. 对应 Python 的 decrypt_json */
export function openJson<T = unknown>(
  blobB64: string,
  key: Buffer,
  aad: string,
): T {
  const raw = Buffer.from(blobB64, "base64");
  const nonce = raw.subarray(0, SHARE_NONCE_LEN);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(SHARE_NONCE_LEN, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}
