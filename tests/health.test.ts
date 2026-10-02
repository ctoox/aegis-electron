/**
 * 健康检查测试: 本地四类问题 + 健康分单调性 + HIBP 联网分支 (注入假 checker, 不真联网).
 * 运行: npm test
 */
import { newEntry } from "../src/core/vault";
import type { Entry } from "../src/core/types";
import { analyzeLocal, analyzeWithBreach, countsByKind, scoreGrade, WEAK_BITS } from "../src/core/health";
import { strengthBits } from "../src/core/generate";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}

function e(partial: Partial<Entry>): Entry {
  return newEntry(partial);
}

async function main() {
  // ---------- 空库 ----------
  const empty = analyzeLocal([]);
  ok(empty.score === 100, "空库健康分 = 100");
  ok(empty.scored === 0 && empty.issues.length === 0, "空库无问题条目");

  // ---------- 弱密码 ----------
  ok(strengthBits("123456") < WEAK_BITS, `"123456" 熵 ${strengthBits("123456")} < ${WEAK_BITS}`);
  const weakOnly = analyzeLocal([e({ title: "A", password: "123456" })]);
  ok(weakOnly.weak === 1, "识别 1 条弱密码");
  ok(weakOnly.score === 70, `弱密码 1/1 → 扣 30 分 (score=${weakOnly.score})`);
  ok(weakOnly.distribution.weak === 1, "强度分布 weak=1");

  // ---------- 重复密码 ----------
  const reuse = analyzeLocal([
    e({ title: "A", password: "S0lid-Passphrase-9x!Q" }),
    e({ title: "B", password: "S0lid-Passphrase-9x!Q" }),
    e({ title: "C", password: "T0tally-Diff3rent-Pw#7" }),
  ]);
  ok(reuse.reused === 1, "识别 1 组重复密码");
  ok(reuse.reusedEntries === 2, "重复涉及 2 个条目");
  ok(reuse.reuseGroups[0].count === 2, "重复组内 2 条");
  ok(reuse.reuseGroups[0].titles.join(",") === "A,B", "重复组标题正确");

  // ---------- 明文 HTTP ----------
  const http = analyzeLocal([
    e({ title: "A", password: "Str0ng!Pass-2026#x", url: "http://insecure.example" }),
    e({ title: "B", password: "Another-Str0ng-Pw!8", url: "https://secure.example" }),
  ]);
  ok(http.http === 1, "只把 http:// 判为明文站点");

  // ---------- 缺两步验证 (粗判: login + 有 url + 有密码 且无 totp) ----------
  const no2fa = analyzeLocal([
    e({ title: "A", password: "Str0ng!Pass-2026#x", url: "https://a.example" }),
    e({
      title: "B",
      password: "Another-Str0ng-Pw!8",
      url: "https://b.example",
      extra: { totp: "JBSWY3DPEHPK3PXP" },
    }),
    e({ title: "备注类", type: "note", password: "N0te-Only-Pw!2026" }),
  ]);
  ok(no2fa.no2fa === 1, "有站点且无 TOTP 的才算缺 2FA");

  // ---------- 健康分单调性 ----------
  const good = e({ title: "全部合格", password: "Str0ng!Pass-2026#x", url: "https://x.example", extra: { totp: "JBSWY3DPEHPK3PXP" } });
  const s0 = analyzeLocal([good]).score;
  const s1 = analyzeLocal([good, e({ title: "w", password: "123456" })]).score;
  const s2 = analyzeLocal([good, e({ title: "w", password: "123456" }), e({ title: "w2", password: "abc" })]).score;
  ok(s0 === 100, `无问题 → 100 (${s0})`);
  ok(s1 < s0 && s2 <= s1, `问题变多 → 分数不增 (${s0} → ${s1} → ${s2})`);
  ok(s2 >= 0, "分数不会为负");

  // ---------- 分类统计 ----------
  const mixed = analyzeLocal([
    e({ title: "弱", password: "123456", url: "http://plain.example" }),
    e({ title: "重复1", password: "Shared-Password!2026" }),
    e({ title: "重复2", password: "Shared-Password!2026" }),
  ]);
  const c = countsByKind(mixed);
  ok(c.weak === 1 && c.reused === 2 && c.http === 1, `按类别统计 (weak=${c.weak} reused=${c.reused} http=${c.http})`);
  ok(mixed.issues.length === c.weak + c.reused + c.http + c.no2fa, "issues 数量与分类合计一致");

  // ---------- 联网分支: 关闭 ----------
  const off = await analyzeWithBreach([e({ title: "A", password: "pw" })], { enabled: false });
  ok(off.breachDisabled === true, "关闭时标记 breachDisabled");
  ok(off.pwned === 0 && off.breachChecked === 0, "关闭时不查、不计泄露");

  // ---------- 联网分支: 命中 ----------
  const entries = [
    e({ title: "Leaked", password: "pwned-pw-123456" }),
    e({ title: "Safe", password: "Uniq-Str0ng-Pw!99" }),
  ];
  const on = await analyzeWithBreach(entries, {
    enabled: true,
    checker: async (pws) => {
      ok(pws.length === 2, "checker 收到 2 条去重密码");
      return new Map([["pwned-pw-123456", 3303003]]);
    },
  });
  ok(on.pwned === 1, "命中 1 条泄露密码");
  ok(on.breachChecked === 2, "breachChecked = 去重密码数");
  ok(on.issues.some((i) => i.kind === "pwned" && i.title === "Leaked"), "泄露条目出现在问题列表");
  ok(on.issues[0].kind === "pwned", "严重项排在列表最前");
  const localOnly = analyzeLocal(entries).score;
  ok(on.score < localOnly, `泄露检测拉低分数 (${localOnly} → ${on.score})`);

  // ---------- 联网分支: 失败降级 ----------
  const fail = await analyzeWithBreach(entries, {
    enabled: true,
    checker: async () => {
      throw new Error("网络不可达");
    },
  });
  ok(fail.breachError === "网络不可达", "失败原因写进 breachError");
  ok(fail.pwned === 0, "失败时不计泄露");
  ok(fail.weak === 0 && fail.score === localOnly, "失败时本地结果仍然有效");

  // ---------- 评分分级 ----------
  ok(scoreGrade(95) === "excellent" && scoreGrade(80) === "good" && scoreGrade(60) === "fair" && scoreGrade(30) === "poor", "分数分级边界");

  console.log(`\n健康检查测试通过 ✔  (${passed} 项)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
