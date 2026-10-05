/**
 * 渲染加速判断测试。
 *
 * 这一组是**防误报**的护栏：判错的后果是"好机器被说成没加速"，
 * 用户在设置页看到一条查不出原因的警告（狼来了），而不是漏报。
 */
import { isCompositingAccelerated } from "../src/core/gpu";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`✗ ${msg} (期望 ${expected}, 实际 ${actual})`);
  passed++;
  console.log(`  ok  ${msg} (期望 ${expected}, 实际 ${actual})`);
}

function main() {
  console.log("-- 硬件加速: 拿到的是 enabled 系列 --");
  // 前缀判断的全部意义在这三条: 后面两种是真实存在、但很容易被写死的 equals 漏掉的值
  for (const s of ["enabled", "enabled_on", "enabled_force", "enabled_force_on"]) {
    eq(isCompositingAccelerated(s), true, `"${s}" 算已启用`);
  }

  console.log("-- 硬件加速: 拿到的是 disabled / unavailable 系列 --");
  for (const s of [
    "disabled",
    "disabled_software",
    "disabled_off",
    "disabled_off_ok",
    "unavailable_software",
    "unavailable_off",
    "unavailable_off_ok",
  ]) {
    eq(isCompositingAccelerated(s), false, `"${s}" 算未启用`);
  }

  console.log("-- 硬件加速: 探不到时不吓唬用户 --");
  eq(isCompositingAccelerated(undefined), true, "undefined → 当作正常（不提示）");
  eq(isCompositingAccelerated(null), true, "null → 当作正常（不提示）");
  eq(isCompositingAccelerated(""), true, "空串 → 当作正常（不提示）");
  eq(isCompositingAccelerated("unknown"), false, '"unknown" 不是 enabled 前缀 → 按未启用处理');
  eq(isCompositingAccelerated("Enabled"), false, "大小写敏感: Chromium 只给小写, 别自作主张");

  console.log(`\n渲染加速判断测试通过 ✔  (${passed} 项)`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
