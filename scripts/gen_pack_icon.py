"""生成打包图标 build/icon.png (1024×1024, electron-builder 自动转 icns/ico)."""
import sys
from pathlib import Path

sys.path.insert(0, r"C:\dev\aegis")

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import (
    QColor,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPixmap,
)
from PySide6.QtWidgets import QApplication

OUT = Path(r"C:\dev\aegis-electron\build")
OUT.mkdir(parents=True, exist_ok=True)


def draw(size: int) -> QPixmap:
    pm = QPixmap(size, size)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    s = size / 512.0

    bg = QLinearGradient(0, 0, 0, size)
    bg.setColorAt(0, QColor("#0A84FF"))
    bg.setColorAt(1, QColor("#0060DF"))
    path = QPainterPath()
    path.addRoundedRect(0, 0, size, size, 116 * s, 116 * s)
    p.fillPath(path, bg)

    shield = QPainterPath()
    shield.moveTo(256 * s, 96 * s)
    shield.cubicTo(330 * s, 130 * s, 396 * s, 144 * s, 424 * s, 144 * s)
    shield.cubicTo(424 * s, 300 * s, 372 * s, 386 * s, 256 * s, 424 * s)
    shield.cubicTo(140 * s, 386 * s, 88 * s, 300 * s, 88 * s, 144 * s)
    shield.cubicTo(116 * s, 144 * s, 182 * s, 130 * s, 256 * s, 96 * s)
    shield.closeSubpath()
    g = QLinearGradient(0, 96 * s, 0, 424 * s)
    g.setColorAt(0, QColor("#FFFFFF"))
    g.setColorAt(1, QColor("#D8E9FF"))
    p.fillPath(shield, g)

    pen = p.pen()
    pen.setColor(QColor("#007AFF"))
    pen.setWidthF(34 * s)
    pen.setCapStyle(Qt.RoundCap)
    pen.setJoinStyle(Qt.RoundJoin)
    p.setPen(pen)
    p.drawLine(QPointF(190 * s, 268 * s), QPointF(238 * s, 318 * s))
    p.drawLine(QPointF(238 * s, 318 * s), QPointF(330 * s, 208 * s))
    p.end()
    return pm


app = QApplication([])
draw(1024).save(str(OUT / "icon.png"))
print("saved:", OUT / "icon.png")
