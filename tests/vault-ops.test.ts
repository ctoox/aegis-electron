/**
 * 数据能力测试: 改主密码 / 重置 / 清空 / 条目历史 / 自动滚动快照.
 * 运行: npm test  (tsx, 无头, 不开窗口)
 *
 * 这一组测试存在的理由: 这些都是**破坏性**能力, 出错的代价是用户数据,
 * 所以不能只靠"点一下 UI 看起来正常"。特别是 reset 与 changePassword 的
 * 区别 —— 前者换掉整把钥匙 (旧数据必须解不开), 后者只重包 DEK
 * (数据必须一条不丢), 两个方向都要验。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VaultStore } from "../src/core/vault";
import { listHistory } from "../src/core/history";
import { backupDirFor, listSnapshots } from "../src/core/backup";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}

async function main() {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-ops-"));
  const P = (n: string) => path.join(td, n);

  // ============================================================ 改主密码
  {
    const vp = P("a.vault.json");
    const s = await VaultStore.create(vp, "master-pw-123", "旧提示");
    const a = s.add({ title: "GitHub", username: "u1", password: "p1" });
    s.add({ title: "知乎", username: "u2", password: "p2" });
    const before = s.list().map((e) => e.password).sort();

    // 旧密码错 → 拒绝, 且库完全不受影响
    let threw = false;
    try {
      await s.changePassword("wrong-pw-xxx", "brand-new-pw-1");
    } catch {
      threw = true;
    }
    ok(threw, "改密码: 旧密码错 → 拒绝");
    ok(
      (await VaultStore.open(vp, "master-pw-123")).list().length === 2,
      "被拒绝后旧密码仍能打开, 库没被破坏",
    );

    await s.changePassword("master-pw-123", "brand-new-pw-1", "新提示");
    ok(s.hint === "新提示", "改密码后 hint 已更新");
    const after = s.list().map((e) => e.password).sort();
    ok(
      JSON.stringify(before) === JSON.stringify(after),
      "改密码后条目明文一条没变 (DEK 没换, 数据零损失)",
    );

    const s2 = await VaultStore.open(vp, "brand-new-pw-1");
    ok(s2.list().length === 2, "新主密码可解锁且数据完整");
    ok(s2.get(a.id)?.password === "p1", "重开后条目内容正确");

    threw = false;
    try {
      await VaultStore.open(vp, "master-pw-123");
    } catch {
      threw = true;
    }
    ok(threw, "改完之后旧主密码已失效");

    threw = false;
    try {
      await s.changePassword("brand-new-pw-1", "short");
    } catch {
      threw = true;
    }
    ok(threw, "新主密码短于 8 位 → 拒绝");

    threw = false;
    try {
      await s.changePassword("brand-new-pw-1", "brand-new-pw-1");
    } catch {
      threw = true;
    }
    ok(threw, "新旧主密码相同 → 拒绝");
  }

  // ============================================================ 条目历史
  {
    const vp = P("h.vault.json");
    const s = await VaultStore.create(vp, "pw-12345678");
    const e = s.add({
      title: "A",
      username: "u",
      password: "p1",
      url: "https://a",
      notes: "n",
    });
    ok(listHistory(s.get(e.id)!).length === 0, "新建条目没有历史");

    s.update(e.id, { password: "p2" });
    let h = listHistory(s.get(e.id)!);
    ok(h.length === 1 && h[0].password === "p1", "改密码 → 记下旧值快照");

    s.update(e.id, { favorite: true });
    ok(listHistory(s.get(e.id)!).length === 1, "只改收藏 → 不记历史 (不污染)");

    s.update(e.id, { title: "A2", username: "u2" });
    h = listHistory(s.get(e.id)!);
    ok(
      // 这条快照是"改标题/用户名之前"的全量旧值: 标题和用户名还是老的,
      // 密码则是上一次改完的 p2 —— 快照存的是**当时**的值, 不是最初的
      h.length === 2 && h[1].title === "A" && h[1].username === "u" && h[1].password === "p2",
      "改标题+用户名 → 记一条含全部当时值的快照",
    );

    const restored = s.restoreHistory(e.id, 0);
    ok(
      restored.password === "p1" && restored.title === "A" && restored.username === "u",
      "恢复到第 0 版: 字段全部还原",
    );
    ok(listHistory(s.get(e.id)!).length === 3, "恢复动作本身也进历史 (再恢复能撤销)");

    let threw = false;
    try {
      s.restoreHistory(e.id, 99);
    } catch {
      threw = true;
    }
    ok(threw, "越界的历史索引 → 报错");

    for (let i = 0; i < 30; i++) s.update(e.id, { password: `gen-${i}` });
    ok(listHistory(s.get(e.id)!).length === 20, "历史最多保留 20 条 (超出丢最旧)");

    // 渲染层拿到的是带 history 的条目, 编辑后回传时不能把历史冲掉
    s.update(e.id, { history: [] });
    ok(listHistory(s.get(e.id)!).length === 20, "patch 里的 history 被忽略 (回传冲不掉历史)");

    // 历史随库一起加密持久化
    const s2 = await VaultStore.open(vp, "pw-12345678");
    ok(listHistory(s2.get(e.id)!).length === 20, "历史随条目加密落盘, 重开后还在");
    const raw = fs.readFileSync(vp, "utf8");
    ok(!raw.includes("gen-"), "库文件里看不到历史的明文");
  }

  // ============================================================ 自动滚动快照
  {
    const vp = P("b.vault.json");
    const s = await VaultStore.create(vp, "pw-12345678");
    ok(fs.existsSync(backupDirFor(vp)), "首次落盘后 backups/ 目录已建");

    const e = s.add({ title: "x", password: "p" });
    for (let i = 0; i < 20; i++) s.update(e.id, { notes: `n${i}` });
    ok(listSnapshots(vp).length === 10, "滚动保留最近 10 份快照 (超出淘汰最旧)");
  }

  // ============================================================ 清空全部
  {
    const vp = P("c.vault.json");
    const s = await VaultStore.create(vp, "pw-12345678");
    s.add({ title: "一", password: "a" });
    s.add({ title: "二", password: "b" });
    s.add({ title: "三", password: "c" });

    const n = s.clearAll();
    ok(n === 3, "clearAll 返回真正清掉的条数");
    ok(s.list().length === 0, "清空后库为空");
    ok(s.clearAll() === 0, "空库再清 → 返回 0 (不重复写盘)");

    // 主密码没动 —— 这是与 reset 的关键区别
    const s2 = await VaultStore.open(vp, "pw-12345678");
    ok(s2.list().length === 0 && s2.unlocked, "清空后主密码照旧可用 (库没重建)");

    // 关键: 一定要有一份"清空前"的快照能原样打开, 否则这一步不可逆
    let recoverable = false;
    for (const sp of listSnapshots(vp)) {
      try {
        const t = await VaultStore.open(sp, "pw-12345678");
        if (t.list().length === 3) {
          recoverable = true;
          break;
        }
      } catch {
        /* 打不开的快照跳过 */
      }
    }
    ok(recoverable, "存在一份清空前的快照, 能原样打开 → 清空可逆");
  }

  // ============================================================ 重置主密码
  {
    const vp = P("d.vault.json");
    const s = await VaultStore.create(vp, "pw-12345678");
    s.add({ title: "重要的东西", password: "keep-me" });
    s.add({ title: "另一个", password: "me-too" });

    const { store, backupPath } = await VaultStore.reset(
      vp,
      "brand-new-pw-9",
      "重置后提示",
    );
    ok(!!backupPath && fs.existsSync(backupPath), "重置产出了 .bak 备份");
    ok(store.list().length === 0, "重置后新库是空的");
    ok(store.hint === "重置后提示", "重置后 hint 已写入");
    ok(store.unlocked, "重置后直接是解锁态 (可以直接进)");

    const reopened = await VaultStore.open(vp, "brand-new-pw-9");
    ok(reopened.list().length === 0, "新主密码能打开重置后的库");

    let threw = false;
    try {
      await VaultStore.open(vp, "pw-12345678");
    } catch {
      threw = true;
    }
    ok(threw, "重置后旧主密码彻底失效 (换了新 DEK)");

    // 这是重置唯一的人道之处: 备份能拿旧密码开
    const old = await VaultStore.open(backupPath!, "pw-12345678");
    ok(old.list().length === 2, "旧库备份仍可用旧密码打开 (想起密码还能救回来)");

    threw = false;
    try {
      await VaultStore.reset(vp, "short");
    } catch {
      threw = true;
    }
    ok(threw, "重置时新密码短于 8 位 → 拒绝");

    // 没有库文件时不该造假备份
    const { backupPath: noBak } = await VaultStore.reset(
      P("not-there.vault.json"),
      "pw-12345678",
    );
    ok(noBak === null, "库文件不存在 → 不产备份, 只建新库");
  }

  fs.rmSync(td, { recursive: true, force: true });
  console.log(`\n数据能力测试通过 ✔  (${passed} 项)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
