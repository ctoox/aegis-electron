import { useEffect, useMemo, useRef, useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { ColoredPassword } from "./ColoredPassword";

/** 命令面板 (Ctrl+K): 一个输入框搜条目 + 执行动作. 键盘全操作: ↑↓ 选择, Enter 执行. */
type Cmd =
  | { kind: "entry"; entry: EntryWithStrength; label: string; hint: string }
  | { kind: "action"; id: string; label: string; hint: string };

export function CommandPalette(props: {
  entries: EntryWithStrength[];
  onSelectEntry: (id: string) => void;
  onCopy: (text: string) => void;
  onAction: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo<Cmd[]>(() => {
    const actions: Cmd[] = [
      { kind: "action", id: "new", label: "新增条目", hint: "动作" },
      { kind: "action", id: "generate", label: "生成密码（默认参数）", hint: "动作" },
      { kind: "action", id: "theme", label: "切换浅色 / 深色主题", hint: "动作" },
      { kind: "action", id: "lock", label: "锁定密码库", hint: "动作" },
    ];
    const kw = q.trim().toLowerCase();
    const hits: Cmd[] = [];
    for (const e of props.entries) {
      const hay = `${e.title} ${e.username} ${e.url}`.toLowerCase();
      if (!kw || hay.includes(kw)) {
        hits.push({
          kind: "entry", entry: e,
          label: e.title || "(无标题)",
          hint: e.username || e.url || "—",
        });
      }
    }
    const act = actions.filter((a) => !kw || a.label.toLowerCase().includes(kw));
    // 条目优先, 动作跟在后面
    return [...hits.slice(0, 30), ...act];
  }, [q, props.entries]);

  useEffect(() => setIdx(0), [q]);

  useEffect(() => {
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  function run(it: Cmd | undefined, copy: boolean) {
    if (!it) return;
    if (it.kind === "entry") {
      if (copy) props.onCopy(it.entry.password);
      props.onSelectEntry(it.entry.id);
    } else {
      props.onAction(copy ? `${it.id}-copy` : it.id);
    }
    props.onClose();
  }

  return (
    <div className="mask-top" onMouseDown={props.onClose}>
      <div className="cmd fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          placeholder="搜索条目或输入命令…   ↑↓ 选择 · Enter 打开 · Ctrl+Enter 复制密码 · Esc 关闭"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(items[idx], e.ctrlKey || e.metaKey);
            } else if (e.key === "Escape") {
              props.onClose();
            }
          }}
        />
        <div className="cmd-list" ref={listRef}>
          {items.map((it, i) => (
            <button
              key={it.kind === "entry" ? it.entry.id : `act-${it.id}`}
              className={`cmd-row ${i === idx ? "active" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={(e) => run(it, e.ctrlKey || e.metaKey)}
            >
              <span className={`cmd-kind ${it.kind === "action" ? "act" : ""}`}>
                {it.kind === "action" ? "⌘" : "🔑"}
              </span>
              <span className="cmd-label">{it.label}</span>
              <span className="cmd-hint">
                {it.kind === "entry" && it.entry.password ? (
                  <ColoredPassword value="••••••" />
                ) : null}
                {it.hint}
              </span>
            </button>
          ))}
          {items.length === 0 && <div className="cmd-empty">没有匹配项</div>}
        </div>
      </div>
    </div>
  );
}
