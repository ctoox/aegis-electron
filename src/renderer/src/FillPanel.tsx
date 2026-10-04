/**
 * 快速填充面板 —— 按全局快捷键唤出的置顶小窗口。
 *
 * 工作流（与 Python 版 `aegis_desktop/quick_fill.py` 一致）
 * -------------------------------------------------------
 * 1. 你停在浏览器 / 客户端的登录框，按 `Ctrl+Alt+Shift+F`；
 * 2. 面板弹出（**主进程已经先记下**刚才的前台窗口是哪个）；
 * 3. 输入几个字过滤条目，回车 / 点按钮选择填法；
 * 4. 面板收起，焦点交还给第 1 步那个窗口，然后逐字符打进去。
 *
 * 五种动作
 * --------
 * `Enter`       按条目自己的填法填（默认 账号 → Tab → 密码）
 * `Ctrl+Enter`  强制「用户名 + 密码」
 * `Alt+P`       强制「只填密码」      ← 浏览器已记住账号时用它
 * `Alt+U`       强制「只填用户名」
 * `Alt+C`       只复制密码到剪贴板（不依赖打字，管理员窗口也能用）
 *
 * ★ 本组件是**密码盲**的：`atype:entries` 不下发 password 字段，
 *   我们只回传 `{ id, action }`，明文密码只在主进程里取用。
 *   别为了"少一次 IPC"把密码挪到这边（docs/AUTOTYPE-DESIGN.md 5.3）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ArmState, type FillAction, type FillItem } from "./api";

const MAX_ROWS = 7;

/** 与 App.tsx 的条目头像同一套配色，保证两个界面的观感一致 */
const AVATAR_COLORS = [
  "#5E9CE6", "#7A6FE0", "#E07A5F", "#2FA356",
  "#E09B3C", "#4CB9B1", "#D96BA0", "#6B8FD9",
];

function avatarColor(title: string): string {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default function FillPanel() {
  const [arm, setArm] = useState<ArmState | null>(null);
  const [items, setItems] = useState<FillItem[]>([]);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [preview, setPreview] = useState("");
  const [loaded, setLoaded] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const lastHeight = useRef(0);
  const cursorRef = useRef(0);
  const armSeq = useRef(-1);

  // ---------------------------------------------------------- 被唤出
  useEffect(() => {
    const applyArm = async (a: ArmState) => {
      // 丢弃迟到的旧状态（订阅与主动拉取两条路都可能送到）
      if (a.seq <= armSeq.current) return;
      armSeq.current = a.seq;
      setArm(a);
      // 面板不跑 App.tsx 那套主题初始化 —— 主题由主进程解析好随 arm 下发
      document.documentElement.dataset.theme = a.theme;
      setQuery(a.preselect ?? "");
      cursorRef.current = 0;
      setCursor(0);
      busyRef.current = false;
      setLoaded(false);
      try {
        setItems(await api.atype.entries());
      } catch {
        setItems([]);
      }
      setLoaded(true);
      // 唤出就能直接打字，不用先点一下搜索框
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    };

    const off = api.atype.onArm((a) => void applyArm(a));
    // ★ 还得主动拉一次：主进程的 send 有可能在我们的监听注册**之前**就发出来了
    //   （它在 did-finish-load 之后就 send，而 React 的 effect 稍晚才跑）。
    //   只订阅不拉取的话，第一次唤出会拿到一个空面板。
    api.atype
      .armState()
      .then((a) => {
        if (a) void applyArm(a);
      })
      .catch(() => {});
    return off;
  }, []);

  // ---------------------------------------------------------- 过滤
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = q
      ? items.filter((e) => `${e.title} ${e.username} ${e.url}`.toLowerCase().includes(q))
      : items;
    return hit.slice(0, MAX_ROWS);
  }, [items, query]);

  useEffect(() => {
    if (cursorRef.current >= shown.length) {
      cursorRef.current = 0;
      setCursor(0);
    }
  }, [shown.length]);

  const current = shown[cursor] ?? null;
  const currentId = current?.id ?? null;

  // ---------------------------------------------------------- 预览行
  useEffect(() => {
    if (!currentId) {
      setPreview("");
      return;
    }
    let stale = false;
    api.atype
      .preview(currentId, null)
      .then((r) => {
        if (!stale) setPreview(r.text);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [currentId]);

  // ---------------------------------------------------------- 高度上报
  // 内容变了就把高度报给主进程。和上次一样就不报，避免来回抖。
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const report = () => {
      const h = el.offsetHeight;
      if (h > 0 && Math.abs(h - lastHeight.current) > 1) {
        lastHeight.current = h;
        void api.atype.resize(h);
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown.length, preview, arm?.canType, arm?.fillingSelf, loaded]);

  // ---------------------------------------------------------- 动作
  const doAction = useCallback(
    async (action: FillAction) => {
      const id = shown[cursorRef.current]?.id;
      if (!id || busyRef.current) return;
      busyRef.current = true;
      try {
        await api.atype.run(id, action);
      } catch {
        // 主进程已经通过 atype:notice 给出提示了；这里把面板交还用户，
        // 免得卡在 busy 上点不动
        busyRef.current = false;
      }
    },
    [shown],
  );

  const move = useCallback(
    (delta: number) => {
      const n = shown.length;
      if (!n) return;
      const next = (cursorRef.current + delta + n) % n;
      cursorRef.current = next;
      setCursor(next);
    },
    [shown.length],
  );

  // ---------------------------------------------------------- 键盘
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          void api.atype.cancel();
          return;
        case "Enter":
          e.preventDefault();
          void doAction(e.ctrlKey ? "both" : null);
          return;
        case "ArrowDown":
          e.preventDefault();
          move(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          return;
      }
      if (!e.altKey) return;
      // 用 e.code 而不是 e.key：按住 Alt 时有些布局下 e.key 会变成组合字符
      if (e.code === "KeyP") {
        e.preventDefault();
        void doAction("password");
      } else if (e.code === "KeyU") {
        e.preventDefault();
        void doAction("username");
      } else if (e.code === "KeyC") {
        e.preventDefault();
        void doAction("copy");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doAction, move]);

  // ---------------------------------------------------------- 空状态
  function emptyMessage(): string {
    if (!items.length) {
      return "密码库里还没有可填充的登录条目。先在神盾里新建一条「登录」类型的条目吧。";
    }
    if (query.trim()) return `没有匹配「${query.trim()}」的条目。`;
    return "没有可填充的条目。";
  }

  const canType = arm?.canType ?? false;
  const noTarget = arm?.fillingSelf ?? false;

  return (
    <div className="fillpanel-wrap" ref={contentRef}>
      <div className="fillpanel">
        {/* 顶部：目标窗口回显（Auto-Type 没有域绑定，这是唯一的"你正填向哪"线索） */}
        {arm && (arm.targetTitle || noTarget) && (
          <div className={`fp-target ${noTarget ? "warn" : ""}`}>
            {noTarget ? (
              <span>从神盾内部唤起 —— 请点一下要填入的窗口，10 秒内自动填</span>
            ) : (
              <span title={arm.targetTitle}>
                将填入：<b>{arm.targetTitle}</b>
              </span>
            )}
          </div>
        )}

        <input
          ref={searchRef}
          className="fp-search"
          placeholder="搜索要填充的条目…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />

        {/* 结果列表 */}
        {shown.length > 0 ? (
          <div className="fp-list">
            {shown.map((it, i) => (
              <button
                key={it.id}
                className={`fp-row ${i === cursor ? "active" : ""}`}
                onMouseEnter={() => {
                  cursorRef.current = i;
                  setCursor(i);
                }}
                onClick={() => void doAction(null)}
              >
                <span className="avatar" style={{ background: avatarColor(it.title) }}>
                  {it.title.slice(0, 1) || "?"}
                </span>
                <span className="fp-col">
                  <span className="fp-t">{it.title || "(无标题)"}</span>
                  <span className="fp-s">{it.username || it.url || "（这条没有用户名）"}</span>
                </span>
                <span className="fp-tag">{it.modeSummary}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="fp-empty">{loaded ? emptyMessage() : "正在读取…"}</div>
        )}

        {/* 预览：将要按下什么键（密码已打码） */}
        {current && preview && <div className="fp-preview">{preview}</div>}

        {/* 动作按钮 */}
        <div className="fp-actions">
          <button
            className="fp-btn primary"
            disabled={!current || !canType}
            title={
              canType
                ? "按条目自己的填法（Enter）"
                : arm?.canTypeReason || "当前平台不支持自动打字，请用「复制密码」"
            }
            onClick={() => void doAction(null)}
          >
            填入
          </button>
          <button
            className="fp-btn"
            disabled={!current || !canType}
            title={
              canType
                ? "只把密码打过去（Alt+P）"
                : arm?.canTypeReason || "当前平台不支持自动打字，请用「复制密码」"
            }
            onClick={() => void doAction("password")}
          >
            只填密码
          </button>
          <button
            className="fp-btn"
            disabled={!current}
            title="只复制到剪贴板，不向其他窗口打字（Alt+C）"
            onClick={() => void doAction("copy")}
          >
            复制密码
          </button>
        </div>

        <div className="fp-hint">
          <b>Enter</b> 填入 · <b>Ctrl+Enter</b> 账号+密码 · <b>Alt+P</b> 只填密码 ·{" "}
          <b>Alt+U</b> 只填用户名 · <b>Alt+C</b> 复制 · <b>Esc</b> 取消
          <br />
          浏览器已记住账号？用 <b>Alt+P</b>；新机器没填过？用 <b>Ctrl+Enter</b>
        </div>
      </div>
    </div>
  );
}
