/**
 * 导入导出测试: CSV 解析器 / 格式自动识别 / 各家样例解析 / 导出后再导入的往返一致性.
 */
import { newEntry } from "../src/core/vault";
import type { Entry } from "../src/core/types";
import {
  FORMATS,
  buildExport,
  detectFormat,
  normalizeTotp,
  parseCsv,
  parseImport,
  suggestFileName,
  toCsv,
  type FormatId,
} from "../src/core/portable";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}
function okThrows(fn: () => unknown, needle: string, msg: string) {
  let got = "";
  try {
    fn();
  } catch (e: any) {
    got = String(e.message ?? e);
  }
  ok(got.includes(needle), `${msg} (${got.slice(0, 70)})`);
}
function e(p: Partial<Entry>): Entry {
  return newEntry(p);
}
function byTitle(list: Entry[], title: string): Entry {
  const x = list.find((i) => i.title === title);
  if (!x) throw new Error(`✗ 找不到条目 ${title}`);
  return x;
}

const BW_CSV = [
  "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
  '工作,1,login,GitHub,"第一行备注\n第二行备注","备用邮箱: a@b.c\n手机: 13800000000",0,https://github.com,me,pw123,JBSWY3DPEHPK3PXP',
  ',,note,便签条,"带 ""引号"" 的备注",,0,,,,',
].join("\r\n") + "\r\n";

const KP_XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile>
  <Meta><Generator>KeePassXC</Generator><DatabaseName>我的库</DatabaseName></Meta>
  <Root>
    <Group>
      <Name>工作</Name>
      <Group>
        <Name>生产环境</Name>
        <Entry>
          <String><Key>Title</Key><Value>GitLab</Value></String>
          <String><Key>UserName</Key><Value>ops</Value></String>
          <String Protected="True"><Key>Password</Key><Value>P&amp;ss&lt;1&gt;</Value></String>
          <String><Key>URL</Key><Value>https://gitlab.example</Value></String>
          <String><Key>Notes</Key><Value>行1
行2</Value></String>
          <String><Key>otp</Key><Value>otpauth://totp/GitLab?secret=JBSWY3DPEHPK3PXP&amp;issuer=x</Value></String>
          <String><Key>备用电话</Key><Value>13900000000</Value></String>
          <Times><CreationTime>2026-01-02T03:04:05Z</CreationTime><LastModificationTime>2026-02-03T04:05:06Z</LastModificationTime></Times>
        </Entry>
      </Group>
      <!-- 注释应被忽略 -->
      <Entry>
        <String><Key>Title</Key><Value>裸条目</Value></String>
        <String><Key>Password</Key><Value>solo</Value></String>
      </Entry>
    </Group>
  </Root>
</KeePassFile>`;

const LP_CSV = [
  "url,username,password,totp,extra,name,grouping,fav",
  "https://x.example,u,p,77,这是备注,站点名,社交/朋友,1",
].join("\r\n") + "\r\n";

const CHROME_CSV = [
  "name,url,username,password,note",
  "Chrome站点,https://c.example,cu,cp,note here",
].join("\r\n") + "\r\n";

async function main() {
  // ================= CSV 解析器 =================
  const rows = parseCsv('a,"b,c","d""e","f\ng"\r\nh,i,j,k\r\n');
  ok(rows.length === 2, "两行");
  ok(rows[0][1] === "b,c", "引号内的逗号不切分");
  ok(rows[0][2] === 'd"e', "双引号转义还原");
  ok(rows[0][3] === "f\ng", "引号内的换行保留");
  ok(rows[1][0] === "h" && rows[1][3] === "k", "第二行解析正确");

  const bom = parseCsv("\uFEFFa,b\n1,2\n");
  ok(bom[0][0] === "a", "BOM 被剥掉");

  const tricky = [["逗号,", '引号"', "换行\n", "普通", " 前导空格"]];
  const rt = parseCsv(toCsv(tricky));
  ok(rt.length === 1 && rt[0].length === 5, "toCsv → parseCsv 行数一致");
  ok(rt[0].every((v, i) => v === tricky[0][i]), "toCsv → parseCsv 逐格一致 (含逗号/引号/换行/空格)");

  // ================= 格式识别 =================
  ok(detectFormat(BW_CSV) === "bitwarden-csv", "识别 Bitwarden CSV");
  ok(detectFormat(KP_XML) === "keepass-xml", "识别 KeePass XML");
  ok(detectFormat(LP_CSV) === "lastpass-csv", "识别 LastPass CSV");
  ok(detectFormat(CHROME_CSV) === "chrome-csv", "识别 Chrome CSV");
  ok(detectFormat('{"encrypted":false,"folders":[],"items":[]}') === "bitwarden-json", "识别 Bitwarden JSON");
  ok(detectFormat('{"format":"aegis-portable","version":1,"entries":[]}') === "aegis-json", "识别神盾 JSON");
  ok(detectFormat('{"format":"aegis-vault","header":{}}') === null, "加密库文件不被当成可移植格式");
  // 加密导出仍归到 bitwarden-json, 由解析器抛出「请导未加密格式」的针对性错误
  ok(detectFormat('{"encrypted":true,"data":"xxx"}') === "bitwarden-json", "Bitwarden 加密导出 → 交给 bitwarden-json 分支报错");
  ok(detectFormat("乱七八糟") === null, "垃圾输入 → null");

  // ================= Bitwarden CSV =================
  const bw = parseImport(BW_CSV);
  ok(bw.format === "bitwarden-csv" && bw.entries.length === 2, "Bitwarden CSV 解析出 2 条");
  const gh = byTitle(bw.entries, "GitHub");
  ok(gh.username === "me" && gh.password === "pw123", "用户名/密码");
  ok(gh.url === "https://github.com", "URL");
  ok(gh.favorite === true, "favorite=1 → true");
  ok(gh.extra.group === "工作", "folder → extra.group");
  ok(gh.extra.totp === "JBSWY3DPEHPK3PXP", "login_totp → extra.totp");
  ok(gh.extra["field:备用邮箱"] === "a@b.c", "fields 列拆成自定义字段");
  ok(gh.extra["field:手机"] === "13800000000", "第二个自定义字段");
  ok(gh.notes.includes("第二行备注"), "多行备注保留");
  const noteRow = byTitle(bw.entries, "便签条");
  ok(noteRow.type === "note", "type=note → EntryType note");
  ok(noteRow.notes.includes('"引号"'), "备注里的引号还原");

  // ================= Bitwarden JSON =================
  const bwJson = JSON.stringify({
    encrypted: false,
    folders: [{ id: "f1", name: "家庭" }],
    items: [
      {
        id: "i1", folderId: "f1", type: 1, name: "银行", notes: "n", favorite: true,
        fields: [{ name: "卡号", value: "6222***", type: 0 }],
        login: {
          uris: [{ match: null, uri: "https://bank.example" }],
          username: "u", password: "p",
          totp: "otpauth://totp/x?secret=MZXW6YTBOI======",
        },
        creationDate: "2026-01-01T00:00:00.000Z",
        revisionDate: "2026-03-01T00:00:00.000Z",
      },
      { id: "i2", type: 2, name: "安全笔记", notes: "机密", secureNote: { type: 0 } },
      { id: "i3", type: 3, name: "一张卡" },
      { id: "i4", type: 4, name: "身份" },
    ],
  });
  const bwj = parseImport(bwJson);
  ok(bwj.entries.length === 2, "只导入 login + note, 跳过 card/identity");
  ok(bwj.warnings.some((w) => w.includes("银行卡")), "跳过项在 warnings 里说明");
  const bank = byTitle(bwj.entries, "银行");
  ok(bank.extra.group === "家庭", "folderId → folders 名称");
  ok(bank.extra["field:卡号"] === "6222***", "自定义字段");
  ok(bank.extra.totp === "MZXW6YTBOI======", "otpauth URL 抽出 secret");
  ok(bank.created_at === Date.parse("2026-01-01T00:00:00.000Z"), "creationDate 还原");

  okThrows(() => parseImport('{"encrypted":true,"data":"x"}', "bitwarden-json"), "加密导出", "Bitwarden 加密导出给出明确提示");

  // ================= KeePass XML =================
  const kp = parseImport(KP_XML);
  ok(kp.entries.length === 2, "KeePass XML 解析出 2 条");
  const gl = byTitle(kp.entries, "GitLab");
  ok(gl.username === "ops", "UserName 大小写不敏感匹配");
  ok(gl.password === "P&ss<1>", "XML 实体解码");
  ok(gl.extra.group === "工作/生产环境", "嵌套 Group 拼成路径");
  ok(gl.extra.totp === "JBSWY3DPEHPK3PXP", "otp 节点 → totp");
  ok(gl.notes.includes("行1") && gl.notes.includes("行2"), "多行 Notes");
  ok(gl.extra["field:备用电话"] === "13900000000", "额外 String 当自定义字段");
  ok(gl.created_at === Date.parse("2026-01-02T03:04:05Z"), "CreationTime 还原");
  ok(kp.entries.find((x) => x.title === "裸条目")?.extra.group === "工作", "直接挂在 Group 下的条目继承分组");

  okThrows(() => parseImport("<html><body>x</body></html>"), "无法识别", "非 KeePass XML 被拒绝");

  // ================= LastPass / Chrome =================
  const lp = parseImport(LP_CSV);
  const site = byTitle(lp.entries, "站点名");
  ok(site.username === "u" && site.password === "p" && site.notes === "这是备注", "LastPass 列序映射");
  ok(site.extra.group === "社交/朋友", "grouping → 分组");
  ok(site.extra.totp === "77" && site.favorite, "LastPass totp/fav");

  const ch = parseImport(CHROME_CSV);
  const cs = byTitle(ch.entries, "Chrome站点");
  ok(cs.url === "https://c.example" && cs.username === "cu" && cs.password === "cp", "Chrome 列映射");
  ok(cs.notes === "note here", "Chrome note → notes");

  // ================= 有密码列缺失时的提示 =================
  const noPw = parseImport("Title,Username\nA,B\n");
  ok(noPw.warnings.some((w) => w.includes("没有密码列")), "缺密码列时给出警告");

  // ================= 导出 → 再导入 往返 =================
  const src: Entry[] = [
    e({
      type: "login", title: "GitHub", username: "me", password: "S3cret!Pw#2026",
      url: "https://github.com", notes: "含逗号, 含\"引号\"\n还有换行",
      favorite: true, extra: { totp: "JBSWY3DPEHPK3PXP", group: "工作/生产环境", "field:备用邮箱": "a@b.c" },
    }),
    e({ type: "note", title: "保险箱密码", notes: "1234", extra: { group: "家庭" } }),
  ];

  const roundTrips: FormatId[] = ["aegis-json", "bitwarden-json", "bitwarden-csv", "keepass-csv", "keepass-xml", "plain-csv"];
  for (const f of roundTrips) {
    const out = buildExport(src, f);
    ok(out.count === 2 && out.content.length > 0, `${f}: 导出内容非空`);
    const back = parseImport(out.content);
    ok(back.entries.length === 2, `${f}: 重新导入 2 条`);
    const g = byTitle(back.entries, "GitHub");
    ok(g.password === "S3cret!Pw#2026", `${f}: 密码往返一致`);
    ok(g.url === "https://github.com", `${f}: URL 往返一致`);
    ok(g.extra.group === "工作/生产环境", `${f}: 分组路径往返一致`);
    ok(g.extra.totp === "JBSWY3DPEHPK3PXP", `${f}: TOTP 往返一致`);
    // KeePass 格式本身没有「笔记」这个概念 (全是 Entry), type 无法表达 → 不比对
    if (f !== "keepass-csv" && f !== "keepass-xml") {
      const n = byTitle(back.entries, "保险箱密码");
      ok(n.type === "note", `${f}: type=note 往返一致 (${n.type})`);
    }
  }

  // 明文 CSV 也保留备注里的逗号/引号/换行
  const plain = parseImport(buildExport(src, "plain-csv").content);
  ok(byTitle(plain.entries, "GitHub").notes === src[0].notes, "备注原文 (逗号/引号/换行) 完整往返");

  // 自定义字段只在支持它的格式里往返
  ok(byTitle(parseImport(buildExport(src, "aegis-json").content).entries, "GitHub").extra["field:备用邮箱"] === "a@b.c", "aegis-json 保留自定义字段");
  ok(byTitle(parseImport(buildExport(src, "keepass-xml").content).entries, "GitHub").extra["field:备用邮箱"] === "a@b.c", "keepass-xml 保留自定义字段");
  ok(byTitle(parseImport(buildExport(src, "bitwarden-json").content).entries, "GitHub").extra["field:备用邮箱"] === "a@b.c", "bitwarden-json 保留自定义字段");

  // Bitwarden CSV 的 type 列只允许 login/note
  const bwcsv = buildExport(src, "bitwarden-csv").content;
  ok(bwcsv.startsWith("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp"), "Bitwarden CSV 表头与官方一致");
  ok(bwcsv.includes(",note,") && bwcsv.includes(",login,"), "type 只用 login/note");

  // ================= 其它小工具 =================
  ok(normalizeTotp("otpauth://totp/A?secret=abcd&issuer=x") === "ABCD", "otpauth → 大写 secret");
  ok(normalizeTotp("  jbswy3dpehpk3pxp ") === "jbswy3dpehpk3pxp", "裸 Base32 原样(去空白)");
  ok(normalizeTotp("") === "", "空值返回空");
  ok(suggestFileName("bitwarden-csv", new Date("2026-10-02T00:00:00")) === "aegis-bitwarden-csv-20261002.csv", "建议文件名");
  ok(FORMATS.every((f) => f.plaintext), "所有格式都标记为明文 (UI 会二次确认)");
  ok(FORMATS.find((f) => f.id === "lastpass-csv")!.dir === "in", "LastPass 只读不写");

  console.log(`\n导入导出测试通过 ✔  (${passed} 项)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
