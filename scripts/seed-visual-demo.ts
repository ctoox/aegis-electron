/**
 * 造一份用于截图/肉眼检查的演示密码库.
 *
 * 为什么单独拧一个: `shot-ui.mjs` 需要一份**内容可预期**的库 —— 尤其是
 * 「历史版本」那张图, 库里必须先有一条真改过核心字段的条目, 否则历史弹窗
 * 只会显示「还没有历史记录」, 等于没验。所以这里故意在第 2 条上加了一次
 * 密码轮换 (Sw-2026#xyz → Sw-2026#rotated), 留出恰好 1 个历史版本。
 *
 * 用法:
 *   npx tsx scripts/seed-visual-demo.ts <数据目录>
 *   # 例: npx tsx scripts/seed-visual-demo.ts "$TEMP/aegis-vis"
 *   # 主密码固定 visual-check-123, 配合:
 *   #   npm run shot:ui -- --user-data-dir <数据目录> --password visual-check-123
 *
 * 目录会被直接创建/覆盖, 请只传临时目录。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { VaultStore } from "../src/core/vault";

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("用法: npx tsx scripts/seed-visual-demo.ts <数据目录>");
    process.exit(2);
  }
  fs.mkdirSync(dir, { recursive: true });
  const vp = path.join(dir, "aegis.vault.json");
  const s = await VaultStore.create(vp, "visual-check-123", "演示库的密码提示");

  s.add({
    type: "login",
    title: "GitHub",
    username: "dev@example.com",
    password: "Gh-2026#abc",
    url: "https://github.com",
    extra: { group: "开发" },
  });

  // 这条要制造历史版本: 建完再改一次密码
  const rotated = s.add({
    type: "login",
    title: "核心交换机",
    username: "admin",
    password: "Sw-2026#xyz",
    url: "https://10.0.0.1",
    extra: { group: "网络" },
  });
  s.update(rotated.id, { password: "Sw-2026#rotated" });

  s.add({
    type: "login",
    title: "邮箱",
    username: "me@example.com",
    password: "Mail-2026!",
    extra: { group: "日常" },
  });

  const entries = s.list();
  const withHistory = entries.filter((e) => (e.history?.length ?? 0) > 0);
  console.log(`已生成演示库: ${vp}`);
  console.log(`  条目        ${entries.length} 条`);
  console.log(`  带历史版本  ${withHistory.length} 条 —— ${withHistory.map((e) => `${e.title}(${e.history?.length})`).join(", ")}`);
  s.lock();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
