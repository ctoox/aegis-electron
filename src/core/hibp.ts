/**
 * Have I Been Pwned — Pwned Passwords 查询 (k-匿名).
 *
 * 规格 (实测确认):
 *   GET https://api.pwnedpasswords.com/range/{SHA1(password) 前 5 位大写 HEX}
 *   响应 text/plain, 每行 "35位后缀:出现次数", CRLF 分隔, 默认约 800 行
 *   无需 API Key; 但 **必须带 User-Agent**, 否则 403
 *   Add-Padding: true → 填充到 800~1000 行 (填充项 count=0 → 丢弃), 防流量分析
 *
 * 隐私: 只把哈希前 5 位发给服务端, 完整哈希在本地比对 (k-匿名).
 * 只在主进程运行 (Node fetch), 渲染层不接触网络.
 */
import { createHash } from "node:crypto";

export const HIBP_ENDPOINT = "https://api.pwnedpasswords.com/range/";
export const HIBP_UA = "Aegis-Password-Manager/0.1.0 (+https://github.com/aegis)";

/** SHA-1 → 大写十六进制 (40 位). 密码库检索依赖它, 与密码原文脱钩. */
export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").toUpperCase();
}

export interface BreachHit {
  /** 命中次数 (该密码在泄露库中出现的次数) */
  count: number;
}

export type BreachChecker = (passwords: string[]) => Promise<Map<string, number>>;

interface RangeOptions {
  /** 超时毫秒, 默认 8000 */
  timeout?: number;
  /** 注入 fetch 便于测试 */
  fetchImpl?: typeof fetch;
}

/** 单前缀查询: 返回 <后缀, 次数>. 前缀 5 位, 后缀 35 位, 均为大写 HEX. */
export async function queryRange(
  prefix: string,
  opts: RangeOptions = {},
): Promise<Map<string, number>> {
  const p = prefix.toUpperCase();
  if (!/^[0-9A-F]{5}$/.test(p)) throw new Error("HIBP 前缀必须是 5 位十六进制");
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 8000);
  let res: Response;
  try {
    res = await doFetch(HIBP_ENDPOINT + p, {
      headers: {
        "User-Agent": HIBP_UA,
        "Add-Padding": "true",
      },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HIBP 查询失败: HTTP ${res.status}`);
  const text = await res.text();
  const map = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const suffix = line.slice(0, i).trim().toUpperCase();
    const count = Number.parseInt(line.slice(i + 1).trim(), 10);
    // 填充行 count=0, 不是真实命中, 丢弃
    if (!Number.isFinite(count) || count <= 0 || suffix.length !== 35) continue;
    map.set(suffix, count);
  }
  return map;
}

/** 前缀级缓存: 同一个库里反复体检不再联网 (结果只与哈希有关, 与库无关) */
const rangeCache = new Map<string, Map<string, number>>();

export function clearHibpCache(): void {
  rangeCache.clear();
}

/** 批量检查: 按前 5 位合并请求 (N 个密码通常只需 1~N 次, 同前缀只发一次). */
export function makeBreachChecker(opts: RangeOptions = {}): BreachChecker {
  return async (passwords: string[]): Promise<Map<string, number>> => {
    const hashes = new Map<string, string>(); // password → hash
    for (const pw of passwords) if (pw) hashes.set(pw, sha1Hex(pw));

    const byPrefix = new Map<string, string[]>();
    for (const h of hashes.values()) {
      const p = h.slice(0, 5);
      const arr = byPrefix.get(p);
      if (arr) arr.push(h);
      else byPrefix.set(p, [h]);
    }

    const prefixes = [...byPrefix.keys()];
    const fetched = await Promise.all(
      prefixes.map(async (p) => {
        const cached = rangeCache.get(p);
        if (cached) return [p, cached] as const;
        const fresh = await queryRange(p, opts);
        rangeCache.set(p, fresh);
        return [p, fresh] as const;
      }),
    );

    const out = new Map<string, number>();
    for (const [prefix, table] of fetched) {
      for (const h of byPrefix.get(prefix) ?? []) {
        const n = table.get(h.slice(5)) ?? 0;
        if (n > 0) out.set(h, n);
      }
    }
    // 转成 密码 → 次数 (调用方只关心命中与否)
    const byPassword = new Map<string, number>();
    for (const [pw, h] of hashes) {
      const n = out.get(h);
      if (n) byPassword.set(pw, n);
    }
    return byPassword;
  };
}
