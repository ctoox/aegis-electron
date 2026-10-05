/**
 * 逐帧抓「切页面」那一瞬间 —— 用来找"整块内容缩到左上角再变大"这类瞬态。
 *
 * 为什么不能用 shot-ui / bench-switch：
 *   那两个都不抓**逐帧画面**。而上一轮用过一次 screencast，用的是 PNG + 原尺寸，
 *   编码太贵**只抓到 2~6 帧** —— 拿 6 帧去断言"帧帧完整"是无效的：
 *   一个只持续 1~2 帧的瞬态本来就可能整个漏掉。
 *   本脚本把帧压到 380×260 / JPEG q30（编码便宜到能跟上），并且每一帧都要 ack，
 *   所以能真正抓到连续帧。
 *
 * 同时按 rAF 采样几何，但**这次采的是会变的那些元素**：上一轮只采了
 * `.app / .titlebar / .sidebar / html`（都是不动的外壳），漏掉了真正切换的
 * `.page / .listbar / .detail`。要验证"是不是缩放"，必须采对的元素。
 *
 * 用法:
 *   npm run capture:switch -- --user-data-dir <演示库> --password <密码> [--target 设置]
 * 产物:
 *   .visual/switch-frames/NNN.jpg   逐帧画面
 *   .visual/switch-frames/geom.json 逐帧几何
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
const PORT = Number(arg("port", "9229"));
const OUT = path.join(ROOT, ".visual", "switch-frames");

if (!USER_DATA || !PASSWORD) {
  console.error("用法: npm run capture:switch -- --user-data-dir <目录> --password <主密码> [--target 设置]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(ROOT, "node_modules", "electron", "dist", exe);
}

function launch(extra = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
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
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} 超时`)), 30000);
    });
  }
  async js(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面内抛错");
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

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

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
  // 等后台预热和启动那波渲染彻底安静 —— 别把它的帧混进来
  await sleep(6000);

  // ---- 逐帧几何：采**会变的**那些元素 ----
  await cdp.js(`
    window.__cap = [];
    const rect = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    };
    const tick = () => {
      window.__cap.push({
        t: Math.round(performance.now()),
        iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio,
        vv: window.visualViewport
          ? [Math.round(visualViewport.width), Math.round(visualViewport.height), visualViewport.scale]
          : null,
        de: rect("html"),
        shell: rect(".shell"),
        app: rect(".app"),
        page: rect(".page"),
        listbar: rect(".listbar"),
        detail: rect(".detail"),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return "ok";
  `);

  // ---- 密集抓帧：小尺寸 + JPEG，编码便宜才跟得上 ----
  const frames = [];
  cdp.on("Page.screencastFrame", (p) => {
    frames.push({ t: p.metadata.timestamp, w: p.metadata.deviceWidth, h: p.metadata.deviceHeight, data: p.data });
    cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 30,
    maxWidth: 380,
    maxHeight: 260,
    everyNthFrame: 1,
  });

  await sleep(1200); // 先抓一段静止的，作为"正常长什么样"的基准
  const t0 = frames.length;

  await cdp.js(`
    const nav = [...document.querySelectorAll(".nav-item")].find((e) => e.textContent.includes(${JSON.stringify(TARGET)}));
    if (!nav) throw new Error("找不到导航项: " + ${JSON.stringify(TARGET)});
    nav.click();
    return "ok";
  `);
  await sleep(2500);
  await cdp.send("Page.stopScreencast");

  // 落盘
  for (let i = 0; i < frames.length; i++) {
    fs.writeFileSync(path.join(OUT, `${String(i).padStart(3, "0")}.jpg`), Buffer.from(frames[i].data, "base64"));
  }
  const geom = JSON.parse(String(await cdp.js(`return JSON.stringify(window.__cap);`)));
  fs.writeFileSync(path.join(OUT, "geom.json"), JSON.stringify(geom, null, 1));

  console.log(`\n抓到 ${frames.length} 帧（点击前 ${t0} 帧，点击后 ${frames.length - t0} 帧）`);
  console.log(`首帧 ${frames[0]?.w}×${frames[0]?.h}，共 ${new Set(frames.map((f) => `${f.w}×${f.h}`)).size} 种尺寸`);
  const sizes = {};
  for (const f of frames) sizes[`${f.w}×${f.h}`] = (sizes[`${f.w}×${f.h}`] ?? 0) + 1;
  console.log(`尺寸分布: ${JSON.stringify(sizes)}`);
  if (frames.length > 1) {
    const dts = frames.slice(1).map((f, i) => Math.round((f.t - frames[i].t) * 1000));
    const s = [...dts].sort((a, b) => a - b);
    console.log(`帧间隔: 中位 ${s[Math.floor(s.length / 2)]}ms  最大 ${s[s.length - 1]}ms`);
  }

  // 几何：把"和稳定态不一样"的帧挑出来
  console.log(`\n== 逐 rAF 几何（只列与最后一帧不同的）==`);
  const last = geom[geom.length - 1];
  let diffs = 0;
  for (const g of geom) {
    const bad = [];
    for (const k of ["de", "shell", "app", "page", "listbar", "detail"]) {
      if (JSON.stringify(g[k]) !== JSON.stringify(last[k])) bad.push(`${k}: ${JSON.stringify(g[k])} vs 末帧 ${JSON.stringify(last[k])}`);
    }
    for (const k of ["iw", "ih", "dpr"]) if (g[k] !== last[k]) bad.push(`${k}: ${g[k]} vs ${last[k]}`);
    if (g.vv && last.vv && JSON.stringify(g.vv) !== JSON.stringify(last.vv)) bad.push(`vv: ${JSON.stringify(g.vv)}`);
    if (bad.length) {
      diffs++;
      if (diffs <= 12) console.log(`  t=${g.t}  ${bad.join(" | ")}`);
    }
  }
  console.log(diffs === 0 ? `  ✔ ${geom.length} 帧几何完全一致（没有缩放/位移/视口变化）` : `  ✘ ${diffs}/${geom.length} 帧几何与稳定态不同`);
  console.log(`\n产物: ${OUT}`);

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
