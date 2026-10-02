/**
 * 密码强度评估 (纯 TS, 无任何 Node 依赖).
 *
 * 单独成文件的原因: 渲染层要用它算健康分, 而 `generate.ts` 依赖 `node:crypto`,
 * 一旦把 generate.ts 拉进渲染层, Vite 就会把 node:crypto 外部化成空壳
 * —— 现在能跑只是因为没调用到; 换壳 (Tauri) 或改打包配置立刻会炸.
 * 所以「算法」与「随机数」必须分开: 纯算法在这, 随机数留在 generate.ts。
 *
 * 强度 = 字符池熵估算 (bit) + 常见弱口令惩罚; 阈值 40/60 bit。
 */

/** 字符池熵估算: 长度 × log2(池大小), 常见弱口令再打 0.7 折 */
export function strengthBits(password: string): number {
  if (!password) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 28;
  const lowered = password.toLowerCase();
  const penalty = ["password", "123456", "qwerty", "admin"].includes(lowered) ? 0.7 : 1;
  return Math.floor(password.length * Math.log2(Math.max(pool, 2)) * penalty);
}

export type Strength = "good" | "fair" | "weak" | "none";

/** 强度阈值: < 40 bit 弱, < 60 bit 一般, 否则强 */
export function strengthOf(password: string): Strength {
  if (!password) return "none";
  const bits = strengthBits(password);
  if (bits < 40) return "weak";
  if (bits < 60) return "fair";
  return "good";
}

/** 弱密码判定阈值 (bit) —— health.ts 与设置页共用同一个常量 */
export const WEAK_BITS = 40;
