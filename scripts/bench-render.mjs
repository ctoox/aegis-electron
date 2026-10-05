/**
 * 渲染流畅度基准 (走 CDP, 在同一个进程里做 A/B, 不靠肉眼).
 *
 * 背景: 玻璃效果在 Win10/Linux 上走的是 inapp 路径 —— 页面自己铺彩色底图,
 * 再给一堆面板挂 backdrop-filter: blur(30px) saturate(180%)。这些模糊层的
 * 代价是逐帧的, 而「流畅不流畅」如果只靠感觉, 优化就没有验收标准。
 *
 * 做法: 在同一台机器、同一个渲染进程里, 用 data-glass 开关做 on/off 交替测量,
 * 交替跑是为了把"跑久了变热/被别的程序抢 CPU"这类漂移抵消掉。
 * 每轮的动作固定: 设置页从顶滚到底、再滚回顶, 中间穿插鼠标划过条目(触发 hover 重绘)。
 * 指标是 requestAnimationFrame 的帧间隔 —— 它直接反映合成/绘制有没有跟上,
 * 而不是"脚本执行了多久"。
 *
 * 用法:
 *   node scripts/bench-render.mjs --user-data-dir <目录> --password <主密码> [--rounds 3]
 *
 * ★ 判据（"多少 ms 算掉帧"）**跟着实测刷新率走**，不写死 60Hz ——
 *   高刷机器上"掉 1 帧"的门槛比 60Hz 低得多，写死会把掉帧误判成没掉。
 *   见 scripts/lib/refresh.mjs。
 *
 * ⚠ 窗口必须真的可见(不能最小化) —— 被遮挡时 Chromium 会节流渲染,
 *   两边同样被节流的话, 数字就全是噪声。脚本会先把窗口拉到前台。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";
import { FALLBACK_VSYNC_MS, detectRefresh, describeRefresh, drop1Ms, drop2Ms } from "./lib/refresh.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/**
 * 判据基准（ms）。**不写死 60Hz** —— 运行时由 detectRefresh() 探测后覆盖。
 * 60Hz 下 33ms=掉 1 帧；90Hz 下掉 1 帧只有 22ms；160Hz 只有 12.5ms。
 * 写死 33 换到高刷机器会把"掉了一帧"误判成"没掉帧"。见 scripts/lib/refresh.mjs。
 */
let VSYNC_MS = FALLBACK_VSYNC_MS;

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const USER_DATA = arg("user-data-dir");
const PASSWORD = arg("password");
const ROUNDS = Number(arg("rounds", "3"));
const PORT = Number(arg("port", "9224"));
/** --ablate: 逐个关掉某个玻璃层的模糊, 找出到底是谁在吃性能 */
const ABLATE = process.argv.includes("--ablate");

if (!USER_DATA || !PASSWORD) {
  console.error("用法: node scripts/bench-render.mjs --user-data-dir <目录> --password <主密码> [--rounds 3]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(ROOT, "node_modules", "electron", "dist", exe);
}

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 从 shell 直接起 Electron 会秒退, 必须 spawn
  return spawn(electronBin(), [".", `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
}

// ---------------------------------------------------------------- 统计

function stats(frames) {
  const f = frames.filter((x) => x > 0).sort((a, b) => a - b);
  if (!f.length) return null;
  const at = (q) => f[Math.min(f.length - 1, Math.floor(f.length * q))];
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  return {
    n: f.length,
    mean: +mean.toFixed(2),
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    p99: +at(0.99).toFixed(2),
    max: +f[f.length - 1].toFixed(2),
    // 阈值随实测 vsync 变（掉 1 帧 ≈ 2 个 vsync，掉 2 帧 ≈ 3 个），不写死 16.7/33/50
    drop1: f.filter((x) => x > drop1Ms(VSYNC_MS)).length,
    drop2: f.filter((x) => x > drop2Ms(VSYNC_MS)).length,
  };
}

function fmt(s) {
  if (!s) return "无数据";
  return `n=${String(s.n).padStart(4)} 均值=${String(s.mean).padStart(6)}ms p95=${String(s.p95).padStart(6)}ms p99=${String(s.p99).padStart(6)}ms 最大=${String(s.max).padStart(7)}ms  掉1帧:${String(s.drop1).padStart(3)} 掉2帧:${String(s.drop2).padStart(3)}`;
}

// ---------------------------------------------------------------- 主流程

const SAMPLER = `
  window.__bench = (() => {
    const st = { frames: [], on: false };
    let last = 0;
    const tick = (t) => {
      if (st.on) { if (last) st.frames.push(t - last); last = t; }
      else last = 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return st;
  })();
  return "sampler ready";
`;

/** 一段固定的交互: 滚下去 → 滚回来 → 鼠标划过若干条目(hover 重绘) */
async function runInteraction(cdp) {
  const scroll = (yDistance) =>
    cdp.send("Input.synthesizeScrollGesture", {
      x: 620,
      y: 340,
      xDistance: 0,
      yDistance,
      speed: 1400,
      gestureSourceType: "mouse",
    });
  await scroll(-700);
  await scroll(-700);
  // hover 扫一遍: 每行 hover 都会改背景 → 玻璃元素要重绘
  for (let i = 0; i < 12; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 300 + i * 18,
      y: 200 + (i % 6) * 30,
      button: "none",
    });
    await sleep(35);
  }
  await scroll(900);
  await scroll(700);
}

async function main() {
  const proc = launch();
  let cdp = null;

  try {
    cdp = await Cdp.connect((await waitForPage()).webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");

    // ---- 解锁 ----
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await cdp.js(`return Boolean(document.querySelector(".gate-input"))`)) break;
      await sleep(300);
    }
    await cdp.js(`
      const i = document.querySelector(".gate-input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(i, ${JSON.stringify(PASSWORD)});
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return "filled";
    `);
    await sleep(200);
    await cdp.js(`
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("解锁"));
      if (btn) btn.click();
      return "clicked";
    `);
    await sleep(1500);

    // ---- 切到设置页 (卡片最多、玻璃元素最密集的一页) ----
    await cdp.js(`
      const nav = [...document.querySelectorAll(".nav-item")].find((n) => n.textContent.includes("设置"));
      if (nav) nav.click();
      return "nav";
    `);
    await sleep(1200);
    await cdp.send("Page.bringToFront");

    const diag = JSON.parse(
      String(
        await cdp.js(`
          const all = [...document.querySelectorAll("*")];
          const blurs = all.filter((e) => {
            const s = getComputedStyle(e);
            const v = s.backdropFilter || s.webkitBackdropFilter || "none";
            return v && v !== "none";
          });
          const tags = {};
          for (const e of blurs) tags[e.className || e.tagName] = (tags[e.className || e.tagName] || 0) + 1;
          return JSON.stringify({
            total: blurs.length,
            top: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 6),
            mat: document.documentElement.dataset.mat,
            glass: document.documentElement.dataset.glass,
          });
        `),
      ),
    );
    console.log(`材质=${diag.mat}  当前 data-glass=${diag.glass}`);
    console.log(`带 backdrop-filter 的元素: ${diag.total} 个`);
    for (const [c, n] of diag.top) console.log(`    ${String(n).padStart(3)} × ${c}`);

    // ---- 实测渲染节奏（判据要跟着它走，不能写死 60Hz）----
    await cdp.send("Page.bringToFront");
    const refresh = await detectRefresh(cdp);
    VSYNC_MS = refresh.ms;
    console.log(describeRefresh(refresh, VSYNC_MS));

    await cdp.js(SAMPLER);

    /** 施加一个测量状态: data-glass + 一段注入的覆盖 CSS */
    const applyState = async (glass, css) => {
      await cdp.js(`
        document.documentElement.dataset.glass = ${JSON.stringify(glass)};
        let st = document.getElementById("bench-ablate");
        if (!st) {
          st = document.createElement("style");
          st.id = "bench-ablate";
          document.head.appendChild(st);
        }
        st.textContent = ${JSON.stringify(css)};
        const p = document.querySelector(".page");
        if (p) p.scrollTop = 0;
        return "ok";
      `);
      await sleep(600); // 等样式/合成稳定再采样
    };

    /** 测一次, 返回帧间隔统计 */
    const measure = async () => {
      await cdp.js(`window.__bench.frames = []; window.__bench.on = true; return "start";`);
      await runInteraction(cdp);
      const raw = await cdp.js(`window.__bench.on = false; return JSON.stringify(window.__bench.frames);`);
      return stats(JSON.parse(String(raw ?? "[]")));
    };

    if (ABLATE) {
      // ---- 消融: 逐个关掉某个玻璃层, 看谁在吃性能 ----
      const kill = (sel) =>
        `:root[data-glass="on"] ${sel}{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`;
      const CASES = [
        { name: "基线 (全部留着)", css: "" },
        { name: "只去 .page", css: kill(".page") },
        { name: "只去 .sidebar", css: kill(".sidebar") },
        { name: "只去 .titlebar", css: kill(".titlebar") },
        { name: "去 .page + .sidebar + .titlebar", css: kill(".page, .sidebar, .titlebar") },
        { name: "全部去掉 (等于玻璃的核心代价)", css: kill("*") },
      ];
      console.log("\n消融实验 (每格测 " + ROUNDS + " 轮取中位数)");
      const out = [];
      for (const c of CASES) {
        const runs = [];
        for (let r = 0; r < ROUNDS; r++) {
          await applyState("on", c.css);
          runs.push(await measure());
        }
        const med = (k) => {
          const v = runs.filter(Boolean).map((s) => s[k]).sort((a, b) => a - b);
          return v.length ? v[Math.floor(v.length / 2)] : NaN;
        };
        const row = { name: c.name, mean: med("mean"), p95: med("p95"), drop1: med("drop1") };
        out.push(row);
        console.log(`  ${row.name.padEnd(34)} 均值 ${String(row.mean).padStart(7)}ms  p95 ${String(row.p95).padStart(7)}ms  掉1帧: ${row.drop1}`);
      }
      const base = out[0];
      console.log("\n================ 消融结论 ================");
      for (const r of out.slice(1)) {
        const pct = ((1 - r.p95 / base.p95) * 100).toFixed(0);
        console.log(`  ${r.name.padEnd(34)} p95 相比基线降低 ${pct}%`);
      }
      return;
    }

    // ---- 默认: on / off 交替 A/B ----
    const results = { on: [], off: [] };
    const order = [];
    for (let i = 0; i < ROUNDS; i++) order.push("on", "off");

    console.log(`\n开始测量 (${ROUNDS} 轮 × on/off 交替, 共 ${order.length} 次)`);
    for (const arm of order) {
      await applyState(arm, "");
      const s = await measure();
      results[arm].push(s);
      console.log(`  [玻璃 ${arm === "on" ? "开" : "关"}] ${fmt(s)}`);
    }

    const avg = (arr, k) => {
      const v = arr.filter(Boolean).map((s) => s[k]).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : NaN;
    };
    const on = { p95: avg(results.on, "p95"), drop1: avg(results.on, "drop1"), mean: avg(results.on, "mean") };
    const off = { p95: avg(results.off, "p95"), drop1: avg(results.off, "drop1"), mean: avg(results.off, "mean") };

    console.log("\n================ 汇总 (各轮中位数) ================");
    console.log(`玻璃开: 均值 ${on.mean}ms  p95 ${on.p95}ms  掉1帧 ${on.drop1}`);
    console.log(`玻璃关: 均值 ${off.mean}ms  p95 ${off.p95}ms  掉1帧 ${off.drop1}`);
    if (on.p95 && off.p95) {
      const slower = ((on.p95 / off.p95 - 1) * 100).toFixed(0);
      console.log(`玻璃带来的额外卡顿(p95): +${slower}%`);
    }
  } finally {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error("基准跑挂了:", e.message);
  process.exit(1);
});
