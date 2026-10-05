/**
 * 设置测试: 默认值补齐 / 越界 clamp / 非法枚举回退 / 落盘往返 / 坏文件容错.
 * 核心不变量: loadSettings 永不抛错, 任何输入都能得到一份完整的合法 Settings.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLIP_CLEAR_CHOICES,
  DEFAULT_SETTINGS,
  SETTINGS_FILENAME,
  clipClearLabel,
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

  // ---- 快速填充的默认值 ----
  // autotypeAutoSubmit 这条是**安全默认**的看门狗：一旦有人把默认改成 true，
  // 填法就会在一个我们并不知道是哪个网站的窗口里自动回车提交。改它之前先看它红。
  eq(DEFAULT_SETTINGS.autotypeEnabled, true, "默认启用快速填充");
  eq(DEFAULT_SETTINGS.autotypeDefaultMode, "both", "默认填法 = 用户名 + 密码");
  eq(DEFAULT_SETTINGS.autotypeAutoSubmit, false, "★ 默认不自动提交 (无域绑定, 必须留给用户按回车)");
  eq(DEFAULT_SETTINGS.autotypeTypeDelayMs, 0, "默认逐字符不间隔");
  eq(DEFAULT_SETTINGS.autotypeHotkey, "CommandOrControl+Alt+Shift+F", "默认快捷键");
  eq(DEFAULT_SETTINGS.autotypeShowTargetTitle, true, "默认回显目标窗口标题");

  // ---------- clamp ----------
  eq(normalizeSettings({ autoLockMinutes: 99999 }).autoLockMinutes, 24 * 60, "自动锁定上限 1440 分钟");
  eq(normalizeSettings({ autoLockMinutes: -3 }).autoLockMinutes, 0, "自动锁定下限 0 (= 关闭)");
  eq(normalizeSettings({ autoLockMinutes: 7.6 }).autoLockMinutes, 8, "自动锁定取整");
  eq(normalizeSettings({ autoLockMinutes: 0 }).autoLockMinutes, 0, "0 是合法值 (关闭自动锁)");
  eq(normalizeSettings({ clipboardClearSeconds: 9999 }).clipboardClearSeconds, 600, "剪贴板上限 600 秒");
  eq(normalizeSettings({ clipboardClearSeconds: -1 }).clipboardClearSeconds, 0, "剪贴板下限 0");
  eq(normalizeSettings({ clipboardClearSeconds: 300 }).clipboardClearSeconds, 300, "跨机粘贴用的 5 分钟档可用");

  // ---- 剪贴板自清的选项与标签 ----
  // 为什么盯着这个列表: 「0 = 不清空」和「300 = 5 分钟」是跨机粘贴（无界鼠标那类）
  // 唯一能用的两档 —— 自动清空的每一次触发都会被同步到另一台机器。
  ok(CLIP_CLEAR_CHOICES.includes(0), "★ 选项里有「不清空」（跨机粘贴要靠它）");
  ok(CLIP_CLEAR_CHOICES.includes(300), "选项里有 5 分钟（给跨机粘贴留出从容的时间）");
  ok(
    CLIP_CLEAR_CHOICES.every((s, i) => s >= 0 && s <= 600 && (i === 0 || s > CLIP_CLEAR_CHOICES[i - 1])),
    "选项全部落在 0..600 内且严格递增（上限必须与 normalizeSettings 的 clamp 一致）",
  );
  eq(clipClearLabel(0), "不清空", "0 的标签是「不清空」");
  eq(clipClearLabel(30), "30 秒", "不足一分钟按秒显示");
  eq(clipClearLabel(120), "2 分钟", "整分钟换成分钟");
  eq(clipClearLabel(300), "5 分钟", "300 → 5 分钟");
  eq(clipClearLabel(-5), "不清空", "负数也当「不清空」，不出现 -5 秒这种标签");
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

  // ---------- 快速填充 ----------
  eq(normalizeSettings({ autotypeTypeDelayMs: 9999 }).autotypeTypeDelayMs, 1000, "逐字符延迟上限 1000ms");
  eq(normalizeSettings({ autotypeTypeDelayMs: -20 }).autotypeTypeDelayMs, 0, "逐字符延迟下限 0");
  eq(normalizeSettings({ autotypeTypeDelayMs: 30.4 }).autotypeTypeDelayMs, 30, "逐字符延迟取整");
  eq(normalizeSettings({ autotypeTypeDelayMs: "60" as unknown as number }).autotypeTypeDelayMs, 60, "延迟数字字符串可解析");
  eq(normalizeSettings({ autotypeDefaultMode: "teleport" }).autotypeDefaultMode, "both", "非法填法 → 默认");
  eq(normalizeSettings({ autotypeDefaultMode: "custom" }).autotypeDefaultMode, "custom", "合法填法保留 (custom)");
  eq(normalizeSettings({ autotypeDefaultMode: "password" }).autotypeDefaultMode, "password", "合法填法保留 (password)");
  // 字符串 "true" 不能偷偷把自动提交打开 —— 手改 JSON 时最容易写成带引号的假布尔
  eq(normalizeSettings({ autotypeAutoSubmit: "true" as unknown as boolean }).autotypeAutoSubmit, false, '字符串 "true" 不算开');
  eq(normalizeSettings({ autotypeAutoSubmit: true }).autotypeAutoSubmit, true, "真布尔 true 才生效");
  eq(normalizeSettings({ autotypeShowTargetTitle: 0 as unknown as boolean }).autotypeShowTargetTitle, true, "非布尔回显开关 → 默认");
  // 快捷键**不做格式校验**（合法性交给 globalShortcut.register 判定），
  // 但空值必须兜回默认 —— 否则会拿空串去注册，表现为"设置里明明有快捷键，按下去没反应"。
  eq(normalizeSettings({ autotypeHotkey: "" }).autotypeHotkey, DEFAULT_SETTINGS.autotypeHotkey, "空快捷键 → 默认");
  eq(normalizeSettings({ autotypeHotkey: "   " }).autotypeHotkey, DEFAULT_SETTINGS.autotypeHotkey, "全空白快捷键 → 默认");
  eq(normalizeSettings({ autotypeHotkey: 42 as unknown as string }).autotypeHotkey, DEFAULT_SETTINGS.autotypeHotkey, "非字符串快捷键 → 默认");
  eq(normalizeSettings({ autotypeHotkey: "  Alt+Q  " }).autotypeHotkey, "Alt+Q", "自定义快捷键保留并去掉空白");

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

  // 快速填充的设置同样要能落盘往返。saveSettings 是 patch 合并，
  // 漏一个键就会"改了设置、重启就没了"，所以六个字段全走一遍。
  const atSaved = saveSettings(dir, {
    autotypeDefaultMode: "password",
    autotypeAutoSubmit: true,
    autotypeTypeDelayMs: 30,
    autotypeHotkey: "Alt+Shift+P",
  });
  eq(atSaved.autotypeDefaultMode, "password", "save 返回合并后的填法");
  const atBack = loadSettings(dir);
  eq(atBack.autotypeDefaultMode, "password", "重新读取填法");
  eq(atBack.autotypeAutoSubmit, true, "重新读取自动提交开关");
  eq(atBack.autotypeTypeDelayMs, 30, "重新读取逐字符延迟");
  eq(atBack.autotypeHotkey, "Alt+Shift+P", "重新读取快捷键");
  eq(atBack.autoLockMinutes, 15, "写快速填充设置不会冲掉先前的自动锁定");
  eq(atBack.theme, "dark", "写快速填充设置不会冲掉先前的主题");

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
