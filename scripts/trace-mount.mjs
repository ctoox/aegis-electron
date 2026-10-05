/**
 * 「某一页第一次挂载」到底把时间花在哪 —— 事件级时间线，不是三个桶。
 *
 * 为什么需要它：
 *   `Performance.getMetrics` 只给 ScriptDuration / RecalcStyleDuration / LayoutDuration
 *   三个累计桶。它能把"设置页首次挂载要 450ms 布局"这个**事实**摆出来，但答不了
 *   "450ms 里 是谁在干活" —— 尤其当消融了 backdrop-filter 之后还剩 290ms 的时候。
 *   本脚本用 CDP `Tracing` 抓 devtools.timeline，按事件名聚合 + 列出单个最贵事件。
 *
 * 关键读数（见输出）：
 *   - 「最贵单个事件」：如果是一个 200ms+ 的 `Layout`，那就是**一次巨大的布局**，
 *     修法是简化 DOM/CSS；如果是几十个 10ms 的 `FunctionCall`，那是 JS 在干活。
 *   - 「按名聚合」里 `PrePaint` / `Paint` / `CompositeLayers` 大 → 是**栅格/绘制**，
 *     软件渲染下贵是正常的，修法是减少绘制面积/复杂度（比如少用 backdrop-filter）。
 *   - `RunTask` 之和 ≈ 主线程真正忙了多久。
 *
 * ⚠ 聚合表是**嵌套求和**（子事件的时间被父事件包着又算了一遍），所以它只用来做
 *   **相对归因**（谁比谁大一个量级），不能各项相加当总时长。总时长只看 RunTask。
 *
 * 用法:
 *   npm run trace:mount -- --user-data-dir <演示库目录> --password <主密码> --target 设置
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
const TARGET = arg("target", "设置");
const OVERRIDE = arg("override");
const PORT = Number(arg("port", "9228"));
const KEEP = arg("keep-trace"); // 传路径则把原始 trace 落到磁盘，便于用 DevTools 打开

if (!USER_DATA || !PASSWORD) {
  console.error(
    "用法: npm run trace:mount -- --user-data-dir <目录> --password <主密码> [--target 设置] [--keep-trace <路径>]",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(ROOT, "node_modules", "electron", "dist", exe);
}

function launch(extra = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 见 smoke-electron.mjs 文件头
  return spawn(
    electronBin(),
    [".", `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`, ...extra],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error("等不到渲染进程调试目标");
}

/** 极简 CDP 客户端 + 事件订阅（Tracing 靠事件推送拿数据） */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
        return;
      }
      // 通知（method 事件）
      for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
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
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} 超时`)), 60000);
    });
  }
  async js(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? "页面内抛错");
    }
    return r.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 聚合 trace：事件名 → {count, durMs} */
function aggregate(events) {
  const byName = new Map();
  for (const e of events) {
    if (e.ph !== "X" && e.ph !== "B") continue;
    const dur = e.dur ?? 0;
    const cur = byName.get(e.name) ?? { count: 0, dur: 0 };
    cur.count++;
    cur.dur += dur;
    byName.set(e.name, cur);
  }
  return [...byName.entries()]
    .map(([name, v]) => ({ name, count: v.count, ms: v.dur / 1000 }))
    .sort((a, b) => b.ms - a.ms);
}

async function main() {
  const proc = launch();
  const page = await waitForPage();
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront");

  // 解锁
  for (let i = 0; i < 60; i++) {
    if (await cdp.js(`return !!document.querySelector(".gate-card input");`)) break;
    await sleep(500);
  }
  await cdp.js(`
    const el = document.querySelector(".gate-card input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(PASSWORD)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  `);
  await sleep(300);
  await cdp.js(`
    const b = [...document.querySelectorAll("button")].find((x) => /解锁|进入/.test(x.textContent));
    if (b) b.click(); return "ok";
  `);
  for (let i = 0; i < 60; i++) {
    if (await cdp.js(`return !!document.querySelector(".app");`)) break;
    await sleep(400);
  }
  await sleep(2000); // 让启动渲染/字体预热彻底安静下来，别把它们的账算到本次挂载头上

  if (OVERRIDE) {
    await cdp.js(`
      const s = document.createElement("style");
      s.id = "trace-override";
      s.textContent = ${JSON.stringify(OVERRIDE)};
      document.head.appendChild(s);
      return "ok";
    `);
    await sleep(500);
    console.log(`已注入 --override: ${OVERRIDE}`);
  }

  const here = await cdp.js(`
    const nav = [...document.querySelectorAll(".nav-item")].map((e) => e.textContent.trim());
    return JSON.stringify(nav);
  `);
  console.log(`当前导航: ${here}`);
  console.log(`目标页: 「${TARGET}」的**首次**挂载（脚本启动后还没打开过它）\n`);

  // ---- 开抓 ----
  const chunks = [];
  let done = false;
  cdp.on("Tracing.dataCollected", (p) => chunks.push(...(p.value ?? [])));
  cdp.on("Tracing.tracingComplete", () => {
    done = true;
  });
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,toplevel,blink,v8,cc,rail",
    options: "record-until-full",
    bufferUsageReportingInterval: 2000,
    transferMode: "ReportEvents",
  });
  await sleep(120);

  // 同时挂一个 long-animation-frame 观察器（Chrome 123+，LoAF）。
  // trace 只告诉我们"哪一类事件慢"，LoAF 会把一个长帧拆成 script / style+layout
  // 两段并**点名是哪个函数**（sourceFunctionName）—— 这是"谁干的"的唯一直接证据。
  await cdp.js(`
    window.__loaf = [];
    window.__long = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          window.__loaf.push({
            dur: Math.round(e.duration),
            start: Math.round(e.startTime),
            renderStart: Math.round(e.renderStart || 0),
            styleLayoutStart: Math.round(e.styleAndLayoutStart || 0),
            scripts: (e.scripts || []).map((s) => ({
              name: s.name, type: s.invokerType, d: Math.round(s.duration),
              src: (s.sourceURL || "").split("/").pop(), fn: s.sourceFunctionName || "",
            })),
          });
        }
      }).observe({ type: "long-animation-frame", buffered: false });
    } catch (err) { window.__loafErr = String(err); }
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
      }).observe({ type: "longtask", buffered: false });
    } catch (err) { /* 忽略 */ }
    return "ok";
  `);

  // 点目标页 —— 只做一次，量的是首次挂载
  await cdp.js(`
    const nav = [...document.querySelectorAll(".nav-item")].find((e) => e.textContent.includes(${JSON.stringify(TARGET)}));
    if (!nav) throw new Error("找不到导航项: " + ${JSON.stringify(TARGET)});
    nav.click();
    return "ok";
  `);
  await sleep(1500);
  await cdp.send("Tracing.end");
  for (let i = 0; i < 40 && !done; i++) await sleep(200);

  const events = chunks;
  console.log(`抓到 ${events.length} 个事件`);
  if (KEEP) {
    fs.writeFileSync(KEEP, JSON.stringify({ traceEvents: events }));
    console.log(`原始 trace 已写入 ${KEEP}（可以用 DevTools Performance 面板打开）`);
  }

  // ---- 结论 0: LoAF —— 长帧的"两段拆解 + 点名"（最重要，放最前）----
  const loafErr = await cdp.js(`return window.__loafErr ?? null;`);
  if (loafErr) console.log(`\n⚠ long-animation-frame 观察器异常: ${loafErr}`);
  const loaf = JSON.parse(String(await cdp.js(`return JSON.stringify(window.__loaf ?? []);`)));
  const longs = JSON.parse(String(await cdp.js(`return JSON.stringify(window.__long ?? []);`)));
  console.log(`\n== 长任务 longtask (>50ms): ${longs.length} 个  ${longs.join(", ")}ms ==`);
  console.log(`== 长动画帧 LoAF: ${loaf.length} 个 ==`);
  for (const e of loaf) {
    const scriptSum = e.scripts.reduce((a, s) => a + s.d, 0);
    // LoAF 的 renderStart / styleAndLayoutStart 都是**绝对时间戳**（相对 timeOrigin），
    // 不是「相对帧起点」—— 必须减去 startTime 才是相对值。第一版忘了减，
    // 打印出「渲染前 5081ms = 帧 247ms」这种自相矛盾的数。
    const before = Math.max(0, e.renderStart - e.start);
    const render = Math.max(0, e.dur - before);
    const styleLayout = Math.max(0, e.dur - Math.max(0, e.styleLayoutStart - e.start));
    console.log(
      `\n  帧 ${e.dur}ms = 渲染前 ${before}ms + 渲染 ${render.toFixed(0)}ms` +
        `（其中脚本 ${scriptSum.toFixed(0)}ms，样式&布局 ${styleLayout.toFixed(0)}ms）`,
    );
    if (!e.scripts.length) console.log(`    （无脚本归因：这一帧的渲染是浏览器自己触发的）`);
    for (const s of e.scripts.slice(0, 12)) {
      console.log(`    script ${String(s.d).padStart(6)}ms  [${s.type}] ${s.fn || s.name || "?"}  ${s.src || ""}`);
    }
  }

  // ---- 结论 1: 主线程真正忙了多久（RunTask 是不嵌套的顶层任务）----
  const runTasks = events.filter((e) => e.name === "RunTask" && e.ph === "X");
  const busy = runTasks.reduce((a, e) => a + (e.dur ?? 0), 0) / 1000;
  const worstTask = runTasks.reduce((a, e) => ((e.dur ?? 0) > (a.dur ?? 0) ? e : a), { dur: 0 });
  console.log(`\n== 主线程 ==`);
  console.log(`  RunTask 共 ${runTasks.length} 个, 合计 ${busy.toFixed(1)}ms`);
  console.log(`  最贵的单个顶层任务 ${((worstTask.dur ?? 0) / 1000).toFixed(1)}ms`);
  if (worstTask.args?.data?.frame) {
    console.log(`    其 frame: ${worstTask.args.data.frame}`);
  }

  // ---- 结论 2: 按事件名聚合（相对归因）----
  const agg = aggregate(events);
  console.log(`\n== 按事件名聚合（嵌套求和, 只比大小, 别相加）==`);
  console.log(`  ${"事件".padEnd(30)} ${"次数".padStart(7)} ${"合计ms".padStart(10)}`);
  for (const r of agg.slice(0, 22)) {
    if (r.ms < 0.5 && r.count < 20) continue;
    console.log(`  ${r.name.padEnd(30)} ${String(r.count).padStart(7)} ${r.ms.toFixed(1).padStart(10)}`);
  }

  // ---- 结论 3: 单个最贵事件（找"那一下"）----
  const t0 = events.reduce((a, e) => Math.min(a, e.ts ?? Infinity), Infinity);
  const singles = events
    .filter((e) => e.ph === "X" && (e.dur ?? 0) > 0)
    .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
    .slice(0, 15);
  console.log(`\n== 单个最贵事件 top 15 ==`);
  console.log(`  ${"事件".padEnd(34)} ${"耗时".padStart(9)}   ${"起点(相对)".padStart(12)}`);
  for (const e of singles) {
    console.log(
      `  ${e.name.padEnd(34)} ${(e.dur / 1000).toFixed(1).padStart(7)}ms   +${((e.ts - t0) / 1000).toFixed(1).padStart(9)}ms`,
    );
  }

  // ---- 结论 4: 每次 Layout 排了多少对象、是不是被"视口变宽"逼的全排 ----
  // 「671 个节点」是我们插进去的；但一次 Layout 可能把**整个文档**都排一遍。
  // dirtyObjects=671 & totalObjects=671 → 只排了新挂的那棵；
  // totalObjects 远大于 671 → 是整篇文档重排（多半是滚动条出现/消失改了视口宽度）。
  const layouts = events
    .filter((e) => e.name === "Layout" && e.ph === "X")
    .sort((a, b) => a.ts - b.ts);
  console.log(`\n== 每次 Layout 的规模 ==`);
  for (const e of layouts) {
    const b = e.args?.beginData ?? {};
    console.log(
      `  ${(e.dur / 1000).toFixed(1).padStart(7)}ms  dirtyObjects=${b.dirtyObjects ?? "?"}` +
        ` totalObjects=${b.totalObjects ?? "?"} partial=${b.partialLayout ?? "?"} resized=${b.resized ?? "?"}` +
        ` frame=${e.args?.data?.frame ?? b.frame ?? "?"}`,
    );
    if (e === layouts[0]) console.log(`    beginData 全文: ${JSON.stringify(b)}`);
  }

  // ---- 结论 5: 最贵那次 Layout 的"祖先链" —— 谁调用了它 ----
  // 用时间区间包含关系推断调用栈（trace 的 X 事件没有 parent 指针）：
  // 把凡是 [ts, ts+dur] 包住目标事件的都算祖先，按耗时升序 = 从近到远。
  const worstLayout = layouts.reduce((a, e) => ((e.dur ?? 0) > (a?.dur ?? 0) ? e : a), null);
  if (worstLayout) {
    const s0 = worstLayout.ts;
    const s1 = s0 + worstLayout.dur;
    const ancestors = events
      .filter((e) => {
        if (e.ph !== "X" || e === worstLayout) return false;
        const t1 = e.ts + (e.dur ?? 0);
        return e.ts <= s0 && t1 >= s1 && (e.dur ?? 0) > worstLayout.dur;
      })
      .sort((a, b) => a.dur - b.dur);
    console.log(`\n== 最贵那次 Layout (${(worstLayout.dur / 1000).toFixed(1)}ms) 的调用链 ==`);
    console.log(`  （从内到外）`);
    for (const e of ancestors) console.log(`    ↑ ${e.name}  ${(e.dur / 1000).toFixed(1)}ms`);
    if (!ancestors.length) console.log(`    （没有包住它的事件 —— 它本身就是最外层）`);
  }

  cdp.close();
  try {
    proc.kill();
  } catch {
    /* 忽略 */
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
