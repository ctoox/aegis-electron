/**
 * 向演示库灌入一批带「健康问题」的条目, 用于真机验证健康检查页.
 * 用法: npx tsx scripts/seed-health.ts
 * 跑之前先把 dev 应用关掉 (避免两个进程同时写同一个库文件)。
 */
import { VaultStore } from "../src/core/vault";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PW = "ctooctoo";
const file = process.platform === "win32"
  ? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "aegis-electron", "aegis.vault.json")
  : join(homedir(), ".config", "aegis-electron", "aegis.vault.json");

import { existsSync } from "node:fs";

const rows: Parameters<VaultStore["add"]>[0][] = [
  { type: "login", title: "GitHub", username: "me@aegis.local", password: "Xk9!vQ2m#pLw7$Bz", url: "https://github.com", favorite: true, extra: { totp: "JBSWY3DPEHPK3PXP", group: "开发" } },
  { type: "login", title: "公司内网门户", username: "zhang.san", password: "ComP@ny2026#Gate", url: "https://portal.corp.example", extra: { group: "工作" } },
  { type: "login", title: "公司 Wiki", username: "zhang.san", password: "ComP@ny2026#Gate", url: "https://wiki.corp.example", extra: { group: "工作" } },
  { type: "login", title: "老邮箱", username: "old@mail.com", password: "abc123", url: "http://mail.example.com", notes: "大学时代的老账号，一直没换密码" },
  { type: "login", title: "测试服务器", username: "root", password: "admin", url: "http://192.168.1.10", notes: "内网测试机" },
  { type: "login", title: "云控制台", username: "ops@aegis.local", password: "T4b&zM!8rQw#nE2v", url: "https://console.cloud.example", extra: { group: "工作/生产环境" } },
  { type: "bank", title: "银行卡", username: "6222 **** **** 1234", password: "998877", notes: "取款密码" },
  { type: "note", title: "保险箱", notes: "书房，密码见纸质备忘", extra: { group: "家庭" } },
  { type: "login", title: "购物网站", username: "shopper", password: "Sh0p!ng-Pw2026", url: "https://shop.example.com" },
  { type: "login", title: "论坛", username: "lurker", password: "qwerty123", url: "https://forum.example.com" },
];

async function main() {
  if (!existsSync(file)) {
    console.log("库不存在, 新建...");
    await VaultStore.create(file, PW, PW);
  }
  const store = await VaultStore.open(file, PW);
  console.log(`已解锁 ${file}，现有 ${store.list().length} 条`);
  for (const r of rows) store.add(r);
  console.log(`已写入 ${rows.length} 条，现在共 ${store.list().length} 条`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
