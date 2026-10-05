/**
 * 渲染加速能力判断。
 *
 * 单独抽成一个纯函数，是因为这里的取值是个**开放集合**：Chromium 的
 * `gpu_compositing` 在不同版本/平台上会给出 `enabled` / `enabled_on` /
 * `enabled_force` / `enabled_force_on`，对面还有 `disabled` / `disabled_software` /
 * `disabled_off` / `disabled_off_ok` / `unavailable_software` / `unavailable_off` …
 *
 * 如果写成等于某几个字面量，将来 Chromium 多出一种 `enabled_*`，
 * 好好的机器就会被判成"没加速"，用户在设置页看到一条莫名其妙的警告，
 * 而且**越查越查不出原因**（代码看着完全正确）。所以只认前缀。
 *
 * 探不到时返回 `true`：宁可不说，也不要凭空吓唬用户。
 * 反过来说，只要报的是 `disabled_*` / `unavailable_*`，那就是真的在跑软件渲染 ——
 * 那种情况下玻璃的模糊/渐变/阴影全部按像素在 CPU 上算，切页面一帧画不完，
 * 合成器会先呈现已画好的分块（栅格顺序大致从左往右、从上往下），
 * 看着就像"整块内容从左上角冒出来再铺满"。详见 docs/RENDER-PERF.md 第 10 节。
 */
export function isCompositingAccelerated(status: string | null | undefined): boolean {
  if (!status) return true;
  return status.startsWith("enabled");
}
