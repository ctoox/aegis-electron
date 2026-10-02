import { useCallback, useRef, useState } from "react";

export type ToastKind = "info" | "ok" | "warn" | "err";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ICON: Record<ToastKind, string> = {
  info: "ℹ",
  ok: "✓",
  warn: "⚠",
  err: "✕",
};

/** 极简 toast 队列: 3.5 秒自动消失, 最多同时 3 条 */
export function useToasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const notify = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setItems((cur) => [...cur.slice(-2), { id, kind, text }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 3500);
  }, []);

  return { items, notify };
}

export function Toasts({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind} fade-in`}>
          <span className="ic">{ICON[t.kind]}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
