/**
 * TOTP (RFC 6238): Base32 密钥 → 6 位动态码, 30 秒步长.
 * 与 Python 版 aegis_core/totp.py 语义一致, 测试用 RFC 附录 B 官方向量.
 */
import * as crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("TOTP 密钥不是合法 Base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length === 0) throw new Error("TOTP 密钥为空");
  return Buffer.from(out);
}

export function totpCode(secretB32: string, at: number = Date.now(), digits = 6): string {
  const step = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const hmac = crypto.createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** 当前码剩余秒数 (1..30) */
export function totpRemaining(at: number = Date.now()): number {
  const sec = Math.floor(at / 1000) % 30;
  return 30 - sec;
}

export interface TotpView {
  code: string;
  remaining: number;
  period: number;
  error?: string;
}

/** 给 UI 用: 一次调用拿到码 + 剩余秒 + 周期, 出错返回 error 而不抛 */
export function totpView(secretB32: string, at: number = Date.now()): TotpView {
  try {
    return {
      code: totpCode(secretB32, at),
      remaining: totpRemaining(at),
      period: 30,
    };
  } catch (e) {
    return {
      code: "",
      remaining: 0,
      period: 30,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
