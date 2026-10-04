/**
 * 打包前置资源检查 —— 专治"本地能打出包, CI 上打出来不对"。
 *
 * 起因（真事）: `build/icon.png`(1024×1024, 真正用于打包的图标) 被 .gitignore 忽略了,
 * 本地因为文件就在磁盘上所以一切正常; 一到 CI 干净检出就没了 ——
 * electron-builder 不会报错, 它会**静默退化成默认 Electron 图标**,
 * 于是发出去的安装包带着 Electron 的 logo, 而且没人会发现。
 *
 * 所以这里做两件事:
 *   1. 校验打包必需资源存在且格式合法 (PNG 头 + 尺寸)
 *   2. 校验这些文件**确实进了版本库** —— 文件在磁盘上 ≠ CI 上有
 *
 *   npx tsx scripts/check-package-assets.ts            # 只查资源
 *   npx tsx scripts/check-package-assets.ts --require-out   # 顺带要求 out/ 已构建
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const needOut = process.argv.includes("--require-out");

const errors: string[] = [];
const warns: string[] = [];
const okList: string[] = [];

const rel = (p: string) => path.relative(root, p).replace(/\\/g, "/");

/** 用 git 自己的判定: 文件是否已加入索引 (tracked or staged) */
function isTracked(p: string): boolean | null {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", rel(p)], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
      return false; // 是 git 仓库, 但没被跟踪
    } catch {
      return null; // 根本不是 git 仓库 → 跳过这项
    }
  }
}

function checkTracked(p: string, why: string) {
  const t = isTracked(p);
  if (t === false) errors.push(`${rel(p)} 存在但**没有被 git 跟踪** —— ${why} (CI 上会消失, 先 git add)`);
  else if (t === true) okList.push(`${rel(p)} 已进版本库`);
}

/** 读 PNG 的 IHDR, 返回宽高 (不引第三方库) */
function pngSize(p: string): { w: number; h: number } | null {
  const fd = fs.openSync(p, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 1. 应用图标 ----------
const icon = path.join(root, "build", "icon.png");
if (!fs.existsSync(icon)) {
  errors.push("build/icon.png 缺失 —— electron-builder 会静默用默认 Electron 图标");
} else {
  const size = pngSize(icon);
  if (!size) errors.push("build/icon.png 不是合法 PNG");
  // electron-builder 要求 ≥256; macOS 的 icns 从这张图生成, 1024 才够清晰
  else if (size.w < 512 || size.h < 512) {
    errors.push(`build/icon.png 只有 ${size.w}×${size.h}, 打包图标至少要 512×512 (建议 1024×1024)`);
  } else okList.push(`build/icon.png ${size.w}×${size.h} —— 由 scripts/gen_pack_icon.py 生成(依赖本机 PySide6, CI 重建不了), 所以必须提交`);
  checkTracked(icon, "打包图标必须进版本库");
}

// ---------- 2. macOS 公证用 entitlements ----------
const ent = path.join(root, "build", "entitlements.mac.plist");
if (!fs.existsSync(ent)) errors.push("build/entitlements.mac.plist 缺失 —— macOS 打包会报错");
else {
  const text = fs.readFileSync(ent, "utf8");
  if (!text.includes("<plist")) errors.push("build/entitlements.mac.plist 不是合法 plist");
  else okList.push("build/entitlements.mac.plist");
  checkTracked(ent, "macOS 打包必需");
}

// ---------- 3. package.json 关键字段 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version?: string;
  main?: string;
  build?: { appId?: string; productName?: string; directories?: { output?: string } };
};
if (!pkg.version) errors.push("package.json 缺 version");
if (!pkg.build?.appId) errors.push("package.json 缺 build.appId");
if (!pkg.build?.productName) errors.push("package.json 缺 build.productName");
if (!pkg.main) errors.push("package.json 缺 main (Electron 入口)");
if (pkg.version && pkg.build?.appId && pkg.build?.productName && pkg.main) {
  okList.push(`package.json v${pkg.version} · ${pkg.build.productName} (${pkg.build.appId}) · main=${pkg.main}`);
}

// ---------- 4. 测试数据 fixture ----------
// tests/portable.test.ts 直接读 testdata/test-bulk.csv, 漏提交就是 CI 直接红
const fixture = path.join(root, "testdata", "test-bulk.csv");
if (fs.existsSync(fixture)) checkTracked(fixture, "tests/portable.test.ts 直接依赖这份 fixture");

// tests/share.test.ts 的**跨语言互通**用例依赖这份 Python 版导出的分享包。
// 它同时也是"Node 能解开 Python 写的包"这条结论的物证 —— 丢了就只剩单向验证,
// 而单向验证证明不了互通。生成方式见 scripts/interop-share.py --gen
const shareFixture = path.join(root, "testdata", "share-from-python.json");
if (!fs.existsSync(shareFixture)) {
  errors.push(
    "testdata/share-from-python.json 缺失 —— 跨语言互通用例会静默降级。\n" +
      "     重新生成: cd C:/dev/aegis && uv run python C:/dev/aegis-electron/scripts/interop-share.py --gen",
  );
} else {
  checkTracked(shareFixture, "tests/share.test.ts 的跨语言互通用例直接依赖它");
}

// ---------- 5. 构建产物 (可选) ----------
const outDir = path.join(root, "out");
const outFiles = ["out/main/index.js", "out/preload/index.js", "out/renderer/index.html"];
if (!fs.existsSync(outDir)) {
  (needOut ? errors : warns).push(
    needOut
      ? "out/ 不存在 —— 打包前必须先跑 `npm run build`"
      : "out/ 尚未构建 (跑 `npm run build` 后可用 --require-out 复查)",
  );
} else {
  for (const f of outFiles) {
    if (!fs.existsSync(path.join(root, f))) errors.push(`${f} 缺失 —— electron-vite 没产出预期结构`);
  }
  if (outFiles.every((f) => fs.existsSync(path.join(root, f)))) okList.push("out/ 三件套齐全 (main / preload / renderer)");
}

// ---------- 汇总 ----------
console.log("打包前置资源检查");
for (const o of okList) console.log(`  ✔ ${o}`);
for (const w of warns) console.log(`  ! ${w}`);
if (errors.length) {
  console.error("");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("\n✔ 打包资源齐备, 且都在版本库里");
