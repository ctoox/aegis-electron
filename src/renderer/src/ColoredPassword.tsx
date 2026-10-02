/** 密码字符着色 (借鉴 Bitwarden ColorPasswordPipe 的可读性技巧):
 *  字母=默认色, 数字=系统蓝, 符号=琥珀. 让长密码里各类字符一眼可辨. */
const DIGIT_COLOR = "#0A84FF";
const SYMBOL_COLOR = "#C9882B";

export function ColoredPassword(props: { value: string }) {
  return (
    <span className="mono pw-colored">
      {[...props.value].map((ch, i) => {
        const color = /[0-9]/.test(ch)
          ? DIGIT_COLOR
          : /[a-zA-Z]/.test(ch)
            ? undefined
            : SYMBOL_COLOR;
        return (
          <span key={i} style={color ? { color } : undefined}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}
