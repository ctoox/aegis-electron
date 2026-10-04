/**
 * 加密核心测试: 信封加密 / 库文件往返 / 错误主密码 / AAD 防篡改 / 生成器约束.
 * 运行: npm test  (tsx, 无头, 不开窗口)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decryptEntry,
  deriveKek,
  encryptEntry,
  newDek,
  unwrapDek,
  wrapDek,
} from "../src/core/crypto";
import { generatePassword, strengthOf } from "../src/core/generate";
import { VaultStore } from "../src/core/vault";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}

async function main() {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-test-"));
  const vp = path.join(td, "aegis.vault.json");

  // --- 信封原语 ---
  const kek = await deriveKek("correct horse battery", Buffer.alloc(16, 7));
  const dek = newDek();
  const { nonce, wrapped } = wrapDek(dek, kek);
  ok(unwrapDek(wrapped, nonce, kek).equals(dek), "DEK 包裹/解包往返");
  const wrongKek = await deriveKek("wrong password!!", Buffer.alloc(16, 7));
  let threw = false;
  try {
    unwrapDek(wrapped, nonce, wrongKek);
  } catch {
    threw = true;
  }
  ok(threw, "错误 KEK 解包 DEK → GCM 认证失败");

  const enc = encryptEntry({ pw: "s3cret" }, dek, "id1|login");
  ok(
    (decryptEntry(enc.nonce, enc.data, dek, "id1|login") as any).pw === "s3cret",
    "条目加解密往返 (AAD id|type)",
  );
  threw = false;
  try {
    decryptEntry(enc.nonce, enc.data, dek, "id2|login"); // AAD 不匹配
  } catch {
    threw = true;
  }
  ok(threw, "AAD 不匹配 → 拒绝解密 (防密文挪用)");

  // --- 库生命周期 ---
  const s = await VaultStore.create(vp, "master-pw-123", "hint: xyz");
  ok(s.unlocked, "创建即解锁");
  const a = s.add({ title: "GitHub", username: "u1", password: "p1" });
  s.add({ title: "知乎", username: "u2", password: "" });
  s.update(a.id, { password: "p1-rotated" });
  ok(s.list().length === 2, "add/update 后 2 条");

  // 落盘无明文
  const raw = fs.readFileSync(vp, "utf8");
  ok(!raw.includes("GitHub") && !raw.includes("p1-rotated"), "库文件无明文泄漏");
  ok(raw.includes('"format": "aegis-vault"'), "格式标记 aegis-vault");

  // 重开
  const s2 = await VaultStore.open(vp, "master-pw-123");
  const got = s2.list();
  ok(got.length === 2, "重开后条目数一致");
  ok(
    got.find((e) => e.id === a.id)?.password === "p1-rotated",
    "更新后的密码往返一致",
  );
  ok(s2.hint === "hint: xyz", "hint 往返");

  threw = false;
  try {
    await VaultStore.open(vp, "wrong-password");
  } catch (e: any) {
    threw = e.message === "主密码错误";
  }
  ok(threw, "错误主密码 → 明确报「主密码错误」");

  s2.lock();
  threw = false;
  try {
    s2.list();
  } catch {
    threw = true;
  }
  ok(threw, "lock 后拒绝操作 (密钥已清)");

  // 删除
  const s3 = await VaultStore.open(vp, "master-pw-123");
  ok(s3.remove(a.id), "remove 返回 true");
  ok(s3.list().length === 1, "删除后剩 1 条");
  const s4 = await VaultStore.open(vp, "master-pw-123");
  ok(s4.list().length === 1, "删除已落盘");

  // --- 批量删除 (列表多选 / 健康页一键清理 走这条路径) ---
  s4.add({ title: "批量A", password: "x" });
  s4.add({ title: "批量B", password: "y" });
  s4.add({ title: "批量C", password: "z" });
  ok(s4.list().length === 4, "批量删除前 4 条");

  const batchIds = s4
    .list()
    .filter((e) => e.title.startsWith("批量"))
    .map((e) => e.id);
  ok(s4.removeMany(batchIds) === 3, "removeMany 返回真正删掉的条数");
  ok(s4.list().length === 1, "批量删除后剩 1 条");

  // 不存在的 id: 不应计数, 也不应抛错 (列表里并发删除的兜底)
  ok(s4.removeMany(["no-such-id", ...batchIds]) === 0, "不存在/已删的 id → 返回 0");
  ok(s4.removeMany([]) === 0, "空数组 → 0 且不报错");

  const s5 = await VaultStore.open(vp, "master-pw-123");
  ok(s5.list().length === 1, "批量删除已落盘");

  s5.lock();
  threw = false;
  try {
    s5.removeMany(["x"]);
  } catch {
    threw = true;
  }
  ok(threw, "锁定后 removeMany 拒绝执行 (密钥已清)");

  // --- 主密码二次校验 (批量删除前的防误触) ---
  const s6 = await VaultStore.open(vp, "master-pw-123");
  ok(await s6.verifyMasterPassword("master-pw-123"), "正确主密码 → 二次校验通过");
  ok(!(await s6.verifyMasterPassword("wrong-password")), "错误主密码 → 二次校验失败");
  ok(!(await s6.verifyMasterPassword("")), "空密码 → 二次校验失败");
  ok(s6.list().length === 1, "二次校验不影响库内容");

  threw = false;
  try {
    await VaultStore.create(vp + "2", "short");
  } catch (e: any) {
    threw = e.message.includes("至少 8 位");
  }
  ok(threw, "主密码 <8 位拒绝");

  // --- 生成器 (与 Python 版同语义) ---
  for (let i = 0; i < 50; i++) {
    const pw = generatePassword({
      length: 24, useUpper: true, useLower: true,
      useDigits: true, useSymbols: true, minDigits: 5, minSymbols: 3,
    });
    const d = (c: string) => [...pw].filter((x) => c.includes(x)).length;
    if (d("0123456789") < 5 || d("!@#$%^&*()-_=+[]{}:,.") < 3 || pw.length !== 24) {
      throw new Error("✗ 约束不满足: " + pw);
    }
  }
  ok("50 轮: minDigits=5/minSymbols=3 全部满足");
  ok(
    strengthOf("Str0ng!Pass-2026#x") === "good" && strengthOf("123456") === "weak",
    "强度分级 (good/weak)",
  );
  threw = false;
  try {
    generatePassword({
      length: 6, useUpper: true, useLower: true,
      useDigits: true, useSymbols: true, minDigits: 9, minSymbols: 1,
    });
  } catch (e: any) {
    threw = e.message.includes("太短");
  }
  ok(threw, "约束超长 → 中文报错");

  fs.rmSync(td, { recursive: true, force: true });
  console.log(`\n加密核心测试通过 ✔  (${passed} 项)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
