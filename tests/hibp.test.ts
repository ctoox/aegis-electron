/**
 * HIBP Pwned Passwords 客户端测试 (全程注入假 fetch, 不真联网):
 *   - SHA-1 向量 / k-匿名前缀切分
 *   - 响应解析: 丢弃 Add-Padding 的填充行 (count=0)
 *   - 请求头必须带 User-Agent 与 Add-Padding
 *   - 批量查询按前缀合并 + 前缀级缓存
 */
import {
  clearHibpCache,
  makeBreachChecker,
  queryRange,
  sha1Hex,
  HIBP_UA,
} from "../src/core/hibp";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** 造一个假 fetch: 记录请求, 按前缀返回预设 body */
function fakeFetch(bodies: Record<string, string>, calls: Call[]) {
  return (async (url: string, init: any) => {
    const prefix = String(url).split("/").pop() as string;
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const body = bodies[prefix];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => "" };
    }
    return { ok: true, status: 200, text: async () => body };
  }) as unknown as typeof fetch;
}

async function main() {
  // ---------- SHA-1 向量 ----------
  // 公开已知: SHA1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const h = sha1Hex("password");
  ok(h === "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8", `SHA1("password") 向量正确 (${h})`);
  ok(h.length === 40 && h === h.toUpperCase(), "哈希为 40 位大写十六进制");

  // ---------- queryRange: 解析 + 丢弃填充 ----------
  const prefix = "5BAA6";
  const suffix = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";
  const calls: Call[] = [];
  const body = [
    suffix + ":3303003",
    "0000000000000000000000000000000000A:0", // Add-Padding 填充行 → 必须丢弃
    "0000000000000000000000000000000000B:0",
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:12", // 真实但仍需 35 位后缀
    "",
  ].join("\r\n");
  const table = await queryRange(prefix, { fetchImpl: fakeFetch({ [prefix]: body }, calls) });

  ok(calls.length === 1, "只发 1 次请求");
  ok(calls[0].url === `https://api.pwnedpasswords.com/range/${prefix}`, "URL 只带前 5 位 (k-匿名)");
  ok(calls[0].headers["User-Agent"] === HIBP_UA, "带 User-Agent (否则 403)");
  ok(calls[0].headers["Add-Padding"] === "true", "带 Add-Padding: true");
  ok(table.get(suffix) === 3303003, "命中条目次数解析正确");
  ok(!table.has("0000000000000000000000000000000000A"), "count=0 的填充行被丢弃");
  ok(table.size === 2, `只保留 2 条真实命中 (实际 ${table.size})`);

  // ---------- 前缀非法 ----------
  let threw = false;
  try {
    await queryRange("5BAA", { fetchImpl: fakeFetch({}, []) });
  } catch (e: any) {
    threw = e.message.includes("5 位十六进制");
  }
  ok(threw, "非 5 位前缀直接拒绝, 不发请求");

  // ---------- HTTP 错误 ----------
  threw = false;
  try {
    await queryRange("AAAAA", { fetchImpl: fakeFetch({}, []) });
  } catch (e: any) {
    threw = e.message.includes("HTTP 404");
  }
  ok(threw, "非 2xx 响应 → 抛出中文错误");

  // ---------- 批量: 哈希去重 → 只发一次 ----------
  clearHibpCache();
  const calls2: Call[] = [];
  const checker = makeBreachChecker({
    fetchImpl: fakeFetch({ "5BAA6": suffix + ":42\r\n" }, calls2),
  });
  const hit1 = await checker(["password", "password", ""]);
  ok(calls2.length === 1, "重复密码去重后只发 1 次请求");
  ok(hit1.get("password") === 42, "批量结果按密码原文返回次数");
  ok(hit1.size === 1, "未命中的密码不出现在结果里");

  // ---------- 前缀级缓存: 第二次不再联网 ----------
  const hit2 = await checker(["password"]);
  ok(calls2.length === 1, "第二次查询命中缓存, 不发新请求");
  ok(hit2.get("password") === 42, "缓存结果一致");

  clearHibpCache();
  const calls3: Call[] = [];
  const checker3 = makeBreachChecker({
    fetchImpl: fakeFetch({ "5BAA6": suffix + ":42\r\n" }, calls3),
  });
  await checker3(["password"]);
  ok(calls3.length === 1, "清缓存后重新联网");

  console.log(`\nHIBP 客户端测试通过 ✔  (${passed} 项)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
