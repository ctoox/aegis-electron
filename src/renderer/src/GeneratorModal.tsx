import { useEffect, useState } from "react";
import { api } from "./api";
import { ColoredPassword } from "./ColoredPassword";

const DEFAULT_OPTS = {
  length: 20,
  useUpper: true,
  useLower: true,
  useDigits: true,
  useSymbols: true,
  minDigits: 1,
  minSymbols: 1,
};

/** 生成参数 (与设置页里存的默认值同构) */
export type GenDefaults = Partial<typeof DEFAULT_OPTS>;

/** 参数化生成器 (对齐 Python 版 GeneratorDialog): 长度/池/最少位数 + 预览. */
export function GeneratorModal(props: {
  onUse: (pw: string) => void;
  onClose: () => void;
  /** 设置页里存的默认参数; 不传就用内置默认 */
  defaults?: GenDefaults;
}) {
  const [opts, setOpts] = useState({ ...DEFAULT_OPTS, ...(props.defaults ?? {}) });
  const [preview, setPreview] = useState("");
  const [err, setErr] = useState("");

  async function regen(o = opts) {
    try {
      setPreview(await api.pw.generate(o));
      setErr("");
    } catch (e: any) {
      const m = String(e).match(/Error: (.+)$/);
      setErr(m ? m[1] : String(e));
      setPreview("");
    }
  }

  useEffect(() => {
    regen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  const set = (patch: Partial<typeof opts>) => setOpts({ ...opts, ...patch });

  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>生成密码</h2>
        <div className="gen-preview">
          {preview ? <ColoredPassword value={preview} /> : `参数无效: ${err}`}
        </div>
        <label className="gen-row">
          <span>长度</span>
          <input
            type="number"
            min={8}
            max={64}
            value={opts.length}
            onChange={(e) =>
              set({ length: Math.max(8, Math.min(64, +e.target.value || 20)) })
            }
          />
        </label>
        <div className="gen-checks">
          <label>
            <input
              type="checkbox"
              checked={opts.useLower}
              onChange={(e) => set({ useLower: e.target.checked })}
            />
            小写
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.useUpper}
              onChange={(e) => set({ useUpper: e.target.checked })}
            />
            大写
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.useDigits}
              onChange={(e) => set({ useDigits: e.target.checked })}
            />
            数字
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.useSymbols}
              onChange={(e) => set({ useSymbols: e.target.checked })}
            />
            符号
          </label>
        </div>
        <div className="gen-row2">
          <label>
            最少数字
            <input
              type="number"
              min={0}
              max={10}
              disabled={!opts.useDigits}
              value={opts.minDigits}
              onChange={(e) =>
                set({ minDigits: Math.max(0, Math.min(10, +e.target.value || 0)) })
              }
            />
          </label>
          <label>
            最少符号
            <input
              type="number"
              min={0}
              max={10}
              disabled={!opts.useSymbols}
              value={opts.minSymbols}
              onChange={(e) =>
                set({ minSymbols: Math.max(0, Math.min(10, +e.target.value || 0)) })
              }
            />
          </label>
        </div>
        <div className="modal-btns">
          <button onClick={() => regen()}>换一个</button>
          <button
            className="primary"
            disabled={!preview}
            onClick={() => {
              props.onUse(preview);
              props.onClose();
            }}
          >
            使用
          </button>
        </div>
      </div>
    </div>
  );
}
