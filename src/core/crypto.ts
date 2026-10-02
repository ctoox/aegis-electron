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

export async function deriveKek(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  const out = await argon2id({
    password,
    salt,
    parallelism: KDF_PARAMS.parallelism,
    iterations: KDF_PARAMS.iterations,
    memorySize: KDF_PARAMS.memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
  return Buffer.from(out);
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
