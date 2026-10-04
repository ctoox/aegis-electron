/**
 * 加密分享包测试: 导出 / 预览 / 指纹 / 签名 / 导入 / 冲突处理 / 篡改检测,
 * 以及**与 Python 版的跨语言互通**.
 * 运行: npm test  (tsx, 无头)
 *
 * 互通用例的分量: 分享包是唯一一个"要发给别人"的产物, 如果 Node 版和
 * Python 版各自往包里塞自己的私有格式, 用户 A 用桌面端导、用户 B 用别的
 * 实现就打不开 —— 这种 bug 在自己机器上永远复现不了。所以这里拿一份
 * **真·Python 版导出**的包当固定夹具, 直接断言能解开。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ShareError,
  bundleFingerprint,
  bundleToJson,
  defaultShareFilename,
  describeBundle,
  exportBundle,
  importBundle,
  signBundle,
  verifySignature,
} from "../src/core/share";
import { VaultStore } from "../src/core/vault";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}

const SHARE_PW = "share-pw-2026";

async function main() {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-share-"));
  const vp = path.join(td, "a.vault.json");

  const s = await VaultStore.create(vp, "master-pw-123");
  const e1 = s.add({
    type: "login",
    title: "交换机",
    username: "admin",
    password: "sw-pass-1",
    url: "https://10.0.0.1",
    notes: "机房里那台",
    extra: { group: "网络" },
  });
  const e2 = s.add({
    type: "login",
    title: "路由器",
    username: "root",
    password: "rt-pass-2",
    extra: { group: "网络" },
  });

  // ============================================================ 导出
  const bundle = await exportBundle(s.list(), SHARE_PW, {
    title: "网络设备账号",
    sender: "张三",
    // 注意: note 是**明文**元信息, 措辞里别混进要保密的条目名 —— 否则下面
    // 「包里没有条目明文」的断言会因为 note 而假失败 (这个坑踩过一次)
    note: "只给了网络组那几台",
    hint: "和上次一样",
  });
  ok(bundle.format === "aegis-share" && bundle.version === 1, "分享包魔数与版本正确");
  ok(bundle.entries.length === 2, "包内条目数正确");
  ok(
    bundle.meta.title === "网络设备账号" && bundle.meta.sender === "张三",
    "明文元信息 (标题/署名) 可读",
  );
  ok(
    Math.abs(bundle.meta.created_at - Date.now() / 1000) < 60,
    "created_at 是**秒**级时间戳 (与 Python 对齐)",
  );

  const raw = bundleToJson(bundle);
  ok(
    !raw.includes("sw-pass-1") && !raw.includes("admin") && !raw.includes("交换机"),
    "分享包里没有密码/用户名/条目标题的明文",
  );
  ok(
    raw.includes("网络设备账号") && raw.includes("张三"),
    "元信息按设计是明文 (接收方导入前就能看清是什么)",
  );

  // 与 Python 版的 KDF 参数必须一致, 否则互开不了
  ok(
    bundle.kdf.params.time_cost === 3 &&
      bundle.kdf.params.memory_cost === 65536 &&
      bundle.kdf.params.parallelism === 1 &&
      bundle.kdf.params.hash_len === 32,
    "分享 KDF 参数与 Python 版 SHARE_KDF_DEFAULT 逐项一致",
  );
  ok(bundle.kdf.type === "argon2id" && bundle.kdf.salt.length > 0, "KDF 类型与 salt 就位");

  // ============================================================ 预览
  const info = describeBundle(JSON.parse(raw));
  ok(info.entry_count === 2 && info.title === "网络设备账号", "describeBundle 读出元信息");
  ok(info.type_counts.login === 2, "describeBundle 正确统计条目类型");
  ok(info.createdText.length > 0, "describeBundle 给出本地可读时间");

  // ============================================================ 指纹与签名
  const fp = bundleFingerprint(bundle);
  ok(fp.length === 32 && /^[0-9a-f]+$/.test(fp), "指纹是 32 位十六进制");
  ok(
    bundleFingerprint(signBundle(bundle, "team-secret")) === fp,
    "加签名后指纹不变 (指纹不含 signature 本身)",
  );
  ok(verifySignature(signBundle(bundle, "team-secret"), "team-secret"), "签名校验通过");
  ok(!verifySignature(signBundle(bundle, "team-secret"), "other-secret"), "签名密钥不对 → 校验失败");
  ok(!verifySignature(bundle, "team-secret"), "没有签名 → 校验失败 (不谎报通过)");

  // ============================================================ 导入
  const res = await importBundle(bundle, SHARE_PW);
  ok(res.entries.length === 2 && res.skipped === 0, "导入 2 条, 无跳过");
  const g = res.entries.find((e) => e.title === "交换机")!;
  ok(
    g.password === "sw-pass-1" && g.username === "admin" && g.extra.group === "网络",
    "条目字段 (含 extra) 完整还原",
  );
  ok(g.id === e1.id, "id 原样保留 (同一个人拿到的是同一条)");

  let threw = false;
  try {
    await importBundle(bundle, "wrong-share-pw");
  } catch (e) {
    threw = e instanceof ShareError;
  }
  ok(threw, "分享口令错误 → ShareError, 不泄漏内部错误");

  // ============================================================ id 冲突
  const res2 = await importBundle(bundle, SHARE_PW, {
    existingIds: [e1.id, e2.id],
  });
  ok(res2.rekeyed === 2 && res2.entries.length === 2, "id 与目标库冲突 → 全部改发新 id");
  ok(
    res2.entries.every((x) => x.id !== e1.id && x.id !== e2.id),
    "新 id 与旧库不撞 (不会覆盖已有条目)",
  );

  const res3 = await importBundle(bundle, SHARE_PW, { forceNewIds: true });
  ok(res3.rekeyed === 2, "forceNewIds → 无条件换新 id (副本语义)");

  // ============================================================ 拒绝非法输入
  threw = false;
  try {
    describeBundle({ format: "aegis-vault", version: 1 });
  } catch (e) {
    threw = e instanceof ShareError;
  }
  ok(threw, "不是分享包 → ShareError");

  threw = false;
  try {
    describeBundle({ ...bundle, version: 99 });
  } catch {
    threw = true;
  }
  ok(threw, "分享包版本过新 → 拒绝 (提示升级, 而不是解出乱码)");

  threw = false;
  try {
    describeBundle({ ...bundle, entries: undefined });
  } catch {
    threw = true;
  }
  ok(threw, "缺必要字段 → 拒绝");

  threw = false;
  try {
    await exportBundle([], SHARE_PW);
  } catch {
    threw = true;
  }
  ok(threw, "没有条目 → 拒绝导出");

  threw = false;
  try {
    await exportBundle([e1], "short");
  } catch {
    threw = true;
  }
  ok(threw, "分享口令短于 8 位 → 拒绝导出");

  // ============================================================ 篡改检测
  {
    const t = JSON.parse(raw);
    t.entries[0].data = t.entries[1].data; // 把第二条的密文挪到第一条
    const r = await importBundle(t, SHARE_PW);
    ok(r.skipped === 1 && r.entries.length === 1, "密文被互换 → AAD 不匹配, 该条跳过, 其余照常");
  }
  {
    const t = JSON.parse(raw);
    t.wrapped_key = t.wrapped_key.slice(0, -8) + "AAAAAAAA"; // 弄坏包裹密钥
    let flag = false;
    try {
      await importBundle(t, SHARE_PW);
    } catch {
      flag = true;
    }
    ok(flag, "wrapped_key 被篡改 → 拒绝整个包");
  }
  {
    const t = JSON.parse(raw);
    t.meta.title = "被改过的标题"; // 明文元信息改了不影响解密
    const r = await importBundle(t, SHARE_PW);
    ok(r.entries.length === 2, "只改明文元信息 → 仍能正常导入 (元信息不参与加密)");
  }

  // ============================================================ 默认文件名
  ok(
    defaultShareFilename("网络设备账号", new Date(2026, 9, 4)) ===
      "aegis-share-网络设备账号-20261004.json",
    "默认文件名带标题与日期",
  );
  ok(
    defaultShareFilename("a/b:c*d?", new Date(2026, 9, 4)) ===
      "aegis-share-abcd-20261004.json",
    "默认文件名剔除路径非法字符",
  );
  ok(
    defaultShareFilename("", new Date(2026, 9, 4)) === "aegis-share-bundle-20261004.json",
    "空标题回退成 bundle",
  );

  // ============================================================ 跨语言互通
  // 夹具是**真·Python 版**导出的包 (生成脚本: scripts/interop-share.py)
  const fixture = path.join(__dirname, "..", "testdata", "share-from-python.json");
  if (fs.existsSync(fixture)) {
    const doc = JSON.parse(fs.readFileSync(fixture, "utf8"));
    const pyInfo = describeBundle(doc);
    ok(pyInfo.title === "来自 Python 的分享包", "读到 Python 版分享包的明文标题");
    ok(pyInfo.sender === "Python 版", "读到 Python 版分享包的署名");
    ok(pyInfo.entry_count === 3, "Python 版分享包里有 3 条");

    const pyRes = await importBundle(doc, "python-share-2026");
    ok(pyRes.entries.length === 3, "**Node 能解开 Python 版导出的分享包** (跨语言互通)");
    const sw = pyRes.entries.find((e) => e.title === "核心交换机")!;
    ok(!!sw, "解出的条目里有预期的中文标题");
    ok(sw.password === "Py-Sh@re-2026!", "解出的密码与 Python 侧写入的一致");
    ok(sw.username === "pyadmin" && sw.extra?.group === "网络", "用户名与 extra 也完整还原");

    let bad = false;
    try {
      await importBundle(doc, "wrong-password-xx");
    } catch {
      bad = true;
    }
    ok(bad, "Python 版分享包用错口令同样解不开");
  } else {
    console.log("  (跳过跨语言用例: 夹具缺失, 跑 npm run gen:share-fixture 生成)");
  }

  fs.rmSync(td, { recursive: true, force: true });
  console.log(`\n分享包测试通过 ✔  (${passed} 项)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
