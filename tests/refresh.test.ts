/**
 * 刷新率判据测试（被测件：scripts/lib/refresh.mjs）。
 *
 * 这一组防的是**"把 60Hz 写死"**：判据一旦写死，换到 90/160Hz 的机器上
 * "多少 ms 算掉帧"就比实际宽一倍多 —— 掉了帧也报"没掉"，
 * 于是"这台机器渲染没问题"这种结论会静默失真。
 *
 * 所以断言的重点**不是 60Hz**（本机就是 60Hz，只断言它等于什么都没验），
 * 而是"**同一个帧间隔，在不同刷新率下判据确实不同**"。
 */
import { hzFromMedian, drop1Ms, drop2Ms } from "../scripts/lib/refresh.mjs";

let passed = 0;
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`✗ ${msg} (期望 ${expected}, 实际 ${actual})`);
  passed++;
  console.log(`  ok  ${msg} (期望 ${expected}, 实际 ${actual})`);
}

function main() {
  console.log("-- 帧间隔中位 → 刷新率（60/90/160 三档都要对）--");
  eq(hzFromMedian(1000 / 60), 60, "16.67ms → 60Hz");
  eq(hzFromMedian(1000 / 90), 90, "11.11ms → 90Hz");
  eq(hzFromMedian(1000 / 160), 160, "6.25ms → 160Hz");

  console.log("-- 不合理的采样要判「探测失败」，不能硬凑一个 Hz --");
  eq(hzFromMedian(1000), null, "被节流到 1Hz → null");
  eq(hzFromMedian(2), null, "2ms（不现实）→ null");
  eq(hzFromMedian(NaN), null, "NaN → null");

  console.log("-- 判据随刷新率变（本组重点）--");
  const frame = 25; // 一个 25ms 的帧
  eq(frame > drop1Ms(1000 / 60), false, "25ms 帧 @60Hz 不算掉帧（门槛 33.3）");
  eq(frame > drop1Ms(1000 / 90), true, "同一个 25ms 帧 @90Hz 算掉帧（门槛 22.2）");
  eq(frame > drop1Ms(1000 / 160), true, "同一个 25ms 帧 @160Hz 算掉帧（门槛 12.5）");

  console.log("-- 门槛数值本身（换机器时人会拿它对表）--");
  eq(drop1Ms(1000 / 60).toFixed(1), "33.3", "掉1帧门槛 @60Hz = 33.3ms");
  eq(drop2Ms(1000 / 60).toFixed(1), "50.0", "掉2帧门槛 @60Hz = 50.0ms");
  eq(drop1Ms(1000 / 90).toFixed(1), "22.2", "掉1帧门槛 @90Hz = 22.2ms");
  eq(drop1Ms(1000 / 160).toFixed(1), "12.5", "掉1帧门槛 @160Hz = 12.5ms");

  console.log(`\n刷新率判据测试通过 ✔  (${passed} 项)`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
