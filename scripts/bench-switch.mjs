/**
 * 页面切换的渲染代价基准 (走 CDP, 不碰窗口消息).
 *
 * 为什么单独做一份、不和 bench-render.mjs 合并：
 *   bench-render 量的是**滚动/hover**（脏区小、可增量刷新）；
 *   切页面是**整块内容换掉**——列 2–3 整片都要重画，是软件渲染下最贵的一种操作。
 *   两者查的是不同的东西，分开跑才好对比。
 *
 * 它回答两个问题：
 *   1. 这台机器有没有硬件加速？（**先看这一行**：没有 GPU 时所有数字都要按"CPU 在画"来读）
 *   2. 切一次页面要几个帧？（"1 个掉帧"是多少 ms **随刷新率变**：60Hz≈33ms、
 *      90Hz≈22ms、160Hz≈12.5ms —— 脚本会实测，不写死；见 scripts/lib/refresh.mjs。
 *      几百 ms 就会出现"整块内容先从左上角冒出来再铺满"——CPU 一帧画不完，
 *      合成器先呈现已画好的分块，而栅格顺序大致从左往右、从上往下。详见 docs/RENDER-PERF.md 第 10 节。）
 *
 * 用法:
 *   npm run bench:switch -- --user-data-dir <演示库目录> --password <主密码>
 *   npm run bench:switch -- --user-data-dir <目录> --password <密码> --rounds 8
 *   npm run bench:switch -- --user-data-dir <目录> --password <密码> --override ':root{--g-bg:#dfe6f2;}'
 *     ↑ 消融：临时注入 CSS 看某项样式占多少（一次只改一个变量，否则结论无效）
 *     ↑ 注入后**会打印每个选择器的命中数**；一个都没命中就直接说"本次消融无效"
 *       —— 免得"注入没生效"被读成"这个属性没用"（见 docs/RENDER-PERF.md 第 13 节）
 *
 * ⚠ 与 smoke-electron.mjs 同源的两个环境坑: ELECTRON_RUN_AS_NODE 要清掉;
 *   必须用 Node spawn 起 Electron (从 shell 直接起会秒退)。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";
import { FALLBACK_VSYNC_MS, detectRefresh, describeRefresh, drop1Ms, drop2Ms } from "./lib/refresh.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/**
 * 判据基准（ms）。**不写死 60Hz**：运行时由 detectRefresh() 探测后覆盖。
 * "1 个掉帧"在 60Hz 是 33ms，在 90Hz 只有 22ms，160Hz 只有 12.5ms。
 * 见 scripts/lib/refresh.mjs。
 */
let VSYNC_MS = FALLBACK_VSYNC_MS;

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const USER_DATA = arg("user-data-dir");
const PASSWORD = arg("password");
const ROUNDS = Number(arg("rounds", "8"));
const OVERRIDE = arg("override");
const EXTRA_ARGS = arg("electron-args");
const PORT = Number(arg("port", "9227"));

if (!USER_DATA || !PASSWORD) {
  console.error(
    "用法: npm run bench:switch -- --user-data-dir <目录> --password <主密码> [--rounds 8] [--override '<css>']",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(ROOT, "node_modules", "electron", "dist", exe);
}

/** 起 Electron 并返回进程；调用方负责 kill */
function launch(extra = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 见 smoke-electron.mjs 文件头
  return spawn(
    electronBin(),
    [".", `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`, ...extra],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** 轮询 /json 直到出现 type=page 的目标 */
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

/** 一个极简的 CDP 客户端（够用就好，正式工具见 shot-ui.mjs） */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
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
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} 超时`)), 30000);
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

/**
 * 读浏览器级的 GPU 状态。
 * 单独连一条浏览器 WS —— 渲染目标的 `Runtime.evaluate` 看不到这些。
 */
async function readGpu() {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (!v.webSocketDebuggerUrl) return null;
    const cdp = await Cdp.connect(v.webSocketDebuggerUrl);
    const info = await cdp.send("SystemInfo.getInfo");
    cdp.close();
    return info?.gpu ?? null;
  } catch {
    return null; // 探不到就不显示，别让基准因为一行附带信息挂掉
  }
}

/** 把 key=value 的降级信息翻成人话 */
function gpuLine(gpu) {
  if (!gpu) return "（读不到 GPU 信息）";
  const compositing = gpu.featureStatus?.gpu_compositing ?? "unknown";
  const accelerator = gpu.auxAttributes?.glRenderer ?? gpu.devices?.[0]?.deviceString ?? "?";
  const ok = compositing.startsWith("enabled");
  return `${ok ? "已启用" : "未启用 —— 在跑软件渲染"} (gpu_compositing=${compositing}, ${accelerator})`;
}

async function main() {
  const proc = launch(EXTRA_ARGS ? EXTRA_ARGS.split(",") : []);
  const page = await waitForPage();
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // ★ 必须把窗口拉到前台。被遮挡/最小化时 Chromium 会节流渲染，rAF 少得可怜 ——
  //   那种数字全是噪声（曾经整轮只抓到 34 帧 vs 正常 390 帧）。
  //   注意: 主线程计数(LayoutDuration 等)不受节流影响, 所以哪怕帧数不对,
  //   耗时拆解那一节仍然可信。
  await cdp.send("Page.bringToFront");

  // 解锁（演示库的主密码由 --password 传入）
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
  await sleep(1500);

  // 第一行就先报加速状态 —— 没有 GPU 的话后面所有数字都要换个读法
  const gpu = await readGpu();
  console.log(`硬件加速: ${gpuLine(gpu)}`);
  const glass = await cdp.js(`return document.documentElement.dataset.glass;`);
  console.log(`玻璃效果: ${glass ?? "?"}   窗口材质: ${await cdp.js(`return document.documentElement.dataset.mat;`)}`);

  // ---- 实测渲染节奏（"1 个掉帧"是多少 ms 随刷新率变，不能写死）----
  await cdp.send("Page.bringToFront");
  const refresh = await detectRefresh(cdp);
  VSYNC_MS = refresh.ms;
  console.log(describeRefresh(refresh, VSYNC_MS));

  if (OVERRIDE) {
    await cdp.js(`
      const s = document.createElement("style");
      s.id = "bench-override";
      s.textContent = ${JSON.stringify(OVERRIDE)};
      document.head.appendChild(s);
      return "ok";
    `);
    await sleep(500);
    console.log(`已注入 --override: ${OVERRIDE}`);
    // ★ 消融实验最危险的失败模式是**注入没生效**，然后"数字没变"被读成
    //   "这个属性没用"。所以这里主动证明观测手段能看到被测对象：把 override 里
    //   每个选择器在当前 DOM 上的命中数打出来；一个都没命中就判本次消融无效。
    //   （某个选择器命中 0 也可能只是"它对应的视图此刻不在场"，比如 .page 只在设置页。）
    const hits = await cdp.js(`
      const sels = ${JSON.stringify(OVERRIDE)}
        .split("}").map((block) => (block.split("{")[0] || ""))
        .flatMap((sel) => sel.split(","))
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("@"));
      const out = {};
      for (const s of sels) {
        try { out[s] = document.querySelectorAll(s).length; } catch { out[s] = -1; }
      }
      return out;
    `);
    const parts = Object.entries(hits).map(([s, n]) => `${s}=${n === -1 ? "选择器无效" : n}`);
    const totalHits = Object.values(hits).reduce((a, b) => a + (b > 0 ? b : 0), 0);
    console.log(`  override 命中: ${parts.join("   ")}`);
    if (totalHits === 0) {
      console.log(
        `  ⚠ --override 一个元素都没命中 → **本次消融无效**；别把"数字没变"读成"这个属性没用"。`,
      );
    }
  }

  // 采样器: 记录每帧间隔（用 rAF，不用 setTimeout —— 后台/被遮挡时 rAF 会被节流，
  // 这正好让"没在真渲染"这件事显式化，而不是悄悄量出一堆漂亮数字）
  await cdp.js(`
    window.__sw = { frames: [], marks: [] };
    let last = performance.now();
    const tick = (t) => {
      window.__sw.frames.push([Math.round(t), Math.round(t - last)]);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return "ok";
  `);

  await cdp.send("Performance.enable");

  /** 读一份主线程累计计数器（都是秒，单调递增，所以要读差值） */
  async function readMetrics() {
    const r = await cdp.send("Performance.getMetrics");
    const out = {};
    for (const { name, value } of r.metrics) out[name] = value;
    return out;
  }

  // 每次切换同时记两份账：
  //   页面侧 —— rAF 帧间隔（"用户看到的"）
  //   Node 侧 —— 主线程耗时拆解（"时间花在哪"）
  const mainMetrics = [];
  async function clickNav(name, phase, settleMs) {
    const before = await readMetrics();
    await cdp.js(`
      window.__sw.marks.push([Math.round(performance.now()), ${JSON.stringify(name)}, ${JSON.stringify(phase)}]);
      const nav = [...document.querySelectorAll(".nav-item")].find((e) => e.textContent.includes(${JSON.stringify(name)}));
      if (nav) nav.click();
      return "ok";
    `);
    await sleep(settleMs);
    const after = await readMetrics();
    mainMetrics.push({
      phase,
      name,
      script: after.ScriptDuration - before.ScriptDuration,
      style: after.RecalcStyleDuration - before.RecalcStyleDuration,
      layout: after.LayoutDuration - before.LayoutDuration,
      task: after.TaskDuration - before.TaskDuration,
      // 次数同样重要: 布局 381ms 是"一次巨大的布局"还是"几十次来回布局",
      // 修法完全不同 —— 前者要简化 DOM, 后者要去掉强制同步布局(布局抖动)
      layouts: after.LayoutCount - before.LayoutCount,
      styles: after.RecalcStyleCount - before.RecalcStyleCount,
      nodes: after.Nodes - before.Nodes,
    });
  }

  // 预热: 依次"首次打开"每一页。--visit 可以换顺序/换页面 ——
  // 用它能一次量出**各页的首次代价**，从而区分"某一页特别重"和"共享的冷缓存"
  // （字体/字形缓存是全局的：先开哪一页会替后面的页买单）。
  for (const t of (arg("visit", "设置,全部条目") || "").split(",").filter(Boolean)) {
    await clickNav(t.trim(), "预热", 900);
  }

  for (let r = 0; r < ROUNDS; r++) {
    await clickNav(r % 2 === 0 ? "设置" : "全部条目", "稳态", 700);
  }
  await sleep(300);

  const raw = JSON.parse(String(await cdp.js(`return JSON.stringify(window.__sw);`)));
  const dt = raw.frames.map((f) => f[1]).filter((d) => d > 0);
  const sorted = [...dt].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const over = (ms) => dt.filter((d) => d > ms).length;

  console.log(`\n== 切页期间逐帧间隔 (共 ${dt.length} 帧) ==`);
  console.log(`  中位 ${q(0.5)}ms  p95 ${q(0.95)}ms  max ${Math.max(...dt)}ms`);
  console.log(
    `  掉1帧(>${drop1Ms(VSYNC_MS).toFixed(0)}ms): ${over(drop1Ms(VSYNC_MS))} 帧` +
      `   掉2帧(>${drop2Ms(VSYNC_MS).toFixed(0)}ms): ${over(drop2Ms(VSYNC_MS))} 帧` +
      `   严重(>${(2 * drop2Ms(VSYNC_MS)).toFixed(0)}ms): ${over(2 * drop2Ms(VSYNC_MS))} 帧`,
  );

  // 主线程耗时拆解 —— 这一节决定了该往哪修:
  //   ScriptDuration 大 → React/DOM 在挂载, 修法是"别卸载页面"
  //   Layout/RecalcStyle 大 → 样式/布局在重算, 修法是简化 DOM/CSS
  //   三个都小但帧还是很长 → 那是栅格(合成线程), 修法是"减少绘制复杂度/面积"
  console.log(`\n== 每次切换的主线程耗时拆解 ==`);
  console.log(
    `  ${"切换".padEnd(14)} ${"脚本ms".padStart(8)} ${"样式ms".padStart(8)} ${"布局ms".padStart(8)} ${"任务ms".padStart(8)} ` +
      `${"布局次".padStart(7)} ${"样式次".padStart(7)} ${"节点增".padStart(7)}`,
  );
  const steadyMain = [];
  for (const m of mainMetrics) {
    const tag = `${m.phase === "预热" ? "[首绘]" : "[稳态]"}${m.name}`;
    const total = m.task * 1000;
    console.log(
      `  ${tag.padEnd(14)} ${(m.script * 1000).toFixed(1).padStart(8)} ${(m.style * 1000).toFixed(1).padStart(8)} ` +
        `${(m.layout * 1000).toFixed(1).padStart(8)} ${total.toFixed(1).padStart(8)} ` +
        `${String(m.layouts).padStart(7)} ${String(m.styles).padStart(7)} ${String(m.nodes).padStart(7)}`,
    );
    if (m.phase !== "预热") steadyMain.push(total);
  }
  if (steadyMain.length) {
    const s = [...steadyMain].sort((a, b) => a - b);
    console.log(
      `\n  稳态主线程任务中位 ${s[Math.floor(s.length / 2)].toFixed(1)}ms / 最大 ${s[s.length - 1].toFixed(1)}ms`,
    );
    console.log(
      `  读法: 主线程只占几 ms 而帧却有几十 ms → 瓶颈在栅格/合成, 不在 React;\n` +
        `        脚本大 → React 在卸载/重挂页面; 布局大 → 看"布局次":\n` +
        `          次数少而耗时长 = 一次巨大的布局(要简化 DOM/CSS);\n` +
        `          次数多 = 布局抖动(有代码在强制同步布局)`,
    );
  }

  console.log(`\n== 每次切换的"最贵一帧" ==`);
  const steady = [];
  for (const [mt, name, phase] of raw.marks) {
    const near = raw.frames.filter((f) => f[0] >= mt - 20 && f[0] <= mt + 800);
    const worst = near.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
    const tag = phase === "预热" ? "[首绘]" : "[稳态]";
    if (phase !== "预热") steady.push(worst[1]);
    console.log(`  ${tag} 点「${name}」最贵一帧 ${worst[1]}ms`);
  }
  if (steady.length) {
    const s = [...steady].sort((a, b) => a - b);
    console.log(
      `\n== 稳态汇总 ==  ${steady.length} 次切换: 中位 ${s[Math.floor(s.length / 2)]}ms / 最大 ${s[s.length - 1]}ms`,
    );
    // "掉 1 帧" = 两个 vsync 没出帧。门槛随实测刷新率走（60Hz≈33ms / 90Hz≈22ms / 160Hz≈12.5ms）。
    const dropMs = drop1Ms(VSYNC_MS);
    console.log(
      s[s.length - 1] > dropMs
        ? `  ⚠ 有切换超过 1 个掉帧(>${dropMs.toFixed(0)}ms) —— 软件渲染下这就是"内容从左上角铺开"的来源`
        : `  ✔ 每次切换都在 1 个掉帧以内(<${dropMs.toFixed(0)}ms)`,
    );
  }

  cdp.close();
  try {
    proc.kill();
  } catch {
    /* 忽略 */
  }
}

main().catch((err) => {
  console.error("失败:", err.message);
  process.exit(1);
});
