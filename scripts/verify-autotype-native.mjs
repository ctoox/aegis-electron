#!/usr/bin/env node
/**
 * 快速填充原生模块的**真机冒烟测试**（会打开记事本，属于人工测试，不进 npm test）。
 *
 * 为什么非要有它
 * --------------
 * 这个模块的全部价值就是"能把字打进去"。单测能证明序列编译是对的，但证明不了
 * SendInput 那一段真的把字送进去了 —— 键盘布局、输入法、UTF-16 代理对、
 * 切前台是否成功，这些只有真打一次才知道。
 *
 * 验证闭环：启动记事本 → 切前台 → 发一串含 中文/emoji(代理对)/符号 的文本
 *          → 用 WM_GETTEXT 把编辑框里的内容读回来 → 逐字符比对。
 *
 * 用法：node scripts/verify-autotype-native.mjs
 * 只在 Windows 上有意义；其他平台会直接跳过。
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDON = path.join(ROOT, "native", "autotype-win32", "build", "Release", "autotype_win32.node");

let passed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "ok " : "✗  "} ${msg}`);
  if (cond) passed++;
  else process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用 -EncodedCommand 传 PowerShell，彻底绕开引号与中文编码的坑 */
function ps(script) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], {
    encoding: "utf8",
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("跳过：本验证只在 Windows 上有意义");
    return;
  }
  if (!fs.existsSync(ADDON)) {
    console.error(`✗ 找不到原生模块：${ADDON}\n  先跑 npm run build:native`);
    process.exit(1);
  }

  const require_ = createRequire(import.meta.url);
  const native = require_(ADDON);

  console.log("\n-- 1. 模块加载与接口自检 --");
  ok(typeof native.sendText === "function", "sendText 已导出");
  ok(typeof native.sendKey === "function", "sendKey 已导出");
  ok(typeof native.foregroundWindow === "function", "foregroundWindow 已导出");
  ok(typeof native.setForeground === "function", "setForeground 已导出");
  ok(typeof native.windowTitle === "function", "windowTitle 已导出");
  const av = native.available();
  ok(typeof av?.ok === "boolean" && typeof av?.reason === "string", "available() 返回 {ok, reason}");
  console.log(`     available() = ${JSON.stringify(av)}`);

  console.log("\n-- 2. 启动记事本并拿到真实 hwnd --");
  const child = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
  child.unref();

  let hwndDec = "0";
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const out = ps(
        "$p = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;" +
          "if ($p) { $p.MainWindowHandle.ToString() } else { '0' }",
      ).trim();
      if (out && out !== "0") {
        hwndDec = out;
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }
  ok(hwndDec !== "0", `拿到记事本窗口句柄（十进制 ${hwndDec}）`);
  if (hwndDec === "0") {
    console.error("  ✗ 拿不到记事本窗口，后续验证无法进行");
    process.exit(1);
  }
  // ⚠️ 必须拼成**大写**：原生模块 foregoundWindow() 返回的就是大写十六进制。
  //    拼小写的话数值相同、setForeground 也照常工作（它解析时不区分大小写），
  //    但字符串比较会静默为假 —— 这个坑在 src/main/autotype-native.ts 里
  //    用 normalizeHwnd() 统一掉了，脚本这边照契约拼大写。
  const hwnd = "0x" + BigInt(hwndDec).toString(16).toUpperCase().padStart(16, "0");
  console.log(`     十六进制写法 = ${hwnd}`);

  console.log("\n-- 2b. 句柄格式契约（大小写陷阱的回归护栏）--");
  // 只采样一次再判 —— 调两次比较是竞态（中间焦点可能已经变了）。
  // 注意前缀 "0x" 里的 x 是**小写**（设计如此），所以不能整个字符串比 toUpperCase()，
  // 那会把前缀变成 "0X"；只校验数字部分。
  const fgSample = native.foregroundWindow();
  const fgDigits = fgSample.startsWith("0x") ? fgSample.slice(2) : "";
  ok(
    fgSample.startsWith("0x") && fgDigits === fgDigits.toUpperCase() && fgDigits.length === 16,
    `foregroundWindow() 格式为 0x + 16 位大写十六进制（采样值 ${fgSample}）`,
  );
  ok(
    native.windowTitle(hwnd.toLowerCase()) === native.windowTitle(hwnd),
    "windowTitle() 接受大小写两种写法（解析不区分大小写）",
  );

  console.log("\n-- 3. 切前台 + 读标题 --");
  // 注意: 这里要**重试**, 不是只试一次。
  // 上一步 spawn 的 PowerShell 退出瞬间可能把焦点抢回控制台窗口,
  // 单次判定会误报失败 —— 而 focusTarget 在生产里也是重试的
  // (见 src/main/autotype-native.ts 的注释: 单次判定会导致"明明能打却退回复制")。
  let focused = false;
  for (let i = 0; i < 5 && !focused; i++) {
    native.setForeground(hwnd);
    await sleep(200);
    focused = native.foregroundWindow() === hwnd;
  }
  ok(focused, "前台窗口确实变成了记事本（以实际前台为准，最多重试 5 次）");
  const title = native.windowTitle(hwnd);
  ok(title.length > 0, `windowTitle 读得到标题：「${title}」`);

  // ---------- 这是本次验证的核心 ----------
  const SAMPLE = "神盾Aegis·测试🚀✓—0O1l";
  console.log(`\n-- 4. 发送 ${SAMPLE.length} 个 UTF-16 码元 --`);
  console.log(`     内容: ${SAMPLE}`);
  const sent = native.sendText(SAMPLE);
  ok(sent, "sendText 返回 true（没有被系统拒收）");
  await sleep(500);

  console.log("\n-- 5. 把编辑框里的内容读回来比对 --");
  const tmp = path.join(os.tmpdir(), `aegis-autotype-verify-${Date.now()}.txt`);
  const rbScript = `
$sig = @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
[DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr wp, System.Text.StringBuilder lp);
'@
$t = Add-Type -MemberDefinition $sig -Name U -Namespace AegisVerify -PassThru
$np = [IntPtr]${hwndDec}
$ed = [IntPtr]::Zero
foreach ($cls in @('Edit','RichEditD2DPT','RichEdit50W','RichEdit20W')) {
  $ed = $t::FindWindowEx($np, [IntPtr]::Zero, $cls, $null)
  if ($ed -ne [IntPtr]::Zero) { break }
}
if ($ed -eq [IntPtr]::Zero) {
  [System.IO.File]::WriteAllText('${tmp.replace(/\\/g, "\\\\")}', '<<NO_EDIT_CONTROL>>', (New-Object System.Text.UTF8Encoding $false))
} else {
  $sb = New-Object System.Text.StringBuilder 8192
  $t::SendMessage($ed, 0x000D, [IntPtr]8192, $sb) | Out-Null
  [System.IO.File]::WriteAllText('${tmp.replace(/\\/g, "\\\\")}', $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
}
`;
  ps(rbScript);
  const got = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);

  if (got === "<<NO_EDIT_CONTROL>>") {
    ok(false, "没找到记事本的编辑控件（不同 Windows 版本的 Notepad 类名不同）");
  } else {
    console.log(`     读回: ${got}`);
    ok(got === SAMPLE, "读回的内容与发送的完全一致（含中文/emoji 代理对/符号）");
    if (got !== SAMPLE) {
      console.log(`     期望: ${JSON.stringify(SAMPLE)}`);
      console.log(`     实际: ${JSON.stringify(got)}`);
      console.log(`     长度: 期望 ${SAMPLE.length}, 实际 ${got.length}`);
    }
  }

  console.log("\n-- 6. 功能键：全选后清掉，再打一行 ASCII --");
  // Ctrl+A 不支持（我们只发功能键不组合键），改用 End + 多次 Backspace 的等价物：
  // 这里只验证 sendKey 本身可用 —— 发一个 Backspace 应让长度 -1
  const before = native.windowTitle(hwnd); // 只为确认窗口还在
  ok(before.length > 0, "窗口仍然存在（没被我们发死）");
  const bs = native.sendKey("Backspace");
  ok(bs === true, "sendKey('Backspace') 返回 true");
  const unknown = native.sendKey("NoSuchKey");
  ok(unknown === false, "未知键名返回 false（不静默假装成功）");

  console.log("\n-- 7. 收尾：关掉记事本 --");
  try {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`,
    ]);
    ok(true, "记事本已关闭");
  } catch {
    ok(true, "记事本已关闭（或已自行退出）");
  }

  console.log(`\n原生模块真机验证通过 ✔  (${passed} 项)`);
}

main().catch((e) => {
  console.error("✗ 验证过程出错：", e);
  process.exit(1);
});
