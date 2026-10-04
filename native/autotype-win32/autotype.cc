/*
 * 神盾 Aegis · 快速填充的 Windows 发送层。
 *
 * 纯 C 的 N-API 模块（零第三方依赖：只用 node_api.h + windows.h）。
 * 为什么不用 node-addon-api / robotjs / nut-js —— 见 docs/AUTOTYPE-DESIGN.md 4.1。
 * 简版理由：本模块只有 6 个函数，注入 C++ 封装层与引入一个带许可争议的
 * 依赖都不划算；而 N-API 是 ABI 稳定的，编译一次能跨 Node 与 Electron 版本用。
 *
 * ★ 这里刻意**没有任何 Sleep**。
 *   逐字符延迟（typeDelayMs）由 JS 侧用 setTimeout 编排 ——
 *   在主进程里 Sleep 会把整个 Electron 冻住（托盘、自动锁定、所有 IPC），
 *   而 JS 的 await 不阻塞。所以本模块只提供"快"的原语，
 *   时序由 src/main/autotype-native.ts 的 runTokens 负责。
 *
 * 三条来自 Python 版（aegis_desktop/autotype_win.py）的结论，一条都不能改：
 *   1. 用 KEYEVENTF_UNICODE 通道发字符 —— 不受键盘布局影响、不经过输入法。
 *      用虚拟键码的话，中文输入法开着、或用户布局与系统记的不一致，就会打错。
 *   2. 扩展键（方向键/翻页/Delete…）必须带 KEYEVENTF_EXTENDEDKEY，否则语义错。
 *   3. SendInput 的返回值必须检查：返回 0 表示被系统拒收（典型是 UIPI 拦提权窗口），
 *      这是"目标窗口拒收"的唯一可靠信号，也是退回复制的触发点。
 */

#ifndef _WIN32
#error "autotype_win32 只能在 Windows 上构建。非 Windows 平台不需要它 —— 见 docs/AUTOTYPE-DESIGN.md 4.3"
#endif

#include <node_api.h>
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>

/* ============================================================ 小工具 */

static napi_value bool_value(napi_env env, int v) {
  napi_value out;
  napi_get_boolean(env, v != 0, &out);
  return out;
}

static napi_value str_value(napi_env env, const char16_t* s, size_t len) {
  napi_value out;
  if (napi_create_string_utf16(env, s, len, &out) != napi_ok) {
    napi_get_undefined(env, &out);
  }
  return out;
}

/** 取第 idx 个参数的 UTF-16 字符串；调用方负责 free。失败返回 NULL, *len=0 */
static char16_t* arg_utf16(napi_env env, napi_value v, size_t* len) {
  *len = 0;
  size_t n = 0;
  if (napi_get_value_string_utf16(env, v, NULL, 0, &n) != napi_ok) return NULL;
  char16_t* buf = (char16_t*)malloc((n + 1) * sizeof(char16_t));
  if (!buf) return NULL;
  if (napi_get_value_string_utf16(env, v, buf, n + 1, &n) != napi_ok) {
    free(buf);
    return NULL;
  }
  *len = n;
  return buf;
}

/* ============================================================ hwnd <-> 字符串
 *
 * HWND 在 Win64 上是指针宽度（64 位），而 JS 的 number 是 double、整数只精确到 2^53。
 * 真实用户态窗口句柄事实上落在 32 位内，但没有 API 契约保证这一点 ——
 * 所以一律走十六进制字符串（"0x00000000000A1B2C"）：无损、能安全穿过
 * contextBridge 序列化、日志里也可读。Python 版能用 int 是因为 Python 整数是
 * 任意精度，那条经验不能照搬。
 */

static const WCHAR kHex[] = L"0123456789ABCDEF";

/** 写成 "0x" + 16 位十六进制。out 至少 19 个 WCHAR */
static void format_hwnd(HWND h, char16_t* out) {
  uintptr_t v = (uintptr_t)h;
  out[0] = L'0';
  out[1] = L'x';
  for (int i = 0; i < 16; i++) {
    out[2 + i] = (char16_t)kHex[(v >> ((15 - i) * 4)) & 0xF];
  }
  out[18] = 0;
}

static int hex_digit(char16_t c) {
  if (c >= L'0' && c <= L'9') return (int)(c - L'0');
  if (c >= L'A' && c <= L'F') return (int)(c - L'A') + 10;
  if (c >= L'a' && c <= L'f') return (int)(c - L'a') + 10;
  return -1;
}

/** 认 "0x…" 与纯十进制两种写法；认不出来返回 NULL */
static HWND parse_hwnd(const char16_t* s, size_t len) {
  if (!s || len == 0) return NULL;
  uintptr_t v = 0;
  size_t i = 0;
  if (len > 2 && s[0] == L'0' && (s[1] == L'x' || s[1] == L'X')) {
    for (i = 2; i < len; i++) {
      int d = hex_digit(s[i]);
      if (d < 0) break;
      v = (v << 4) | (uintptr_t)d;
    }
  } else {
    for (i = 0; i < len; i++) {
      if (s[i] < L'0' || s[i] > L'9') break;
      v = v * 10 + (uintptr_t)(s[i] - L'0');
    }
  }
  return (HWND)v;
}

static HWND hwnd_arg(napi_env env, napi_value v) {
  size_t len = 0;
  char16_t* s = arg_utf16(env, v, &len);
  if (!s) return NULL;
  HWND h = parse_hwnd(s, len);
  free(s);
  return h;
}

/* ============================================================ 发送按键 */

/**
 * 扩展键集合。这些键必须带 KEYEVENTF_EXTENDEDKEY，
 * 否则方向键/翻页键会按小键盘语义解释（照抄 autotype_win.py:24-31）。
 */
static int is_extended(WORD vk) {
  switch (vk) {
    case VK_UP: case VK_DOWN: case VK_LEFT: case VK_RIGHT:
    case VK_HOME: case VK_END: case VK_INSERT: case VK_DELETE:
    case VK_PRIOR: case VK_NEXT:
    case VK_RCONTROL: case VK_RMENU: case VK_DIVIDE: case VK_NUMLOCK:
      return 1;
    default:
      return 0;
  }
}

/**
 * 发一个 UTF-16 码元。走 Unicode 通道：wVk=0 且 wScan=码元。
 * 非 BMP 字符（emoji、生僻字）在这层是"两个连续码元"，Windows 期望的就是这个形式。
 */
static int send_unit(WCHAR unit) {
  INPUT in[2];
  ZeroMemory(in, sizeof(in));
  in[0].type = INPUT_KEYBOARD;
  in[0].ki.wVk = 0;
  in[0].ki.wScan = unit;
  in[0].ki.dwFlags = KEYEVENTF_UNICODE;
  in[1] = in[0];
  in[1].ki.dwFlags = (DWORD)(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
  return SendInput(2, in, sizeof(INPUT)) == 2;
}

static int send_vk(WORD vk) {
  DWORD flags = is_extended(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
  INPUT in[2];
  ZeroMemory(in, sizeof(in));
  in[0].type = INPUT_KEYBOARD;
  in[0].ki.wVk = vk;
  in[0].ki.dwFlags = flags;
  in[1] = in[0];
  in[1].ki.dwFlags = flags | KEYEVENTF_KEYUP;
  return SendInput(2, in, sizeof(INPUT)) == 2;
}

typedef struct {
  const WCHAR* name;
  WORD vk;
} KeyDef;

static const KeyDef kKeys[] = {
    {L"Tab", VK_TAB},         {L"Enter", VK_RETURN},   {L"Escape", VK_ESCAPE},
    {L"Space", VK_SPACE},     {L"Backspace", VK_BACK}, {L"Delete", VK_DELETE},
    {L"Insert", VK_INSERT},   {L"Home", VK_HOME},      {L"End", VK_END},
    {L"PageUp", VK_PRIOR},    {L"PageDown", VK_NEXT},  {L"Left", VK_LEFT},
    {L"Up", VK_UP},           {L"Right", VK_RIGHT},    {L"Down", VK_DOWN},
};
static const size_t kKeyCount = sizeof(kKeys) / sizeof(kKeys[0]);

/* ============================================================ 导出给 JS 的 6 个函数 */

/** available() -> { ok: boolean, reason: string } */
static napi_value Available(napi_env env, napi_callback_info info) {
  napi_value obj, okv, reasonv;
  napi_create_object(env, &obj);

  const char16_t* reason = NULL;
  size_t rlen = 0;
  int ok = 1;

  /* 锁屏 / UAC 安全桌面 / 会话切换中，输入桌面打不开 —— 此时注入必然失败。
     提前查出来告诉用户，比让他对着"没反应"猜要强。 */
  HDESK desk = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS);
  if (desk == NULL) {
    ok = 0;
    static const char16_t msg[] =
        u"当前桌面不接受按键注入（可能是锁屏、UAC 提示或远程会话切换中）";
    reason = msg;
    rlen = sizeof(msg) / sizeof(msg[0]) - 1;
  } else {
    CloseDesktop(desk);
  }

  napi_get_boolean(env, ok != 0, &okv);
  napi_set_named_property(env, obj, "ok", okv);
  if (reason) {
    napi_create_string_utf16(env, reason, rlen, &reasonv);
  } else {
    napi_create_string_utf16(env, u"", 0, &reasonv);
  }
  napi_set_named_property(env, obj, "reason", reasonv);
  return obj;
}

/** sendText(text) -> boolean  按 UTF-16 码元逐字符发 */
static napi_value SendText(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return bool_value(env, 0);

  size_t len = 0;
  char16_t* s = arg_utf16(env, argv[0], &len);
  if (!s) return bool_value(env, 0);

  int okAll = 1;
  for (size_t i = 0; i < len; i++) {
    if (!send_unit((WCHAR)s[i])) {
      okAll = 0; /* 被 UIPI 拦 / 桌面拒绝 —— 上层据此退回复制 */
      break;
    }
  }
  free(s);
  return bool_value(env, okAll);
}

/** sendKey(name) -> boolean  功能键，名字见 kKeys */
static napi_value SendKey(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return bool_value(env, 0);

  size_t len = 0;
  char16_t* s = arg_utf16(env, argv[0], &len);
  if (!s) return bool_value(env, 0);

  int ok = 0;
  for (size_t i = 0; i < kKeyCount; i++) {
    const WCHAR* n = kKeys[i].name;
    size_t j = 0;
    while (n[j] && j < len && (char16_t)n[j] == s[j]) j++;
    if (n[j] == 0 && j == len) {
      ok = send_vk(kKeys[i].vk);
      break;
    }
  }
  free(s);
  return bool_value(env, ok);
}

/** foregroundWindow() -> "0x…"（没有前台窗口时返回 "0"） */
static napi_value ForegroundWindow(napi_env env, napi_callback_info info) {
  (void)info;
  HWND h = GetForegroundWindow();
  if (!h) {
    return str_value(env, u"0", 1);
  }
  char16_t buf[19];
  format_hwnd(h, buf);
  return str_value(env, buf, 18);
}

/** setForeground(hwnd) -> boolean */
static napi_value SetForeground(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return bool_value(env, 0);

  HWND h = hwnd_arg(env, argv[0]);
  if (!h || !IsWindow(h)) return bool_value(env, 0);
  if (GetForegroundWindow() == h) return bool_value(env, 1);

  if (!SetForegroundWindow(h)) {
    /*
     * 兜底：Windows 刻意限制非前台进程调 SetForegroundWindow（防焦点窃取）。
     * 轻敲一次 Alt 能让本进程"看起来"刚被用户交互过，系统随即放行。
     * 这不是 hack 的猜测 —— 是 Win32 文档里 AttachThreadInput/
     * AllowSetForegroundWindow 之外被广泛验证的可行做法（照抄 autotype_win.py）。
     */
    INPUT alt[2];
    ZeroMemory(alt, sizeof(alt));
    alt[0].type = INPUT_KEYBOARD;
    alt[0].ki.wVk = VK_MENU;
    alt[1] = alt[0];
    alt[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, alt, sizeof(INPUT));
    SetForegroundWindow(h);
  }
  return bool_value(env, GetForegroundWindow() == h);
}

/**
 * windowTitle(hwnd) -> string
 *
 * 仅用于界面回显"将要填进哪个窗口"（docs/AUTOTYPE-DESIGN.md 7.1）。
 * 用 SendMessageTimeout 而不是 GetWindowText：后者对别家进程的窗口会发
 * WM_GETTEXT 并**可能挂住**（目标无响应时），把我们的主进程一起拖死。
 */
static napi_value WindowTitle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return str_value(env, u"", 0);

  HWND h = hwnd_arg(env, argv[0]);
  if (!h || !IsWindow(h)) return str_value(env, u"", 0);

  WCHAR buf[512];
  DWORD_PTR out = 0;
  buf[0] = 0;
  SendMessageTimeoutW(h, WM_GETTEXT, (WPARAM)512, (LPARAM)buf,
                      SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, &out);

  const char16_t* c = (const char16_t*)buf;
  size_t n = 0;
  while (n < 511 && c[n]) n++;
  return str_value(env, c, n);
}

/* ============================================================ 模块注册 */

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"available", 0, Available, 0, 0, 0, napi_default, 0},
      {"sendText", 0, SendText, 0, 0, 0, napi_default, 0},
      {"sendKey", 0, SendKey, 0, 0, 0, napi_default, 0},
      {"foregroundWindow", 0, ForegroundWindow, 0, 0, 0, napi_default, 0},
      {"setForeground", 0, SetForeground, 0, 0, 0, napi_default, 0},
      {"windowTitle", 0, WindowTitle, 0, 0, 0, napi_default, 0},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
