#!/usr/bin/env node
/**
 * 构建快速填充的 Windows 原生模块（N-API，零第三方依赖）。
 *
 * 为什么要这个脚本而不是直接在 npm scripts 里写 node-gyp：
 *   1. **非 Windows 必须静默跳过**。这个模块只有 Windows 用得上，而 CI 里有
 *      5 个打包目标（mac / linux x64 / linux arm64 / win）。让 3 个目标去跑一个
 *      必然失败的 node-gyp，或者为此给每个 job 都变成"允许失败"，都很难看。
 *   2. **增量**。本地开发每次 `npm run dist:win` 都重编译一遍毫无必要。
 *   3. **缺 MSVC 要早点报清楚**。否则会在 electron-builder 的最后一步以
 *      "找不到 autotype_win32.node" 的形式爆出来，离真正的病根隔了十万八千里。
 *
 * 退出码：0 = 已构建 / 已是最新 / 本平台不需要 / 显式 --optional 跳过；1 = 真的失败了
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDON_DIR = path.join(root, "native", "autotype-win32");
const OUT = path.join(ADDON_DIR, "build", "Release", "autotype_win32.node");

const log = (m) => console.log(`[native] ${m}`);

// ---------- 1. 平台闸门 ----------
if (process.platform !== "win32") {
  log(`跳过：自动打字模块仅 Windows 需要（当前 ${process.platform}）`);
  process.exit(0);
}

// ---------- 2. --optional：缺 MSVC 时的显式逃生口 ----------
// 默认**硬失败**是刻意的：`dist:win` / `dist:all` 都串了这一步，硬失败才能挡住
// "一个没有自动打字模块的 Windows 包被当成正式版发出去"。
// 但新机器、纯前端开发机上没装 C++ 工具链是常态，所以留一个需要**明确写出**的口子：
// --optional 等于用户签字确认"我知道这个包的快速填充会退化成只能复制密码"。
const OPTIONAL =
  process.argv.includes("--optional") || process.env.AEGIS_NATIVE_OPTIONAL === "1";

// ---------- 3. 增量判断 ----------
const SOURCES = ["autotype.cc", "binding.gyp"].map((f) => path.join(ADDON_DIR, f));

if (fs.existsSync(OUT)) {
  const outMtime = fs.statSync(OUT).mtimeMs;
  const newest = Math.max(...SOURCES.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)));
  if (outMtime > newest) {
    log("已是最新，跳过编译（改了 autotype.cc / binding.gyp 会自动重编）");
    process.exit(0);
  }
}

// ---------- 4. 找 MSVC，早点给人话 ----------
function hasMsvc() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!fs.existsSync(vswhere)) return false;
  const r = spawnSync(
    vswhere,
    [
      "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationPath",
    ],
    { encoding: "utf8" },
  );
  return r.status === 0 && Boolean((r.stdout ?? "").trim());
}

if (!hasMsvc()) {
  if (OPTIONAL) {
    // 两种结局都要说清：有现成的就用现成的，没有就真的少一个功能
    console.warn(
      [
        "",
        "[native] ⚠ 找不到 MSVC，已按 --optional 跳过编译。",
        fs.existsSync(OUT)
          ? `  沿用已有的预编译产物：${path.relative(root, OUT)}`
          : "  这个包里不会有自动打字模块 —— 「快速填充」面板还在，但「填入」按钮不可用，只能复制密码。",
        "  想启用完整功能：装 Visual Studio Build Tools 2022（勾「使用 C++ 的桌面开发」）后重跑 npm run build:native",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  console.error(
    [
      "",
      "[native] ✗ 找不到 MSVC（C++ 构建工具），无法编译快速填充模块。",
      "",
      "  挡在这里、而不是让 electron-builder 到最后一步报「找不到 autotype_win32.node」，",
      "  是因为后者离真正的病根太远。二选一：",
      "",
      "  A. 装 C++ 工具链（功能完整，推荐）",
      "     Visual Studio Build Tools 2022，勾选「使用 C++ 的桌面开发」",
      "     https://visualstudio.microsoft.com/visual-cpp-build-tools/",
      "     装完重开终端，再跑：npm run build:native",
      "",
      "  B. 不装，接受少一个功能（「快速填充」退化成只能复制密码）",
      "     npm run dist:win:optional           # 直接打包",
      "     npm run build:native -- --optional  # 或只跑这一步",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------- 5. 编译 ----------
log(`编译 ${path.relative(root, ADDON_DIR)} …`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const r = spawnSync(npx, ["--yes", "node-gyp", "rebuild"], {
  cwd: ADDON_DIR,
  stdio: "inherit",
  // Windows 上 npx 是 .cmd，必须走 shell 才能被 spawn 找到
  shell: process.platform === "win32",
});

if (r.status !== 0 || !fs.existsSync(OUT)) {
  console.error(
    [
      "",
      `[native] ✗ 编译失败（node-gyp 退出码 ${r.status}）。`,
      "  常见原因：MSVC 组件没装全（缺 Windows SDK）、或 node-gyp 下不到 Node 头文件（需联网）。",
      "  想看完整日志：cd native/autotype-win32 && npx node-gyp rebuild --verbose",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
log(`✔ 构建完成：${path.relative(root, OUT)} (${kb} KB)`);
