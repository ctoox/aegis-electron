/**
 * 生成「批量删除」测试用的 CSV（默认 80 条）。
 *
 *   npx tsx scripts/gen-bulk-testdata.ts          # 80 条 → testdata/test-bulk.csv
 *   npx tsx scripts/gen-bulk-testdata.ts 200      # 200 条
 *   npx tsx scripts/gen-bulk-testdata.ts 50 b50.csv
 *
 * 每一条都刻意排布成「好验证批量操作」的样子：
 *   · 标题带序号（测试条目 001…）  → Shift 区间选择时一眼看出到底选中了哪些
 *   · 每 10 条一个分组            → 先按分组筛选、再全选删除，验证「按当前筛选全选」
 *   · 密码每 4 条复用一次          → 健康页立刻出现「重复密码」分组
 *   · 混合 4 种类型 / TOTP / HTTP  → 顺带把健康检查也压一遍
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { toCsv } from "../src/core/portable";

const count = Number(process.argv[2] ?? 80);
const outName = process.argv[3] ?? "test-bulk.csv";
const outPath = path.join(process.cwd(), "testdata", outName);

const GROUPS = ["批量测试A", "批量测试B", "批量测试C", "批量测试D", "批量测试E"];
/** 故意复用的弱密码 → 触发「重复密码」检测 */
const REUSED = ["123456", "qwerty", "password", "abc123"];

const rows: string[][] = [
  ["Title", "Username", "Password", "URL", "Notes", "TOTP", "Group", "Favorite", "Type"],
];

for (let i = 1; i <= count; i++) {
  const no = String(i).padStart(3, "0");
  const group = GROUPS[Math.floor((i - 1) / 10) % GROUPS.length];

  // 类型分布：绝大多数 login，少量 note / bank / id
  const type = i % 10 === 0 ? "note" : i % 15 === 0 ? "bank" : i % 21 === 0 ? "id" : "login";

  // 每 4 条复用一次弱密码 → 重复密码检测
  const password = i % 4 === 0 ? REUSED[((i / 4 - 1) % REUSED.length) | 0] : `Pw#${no}!Bulk2026`;

  // 每 7 条一个明文 http（触发「不安全网站」），其余 https
  const url =
    type === "note"
      ? ""
      : i % 7 === 0
        ? `http://insecure-${no}.example.com`
        : `https://site-${no}.example.com`;

  // 每 5 条一个 TOTP（note 不带 —— 笔记条目挂 TOTP 看着像 bug）
  const totp = type !== "note" && i % 5 === 0 ? "JBSWY3DPEHPK3PXP" : "";

  rows.push([
    `测试条目 ${no}`,
    `user${no}@bulk.example.com`,
    type === "note" ? "" : password,
    url,
    `第 ${i} 条批量测试数据（分组 ${group}）`,
    totp,
    group,
    i % 8 === 0 ? "1" : "0",
    type,
  ]);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, toCsv(rows), "utf8");
console.log(`已生成 ${count} 条 → ${outPath}`);
