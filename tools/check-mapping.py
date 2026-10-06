"""核对卡面映射：成品图与预期的源文件**像素一致**。

注意：不能用 md5 比对文件字节 —— 构建时用 optimize=True 重存过 PNG，
字节数会变但像素不变。所以这里比对像素数据 + 尺寸。
"""
import glob
from pathlib import Path

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "cards"

# 角色 → 预期源文件名
EXPECT = {
    "soviet": {
        "general": "莫斯科_默认.png",
        "advisor": "近卫步兵第 272 团_zh-Hans.png",
        "elephant": "战术撤退_zh-Hans.png",
        "horse": "库班哥萨克第 4 团_zh-Hans.png",
        "chariot": "IS-2_zh-Hans.png",
        "cannon": "喀秋莎_zh-Hans.png",
        "pawn": "步兵第 554 团_zh-Hans.png",
    },
    "germany": {
        "general": "阿登_默认.png",
        "advisor": "三号坦克 H 型_zh-Hans.png",
        "elephant": "步兵第百十四联队_zh-Hans.png",
        "horse": "第 15 侦察营_zh-Hans.png",
        "chariot": "虎式坦克 H 型_zh-Hans.png",
        "cannon": "利奥波德_zh-Hans.png",
        "pawn": "第 18 步兵团_zh-Hans.png",
    },
}

LABEL = {"advisor": "士", "elephant": "相/象", "general": "帅/将", "horse": "马",
         "chariot": "车", "cannon": "炮", "pawn": "兵/卒"}


def pixels(p):
    im = Image.open(p).convert("RGBA")
    return im.size, np.asarray(im)


bad = 0
for faction, roles in EXPECT.items():
    print(f"=== {faction} ===")
    for role, srcname in roles.items():
        src = glob.glob(str(ROOT / "art" / "*" / srcname))
        dst = OUT / faction / f"{role}.webp"
        if not src:
            print(f"  [X] {LABEL[role]:6} 找不到源文件 {srcname}")
            bad += 1
            continue
        s_size, s_px = pixels(src[0])
        d_size, d_px = pixels(dst)
        ok = s_size == d_size and s_px.shape == d_px.shape and np.array_equal(s_px, d_px)
        print(f"  {'[OK]' if ok else '[X] '} {LABEL[role]:6} {role:9} <- {srcname}")
        if not ok:
            bad += 1
    print()

print("全部一致" if bad == 0 else f"有 {bad} 处不一致")
raise SystemExit(1 if bad else 0)
