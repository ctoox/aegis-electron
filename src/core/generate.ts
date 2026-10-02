/**
 * 密码生成 (移植 Python 版 aegis_core/generate.py 语义):
 *  - 四字符池开关 + 最少数字/符号硬约束, 约束超长抛中文错误
 *
 * 注意: 本文件依赖 node:crypto (随机数), **只能在主进程 import**。
 * 强度评估已拆到 ./strength.ts (纯算法), 渲染层请从那里取, 否则会把
 * node:crypto 拖进前端产物。这里仍然 re-export 一次, 保持旧调用点不破。
 */
import crypto from "node:crypto";
import { strengthBits, strengthOf, type Strength } from "./strength";

export { strengthBits, strengthOf };
export type { Strength };

const SYMBOLS = "!@#$%^&*()-_=+[]{}:,.";
const WORDS =
  ("anchor apple amber arrow atlas acorn aurora bamboo basil beacon birch bloom " +
    "brace brisk brook butter cactus candle canyon cedar cherry cinder cliff clover " +
    "comet coral cosmic cotton crater crystal dagger dawn delta desert dolphin dragon " +
    "dune ember emerald falcon feather fern flame flint forest fossil galaxy garden " +
    "garnet ginger glacier granite harbor hazel heron hollow horizon indigo island " +
    "ivory jade jasper jungle kayak lagoon lantern lava lemon lilac lotus lunar maple " +
    "marble meadow mesa mint mist morning moss nebula nectar nickel noble north nova " +
    "oak ocean olive onyx orbit orchard otter paddle pebble pepper pine planet plume " +
    "polar prairie quartz quill radiant raven reef ripple river robin rocket rose " +
    "rustic sage salmon sandal sapphire savanna shadow silver slate solar spruce " +
    "stellar summit sunset thistle thunder tiger timber topaz torch tulip tundra " +
    "umber valley vanilla velvet vortex walnut willow winter zephyr").split(" ");

function pick(pool: string): string {
  return pool[crypto.randomInt(pool.length)];
}

function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

export interface GenOptions {
  length: number;
  useUpper: boolean;
  useLower: boolean;
  useDigits: boolean;
  useSymbols: boolean;
  minDigits: number;
  minSymbols: number;
}

export function generatePassword(opts: GenOptions): string {
  const pools: string[] = [];
  if (opts.useLower) pools.push("abcdefghijklmnopqrstuvwxyz");
  if (opts.useUpper) pools.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  if (opts.useDigits) pools.push("0123456789");
  if (opts.useSymbols) pools.push(SYMBOLS);
  if (pools.length === 0) throw new Error("至少要启用一类字符");

  const nDigits = opts.useDigits ? Math.max(0, opts.minDigits) : 0;
  const nSymbols = opts.useSymbols ? Math.max(0, opts.minSymbols) : 0;
  const extraDigits = opts.useDigits ? Math.max(0, nDigits - 1) : 0;
  const extraSymbols = opts.useSymbols ? Math.max(0, nSymbols - 1) : 0;
  if (opts.length < pools.length + extraDigits + extraSymbols) {
    throw new Error(
      `长度 ${opts.length} 太短: 放不下最少 ${pools.length} 类字符` +
        ` + ${extraDigits} 位数字 + ${extraSymbols} 位符号`,
    );
  }

  const chars = pools.map(pick);
  for (let i = 0; i < extraDigits; i++) chars.push(pick("0123456789"));
  for (let i = 0; i < extraSymbols; i++) chars.push(pick(SYMBOLS));
  const alphabet = pools.join("");
  while (chars.length < opts.length) chars.push(pick(alphabet));
  return shuffle(chars).join("");
}

export function generatePassphrase(count = 4, sep = "-"): string {
  const words = Array.from(
    { length: count },
    () => WORDS[crypto.randomInt(WORDS.length)],
  );
  const n = crypto.randomInt(100);
  return [...words, String(n).padStart(2, "0")].join(sep);
}

// 强度评估本体在 ./strength.ts (纯算法), 见文件头的说明
