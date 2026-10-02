/**
 * 密码生成与强度评估 (移植 Python 版 aegis_core/generate.py 语义):
 *  - 四字符池开关 + 最少数字/符号硬约束, 约束超长抛中文错误
 *  - 强度: 字符池熵估算 (bit) + 常见弱口令惩罚; 阈值 28/40/60/80
 * 渲染层与主进程都可 import (纯 TS, 无 Node 依赖).
 */
import crypto from "node:crypto";

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

export function strengthBits(password: string): number {
  if (!password) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 28;
  const lowered = password.toLowerCase();
  const penalty = ["password", "123456", "qwerty", "admin"].includes(lowered)
    ? 0.7
    : 1;
  return Math.floor(password.length * Math.log2(Math.max(pool, 2)) * penalty);
}

export type Strength = "good" | "fair" | "weak" | "none";

export function strengthOf(password: string): Strength {
  if (!password) return "none";
  const bits = strengthBits(password);
  if (bits < 40) return "weak";
  if (bits < 60) return "fair";
  return "good";
}
