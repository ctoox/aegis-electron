/**
 * 刷新率探测 —— 让"掉帧判据"跟着显示器走，而不是写死 60Hz。
 *
 * 为什么需要：**"多少 ms 算掉一帧"随刷新率变**。
 *   60Hz  → 1 帧 16.7ms，掉 1 帧 ≈ 33ms
 *   90Hz  → 1 帧 11.1ms，掉 1 帧 ≈ 22ms
 *   160Hz → 1 帧  6.3ms，掉 1 帧 ≈ 12.5ms
 * 把 33ms 写死，换到高刷机器上判据就**比实际宽一倍多** —— 掉了帧也报"没掉"，
 * 于是"这台机器渲染没问题"这种结论会静默失真。判据必须跟着实测走。
 *
 * 探测法：让页面**空闲地**跑一小段 rAF，取**帧间隔中位数**。
 * 这测的是"应用实际能拿到的呈现节奏"，而不是显示器的标称值：
 * 若合成器把 rAF 压到 60Hz，这里就报 60 —— 那正是判断"有没有掉帧"该用的基准。
 *
 * ⚠ 前提：窗口必须真的在前台。被遮挡/最小化时 Chromium 会把 rAF 节流到 ~1Hz，
 *   中位数会大得离谱；这种情况按"探测失败"处理并退回 60Hz，由调用方标注出来。
 *
 * ⚠ 调用方的 `cdp.js()` 把代码包成**非 async** 的 `(() => { … })()` ——
 *   所以这里**不能写 `await`**，只能 `return new Promise(...)`，
 *   靠 CDP 的 `awaitPromise: true` 去等它（写 `await` 会直接语法错误，
 *   然后被 catch 吞成"探测失败"，症状是"永远是 60Hz"）。
 */

/** 探测失败时的退路。调用方应把"没探测成功"显式打印，别让读者以为量到了。 */
export const FALLBACK_VSYNC_MS = 1000 / 60;

/**
 * 帧间隔中位数 → 刷新率。超出现实范围（3~40ms ≈ 25~333Hz）返回 null，
 * 表示"这个数不是刷新率"（多半是窗口被遮挡、rAF 被节流到 ~1Hz）。
 * 抽成纯函数是为了能直接对 60/90/160 三档做断言，而不是只能在真机上碰运气。
 */
export function hzFromMedian(medianMs) {
  if (!(medianMs >= 3 && medianMs <= 40)) return null;
  return Math.round(1000 / medianMs);
}

/**
 * @param {{ js: (code: string) => Promise<any> }} cdp 已连接的 CDP 句柄
 * @param {{ samples?: number, retries?: number }} [opts] 采样帧数（默认 45 ≈ 0.75s@60Hz）
 * @returns {Promise<{ hz:number, ms:number, measured:boolean, medianMs:number|null }>}
 */
export async function detectRefresh(cdp, opts = {}) {
  const samples = opts.samples ?? 45;
  const retries = opts.retries ?? 1;

  const sampleOnce = async () => {
    // ★ 注意：不能写 await（外层是同步 IIFE），靠 awaitPromise 等这个 Promise
    const raw = await cdp.js(`
      return new Promise((resolve) => {
        const t = [];
        let last = 0, n = 0;
        const tick = (ts) => {
          if (last) t.push(ts - last);
          last = ts;
          if (++n >= ${samples}) resolve(JSON.stringify(t));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    `);
    const arr = JSON.parse(String(raw ?? "[]"))
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    return arr.length ? arr[Math.floor(arr.length / 2)] : null;
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    let med = null;
    try {
      med = await sampleOnce();
    } catch {
      med = null;
    }
    const hz = hzFromMedian(med);
    if (hz !== null) {
      return { hz, ms: 1000 / hz, measured: true, medianMs: med };
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 350));
    else return { hz: 60, ms: FALLBACK_VSYNC_MS, measured: false, medianMs: med };
  }
  return { hz: 60, ms: FALLBACK_VSYNC_MS, measured: false, medianMs: null };
}

/** 掉 1 帧 ≈ 两个 vsync 没出帧。 */
export const drop1Ms = (vsyncMs) => 2 * vsyncMs;
/** 掉 2 帧 ≈ 三个 vsync。 */
export const drop2Ms = (vsyncMs) => 3 * vsyncMs;

/** 人话描述，给报告头用。未探到时报"实际中位"而不是兜底值，免得看着像测到了。 */
export function describeRefresh(r, vsyncMs) {
  const verdict = r.measured ? `约 ${r.hz}Hz` : "退回 60Hz";
  const medTxt =
    r.medianMs === null ? "中位读不到" : `实测帧间隔中位 ${r.medianMs.toFixed(2)}ms`;
  return (
    `${r.measured ? "渲染节奏" : "渲染节奏（未探到，" + verdict + "）"}: ${medTxt} → ${verdict}` +
    `；判据: 掉1帧 > ${drop1Ms(vsyncMs).toFixed(1)}ms，掉2帧 > ${drop2Ms(vsyncMs).toFixed(1)}ms`
  );
}
