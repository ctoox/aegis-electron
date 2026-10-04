/**
 * 临时校验: 把 testdata/*.csv 走一遍真实的 detectFormat + parseImport,
 * 确认格式识别、字段映射、特殊字符(RFC4180 转义)都没问题, 再交给用户导入.
 * 跑完即删.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FORMATS, detectFormat, parseImport } from "../src/core/portable";
import { analyzeLocal } from "../src/core/health";

const dir = path.join(process.cwd(), "testdata");
const files = fs.readdirSync(dir).filter((x) => x.endsWith(".csv"));

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const fmt = detectFormat(text);
  console.log(`\n========== ${f} ==========`);
  console.log(`识别格式 : ${fmt ?? "(未识别!)"}  ${fmt ? `→ ${FORMATS.find((x) => x.id === fmt)?.label}` : ""}`);
  if (!fmt) continue;

  const p = parseImport(text, fmt);
  console.log(`条目数   : ${p.entries.length}`);
  console.log(`分组     : ${p.groups.join(" / ") || "(无)"}`);
  if (p.warnings.length) console.log(`警告     : ${p.warnings.join(" | ")}`);
  const shown = p.entries.length <= 12 ? p.entries : [...p.entries.slice(0, 3), null, ...p.entries.slice(-2)];
  for (const e of shown) {
    if (!e) { console.log(`   ... 省略 ${p.entries.length - 5} 条 ...`); continue; }
    const g = e.extra?.group ? `group=${e.extra.group}` : "group=-";
    const t = e.extra?.totp ? "totp=有" : "totp=-";
    console.log(
      `   [${String(e.type).padEnd(5)}] ${String(e.title).padEnd(12)} | ${String(e.username || "-").padEnd(22)} | pw=${String(e.password || "(无)").padEnd(20)} | ${g} fav=${e.favorite ? 1 : 0} ${t} | notes=${e.notes ? e.notes.slice(0, 26) : "-"}`,
    );
  }
  // 大批量时按类型/分组统计, 便于确认"每 10 条一分组"等设计意图是否落到数据里
  if (p.entries.length > 12) {
    const byType = new Map<string, number>();
    const byGroup = new Map<string, number>();
    let pw = 0, totp = 0, http = 0, fav = 0, noPw = 0, noUser = 0;
    for (const e of p.entries) {
      byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      const g = e.extra?.group ?? "(无)";
      byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
      if (e.password) pw++; else noPw++;
      if (e.extra?.totp) totp++;
      if (e.url && /^http:\/\//i.test(e.url)) http++;
      if (e.favorite) fav++;
      if (!e.username) noUser++;
    }
    console.log(`类型分布 : ${[...byType].map(([k, v]) => `${k}=${v}`).join(" ")}`);
    console.log(`分组分布 : ${[...byGroup].map(([k, v]) => `${k}=${v}`).join(" ")}`);
    console.log(`特征计数 : 有密码 ${pw} / 无密码 ${noPw} / 无用户名 ${noUser} / HTTP ${http} / TOTP ${totp} / 收藏 ${fav}`);
  }
  const h = analyzeLocal(p.entries);
  console.log(
    `健康体检 : 分数 ${h.score} | 弱密码 ${h.weak} | 重复条目 ${h.reusedEntries} | HTTP ${h.http} | 缺2FA ${h.no2fa}`,
  );
}
console.log("\n校验完成");
