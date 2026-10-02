/**
 * TOTP 测试: RFC 6238 附录 B 官方测试向量 (SHA-1, 8 位码).
 * 密钥 "12345678901234567890" 的 Base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
 */
import { base32Decode, totpCode, totpRemaining, totpView } from "../src/core/totp";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// RFC 6238 Appendix B (SHA1, T0=0, X=30, 8 digits)
const VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];
for (const [t, want] of VECTORS) {
  const got = totpCode(SECRET, t * 1000, 8);
  ok(got === want, `RFC 向量 T=${t} → ${want}`);
}

ok(base32Decode(SECRET).toString() === "12345678901234567890", "Base32 解码正确");

// 6 位码 = 8 位码后 6 位
ok(
  totpCode(SECRET, 59_000, 6) === "287082",
  "6 位码取模正确 (94287082 → 287082)",
);

// 剩余秒数
ok(totpRemaining(0) === 30, "t=0 时剩余 30s");
ok(totpRemaining(1_000) === 29, "t=1s 时剩余 29s");
ok(totpRemaining(29_000) === 1, "t=29s 时剩余 1s");
ok(totpRemaining(30_000) === 30, "t=30s 重新计满");

// 同一 30s 窗口内码不变, 跨窗口变化
ok(totpCode(SECRET, 10_000) === totpCode(SECRET, 29_000), "同窗口内码稳定");
ok(totpCode(SECRET, 29_000) !== totpCode(SECRET, 31_000), "跨窗口码变化");

// 容错: 带空格/小写/等号
ok(
  totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 59_000, 8) === "94287082",
  "小写+空格+可省略 = 仍可解码",
);

// 错误输入不抛 (UI 路径)
const bad = totpView("!!!not-base32!!!");
ok(!!bad.error && bad.code === "", "非法密钥 → totpView 返回 error 不抛");
const good = totpView(SECRET, 59_000);
ok(good.code.length === 6 && good.period === 30 && good.remaining > 0, "totpView 正常路径");

console.log(`\nTOTP 测试通过 ✔  (${passed} 项)`);
