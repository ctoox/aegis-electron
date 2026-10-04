/**
 * 界面截图 (走 Chromium DevTools Protocol, 不碰窗口消息).
 *
 * 为什么不用 PrintWindow 抓窗口: 只能"看一眼", 点不动。而新增的几个界面
 * (设置页快照列表 / 历史弹窗 / 分享弹窗 / 解锁页"忘记主密码")全都藏在
 * 交互后面, 光截首屏等于没验证。走 CDP 既能派发点击, 又能拿渲染进程的
 * 精确像素 —— 而且完全不受"窗口有没有被遮挡/是否最小化"影响。
 *
 * 用法:
 *   node scripts/shot-ui.mjs --user-data-dir <目录> --password <主密码> [--out .visual]
 *   node scripts/shot-ui.mjs --user-data-dir <目录> --password <主密码> --exe C:\\app\\aegis\\AegisNext.exe
 *     ↑ 加 --exe 就是截打包产物的图: 打包漏文件 / asar 内路径不对, 只有跑真 exe 才发现得了
 *
 * ⚠ 与 smoke-electron.mjs 同源的两个环境坑: ELECTRON_RUN_AS_NODE 要清掉;
 *   必须用 Node spawn 起 Electron (从 shell 直接起会秒退)。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const USER_DATA = arg("user-data-dir");
const PASSWORD = arg("password");
const OUT = path.resolve(arg("out", path.join(ROOT, ".visual")));
const PORT = Number(arg("port", "9223"));
// --exe <路径>: 截打包产物的图而不是开发态
const exeArg = arg("exe");
const EXE = exeArg ? path.resolve(exeArg) : null;

if (!USER_DATA || !PASSWORD) {
  console.error(
    "用法: node scripts/shot-ui.mjs --user-data-dir <目录> --password <主密码> [--exe <打包产物>]",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------- 启动

function electronBin() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(ROOT, "node_modules", "electron", "dist", exe);
}

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 见 smoke-electron.mjs 文件头
  // --exe: 截打包产物的图 (开发态传 "." 即可). 打包漏文件这类问题只有跑真 exe 才发现
  const args = [];
  if (!EXE) args.push(".");
  args.push(`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`);
  return spawn(EXE ?? electronBin(), args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 轮询 /json 直到出现 type=page 的目标 */
async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  throw new Error(`等不到渲染进程调试目标 (${timeoutMs}ms): ${lastErr?.message ?? ""}`);
}

// ---------------------------------------------------------------- CDP

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 20000);
    });
  }

  /** 在页面主世界求值; 抛错会带上页面的异常文本 */
  async js(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "页面内抛错");
    }
    return r.result?.value;
  }

  async shot(file, { full = false } = {}) {
    // 想截整页就先临时把视口撑高 —— 设置页比一屏长得多
    if (full) {
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: 1000,
        height: 2400,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(500);
    }
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    if (full) {
      await this.send("Emulation.clearDeviceMetricsOverride");
      await sleep(200);
    }
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  📷 ${path.basename(file)}  (${kb} KB)`);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------- 页面动作

/** 按可见文字点按钮 (取文字最短的那个, 免得点到外层容器) */
const clickText = (text, sel = "button,a,[role=button]") => `
  const t = ${JSON.stringify(text)};
  const hit = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .filter((e) => e.textContent.trim().includes(t))
    .sort((a, b) => a.textContent.trim().length - b.textContent.trim().length)[0];
  if (!hit) return "NOTFOUND:" + t;
  hit.click();
  return "ok:" + (hit.className || hit.tagName);
`;

const clickSel = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "NOTFOUND:" + ${JSON.stringify(sel)};
  el.click();
  return "ok";
`;

/** 填 React 受控 input —— 直接改 .value 不会触发 onChange, 必须走原生 setter */
const fill = (sel, value, nth = 0) => `
  const els = document.querySelectorAll(${JSON.stringify(sel)});
  const el = els[${nth}];
  if (!el) return "NOTFOUND:" + ${JSON.stringify(sel)} + "#" + ${nth};
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
`;

/** 等某个选择器出现 */
async function waitFor(cdp, sel, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await cdp.js(`return !!document.querySelector(${JSON.stringify(sel)});`);
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

/**
 * 把弹窗滚到底, 检查带某段文字的按钮能不能被真正看到。
 * 返回 true/false. 高弹窗(比视口高)全靠遮罩层滚动, 按钮够不到就是 bug。
 */
async function scrollAndProbe(cdp, text) {
  const r = await cdp.js(`
    const mask = document.querySelector(".modal-mask");
    if (!mask) return "NOMASK";
    mask.scrollTop = mask.scrollHeight;
    const btn = [...document.querySelectorAll(".modal-btns button")]
      .find((b) => b.textContent.includes(${JSON.stringify(text)}));
    if (!btn) return "NOBTN";
    const b = btn.getBoundingClientRect();
    if (b.bottom <= innerHeight + 1 && b.top >= -1) return "ok";
    return "CLIPPED bottom=" + Math.round(b.bottom) + " vh=" + innerHeight;
  `);
  console.log(`    · 探针「${text}」→ ${r}`);
  return r === "ok";
}

/**
 * 侧栏探针: 把视口压矮, 检查底部的健康卡还在不在可视区里。
 *
 * 背景: 侧栏有十几个导航项, 窗口一矮整列就会溢出色栏, 健康卡被挤出可视区 ——
 * 而健康卡是"要么完整显示, 要么等于没有"的那类元素: 数字还在, 却没人看得见。
 * 正确行为是导航区自己滚 (.nav-scroll), 健康卡钉在底部。
 *
 * 只改渲染视口, 不动真实窗口 —— 复现"窗口小"而不影响用户正在看的画面。
 */
async function sidebarProbe(cdp, out) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 520,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  await cdp.shot(path.join(out, "03b-sidebar-short.png"));

  const raw = await cdp.js(`
    const card = document.querySelector(".sidebar .health-card");
    const nav = document.querySelector(".sidebar .nav-scroll");
    if (!card || !nav) return "NOMARKUP";
    const c = card.getBoundingClientRect();
    return JSON.stringify({
      top: Math.round(c.top),
      bottom: Math.round(c.bottom),
      vh: innerHeight,
      overflowY: getComputedStyle(nav).overflowY,
      canScroll: nav.scrollHeight > nav.clientHeight + 1,
    });
  `);

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(250);

  if (raw === "NOMARKUP") {
    console.log("    · 侧栏探针 → 没找到 .health-card / .nav-scroll");
    return false;
  }
  const s = JSON.parse(raw);
  console.log(
    `    · 侧栏探针 → 健康卡 ${s.top}~${s.bottom} / 视口高 ${s.vh}` +
      ` · nav-scroll overflow=${s.overflowY} 可滚=${s.canScroll}`,
  );
  const fullyVisible = s.top >= -1 && s.bottom <= s.vh + 1;
  const scrolls = s.overflowY === "auto" && s.canScroll;
  return fullyVisible && scrolls;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("界面截图 (CDP)");
  console.log(`  被测程序: ${EXE ?? "开发态 (node_modules/electron + .)"}`);
  console.log(`  渲染目录: ${OUT}`);
  console.log(`  数据目录: ${USER_DATA}\n`);

  const child = launch();
  const logs = [];
  child.stdout.on("data", (b) => logs.push(String(b)));
  child.stderr.on("data", (b) => logs.push(String(b)));

  let cdp = null;
  try {
    const page = await waitForPage();
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    check(true, `已连上渲染进程 (${page.url})`);

    // ---- 1. 解锁页 ----
    const gotGate = await waitFor(cdp, ".gate-card");
    check(gotGate, "解锁页已渲染 (.gate-card)");
    await sleep(600);
    await cdp.shot(path.join(OUT, "01-gate.png"));

    // ---- 2. 「忘记主密码？」→ 重置弹窗 ----
    console.log("\n重置弹窗");
    const r1 = await cdp.js(clickText("忘记主密码"));
    check(r1.startsWith("ok"), `点到「忘记主密码？」(${r1})`);
    const gotReset = await waitFor(cdp, ".sec-danger");
    check(gotReset, "重置弹窗已打开 (.sec-danger 警告块)");
    await sleep(400);
    await cdp.shot(path.join(OUT, "02-reset-modal.png"));
    check(await scrollAndProbe(cdp, "确认重置"), "「确认重置」滚到底后可达");
    await cdp.shot(path.join(OUT, "02b-reset-bottom.png"));
    await cdp.js(clickText("取消"));
    await sleep(400);

    // ---- 3. 解锁进主界面 ----
    console.log("\n解锁");
    await cdp.js(fill(".gate-input", PASSWORD, 0));
    await sleep(150);
    const r2 = await cdp.js(clickText("解锁"));
    check(r2.startsWith("ok"), `点了「解锁」(${r2})`);
    const gotMain = await waitFor(cdp, ".nav-item", 25000); // Argon2id 要算一会儿
    check(gotMain, "主界面已渲染 (.nav-item)");
    await sleep(900);
    await cdp.shot(path.join(OUT, "03-vault.png"));

    // ---- 3b. 矮窗口下侧栏会不会把健康卡挤出去 ----
    console.log("\n侧栏布局（压矮视口）");
    check(
      await sidebarProbe(cdp, OUT),
      "矮窗口下健康卡仍完整可见，导航区自己滚（不被挤出）",
    );

    // ---- 4. 条目详情里的 🕘 / 📤 ----
    const entryRows = await cdp.js(`
      const rows = document.querySelectorAll(".entry-list .row");
      if (rows[0]) rows[0].click();
      return rows.length;
    `);
    console.log(`  条目行数≈${entryRows}`);
    await sleep(600);
    await cdp.shot(path.join(OUT, "04-entry.png"));

    // ---- 5. 历史弹窗 ----
    // 演示库里只有个别条目改过核心字段, 所以逐条试: 打开历史 → 有 .hist-item 就停.
    // 顺带就把"历史确实记下来了"这件事验了。
    console.log("\n历史弹窗");
    let withHist = -1;
    const rowCount = Number(entryRows) || 0;
    for (let i = 0; i < rowCount && withHist < 0; i++) {
      // eslint-disable-next-line no-await-in-loop
      await cdp.js(`const r = document.querySelectorAll(".entry-list .row")[${i}]; if (r) r.click(); return "ok";`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(350);
      // eslint-disable-next-line no-await-in-loop
      await cdp.js(clickSel('[title="历史版本"]'));
      // eslint-disable-next-line no-await-in-loop
      const has = await waitFor(cdp, ".hist-item", 4000);
      if (has) {
        withHist = i;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await cdp.js(clickText("关闭"));
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    check(withHist >= 0, `第 ${withHist + 1} 个条目里有历史记录 (.hist-item)`);
    await sleep(400);
    await cdp.shot(path.join(OUT, "05-history.png"));
    await cdp.js(clickText("关闭"));
    await sleep(400);

    // ---- 6. 分享导出弹窗 ----
    console.log("\n分享弹窗");
    const r4 = await cdp.js(clickSel('[title="分享此条目"]'));
    await sleep(700);
    const gotShare = await cdp.js(`return !!document.querySelector(".share-scope");`);
    check(gotShare, "分享弹窗已打开 (.share-scope)");
    await sleep(600);
    await cdp.shot(path.join(OUT, "06-share-export.png"));
    check(await scrollAndProbe(cdp, "导出 1 条") || (await scrollAndProbe(cdp, "导出")), "分享弹窗的导出按钮滚到底后可达");
    await cdp.shot(path.join(OUT, "06b-share-bottom.png"));
    await cdp.js(clickText("取消"));
    await sleep(400);

    // ---- 7. 设置页 (整页, 因为比一屏长) ----
    console.log("\n设置页");
    const r5 = await cdp.js(clickText("设置", ".nav-item"));
    check(r5.startsWith("ok"), `点了「设置」(${r5})`);
    const gotSettings = await waitFor(cdp, ".settings-page");
    check(gotSettings, "设置页已渲染");
    await sleep(800);
    await cdp.shot(path.join(OUT, "07-settings.png"), { full: true });

    // ---- 8. 修改主密码弹窗 ----
    console.log("\n修改主密码弹窗");
    const r6 = await cdp.js(clickText("修改主密码"));
    check(r6.startsWith("ok"), `点了「修改主密码」(${r6})`);
    const gotPw = await waitFor(cdp, ".sec-note", 5000);
    check(gotPw, "改密码弹窗已打开 (.sec-note 说明块)");
    await sleep(500);
    await cdp.shot(path.join(OUT, "08-change-password.png"));
    check(await scrollAndProbe(cdp, "更换主密码"), "「更换主密码」滚到底后可达");

    // 提示语不重填就会被清空 —— 弹窗必须预填当前值。
    // 输入框顺序: 当前主密码 / 新主密码 / 再输一次 / 提示语, 所以取第 4 个。
    const hp = JSON.parse(
      String(
        await cdp.js(`
          // cdp.js 的外壳是同步 (() => {…})(), 顶层不能 await —— 用 async IIFE 包一层
          return (async () => {
            const st = await window.api.vault.status();
            const f = [...document.querySelectorAll(".modal .gate-input")];
            return JSON.stringify({ backend: st.hint, modal: f[3] ? f[3].value : null, n: f.length });
          })();
        `),
      ),
    );
    console.log(`    · 后端 hint=「${hp.backend}」 弹窗预填=「${hp.modal}」(${hp.n} 个输入框)`);
    check(String(hp.backend).length > 0, "演示库本身带提示语 (否则下面这条是空转)");
    check(hp.modal === hp.backend, "改密码弹窗预填了当前提示语 (不重填也不会被默默清空)");

    await cdp.js(clickText("取消"));
    await sleep(300);

    // ---- 剩余: 把设置页该有的新样式类断言一遍 (sec-note / sec-danger 在弹窗里,
    //      上面两个弹窗步骤已经各自验过了) ----
    console.log("\n设置页新增样式类");
    const cls = await cdp.js(`
      // sec-hint / at-hotkey / at-flag 是「⌨ 快速填充」那一节的 ——
      // 光看 settings-page 渲染出来不算数, 得确认那一节真的进了 DOM。
      const want = ["sec-divider", "snap-list", "snap-act", "btn-danger", "sec-hint", "at-hotkey", "at-flag"];
      const html = document.documentElement.outerHTML;
      return want.map((c) => c + "=" + html.includes(c)).join(" ");
    `);
    console.log(`  ${cls}`);
    for (const part of String(cls).split(" ")) {
      const [name, ok] = part.split("=");
      check(ok === "true", `设置页 DOM 里出现 ${name}`);
    }

    // ---- 9. 快速填充（Auto-Type）----
    //   这一组是**安全护栏**: "面板看不到密码"和"面板弹出来不会把自己的库锁掉"
    //   都属于"改坏了不会报错、只会静默变危险"的那一类, 必须由脚本盯着。
    //   设计依据: docs/AUTOTYPE-DESIGN.md §5.3 / §5.5 / §12.2
    console.log("\n快速填充（Auto-Type）");

    // (1) 面板是"密码盲"的 —— atype:entries 的返回对象里不许出现 password 键
    const blind = JSON.parse(
      String(
        await cdp.js(`
          return (async () => {
            const list = await window.api.atype.entries();
            const leaked = list.filter((e) => Object.prototype.hasOwnProperty.call(e, "password"));
            return JSON.stringify({
              n: list.length,
              leaked: leaked.length,
              keys: list.length ? Object.keys(list[0]).sort().join("/") : "",
            });
          })();
        `),
      ),
    );
    console.log(`    · 面板拿到 ${blind.n} 条, 字段 = ${blind.keys}`);
    check(blind.n > 0, "演示库里有可填充条目 (否则下面那条是空转)");
    check(blind.leaked === 0, "★ atype:entries 不含 password 字段 (面板是密码盲的)");

    // (2) 可用性必须是"能/不能 + 非空原因", 界面要靠 reason 显示为什么会降级
    const av = JSON.parse(String(await cdp.js(`return (async () => JSON.stringify(await window.api.atype.available()))();`)));
    console.log(`    · available = ${JSON.stringify(av)}`);
    check(typeof av.ok === "boolean", "available() 返回 ok 布尔");
    check(av.ok || String(av.reason).length > 0, "不可用时必须给出非空原因 (设置页要显示它)");

    // (3) 条目不存在时不许抛 —— 面板传进来的 id 可能是刚被删掉的
    const bad = JSON.parse(
      String(
        await cdp.js(`
          return (async () => {
            try {
              const r = await window.api.atype.run("no-such-entry-id", null);
              return JSON.stringify({ threw: false, r });
            } catch (e) {
              return JSON.stringify({ threw: true, msg: String(e && e.message) });
            }
          })();
        `),
      ),
    );
    check(bad.threw === false, `条目不存在时 atype:run 不抛错${bad.threw ? ` (实际抛了: ${bad.msg})` : ""}`);
    check(bad.r && bad.r.ok === false, "条目不存在时返回 {ok:false, how:...} 而不是抛");

    // (4) 面板是独立窗口, 且连开两次不会叠出第二个 (人工清单第 7 条自动化)
    const countPanel = async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      return list.filter((t) => t.type === "page" && String(t.url).includes("#/fill")).length;
    };
    check((await countPanel()) === 0, "唤出之前没有 #/fill 面板窗口 (预置条件)");
    check((await cdp.js(`return window.api.atype.open()`)) === true, "面板已唤出");
    await sleep(500);
    const n1 = await countPanel();
    check(n1 === 1, `面板作为独立窗口存在, 且只有 1 个 (实际 ${n1})`);
    check((await cdp.js(`return window.api.atype.open()`)) === true, "再唤出一次");
    await sleep(500);
    const n2 = await countPanel();
    check(n2 === 1, `连开两次仍是 1 个面板窗口, 没有叠窗 (实际 ${n2})`);

    // (4b) 面板**自己**那个渲染进程里, 条目真的渲染成了行。
    //   上面几条只能证明"窗口在、数据在", 证明不了"界面画出来了" ——
    //   列表为空时面板会显示 .fp-empty, 那是另一条分支, 必须分开断言。
    //   顺便拍一张图: 这个界面此前从来没人看过长什么样。
    const panelTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(
      (t) => t.type === "page" && String(t.url).includes("#/fill"),
    );
    const panelCdp = await Cdp.connect(panelTarget.webSocketDebuggerUrl);
    try {
      check(await waitFor(panelCdp, ".fillpanel", 5000), "面板 React 已挂载 (.fillpanel)");
      await sleep(400);
      const panelDom = JSON.parse(
        String(
          await panelCdp.js(`
            return JSON.stringify({
              rows: document.querySelectorAll(".fp-row").length,
              empty: document.querySelectorAll(".fp-empty").length,
              tag: (document.querySelector(".fp-tag") || {}).textContent || "",
            });
          `),
        ),
      );
      console.log(`    · 面板渲染 ${panelDom.rows} 行, 首行填法标签 = 「${panelDom.tag}」`);
      check(panelDom.rows >= 1, `面板把条目渲染成了行 (实际 ${panelDom.rows} 行)`);
      check(panelDom.empty === 0, "面板没有落到「无条目」空状态");
      await panelCdp.shot(path.join(OUT, "10-fillpanel.png"));
    } finally {
      panelCdp.close();
    }

    // (5) ★ 「失焦即锁」不被自己弹出的面板触发 (AUTOTYPE-DESIGN §5.5)
    //     旧代码里主窗口的 blur 处理器无条件锁库, 而面板抢焦点必然触发 blur ——
    //     结果是"一开快速填充就把自己的库锁了"。这条探针就是那个 bug 的回归护栏。
    //
    //     ⚠ 必须先收起面板、把主窗口拉回前台, 否则"失焦"是上一步 (4) 留下的状态:
    //     面板还开着时再 open() 不会产生第二次 blur, 断言就成了空转。
    //     这不是假想 —— 第一版探针就这么写的, 在"故意删掉让路逻辑"的代码上照样绿。
    await cdp.js(`return window.api.atype.cancel()`);
    await sleep(600);
    await cdp.send("Page.bringToFront");
    await sleep(600);
    check((await cdp.js(`return document.hasFocus()`)) === true, "预置条件: 主窗口已回到前台并持有焦点");
    await cdp.js(`return window.api.settings.set({ lockOnBlur: true })`);
    await sleep(300);
    await cdp.js(`return window.api.atype.open()`);
    await sleep(1200);
    const blurProbe = JSON.parse(
      String(
        await cdp.js(`
          return (async () => JSON.stringify({
            mainFocused: document.hasFocus(),
            unlocked: (await window.api.vault.status()).unlocked,
          }))();
        `),
      ),
    );
    console.log(`    · 主窗口失焦=${!blurProbe.mainFocused} · 库仍解锁=${blurProbe.unlocked}`);
    // 反空转: 主窗口要是没失焦, 下面那条断言就是白过
    check(blurProbe.mainFocused === false, "预置条件: 面板弹出后主窗口确实失去了焦点");
    check(blurProbe.unlocked === true, "★ 开了「失焦即锁」时弹出填充面板, 库仍然保持解锁");
    await cdp.js(`return window.api.settings.set({ lockOnBlur: false })`);
    await cdp.js(`return window.api.atype.cancel()`); // 收起面板, 别影响后面的步骤
    await sleep(300);

    // ---- 10. 改提示 → 锁库 → 解锁页必须显示【新】提示 ----
    //   这是本 bug 的正面复现。旧代码只在启动时读一次 hint, 所以"改提示 → 锁库"
    //   之后解锁页显示的还是旧值, 用户看到的就是"提示改不动"。
    //   这里只比对新旧不等的两个值才有意义(改完再锁库显示旧值 = 复现)。
    //   核心拒绝新旧主密码同值, 所以必须连密码一起换 —— 跑完再把两者都还原,
    //   保证脚本对着同一个演示目录可以反复跑。放最后: 一锁定就离开设置页。
    console.log("\n改提示 → 锁库 → 解锁页显示的应是新提示");
    const MARK = `巡检提示-${Date.now()}`;
    const TMP_PW = "visual-check-123#tmp";
    const sw = JSON.parse(
      String(
        await cdp.js(`
          return (async () => {
            const v = window.api.vault;
            const orig = (await v.status()).hint;
            await v.changePassword(${JSON.stringify(PASSWORD)}, ${JSON.stringify(TMP_PW)}, ${JSON.stringify(MARK)});
            return JSON.stringify({ orig, after: (await v.status()).hint });
          })();
        `),
      ),
    );
    console.log(`    · 后端提示: 「${sw.orig}」→「${sw.after}」`);
    check(sw.after === MARK, "后端已写入新提示");

    // 走界面上的锁定按钮 (或直接调 API 也会收到 vault:locked), 让 App 回到解锁页
    const rLock = await cdp.js(clickText("锁定密码库", ".nav-item"));
    check(rLock.startsWith("ok"), `点了「锁定密码库」(${rLock})`);
    check(await waitFor(cdp, ".gate-card"), "已回到解锁页 (.gate-card)");
    await sleep(600);

    const shown = await cdp.js(`
      const el = document.querySelector(".gate-hint");
      return el ? el.textContent.trim() : "";
    `);
    console.log(`    · 解锁页显示: 「${shown}」  期望含: 「${MARK}」`);
    check(String(shown).includes(MARK), "解锁页显示【新】提示 (不是启动时缓存/旧的那条)");
    await cdp.shot(path.join(OUT, "09-unlock-hint.png"));

    // 还原主密码与提示, 让演示目录可重复使用
    const restored = await cdp.js(`
      return (async () => {
        const v = window.api.vault;
        await v.unlock(${JSON.stringify(TMP_PW)});
        await v.changePassword(${JSON.stringify(TMP_PW)}, ${JSON.stringify(PASSWORD)}, ${JSON.stringify(sw.orig)});
        await v.lock();
        return (await v.status()).hint;
      })();
    `);
    check(String(restored) === sw.orig, `已还原主密码与提示 (hint=「${restored}」)`);
  } catch (e) {
    check(false, `流程中断: ${e.message}`);
    const out = logs.join("");
    if (out.trim()) console.log("---- 应用输出 ----\n" + out.trim().slice(0, 3000) + "\n------------------");
  } finally {
    cdp?.close();
    child.kill();
    await sleep(800);
    child.kill("SIGKILL");
  }

  console.log(
    failures === 0
      ? `\n截图完成 ✔  产物在 ${OUT}`
      : `\n截图有 ${failures} 项不对 ✘ (图仍然生成了, 先看图)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
