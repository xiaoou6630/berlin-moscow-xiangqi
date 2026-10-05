"""把美术素材整理成网页用的资源：
  - 卡牌整图  → public/assets/cards/<faction>/<role>.png   (保持 500x702 原始比例)
  - 卡面头像  → public/assets/portraits/<faction>.png      (裁成正方形，给选边界面用)
  - 背景底图  → public/assets/background.jpg
运行：npm run assets
"""
from pathlib import Path
from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
# 素材目录用 ASCII 名，避免第三方编译站在中文路径上翻车
SRC_SOV = ROOT / "art" / "soviet"
SRC_GER = ROOT / "art" / "germany"
OUT = ROOT / "public" / "assets"

# 角色 → 素材文件名（每边 7 个单位，正好对应 7 种棋子）
SOV = {
    "general": "莫斯科_默认.png",
    "pawn": "步兵第 554 团_zh-Hans.png",
    "cannon": "喀秋莎_zh-Hans.png",
    "chariot": "IS-2_zh-Hans.png",
    "horse": "库班哥萨克第 4 团_zh-Hans.png",
    # 士：近卫步兵第 272 团（文件放在 art/germany 里，但它是苏联单位）
    "advisor": "近卫步兵第 272 团_zh-Hans.png",
    "elephant": "战术撤退_zh-Hans.png",
}
GER = {
    "general": "阿登_默认.png",
    "pawn": "第 18 步兵团_zh-Hans.png",
    "cannon": "利奥波德_zh-Hans.png",
    "chariot": "虎式坦克 H 型_zh-Hans.png",
    "horse": "第 15 侦察营_zh-Hans.png",
    "elephant": "步兵第百十四联队_zh-Hans.png",
    "advisor": "三号坦克 H 型_zh-Hans.png",
}

# 头像来源：整图主体 + 竖版头像图
PORTRAIT = {
    "soviet": {"card": SRC_SOV / "步兵第 554 团_zh-Hans.png", "file": SRC_SOV / "T_Portrait_Standard_91st-Astrakhan.png"},
    "germany": {"card": SRC_GER / "第 18 步兵团_zh-Hans.png", "file": SRC_GER / "T_Portrait_Standard_Blitzkrieg.png"},
}

PORTRAIT_SIZE = 256
BG_MAX = 1600  # 背景压到这个宽度足够，减体积


def ensure(p: Path):
    p.mkdir(parents=True, exist_ok=True)
    return p


def export_cards(mapping, folder, out_dir, extra_dirs=()):
    """extra_dirs: 额外搜索目录（素材偶尔会放错阵营的文件夹）。"""
    search = [folder, *extra_dirs]
    for role, name in mapping.items():
        src = next((d / name for d in search if (d / name).exists()), None)
        if src is None:
            raise SystemExit(f"缺少素材: {name}（找过 {[str(d) for d in search]}）")
        im = Image.open(src).convert("RGBA")
        dst = out_dir / f"{role}.png"
        im.save(dst, optimize=True)
        print(f"  card  {src.parent.name}/{name} -> {dst.relative_to(ROOT)}  {im.size}")


def square_crop(im: Image.Image) -> Image.Image:
    """取内容外接框，再裁成正方形"""
    a = np.asarray(im.convert("RGBA"))
    alpha = a[..., 3]
    ys, xs = np.where(alpha > 10)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    im = im.crop(box)
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return canvas


def artwork_square(im: Image.Image) -> Image.Image:
    """从卡牌整图里取上方插画区域，裁成正方形做头像"""
    w, h = im.size
    side = int(w * 0.98)
    top = int(h * 0.035)
    left = (w - side) // 2
    im = im.crop((left, top, left + side, top + side))
    return im


def export_portraits():
    for faction, cfg in PORTRAIT.items():
        # 优先用竖版头像图；没有就退回卡牌插画
        if cfg["file"].exists():
            im = Image.open(cfg["file"]).convert("RGBA")
            sq = square_crop(im)
        else:
            im = Image.open(cfg["card"]).convert("RGBA")
            sq = artwork_square(im)
        sq = sq.resize((PORTRAIT_SIZE, PORTRAIT_SIZE), Image.LANCZOS)
        dst = ensure(OUT / "portraits") / f"{faction}.png"
        sq.save(dst, optimize=True)
        print(f"  portrait {faction} -> {dst.relative_to(ROOT)}  {sq.size}")


def export_background():
    """背景底图：**原样使用**用户给的 R-C.jpg。
    只做等比缩放以减小体积，不调色、不归一化、不改亮度。"""
    src = SRC_GER / "R-C.jpg"
    if not src.exists():
        raise SystemExit(f"缺少背景: {src}")
    im = Image.open(src).convert("RGB")
    if im.width > BG_MAX:
        im = im.resize((BG_MAX, round(im.height * BG_MAX / im.width)), Image.LANCZOS)
    dst = ensure(OUT) / "background.jpg"
    im.save(dst, quality=90, optimize=True, progressive=True)
    arr = np.asarray(im).astype(float)
    print(f"  background -> {dst.relative_to(ROOT)}  {im.size}  原图直出（亮度均值 {arr.mean():.1f}）")


def main():
    print("导出卡牌：")
    export_cards(SOV, SRC_SOV, ensure(OUT / "cards" / "soviet"), extra_dirs=[SRC_GER])
    export_cards(GER, SRC_GER, ensure(OUT / "cards" / "germany"), extra_dirs=[SRC_SOV])
    print("导出头像：")
    export_portraits()
    print("导出背景：")
    export_background()
    print("完成 ->", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
