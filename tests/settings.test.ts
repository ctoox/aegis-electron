/**
 * 设置测试: 默认值补齐 / 越界 clamp / 非法枚举回退 / 落盘往返 / 坏文件容错.
 * 核心不变量: loadSettings 永不抛错, 任何输入都能得到一份完整的合法 Settings.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FILENAME,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsPath,
} from "../src/core/settings";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error("✗ " + msg);
  passed++;
  console.log("  ok ", msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`,
  );
}

function main() {
  // ---------- 默认值 ----------
  eq(normalizeSettings({}), DEFAULT_SETTINGS, "空对象 → 全默认");
  eq(normalizeSettings(undefined), DEFAULT_SETTINGS, "undefined → 全默认");
  eq(normalizeSettings(null), DEFAULT_SETTINGS, "null → 全默认");
  eq(normalizeSettings("垃圾"), DEFAULT_SETTINGS, "非对象字符串 → 全默认");
  eq(normalizeSettings(42), DEFAULT_SETTINGS, "非对象数字 → 全默认");
  eq(DEFAULT_SETTINGS.autoLockMinutes, 5, "默认自动锁定 5 分钟");
  eq(DEFAULT_SETTINGS.clipboardClearSeconds, 30, "默认剪贴板 30 秒自清");
  eq(DEFAULT_SETTINGS.lockOnBlur, false, "默认不失焦即锁");
  eq(DEFAULT_SETTINGS.clearClipboardOnLock, true, "默认锁库清剪贴板");
  eq(DEFAULT_SETTINGS.hibpEnabled, true, "默认开启泄露检测");

  // ---------- clamp ----------
  eq(normalizeSettings({ autoLockMinutes: 99999 }).autoLockMinutes, 24 * 60, "自动锁定上限 1440 分钟");
  eq(normalizeSettings({ autoLockMinutes: -3 }).autoLockMinutes, 0, "自动锁定下限 0 (= 关闭)");
  eq(normalizeSettings({ autoLockMinutes: 7.6 }).autoLockMinutes, 8, "自动锁定取整");
  eq(normalizeSettings({ autoLockMinutes: 0 }).autoLockMinutes, 0, "0 是合法值 (关闭自动锁)");
  eq(normalizeSettings({ clipboardClearSeconds: 9999 }).clipboardClearSeconds, 600, "剪贴板上限 600 秒");
  eq(normalizeSettings({ clipboardClearSeconds: -1 }).clipboardClearSeconds, 0, "剪贴板下限 0");
  eq(normalizeSettings({ genLength: 1 }).genLength, 6, "生成长度下限 6");
  eq(normalizeSettings({ genLength: 9999 }).genLength, 64, "生成长度上限 64");
  eq(normalizeSettings({ genMinDigits: -5 }).genMinDigits, 0, "最少数字下限 0");
  eq(normalizeSettings({ genMinSymbols: 999 }).genMinSymbols, 16, "最少符号上限 16");

  // ---------- 类型错误回退 ----------
  eq(normalizeSettings({ theme: "neon" }).theme, "system", "非法主题 → 跟随系统");
  eq(normalizeSettings({ theme: "dark" }).theme, "dark", "合法主题保留");
  eq(normalizeSettings({ theme: "light" }).theme, "light", "合法主题保留 (light)");
  eq(normalizeSettings({ glass: "yes" }).glass, DEFAULT_SETTINGS.glass, "非布尔 glass → 默认");
  eq(normalizeSettings({ lockOnBlur: true }).lockOnBlur, true, "布尔字段保留");
  eq(normalizeSettings({ autoLockMinutes: "15" as unknown as number }).autoLockMinutes, 15, "数字字符串可解析");
  eq(normalizeSettings({ genLength: "abc" as unknown as number }).genLength, DEFAULT_SETTINGS.genLength, "垃圾数字 → 默认");

  // ---------- 部分字段: 其余补默认 ----------
  const partial = normalizeSettings({ theme: "light" });
  eq(partial.theme, "light", "提供的字段生效");
  eq(partial.autoLockMinutes, DEFAULT_SETTINGS.autoLockMinutes, "未提供的字段补默认");
  eq(
    Object.keys(partial).sort().join(","),
    Object.keys(DEFAULT_SETTINGS).sort().join(","),
    "输出字段集合与默认完全一致 (无缺项/无多余)",
  );

  // ---------- 落盘往返 ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-settings-"));
  eq(loadSettings(dir), DEFAULT_SETTINGS, "文件不存在 → 默认 (不报错)");

  const saved = saveSettings(dir, { autoLockMinutes: 15, theme: "dark", clipboardClearSeconds: 60 });
  eq(saved.autoLockMinutes, 15, "save 返回合并后的值");
  eq(loadSettings(dir).theme, "dark", "重新读取 theme");
  eq(loadSettings(dir).clipboardClearSeconds, 60, "重新读取剪贴板设置");
  eq(loadSettings(dir).autoLockMinutes, 15, "重新读取自动锁定");
  eq(loadSettings(dir).genLength, DEFAULT_SETTINGS.genLength, "未改动的字段保持默认");

  const second = saveSettings(dir, { genLength: 32 });
  eq(second.genLength, 32, "第二次 save 是 patch 合并而非整体覆盖");
  eq(second.theme, "dark", "第二次 save 后先前设置仍在");
  eq(loadSettings(dir).genLength, 32, "第二次 save 已落盘");

  // 越界值落盘时就被 clamp, 不会写进文件
  saveSettings(dir, { genLength: 9999 });
  eq(loadSettings(dir).genLength, 64, "落盘时 clamp 到 64");

  ok(fs.existsSync(path.join(dir, SETTINGS_FILENAME)), `文件名固定为 ${SETTINGS_FILENAME}`);
  eq(settingsPath(dir), path.join(dir, SETTINGS_FILENAME), "settingsPath = userData 拼接文件名");

  // ---------- 坏文件容错 ----------
  fs.writeFileSync(settingsPath(dir), "{ 这不是 json", "utf8");
  eq(loadSettings(dir), DEFAULT_SETTINGS, "JSON 损坏 → 回落默认而非抛错");

  fs.writeFileSync(settingsPath(dir), "", "utf8");
  eq(loadSettings(dir), DEFAULT_SETTINGS, "空文件 → 回落默认");

  fs.writeFileSync(settingsPath(dir), JSON.stringify({ autoLockMinutes: 0, 未知字段: 1, theme: "neon" }), "utf8");
  const dirty = loadSettings(dir);
  eq(dirty.autoLockMinutes, 0, "未知字段被忽略, 已知字段保留");
  eq(dirty.theme, "system", "非法枚举回落默认");
  eq(
    Object.keys(dirty).sort().join(","),
    Object.keys(DEFAULT_SETTINGS).sort().join(","),
    "脏文件读出来仍是完整合法结构",
  );

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n设置测试通过 ✔  (${passed} 项)`);
}

main();
