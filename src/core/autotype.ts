/**
 * 把一条条目编译成「按键序列」—— 纯逻辑，不碰任何平台 API。
 *
 * 分工
 * ----
 * 这里只回答一个问题：**该往目标窗口依次打什么？**
 * 真去打字的是 `src/main/autotype-native.ts`（经 N-API 模块调 Windows `SendInput`）。
 * 拆开有两个好处：
 *   1. 序列可以在单元测试里逐段断言，不需要真键盘、也不需要 GUI；
 *   2. 本文件是**纯模块**（零 `node:*`），渲染层要直接 import 它来算「这条会怎么填」
 *      的预览行 —— 而 `npm run check:purity` 会沿 import 链做传递闭包检查，
 *      一旦这里碰了 `node:*`，渲染层一 import 就红。**别在这里加任何 Node 依赖。**
 *
 * 三种内置填法（对应不同网站的登录框）
 * ------------------------------------
 * `both`     —— 先打用户名，按 `Tab` 跳到密码框，再打密码。大多数登录页。
 * `password` —— 只打密码。适合「分两步登录」（先填账号再翻页），或密码框已聚焦。
 * `username` —— 只打用户名。
 * `custom`   —— 自己写模板，例如 `{USERNAME}{TAB}{PASSWORD}{ENTER}`。
 *
 * 占位符
 * ------
 * `{USERNAME}` `{PASSWORD}` `{TITLE}` `{URL}`
 * `{TAB}` `{ENTER}` `{SPACE}` `{BACKSPACE}` `{ESC}`
 * `{UP}` `{DOWN}` `{LEFT}` `{RIGHT}` `{HOME}` `{END}` `{DELETE}`
 * `{DELAY:300}` —— 停顿 300 毫秒（有些前端需要等接口返回）
 *
 * 与 Python 版（`aegis_core/autotype.py`）的关系
 * ----------------------------------------------
 * 本文件是它的 1:1 移植，行为逐条对齐，**唯一有意为之的差异**在
 * `unknownPlaceholders`：原版只校验 `{DELAY:n}` 的参数，`{TAB:5}` 这种写法会被
 * 放过，然后在展开阶段落成**字面量 `{TAB:5}` 直接打进目标窗口**。这里补上了这条校验。
 */
import {
  FILL_BOTH,
  FILL_CUSTOM,
  FILL_MODES,
  FILL_PASSWORD,
  FILL_USERNAME,
  fillLabel,
  isValidFillMode,
  type FillMode,
} from "./prefs";
import type { Entry } from "./types";

// ---------------------------------------------------------------- 常量表

/** 各填充方式对应的默认模板 */
export const TEMPLATES: Record<string, string> = {
  [FILL_BOTH]: "{USERNAME}{TAB}{PASSWORD}",
  [FILL_PASSWORD]: "{PASSWORD}",
  [FILL_USERNAME]: "{USERNAME}",
};

export const DEFAULT_CUSTOM_TEMPLATE = "{USERNAME}{TAB}{PASSWORD}{ENTER}";

/** 占位符 -> 取值来源（Entry 字段） */
const FIELD_PLACEHOLDERS: Record<string, keyof Entry> = {
  USERNAME: "username",
  PASSWORD: "password",
  TITLE: "title",
  URL: "url",
};

/** 占位符 -> 键名（交给平台层发送） */
const KEY_PLACEHOLDERS: Record<string, string> = {
  TAB: "Tab",
  ENTER: "Enter",
  SPACE: "Space",
  BACKSPACE: "Backspace",
  ESC: "Escape",
  ESCAPE: "Escape",
  DELETE: "Delete",
  DEL: "Delete",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  HOME: "Home",
  END: "End",
};

/** 界面上「可用占位符」提示列表（排序保证渲染稳定） */
export const PLACEHOLDER_NAMES: readonly string[] = [
  ...new Set([...Object.keys(FIELD_PLACEHOLDERS), ...Object.keys(KEY_PLACEHOLDERS), "DELAY"]),
].sort();

/** 匹配 `{NAME}` 或 `{NAME:123}` */
const TOKEN_RE = /\{([A-Za-z]+)(?::(\d+))?\}/g;

/** extra 里存填充方式 / 自定义模板的键名。**与 Python 版同名**，分享包互通时不会丢 */
export const EXTRA_FILL = "fill";
export const EXTRA_FILL_TEMPLATE = "fill_template";

export class AutoTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoTypeError";
  }
}

// ---------------------------------------------------------------- Token

export type TokenKind = "text" | "key" | "delay" | "empty";

/** 序列里的一段：文本 / 按键 / 停顿 / 空占位 */
export interface Token {
  kind: TokenKind;
  /** text/key -> string; delay -> number(毫秒); empty -> "" */
  value: string | number;
}

export const text = (value: string): Token => ({ kind: "text", value });
export const key = (name: string): Token => ({ kind: "key", value: name });
export const delay = (ms: number): Token => ({ kind: "delay", value: Math.trunc(ms) });

/**
 * 占位符取到空值时的哨兵：它本身不发送任何东西，但能让清理阶段知道
 * 「这里的 Tab 是被空值孤立的，应该去掉」。
 */
export const EMPTY: Token = { kind: "empty", value: "" };

/** 给界面显示的一段（与 Python 的 `Token.__str__` 同形） */
export function tokenLabel(t: Token): string {
  switch (t.kind) {
    case "text":
      return String(t.value);
    case "key":
      return `<${t.value}>`;
    case "empty":
      return "<空>";
    default:
      return `<等待${t.value}ms>`;
  }
}

// ---------------------------------------------------------------- 条目上的填充方式

/** 条目可能来自导入，`extra` 在运行期不保证存在 */
function extraOf(entry: Entry): Record<string, string> {
  return (entry?.extra ?? {}) as Record<string, string>;
}

/** 读条目自带的填充方式（存在 `extra.fill`），没设就用 defaultMode */
export function fillModeOf(entry: Entry, defaultMode: FillMode = FILL_BOTH): FillMode {
  const raw = extraOf(entry)[EXTRA_FILL];
  return isValidFillMode(raw) ? raw : defaultMode;
}

/** 写回条目的填充方式；传 null/undefined/空串 = 清除（退回全局默认） */
export function setFillMode(entry: Entry, mode: FillMode | null | undefined): void {
  // 用 falsy 一次覆盖 null / undefined / ""（后者是 Python 版的写法遗留，运行期仍可能传进来）
  if (!mode) {
    delete extraOf(entry)[EXTRA_FILL];
    return;
  }
  if (!isValidFillMode(mode)) throw new AutoTypeError(`未知填充方式: ${mode}`);
  extraOf(entry)[EXTRA_FILL] = mode;
}

export function fillTemplateOf(entry: Entry): string {
  return String(extraOf(entry)[EXTRA_FILL_TEMPLATE] ?? "");
}

export function setFillTemplate(entry: Entry, template: string): void {
  const t = (template ?? "").trim();
  if (t) extraOf(entry)[EXTRA_FILL_TEMPLATE] = t;
  else delete extraOf(entry)[EXTRA_FILL_TEMPLATE];
}

/** 算出这条条目在这个方式下实际用的模板 */
export function effectiveTemplate(entry: Entry, mode: FillMode): string {
  if (mode === FILL_CUSTOM) return fillTemplateOf(entry) || DEFAULT_CUSTOM_TEMPLATE;
  return TEMPLATES[mode] ?? TEMPLATES[FILL_BOTH]!;
}

/** 只有登录类且有用户名或密码的条目才谈得上「填充」 */
export function isFillable(entry: Entry): boolean {
  return entry?.type === "login" && Boolean(entry.username || entry.password);
}

// ---------------------------------------------------------------- 模板校验 / 展开

/**
 * 模板里认不出来的占位符（用于界面提示）。
 *
 * 做法：先摘掉合法的，剩下的 `{...}` 就是错的 —— 避免嵌套 `{}` 误判。
 */
export function unknownPlaceholders(template: string): string[] {
  const bad: string[] = [];
  for (const m of (template || "").matchAll(/\{([^{}]*)\}/g)) {
    const raw = m[1] ?? "";
    const colon = raw.indexOf(":");
    const name = (colon === -1 ? raw : raw.slice(0, colon)).trim().toUpperCase();
    const arg = colon === -1 ? "" : raw.slice(colon + 1).trim();

    if (!PLACEHOLDER_NAMES.includes(name)) {
      bad.push(m[0]);
      continue;
    }
    // 只有 {DELAY:n} 允许带参数，且必须是纯数字。
    // ⚠ 比 Python 版严的一条：原版只查 DELAY 的参数，`{TAB:5}` 会被放过，
    //   然后在 expandTemplate 里落成字面量 `{TAB:5}` 直接打进目标窗口。
    if (name !== "DELAY" && arg) {
      bad.push(m[0]);
      continue;
    }
    if (name === "DELAY" && !/^\d+$/.test(arg)) bad.push(m[0]);
  }
  return bad;
}

/** 模板合法返回 null，否则返回给用户看的原因 */
export function validateTemplate(template: string): string | null {
  const t = (template ?? "").trim();
  if (!t) return "模板不能为空";
  const bad = unknownPlaceholders(t);
  if (bad.length) {
    return `认不出的占位符：${bad.join(" ")}（可用：${PLACEHOLDER_NAMES.join(" ")}）`;
  }
  if (!/\{(USERNAME|PASSWORD|TITLE|URL)\}/i.test(t)) {
    return "模板里至少要有一个 {USERNAME} / {PASSWORD} / {TITLE} / {URL}";
  }
  return null;
}

/**
 * 把模板展开成 Token 序列（空值留哨兵，不产生空文本段）。
 *
 * 这里只拦「认不出的占位符」；「模板至少要含一个字段占位符」这类产品级约束
 * 由 `buildSequence` 负责（它才是用户入口）。
 */
export function expandTemplate(template: string, entry: Entry): Token[] {
  const bad = unknownPlaceholders(template);
  if (bad.length) {
    throw new AutoTypeError(`认不出的占位符：${bad.join(" ")}（可用：${PLACEHOLDER_NAMES.join(" ")}）`);
  }

  const out: Token[] = [];
  let pos = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(template); m; m = TOKEN_RE.exec(template)) {
    const literal = template.slice(pos, m.index);
    if (literal) out.push(text(literal));
    pos = m.index + m[0].length;

    const name = (m[1] ?? "").toUpperCase();
    const arg = m[2];

    if (name in FIELD_PLACEHOLDERS) {
      const val = String((entry as unknown as Record<string, unknown>)[FIELD_PLACEHOLDERS[name]!] ?? "");
      // 空值也要留个哨兵，否则相邻的 Tab 看不出「是被空值孤立的」
      out.push(val ? text(val) : EMPTY);
    } else if (name in KEY_PLACEHOLDERS) {
      out.push(key(KEY_PLACEHOLDERS[name]!));
    } else if (name === "DELAY") {
      if (arg) out.push(delay(Number(arg)));
    }
    // 认不出的已在上面拦下，这里不会走到
  }

  const tail = template.slice(pos);
  if (tail) out.push(text(tail));
  return out;
}

/**
 * 清掉空占位，以及**被空值孤立**的导航键。
 *
 * 例：用户名是空的，`{USERNAME}{TAB}{PASSWORD}` 展开成 `[空, Tab, 密码]` ——
 * 那个 Tab 必须去掉，否则光标会在目标窗口里白跳一下，密码就打进错误的输入框。
 *
 * 注意只处理「紧挨着空占位」的键：用户在自定义模板里**故意**写的
 * `{USERNAME}{TAB}` 结尾 Tab 会原样保留。
 */
export function dropEmptyEdges(tokens: Token[]): Token[] {
  const NAV = new Set(["Tab", "Enter"]);
  const out: Token[] = [];
  let prevEmpty = false;

  for (const t of tokens) {
    if (t.kind === "empty") {
      // 空值**前面**刚放的导航键也是被孤立的
      while (out.length) {
        const last = out[out.length - 1]!;
        if (last.kind === "key" && NAV.has(String(last.value))) out.pop();
        else break;
      }
      prevEmpty = true;
      continue;
    }
    // 空值**后面**紧跟的导航键同理
    if (prevEmpty && t.kind === "key" && NAV.has(String(t.value))) {
      prevEmpty = false;
      continue;
    }
    prevEmpty = false;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- 降级规则

/**
 * 这条条目**实际**会用哪种方式填 —— 按字段缺失自动降级。
 *
 * - `both` 没用户名 → 只填密码；没密码 → 只填用户名
 * - 明确指定「只填密码」但没有密码 → 降级成只填用户名（反之亦然）
 * - `custom` 模板不降级（模板里删掉空字段即可）
 *
 * 显示（`modeSummary`）与实际按键（`buildSequence`）**共用这一份规则** ——
 * 保证「界面上写的」和「实际会做的」永远一致。
 */
export function effectiveMode(
  entry: Entry,
  mode?: FillMode | null,
  defaultMode: FillMode = FILL_BOTH,
): FillMode {
  let chosen: FillMode = mode ?? fillModeOf(entry, defaultMode);
  if (!isValidFillMode(chosen)) chosen = FILL_BOTH;
  if (chosen === FILL_CUSTOM) return FILL_CUSTOM;
  if (chosen === FILL_BOTH && !entry.username) return FILL_PASSWORD;
  if (chosen === FILL_BOTH && !entry.password) return FILL_USERNAME;
  if (chosen === FILL_PASSWORD && !entry.password && entry.username) return FILL_USERNAME;
  if (chosen === FILL_USERNAME && !entry.username && entry.password) return FILL_PASSWORD;
  return chosen;
}

/** 给条目列表/详情页显示的一行：这条**实际**会怎么填 */
export function modeSummary(entry: Entry, defaultMode: FillMode = FILL_BOTH): string {
  const mode = fillModeOf(entry, defaultMode);
  const eff = effectiveMode(entry, null, defaultMode);
  if (eff === mode) return fillLabel(eff);
  // 降级了：说明缺哪个字段
  if (eff === FILL_PASSWORD) return `${fillLabel(eff)}（这条没有用户名）`;
  if (eff === FILL_USERNAME) return `${fillLabel(eff)}（这条没有密码）`;
  return fillLabel(eff);
}

// ---------------------------------------------------------------- 主编译入口

export interface BuildOptions {
  /** 强制指定填法；不给就取条目自带的，再退回 defaultMode */
  mode?: FillMode | null;
  /** 强制指定模板（会走完整校验） */
  template?: string | null;
  /** 末尾补一个回车 */
  autoSubmit?: boolean;
  defaultMode?: FillMode;
}

/**
 * 把条目编译成按键序列。
 *
 * - `mode` 为空时，取条目自带的填充方式，再退回 `defaultMode`
 * - 字段不全时按 `effectiveMode` 自动降级，与界面显示同一份规则
 * - `autoSubmit` 为真则在末尾补一个回车
 */
export function buildSequence(entry: Entry, opts: BuildOptions = {}): Token[] {
  const { mode = null, template = null, autoSubmit = false, defaultMode = FILL_BOTH } = opts;
  const chosen = effectiveMode(entry, mode, defaultMode);

  const tpl = template !== null ? template : effectiveTemplate(entry, chosen);
  // 自定义模板走完整校验（含「至少要有一个字段占位符」）；内置模板无需校验
  if (template !== null || chosen === FILL_CUSTOM) {
    const err = validateTemplate(tpl);
    if (err) throw new AutoTypeError(err);
  }
  const tokens = dropEmptyEdges(expandTemplate(tpl, entry));

  if (!tokens.length) {
    throw new AutoTypeError("这条没有可填充的内容（用户名和密码都是空的）");
  }
  if (autoSubmit) tokens.push(key("Enter"));
  return tokens;
}

/**
 * 把序列渲染成给用户看的一行预览（密码打码）。
 *
 * 分隔符用 `→`：这个字符在 MiSans 里**真实存在**。
 * 别用 `▸`(U+25B8) —— Qt 的 `QFontMetrics.inFont()` 会谎报有、实际渲染成豆腐块
 * （Python 版的字形教训，见 `aegis_core/autotype.py:304`）。
 */
export function describeSequence(
  tokens: Iterable<Token>,
  secrets: Iterable<string> = [],
  limit = 60,
): string {
  const secretSet = new Set([...secrets].filter(Boolean));
  const parts: string[] = [];
  for (const t of tokens) {
    if (t.kind === "empty") continue;
    if (t.kind === "text") {
      const v = String(t.value);
      parts.push(secretSet.has(v) ? "•".repeat(Math.min(v.length, 10)) : v);
    } else if (t.kind === "key") {
      parts.push(`[${t.value}]`);
    } else {
      parts.push(`[等待${t.value}ms]`);
    }
  }
  const out = parts.join(" → ");
  return out.length > limit ? out.slice(0, limit - 1) + "…" : out;
}

/** 一步到位：编译 + 渲染预览（设置页 / 填充面板上显示「将要做什么」） */
export function preview(entry: Entry, opts: BuildOptions = {}): string {
  try {
    return describeSequence(buildSequence(entry, opts), [entry.password]);
  } catch (e) {
    return `无法填充：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 供设置页下拉框：全局默认填法只能是这四种之一 */
export const DEFAULT_MODE_CHOICES: readonly FillMode[] = FILL_MODES;

// ---------------------------------------------------------------- IPC 形状
//
// 主进程与渲染层共用这几个类型。放这里而不是各自的目录，是因为渲染层
// 不能 import `src/main/**`（`check:purity` 会拦），各自定义一份又必然漂移。

/** 发给填充面板的条目视图 —— **刻意不含 password**，面板是"密码盲"的 */
export interface FillItem {
  id: string;
  title: string;
  username: string;
  url: string;
  type: string;
  /** 这条实际会怎么填（列表右侧那行小字） */
  modeSummary: string;
}

/** 每次唤出面板时主进程推给它的状态 */
export interface ArmState {
  /**
   * 单调递增的序号。面板据此丢弃迟到的旧状态 ——
   * 主进程是"先 send 再等加载完成"，而渲染层的监听注册可能稍晚，
   * 所以面板同时还要主动拉一次（`atype:armState`）。两条路都可能到达，
   * 用 seq 比大小保证最终生效的是最新那次唤出。
   */
  seq: number;
  /** 目标窗口标题，用于回显"将填入：…"（关闭该设置时为空串） */
  targetTitle: string;
  canType: boolean;
  /** canType 为假时的原因，给用户看的一句人话 */
  canTypeReason: string;
  /** 目标就是神盾自己 → 面板要提示"点一下目标窗口" */
  fillingSelf: boolean;
  /** 预填搜索词 */
  preselect: string;
  /**
   * 已经解析好的主题（跟系统就按系统判定，不把这个判断留给面板）。
   * 面板不跑 App.tsx 的那套主题初始化，不告诉它就会在暗色下白底。
   */
  theme: "light" | "dark";
}

/**
 * 面板要主进程做的动作：
 * 四种填法，外加 `"copy"`（只复制密码不打字，管理员窗口也能用），
 * 以及 `null`（按条目自己的填法）。
 */
export type FillAction = FillMode | "copy" | null;

/** 填充实际是怎么完成的 */
export type FillHow = "typed" | "copied" | "waiting" | "failed";

export interface RunResult {
  /** 用户的意图有没有被满足（"正在等待选目标"也算满足） */
  ok: boolean;
  how: FillHow;
  notice: string;
}
