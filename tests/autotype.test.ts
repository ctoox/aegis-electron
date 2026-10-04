/**
 * 快速填充「序列编译器」测试（纯逻辑, 无 GUI / 无需键盘）。
 *
 * 断言的是 `src/core/autotype.ts` 的**可观察行为**: 给定条目 + 填法 → 得到什么按键序列。
 * 规格来自设计文档 docs/AUTOTYPE-DESIGN.md 第 12.1 节, 逐条对应当年 Python 版
 * `aegis_core/autotype.py` 的注释里写明的边界。
 *
 * 最要紧的两组:
 *   · 空值孤立导航键 —— 用户名空时那个 Tab 必须消失, 否则密码会打进错误的输入框
 *   · 降级规则一致性 —— "界面上写的" 与 "实际会按键的" 必须是同一份规则
 */
import {
  AutoTypeError,
  DEFAULT_CUSTOM_TEMPLATE,
  EMPTY,
  PLACEHOLDER_NAMES,
  buildSequence,
  describeSequence,
  effectiveMode,
  effectiveTemplate,
  expandTemplate,
  fillModeOf,
  isFillable,
  modeSummary,
  preview,
  setFillMode,
  setFillTemplate,
  unknownPlaceholders,
  validateTemplate,
  type Token,
} from "../src/core/autotype";
import { FILL_BOTH, FILL_CUSTOM, fillLabel, type FillMode } from "../src/core/prefs";
import type { Entry } from "../src/core/types";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`,
  );
}

const t = (s: string): Token => ({ kind: "text", value: s });
const k = (s: string): Token => ({ kind: "key", value: s });

function E(patch: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    type: "login",
    title: "GitHub",
    username: "me",
    password: "s3cret",
    url: "https://github.com",
    notes: "",
    favorite: false,
    created_at: 0,
    updated_at: 0,
    extra: {},
    ...patch,
  };
}

/** 断言某次调用抛 AutoTypeError, 且消息里含关键字 */
function throws(fn: () => unknown, needle: string, msg: string) {
  try {
    fn();
  } catch (e) {
    const isOur = e instanceof AutoTypeError;
    const hasNeedle = String((e as Error).message).includes(needle);
    ok(isOur && hasNeedle, `${msg} (实际: ${(e as Error).message})`);
    return;
  }
  throw new Error(`✗ ${msg} —— 期望抛错但没有`);
}

/**
 * 编译 + 渲染预览。**必须把密码作为 secrets 传进去**, 否则 describeSequence
 * 不知道哪段是秘密、就不会打码（这是它的设计: 打码依据是"值等于哪个秘密", 不是猜）。
 */
const seq = (e: Entry, opts: Parameters<typeof buildSequence>[1] = {}) =>
  describeSequence(buildSequence(e, opts), [e.password]);

function main() {
  // ============================================================ 三种内置填法
  console.log("\n-- 三种内置填法 --");
  eq(buildSequence(E(), { mode: "both" }), [t("me"), k("Tab"), t("s3cret")], "both → 账号 Tab 密码");
  eq(buildSequence(E(), { mode: "password" }), [t("s3cret")], "password → 只有密码");
  eq(buildSequence(E(), { mode: "username" }), [t("me")], "username → 只有账号");
  eq(
    buildSequence(E()),
    [t("me"), k("Tab"), t("s3cret")],
    "不指定填法时默认走 both",
  );
  eq(
    buildSequence(E({ extra: { fill: "password" } })),
    [t("s3cret")],
    "条目自带的 extra.fill 优先于默认值",
  );

  // ============================================================ 空值孤立导航键
  console.log("\n-- 空值孤立导航键（最要紧的一组）--");
  // 自定义模板才能绕开降级、真正走到 dropEmptyEdges
  eq(
    buildSequence(E({ username: "" }), { template: "{USERNAME}{TAB}{PASSWORD}" }),
    [t("s3cret")],
    "用户名空 → 空值后面的 Tab 被删掉（不然密码会打进账号框）",
  );
  eq(
    buildSequence(E({ password: "" }), { template: "{USERNAME}{TAB}{PASSWORD}" }),
    [t("me")],
    "密码空 → 空值前面的 Tab 也被删掉",
  );
  eq(
    buildSequence(E({ username: "" }), { template: "{PASSWORD}{TAB}{USERNAME}" }),
    [t("s3cret")],
    "空值在尾部 → 它前面的 Tab 一并删掉",
  );
  eq(
    buildSequence(E(), { template: "{USERNAME}{TAB}" }),
    [t("me"), k("Tab")],
    "用户故意写在结尾的 Tab 原样保留（值不为空, 不是孤立键）",
  );
  eq(
    buildSequence(E({ username: "" }), { template: "{TAB}{TAB}{USERNAME}{PASSWORD}" }),
    [t("s3cret")],
    "连续多个被孤立的导航键全部删掉",
  );
  eq(
    buildSequence(E({ username: "" }), { template: "{USERNAME}{ENTER}{PASSWORD}" }),
    [t("s3cret")],
    "被孤立的 Enter 与 Tab 同等处理",
  );
  eq(
    buildSequence(E({ username: "" }), { template: "{USERNAME}{DELAY:300}{PASSWORD}" }),
    [{ kind: "delay", value: 300 }, t("s3cret")],
    "被孤立的 DELAY **不删**（只清理 Tab/Enter 这两个导航键）",
  );

  // ============================================================ 模板校验
  console.log("\n-- 自定义模板校验 --");
  eq(unknownPlaceholders("{USERNAME}{TAB}{PASSWORD}"), [], "合法模板没有可疑占位符");
  eq(unknownPlaceholders("{FOO}"), ["{FOO}"], "认不出的占位符被列出");
  eq(unknownPlaceholders("{USERNAME}{OOPS}"), ["{OOPS}"], "只列错的那个");
  eq(
    expandTemplate("{USERNAME}", E()),
    [t("me")],
    "expandTemplate 认得出字段占位符",
  );
  eq(expandTemplate("{TITLE}", E()), [t("GitHub")], "{TITLE} 取 title");
  eq(expandTemplate("{URL}", E()), [t("https://github.com")], "{URL} 取 url");
  eq(expandTemplate("{USERNAME}", E({ username: "" })), [EMPTY], "空字段展成哨兵而不是跳过");
  eq(expandTemplate("a{USERNAME}b", E()), [t("a"), t("me"), t("b")], "字面量与占位符混排");

  eq(validateTemplate(""), "模板不能为空", "空模板");
  eq(validateTemplate("   "), "模板不能为空", "纯空白模板按空处理");
  ok(
    (validateTemplate("{FOO}") ?? "").includes("认不出的占位符"),
    "含未知占位符 → 报错",
  );
  eq(
    validateTemplate("{TAB}"),
    "模板里至少要有一个 {USERNAME} / {PASSWORD} / {TITLE} / {URL}",
    "只有按键没有字段 → 报错",
  );
  ok((validateTemplate("{DELAY:abc}") ?? "").includes("认不出的占位符"), "{DELAY:abc} → 报错");
  ok((validateTemplate("{DELAY}") ?? "").includes("认不出的占位符"), "光有 {DELAY} 没参数 → 报错");
  eq(validateTemplate("{USERNAME}{DELAY:300}{TAB}{PASSWORD}"), null, "{DELAY:300} 合法");
  eq(validateTemplate("{USERNAME}{TAB}{PASSWORD}"), null, "标准模板合法");
  // 比 Python 版严的一条：原版会放过 {TAB:5}，然后把它当字面量打进目标窗口
  ok(
    (validateTemplate("{TAB:5}{USERNAME}") ?? "").includes("认不出的占位符"),
    "非 DELAY 的占位符不许带参数（{TAB:5} → 报错, 否则会被当成字面量打出去）",
  );
  eq(validateTemplate("{ESC}{USERNAME}"), null, "{ESC} 是合法别名");

  throws(() => buildSequence(E(), { template: "{FOO}" }), "认不出的占位符", "非法模板不能编译");
  throws(
    () => buildSequence(E({ username: "", password: "" }), { mode: "both" }),
    "没有可填充的内容",
    "字段全空 → 明确报错而不是发一个空序列",
  );

  // ============================================================ 降级矩阵
  console.log("\n-- 降级矩阵（effectiveMode）--");
  const onlyPw = E({ username: "" });
  const onlyUser = E({ password: "" });
  const modes: FillMode[] = ["both", "password", "username"];

  eq(effectiveMode(E(), "both"), "both", "both + 双字段 → both");
  eq(effectiveMode(onlyPw, "both"), "password", "both + 缺账号 → 只填密码");
  eq(effectiveMode(onlyUser, "both"), "username", "both + 缺密码 → 只填账号");

  eq(effectiveMode(E(), "password"), "password", "password + 双字段 → password");
  eq(effectiveMode(onlyPw, "password"), "password", "password + 缺账号 → password");
  eq(effectiveMode(onlyUser, "password"), "username", "password + 缺密码 → 降级为只填账号");

  eq(effectiveMode(E(), "username"), "username", "username + 双字段 → username");
  eq(effectiveMode(onlyPw, "username"), "password", "username + 缺账号 → 降级为只填密码");
  eq(effectiveMode(onlyUser, "username"), "username", "username + 缺密码 → username");

  eq(effectiveMode(E(), "custom"), "custom", "custom 不降级");
  eq(effectiveMode(onlyPw, "custom"), "custom", "custom 缺账号也不降级（模板里自己删字段）");
  eq(effectiveMode(E({ extra: { fill: "password" } })), "password", "不传 mode 时读条目自带的");
  eq(effectiveMode(E({ extra: { fill: "垃圾" } })), FILL_BOTH, "条目里是非法值时退回默认");
  eq(effectiveMode(E(), null, "username"), "username", "defaultMode 生效");

  // 降级后的实际按键必须与降级结果一致（不是只改了显示）
  eq(buildSequence(onlyPw, { mode: "both" }), [t("s3cret")], "降级后的实际按键 = 只打密码");
  eq(buildSequence(onlyUser, { mode: "both" }), [t("me")], "降级后的实际按键 = 只打账号");

  // ============================================================ modeSummary 一致性
  console.log("\n-- modeSummary 与 effectiveMode 必须同源 --");
  eq(modeSummary(E()), "用户名 + 密码", "双字段 → 显示 both");
  eq(modeSummary(onlyPw), "只填密码（这条没有用户名）", "缺账号 → 显示降级并说明原因");
  eq(modeSummary(onlyUser), "只填用户名（这条没有密码）", "缺密码 → 显示降级并说明原因");
  eq(modeSummary(E({ extra: { fill: "password" } })), "只填密码", "条目自带填法直接显示");

  // 一致性：modeSummary 去掉括号里的原因后, 必须等于 fillLabel(effectiveMode(...))
  for (const e of [E(), onlyPw, onlyUser, E({ extra: { fill: "password" } }), E({ extra: { fill: "username" } })]) {
    const shown = modeSummary(e).replace(/（.*$/, "");
    eq(shown, fillLabel(effectiveMode(e)), `显示与实际的填法一致：${modeSummary(e)}`);
  }

  // ============================================================ 预览渲染
  console.log("\n-- 预览渲染 --");
  eq(seq(E(), { mode: "both" }), "me → [Tab] → ••••••", "预览用 → 分隔, 密码打码成 •");
  eq(
    describeSequence(buildSequence(E(), { mode: "both" })),
    "me → [Tab] → s3cret",
    "不传 secrets 就不打码（调用方必须显式告诉它哪个值是秘密）",
  );
  ok(!seq(E(), { mode: "both" }).includes("▸"), "预览里不许出现 ▸(U+25B8) —— 会渲染成豆腐块");
  ok(!seq(E(), { mode: "both" }).includes("s3cret"), "预览绝不泄露明文密码");
  eq(
    seq(E(), { template: "{USERNAME}{DELAY:300}{TAB}{PASSWORD}" }),
    "me → [等待300ms] → [Tab] → ••••••",
    "停顿渲染成 [等待Nms]",
  );
  eq(
    seq(E({ password: "x".repeat(30) }), { mode: "password" }),
    "•".repeat(10),
    "打码长度封顶 10 个 •（不泄露密码长度）",
  );
  ok(
    seq(E({ username: "u".repeat(200) }), { mode: "username" }).endsWith("…"),
    "超长预览截断并加省略号",
  );
  eq(preview(E(), { mode: "both" }), "me → [Tab] → ••••••", "preview 一步到位（自己带上密码）");
  ok(
    preview(E({ username: "", password: "" })).startsWith("无法填充："),
    "preview 编译失败时返回人话而不是抛错",
  );

  // ============================================================ autoSubmit
  console.log("\n-- autoSubmit --");
  eq(
    buildSequence(E(), { mode: "both", autoSubmit: true }),
    [t("me"), k("Tab"), t("s3cret"), k("Enter")],
    "autoSubmit 在末尾补一个回车",
  );
  eq(
    buildSequence(onlyPw, { mode: "both", autoSubmit: true }),
    [t("s3cret"), k("Enter")],
    "autoSubmit 不影响降级结果",
  );
  eq(buildSequence(E(), { mode: "both" }).length, 3, "不传 autoSubmit 就不补回车");

  // ============================================================ extra 兼容性
  console.log("\n-- extra.fill / extra.fill_template --");
  eq(fillModeOf(E({ extra: { fill: "password" } })), "password", "读得到 extra.fill");
  eq(fillModeOf(E({ extra: { fill: "垃圾" } })), FILL_BOTH, "非法 extra.fill → 默认");
  eq(fillModeOf(E({ extra: { fill: "垃圾" } }), "username"), "username", "非法 extra.fill → 给定的默认值");
  eq(fillModeOf(E()), FILL_BOTH, "没有 extra.fill → 默认");

  eq(
    effectiveTemplate(E({ extra: { fill_template: "{PASSWORD}{ENTER}" } }), "custom"),
    "{PASSWORD}{ENTER}",
    "custom 用条目自己的模板",
  );
  eq(effectiveTemplate(E(), "custom"), DEFAULT_CUSTOM_TEMPLATE, "custom 没模板 → 内置默认模板");
  eq(effectiveTemplate(E(), "both"), "{USERNAME}{TAB}{PASSWORD}", "内置模板不受 extra 影响");

  const e2 = E();
  setFillMode(e2, "password");
  eq(e2.extra.fill, "password", "setFillMode 写得进去");
  eq(fillModeOf(e2), "password", "写入后读得出来");
  setFillMode(e2, null);
  eq("fill" in e2.extra, false, "setFillMode(null) 清除而不是写空串");
  setFillTemplate(e2, "  {USERNAME}  ");
  eq(e2.extra.fill_template, "{USERNAME}", "setFillTemplate 去掉首尾空白");
  setFillTemplate(e2, "   ");
  eq("fill_template" in e2.extra, false, "setFillTemplate('') 清除");
  throws(() => setFillMode(e2, "垃圾" as FillMode), "未知填充方式", "setFillMode 非法值抛错");

  // 一条完整往返：写入 → 编译 → 用自定义模板
  const e3 = E({ extra: { fill: "custom", fill_template: "{USERNAME}{TAB}{PASSWORD}{ENTER}" } });
  eq(
    buildSequence(e3),
    [t("me"), k("Tab"), t("s3cret"), k("Enter")],
    "extra 里的自定义模板能一路走到按键序列",
  );

  // ============================================================ isFillable
  console.log("\n-- isFillable --");
  eq(isFillable(E()), true, "有账号的登录条目可填");
  eq(isFillable(E({ username: "", password: "x" })), true, "只有密码也可填");
  eq(isFillable(E({ username: "", password: "" })), false, "账号密码都空 → 不可填");
  eq(isFillable(E({ type: "note" })), false, "非登录类型不可填");
  eq(isFillable(E({ type: "bank" })), false, "银行卡类型不可填");

  // ============================================================ 导出给界面的常量
  console.log("\n-- PLACEHOLDER_NAMES --");
  ok(PLACEHOLDER_NAMES.includes("DELAY"), "含 DELAY");
  ok(PLACEHOLDER_NAMES.includes("USERNAME"), "含 USERNAME");
  ok(PLACEHOLDER_NAMES.includes("ESCAPE"), "含 ESCAPE 别名");
  eq([...PLACEHOLDER_NAMES].sort(), [...PLACEHOLDER_NAMES], "已排序（渲染稳定）");

  console.log(`\n快速填充编译器测试通过 ✔  (${passed} 项)`);
}

main();
