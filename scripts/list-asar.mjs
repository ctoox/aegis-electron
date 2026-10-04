/**
 * 列出 app.asar 里的关键文件, 用于确认打包没漏东西.
 *
 * 为什么需要: `electron-builder` 的 `build.files` 是白名单 glob, 漏掉一个目录
 * **不会报错** —— 只会让某个功能在打包后静默失效 (托盘空白、图标退回默认…)。
 * 所以打包完要直接翻 asar 目录表核对, 别靠"构建成功"就当没事。
 *
 * 用法: node scripts/list-asar.mjs [app.asar 路径]
 *       默认 release/win-unpacked/resources/app.asar
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "release", "win-unpacked", "resources", "app.asar");

if (!fs.existsSync(target)) {
  console.error(`✗ 找不到 ${target} —— 先跑 npm run dist:win`);
  process.exit(2);
}

/*
 * asar 头部是两层嵌套的 Chromium pickle, 错一个字节就读出一堆乱码:
 *   0..3    uint32 = 4            第一层 pickle 的 payload 长度, 恒为 4
 *   4..7    uint32 = headerSize   第二层 pickle 的 payload 长度
 *   8..11   uint32 = headerSize   第二层 pickle 再往里一层: 又是长度
 *   12..15  uint32 = jsonLen      JSON 目录表的字节长度
 *   16..    UTF-8 JSON 目录表
 * 目录表尾部有 \0 对齐填充, parse 前要去掉。
 * (实测值: 4 | 46372 | 46368 | 46361, JSON 从 0x10 开始)
 */
const fd = fs.openSync(target, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const raw = Buffer.alloc(jsonLen);
fs.readSync(fd, raw, 0, jsonLen, 16);
fs.closeSync(fd);
const tree = JSON.parse(raw.toString("utf8").replace(/\0+$/, ""));

const files = [];
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (v.files) walk(v, p);
    else files.push([p, v.size ?? 0]);
  }
})(tree, "");

/** 打包后必须存在的路径 (漏一个就是一个功能静默失效) */
const REQUIRED = [
  "/package.json",
  "/out/main/index.js",
  "/out/preload/index.js",
  "/out/renderer/index.html",
  "/build/icon.png",
];

console.log(`app.asar: ${target}`);
console.log(`共 ${files.length} 个文件\n`);

console.log("关键路径");
let missing = 0;
for (const want of REQUIRED) {
  const hit = files.find(([p]) => p === want);
  if (hit) console.log(`  ✔ ${String(hit[1]).padStart(9)}  ${want}`);
  else {
    console.log(`  ✘ ${"".padStart(9)}  ${want}   ← 缺失!`);
    missing++;
  }
}

console.log("\nbuild/ 全量 (图标这类资源最容易漏)");
const build = files.filter(([p]) => p.startsWith("/build"));
if (!build.length) {
  console.log("  (空 —— build.files 里大概率没写 \"build/**\" 或 \"build/icon.png\")");
  missing++;
} else {
  for (const [p, s] of build) console.log(`  ${String(s).padStart(9)}  ${p}`);
}

console.log("\nrenderer 资源");
for (const [p, s] of files.filter(([p]) => p.startsWith("/out/renderer/")))
  console.log(`  ${String(s).padStart(9)}  ${p}`);

process.exit(missing === 0 ? 0 : 1);
