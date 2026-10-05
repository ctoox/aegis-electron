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
 *   2. 切一次页面要几个帧？（1 个掉帧 = 31ms 是可接受的；几百 ms 就会出现
 *      "整块内容先从左上角冒出来再铺满"——CPU 一帧画不完，合成器先呈现已画好的分块，
 *      而栅格顺序大致从左往右、从上往下。详见 docs/RENDER-PERF.md 第 10 节。）
 *
 * 用法:
 *   npm run bench:switch -- --user-data-dir <演示库目录> --password <主密码>
 *   npm run bench:switch -- --user-data-dir <目录> --password <密码> --rounds 8
 *   npm run bench:switch -- --user-data-dir <目录> --password <密码> --override ':root{--g-bg:#dfe6f2;}'
 *     ↑ 消融：临时注入 CSS 看某项样式占多少（一次只改一个变量，否则结论无效）
 *
 * ⚠ 与 smoke-electron.mjs 同源的两个环境坑: ELECTRON_RUN_AS_NODE 要清掉;
 *   必须用 Node spawn 起 Electron (从 shell 直接起会秒退)。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

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

  async function clickNav(name, phase) {
    await cdp.js(`
      window.__sw.marks.push([Math.round(performance.now()), ${JSON.stringify(name)}, ${JSON.stringify(phase)}]);
      const nav = [...document.querySelectorAll(".nav-item")].find((e) => e.textContent.includes(${JSON.stringify(name)}));
      if (nav) nav.click();
      return "ok";
    `);
  }

  // 预热: 先把两页各点一次。"页面第一次打开"要布局 + 绘制 + 栅格 + 汉字字形缓存,
  // 比稳态贵一个数量级 —— 单独列出来, 不混进稳态统计
  for (const t of ["设置", "全部条目"]) {
    await clickNav(t, "预热");
    await sleep(900);
  }

  for (let r = 0; r < ROUNDS; r++) {
    await clickNav(r % 2 === 0 ? "设置" : "全部条目", "稳态");
    await sleep(700);
  }
  await sleep(300);

  const raw = JSON.parse(String(await cdp.js(`return JSON.stringify(window.__sw);`)));
  const dt = raw.frames.map((f) => f[1]).filter((d) => d > 0);
  const sorted = [...dt].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const over = (ms) => dt.filter((d) => d > ms).length;

  console.log(`\n== 切页期间逐帧间隔 (共 ${dt.length} 帧) ==`);
  console.log(`  中位 ${q(0.5)}ms  p95 ${q(0.95)}ms  max ${Math.max(...dt)}ms`);
  console.log(`  >33ms: ${over(33)} 帧   >50ms: ${over(50)} 帧   >100ms: ${over(100)} 帧`);

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
    // 一个掉帧 = 两个 vsync ≈ 31ms。超过这个数就说明一帧没画完，用户能看见。
    console.log(
      s[s.length - 1] > 33
        ? `  ⚠ 有切换超过 1 个掉帧 —— 软件渲染下这就是"内容从左上角铺开"的来源`
        : `  ✔ 每次切换都在 1 个掉帧以内`,
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
