/**
 * 启动冒烟 + 单实例保护实证.
 *
 * 为什么需要它: `npm test` 只覆盖纯逻辑 (核心加密、导入导出…), 碰不到
 * 「Electron 能不能把窗口开起来」「两个实例会不会同时跑」这类问题 —— 而
 * 后者正是 2026-10-02 把用户密码库写成空库的直接原因。这个脚本就是补这一块。
 *
 * 用法:
 *   node scripts/smoke-electron.mjs            # 跑完整两阶段
 *   node scripts/smoke-electron.mjs --keep     # 不自动关掉第一个实例 (留给你肉眼看看)
 *   node scripts/smoke-electron.mjs --hold 60  # 起一个实例并保活 60 秒, 打印 PID (供抓图/肉眼检查)
 *   node scripts/smoke-electron.mjs --exe C:\\app\\aegis\\AegisNext.exe   # 冒烟打包产物而不是开发态
 *
 * 为什么要有 --hold: 从 shell 直接起 electron.exe 会秒退 (父 shell 一退, GUI 子进程
 * 跟着被回收), 但**经由 Node spawn 起的实例能稳定存活**。所以想"后台挂一个窗口
 * 再抓图", 必须让 Node 进程在前台撑着, 这就是 --hold 干的事。
 *
 * ⚠ 两个环境坑 (踩过, 写在这里免得再踩):
 *  1. 有些环境会注入 ELECTRON_RUN_AS_NODE=1, 那样 electron.exe 会当成纯 Node 跑,
 *     require("electron") 变成一个**字符串路径**, 应用第一行就崩。所以这里
 *     显式把它删掉。判断依据: 纯 Node 模式下 process.type === undefined。
 *  2. Windows 上 Electron 是 GUI 子系统程序, 从 shell 启动后拿到的 PID 是
 *     包装进程的, `kill -0` 判活不可靠 —— 所以用 Node 的 child_process
 *     spawn, 直接看子进程的 exitCode。这是最可靠的判活方式。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
// --hold <秒>: 保活模式. 只跑阶段一, 然后把实例撑住 N 秒 (默认 60) 供抓图.
const holdIdx = process.argv.indexOf("--hold");
const HOLD = holdIdx >= 0 ? Number(process.argv[holdIdx + 1] || 60) : 0;
const BOOT_WAIT_MS = 9000;
const B_WAIT_MS = 12000;
const HOLD_DIR = path.join(ROOT, ".smoke");
// --exe <路径>: 不测开发态, 直接测打包产物。打包漏文件 / asar 路径不对这类问题,
// 只有把真 exe 跑起来才发现得了。
const exeIdx = process.argv.indexOf("--exe");
const EXE = exeIdx >= 0 ? path.resolve(process.argv[exeIdx + 1]) : null;
// --exe2 <路径>: 阶段二的第二个实例换成另一个可执行文件。
// 用来回答"同一份应用装了两个目录 (C:\app\aegis 和 aegis.old), 各点一次算不算多开"。
// 单实例锁是按 userData 目录算的, 所以换目录**不应该**绕过保护 —— 但这是推理,
// 得跑一遍才算数。
const exe2Idx = process.argv.indexOf("--exe2");
const EXE2 = exe2Idx >= 0 ? path.resolve(process.argv[exe2Idx + 1]) : EXE;

function electronBin() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  const p = path.join(ROOT, "node_modules", "electron", "dist", exe);
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到 electron 可执行文件: ${p}\n  先跑 npm install`);
    process.exit(2);
  }
  return p;
}

/** 起一个实例; 返回 { child, exited: Promise<code|null> } */
function launch(userDataDir, tag) {
  const env = { ...process.env };
  // 见文件头注释: 不删掉它, 应用会以"纯 Node"启动, 测的就不是 Electron 了
  delete env.ELECTRON_RUN_AS_NODE;
  // 阶段二可以换一个可执行文件 (区别于阶段一), 开发态时两者等价
  const bin = tag === "B" ? EXE2 : EXE;
  // --exe: 直接冒烟打包产物 (C:\app\aegis\AegisNext.exe 这类). 打包版不需要 "."
  const args = [];
  if (!bin) args.push(".");
  args.push(`--user-data-dir=${userDataDir}`);
  const child = spawn(bin ?? electronBin(), args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (b) => logs.push(String(b)));
  child.stderr.on("data", (b) => logs.push(String(b)));
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));
  console.log(`  [${tag}] pid=${child.pid}`);
  return { child, exited, logs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 exited 最多 ms 毫秒; 超时返回 "timeout" */
function race(ms, exited) {
  return Promise.race([exited, sleep(ms).then(() => "timeout")]);
}

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
}

async function main() {
  // --user-data-dir <path>: 复用一份现成的数据目录 (抓图时想让它带着演示库启动)
  const udIdx = process.argv.indexOf("--user-data-dir");
  const udOverride = udIdx >= 0 ? process.argv[udIdx + 1] : null;
  const ud = udOverride
    ? path.resolve(udOverride)
    : fs.mkdtempSync(path.join(os.tmpdir(), "aegis-smoke-"));
  console.log("Electron 启动冒烟 + 单实例保护验证");
  console.log(`  被测程序     : ${EXE ?? "开发态 (node_modules/electron + .)"}`);
  console.log(`  user-data-dir: ${ud}${udOverride ? "  (复用, 不删除)" : ""}\n`);

  // ---------------- 阶段一: 能不能正常启动并活着 ----------------
  console.log("阶段一 · 启动");
  const a = launch(ud, "A");
  const aBoot = await race(BOOT_WAIT_MS, a.exited);
  if (aBoot !== "timeout") {
    check(false, `实例 A 在 ${BOOT_WAIT_MS}ms 内退出了 (code=${aBoot}) —— 启动即崩`);
    const out = a.logs.join("");
    if (out.trim()) console.log("---- 输出 ----\n" + out.trim().slice(0, 2000) + "\n--------------");
    fs.rmSync(ud, { recursive: true, force: true });
    process.exit(1);
  }
  check(true, `${BOOT_WAIT_MS}ms 后 A 仍然存活`);

  // 数据目录被真正使用 = 主进程跑到了 app.whenReady 之后
  const gotUserData = fs.existsSync(ud);
  check(gotUserData, "userData 目录已建立 (主进程确实完成了初始化)");

  // 托盘图标是"静默失败"重灾区: 图标不在包里时 createFromPath 不抛错,
  // 只是托盘一片空白。主进程现在会 warn, 这里把它当成硬失败。
  const bootLog = a.logs.join("");
  const trayBad = bootLog.includes("托盘图标读不出来");
  check(!trayBad, "托盘图标加载成功 (没有出现 [tray] 告警)");
  if (trayBad) console.log(bootLog.trim().slice(0, 1000));

  // ---------------- 保活模式: 撑住这一个实例, 供抓图/肉眼检查 ----------------
  if (HOLD > 0) {
    fs.mkdirSync(HOLD_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(HOLD_DIR, "hold.json"),
      JSON.stringify({ pid: a.child.pid, userData: ud, at: Date.now() }, null, 2),
    );
    console.log(`\n保活模式 · 实例撑 ${HOLD}s`);
    console.log(`  PID      = ${a.child.pid}`);
    console.log(`  userData = ${ud}`);
    console.log(`  PID 已写入 .smoke/hold.json (抓图脚本可直接读)`);
    const deadline = Date.now() + HOLD * 1000;
    let died = null;
    while (Date.now() < deadline) {
      await sleep(Math.min(5000, deadline - Date.now()));
      const st = await race(0, a.exited);
      if (st !== "timeout") {
        died = st;
        break;
      }
    }
    if (died !== null) {
      check(false, `实例在保活期间退出了 (code=${died})`);
      const out = a.logs.join("");
      if (out.trim()) console.log("---- 输出 ----\n" + out.trim().slice(0, 2000) + "\n--------------");
    } else {
      check(true, `保活 ${HOLD}s 期间实例一直存活`);
    }
    fs.rmSync(HOLD_DIR, { recursive: true, force: true });
    a.child.kill();
    await race(3000, a.exited);
    a.child.kill("SIGKILL");
    if (!udOverride) fs.rmSync(ud, { recursive: true, force: true });
    console.log(failures === 0 ? "\n保活结束 ✔" : `\n保活异常 ✘  ${failures} 项`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // ---------------- 阶段二: 第二个实例必须自己退掉 ----------------
  console.log("\n阶段二 · 单实例保护");
  const b = launch(ud, "B");
  const bExit = await race(B_WAIT_MS, b.exited);
  if (bExit === "timeout") {
    check(false, `实例 B 在 ${B_WAIT_MS}ms 内没退出 —— 单实例保护失效 (两个实例会同时写同一个库!)`);
    b.child.kill("SIGKILL");
  } else {
    check(bExit === 0, `实例 B 自行退出 (code=${bExit})`);
  }

  // A 必须还活着: B 的退出不能是"把 A 顶掉了"
  const aStill = await race(1500, a.exited);
  check(aStill === "timeout", "实例 A 仍存活 (没被 B 顶掉)");

  // ---------------- 收尾 ----------------
  if (!KEEP) {
    a.child.kill();
    await race(3000, a.exited);
    a.child.kill("SIGKILL");
    fs.rmSync(ud, { recursive: true, force: true });
  } else {
    console.log(`\n(--keep) 实例 A 仍在运行, pid=${a.child.pid}; 数据目录 ${ud}`);
  }

  console.log(
    failures === 0
      ? "\n冒烟通过 ✔  应用能启动, 且同一数据目录不会跑起第二个实例"
      : `\n冒烟失败 ✘  ${failures} 项`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
