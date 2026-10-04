"""分享包跨语言互通工具 —— 在 Python 侧生成/校验 aegis-share 包.

本脚本有两个用途, 都围绕一件事: **Node 版和 Python 版导出的分享包必须能互相解开**.

    # 1) 生成夹具: 让 Python 版导出一个包, 供 Node 侧测试固定断言
    uv run python scripts/interop-share.py --gen

    # 2) 校验 Node 产出的包: 确认 Node 写的包 Python 也能读
    uv run python scripts/interop-share.py --verify path/to/bundle.json --password xxx

第 2 步是真正的"反向互通"验证 —— 只做第 1 步的话, 只能证明 Node 会读
Python 的格式, 证明不了 Node 写的格式 Python 认。两个方向都得过。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 允许直接以脚本方式运行 (把项目根放进 sys.path)
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aegis_core.models import Entry  # noqa: E402
from aegis_core.share import (  # noqa: E402
    ShareError,
    describe_bundle,
    export_bundle,
    import_bundle,
    read_bundle,
    write_bundle,
)

FIXTURE = ROOT / "testdata" / "share-from-python.json"

# 夹具的固定内容 —— Node 侧 tests/share.test.ts 会逐项断言这些值,
# 改这里必须同步改那边, 否则测试会红 (这正是想要的效果)
FIXTURE_PASSWORD = "python-share-2026"
FIXTURE_TITLE = "来自 Python 的分享包"
FIXTURE_SENDER = "Python 版"
FIXTURE_ENTRIES = [
    ("核心交换机", "pyadmin", "Py-Sh@re-2026!", "https://10.0.0.1", "网络"),
    ("边界路由器", "pyroot", "Py-Rt#2026", "https://10.0.0.254", "网络"),
    ("机房门禁", "guest", "Door-2026!", "", "物理"),
]


def _fixture_entries() -> list[Entry]:
    out: list[Entry] = []
    for i, (title, user, pw, url, group) in enumerate(FIXTURE_ENTRIES):
        e = Entry.new("login")
        e.title = title
        e.username = user
        e.password = pw
        e.url = url
        e.extra = {"group": group}
        e.created_at = 1767225600 + i  # 固定时间戳, 让夹具可复现
        e.updated_at = e.created_at
        out.append(e)
    return out


def gen() -> int:
    """生成 Node 侧测试用的固定夹具."""
    bundle = export_bundle(
        _fixture_entries(),
        FIXTURE_PASSWORD,
        title=FIXTURE_TITLE,
        sender=FIXTURE_SENDER,
        note="给 Node 版测试用的固定夹具",
        hint="口令就是 python-share-2026",
    )
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    write_bundle(bundle, FIXTURE)
    info = describe_bundle(bundle)
    print(f"✓ 已生成 {FIXTURE}")
    print(f"  {info.summary()}")
    print(f"  口令: {FIXTURE_PASSWORD}")
    return 0


def verify(bundle_path: Path, password: str) -> int:
    """校验一个 (通常是 Node 版产出的) 分享包 Python 能不能解开."""
    try:
        doc = read_bundle(bundle_path)
    except ShareError as exc:
        print(f"✗ 读取失败: {exc}", file=sys.stderr)
        return 1

    info = describe_bundle(doc)
    print(f"包: {bundle_path}")
    print(f"  摘要: {info.summary()}")
    print(f"  时间: {info.created_text or '(未记录)'}")

    try:
        res = import_bundle(doc, password)
    except ShareError as exc:
        print(f"✗ 解密失败: {exc}", file=sys.stderr)
        return 1

    print(f"✓ Python 成功解开 Node 产出的分享包: {res.count} 条")
    for e in res.entries:
        print(f"    - {e.title} / {e.username} / {e.password}")
    if res.rekeyed:
        print(f"  ({res.rekeyed} 条因 id 冲突改发了新 id)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="interop-share",
        description="神盾分享包跨语言互通: 生成夹具 / 校验 Node 产出的包",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--gen", action="store_true", help="生成 Node 测试用夹具")
    ap.add_argument("--verify", metavar="BUNDLE", help="校验指定的分享包 (Python 侧解密)")
    ap.add_argument("--password", default="", help="校验时使用的分享口令")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出校验结果")
    args = ap.parse_args()

    if args.gen:
        return gen()
    if args.verify:
        if not args.password:
            print("✗ --verify 需要同时给 --password", file=sys.stderr)
            return 2
        rc = verify(Path(args.verify), args.password)
        if args.json:
            print(json.dumps({"ok": rc == 0}))
        return rc

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
