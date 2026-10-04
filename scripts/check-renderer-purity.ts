/**
 * 渲染层纯度检查 —— 守住「前端零 Node API」这条硬约束。
 *
 * 为什么非查不可:
 *   Electron 渲染进程是 `contextIsolation + sandbox`, **没有 Node 集成**。
 *   渲染层一旦直接 import 含 `node:*` 的模块, vite 在 dev 下可能只是打个警告,
 *   看着"能跑"; 打包后直接白屏或 `Cannot read properties of undefined`,
 *   而且报错位置离真正的病根(某个 core 模块的 import)隔了十万八千里。
 *   这类问题必须让 CI 在合并前拦住, 不能靠人记得。
 *
 * 判定方式 (传递闭包, 不是只看直接 import):
 *   从 `src/renderer` 出发沿 import 链一路走, 只要链上任何一环碰了 Node 内置,
 *   就把完整链路打出来: `App.tsx:3 → src/core/vault.ts:2 → node:crypto`。
 *   这样 `src/core/` 里的文件怎么改名、怎么拆分都不会把规则写死 ——
 *   纯模块 (health/formats/prefs/strength/types) 随便引, 含 Node 的 (vault/settings/
 *   generate/totp/hibp/crypto) 一引就红。
 *
 * 例外: `import type { ... }` / `export type { ... }` 会被 TS 完全擦除, 不算违规。
 *       同理 `import { type A, B } from "x"` 里的 B 仍算值导入, 照查。
 *
 *   npx tsx scripts/check-renderer-purity.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { builtinModules } from "node:module";

const root = process.cwd();
const SRC = path.join(root, "src");
const RENDERER = path.join(SRC, "renderer");
const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/** Node 内置 + 明确不许渲染层碰的运行时包 */
const FORBIDDEN = new Set<string>([
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
  "electron",
]);

type Edge = { file: string; line: number; spec: string; typeOnly: boolean };

function lineOf(code: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === "\n") n++;
  return n;
}

/** 抽取一个文件里的所有 import/export-from 说明符 (含跨行写法) */
function edgesOf(file: string): Edge[] {
  const code = fs.readFileSync(file, "utf8");
  const out: Edge[] = [];
  const push = (m: RegExpMatchArray, spec: string, decl: string) => {
    out.push({
      file,
      line: lineOf(code, m.index ?? 0),
      spec,
      typeOnly: /^\s*type\s/.test(decl),
    });
  };

  // import <decl> from "spec"   (decl 可能跨行)
  for (const m of code.matchAll(/(?:^|\n)[ \t]*import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
    push(m, m[2], m[1]);
  }
  // import "spec";  —— 副作用导入
  for (const m of code.matchAll(/(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g)) {
    push(m, m[1], "");
  }
  // export <decl> from "spec"
  for (const m of code.matchAll(/(?:^|\n)[ \t]*export\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
    push(m, m[2], m[1]);
  }
  // 动态 import("spec")  —— 运行时才加载, 但同样进打包图
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    push(m, m[1], "");
  }
  return out;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...EXT.map((e) => base + e)];
  for (const e of EXT) candidates.push(path.join(base, "index" + e));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 不存在, 继续试下一个 */
    }
  }
  return null;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(root, p).replace(/\\/g, "/");

const roots = listFiles(RENDERER);
const violations: string[] = [];
const visited = new Set<string>();
/** 顺带统计一下渲染层真正的依赖闭包, 让输出能自证"扫到了什么" */
const closure = new Set<string>();
let scanned = 0;

const queue: Array<{ file: string; chain: string[] }> = roots.map((f) => ({ file: f, chain: [] }));

while (queue.length) {
  const { file, chain } = queue.shift()!;
  const key = file + "|" + chain.join(">");
  if (visited.has(key)) continue;
  visited.add(key);
  if (file !== RENDERER) scanned++;
  if (chain.length > 0) closure.add(file);

  for (const e of edgesOf(file)) {
    if (e.typeOnly) continue;
    const spec = e.spec;
    const here = `${rel(file)}:${e.line}`;
    const nextChain = [...chain, here];

    if (FORBIDDEN.has(spec) || (spec.startsWith("node:") && !FORBIDDEN.has(spec))) {
      violations.push(`${here}  →  ${spec}\n        ${nextChain.join("  →  ")}`);
      continue;
    }
    // 相对路径 / 别名落到 src/ 里的, 跟着走一层
    // (只跟代码文件; `import "./styles.css"` 这类资源导入不进依赖闭包, 免得统计里混进 CSS)
    const resolved = resolveLocal(file, spec);
    if (resolved && resolved.startsWith(SRC) && EXT.includes(path.extname(resolved))) {
      queue.push({ file: resolved, chain: nextChain });
    }
  }
}

console.log(`渲染层纯度检查`);
console.log(`  渲染层文件 : ${roots.length}`);
console.log(`  src 依赖闭包: ${closure.size} 个文件`);
for (const f of [...closure].sort()) console.log(`      · ${rel(f)}`);

if (violations.length) {
  console.error(`\n✗ 发现 ${violations.length} 处渲染层 Node API 泄漏:\n`);
  for (const v of violations) console.error(`  · ${v}\n`);
  console.error(
    "修法: 把含 node:* 的那部分逻辑拆成纯模块 (参考 strength.ts ← generate.ts 的做法),\n" +
      "      或者把该能力做成 main 进程的 IPC (preload → api.ts 暴露给渲染层)。",
  );
  process.exit(1);
}

console.log(`\n✔ 渲染层没有任何 Node API (直接或传递) —— contextIsolation 下不会再白屏`);
