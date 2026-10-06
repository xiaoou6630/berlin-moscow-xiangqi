"""把美术素材整理成网页用的资源：
  - 卡牌整图  → public/assets/cards/<faction>/<role>.webp  (按显示需要缩放)
  - 卡面头像  → public/assets/portraits/<faction>.png      (裁成正方形，给选边界面用)
  - 背景底图  → public/assets/background.webp
运行：npm run assets

为什么要缩放 + 转 WebP：
  卡面在棋盘上的实际显示尺寸约 68x96 CSS px（1400px 宽窗口），
  即使 3x DPR 也只需要 ~205px 宽，而源图是 500x702 —— 超配了 7 倍，
  14 张下来足有 6.2MB PNG，网速一般时要等十几秒。
  按 CARD_WEBP_WIDTH 缩放并转 WebP 后体积降到零头，肉眼无差别。
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

# 卡面输出宽度。
#
# 卡面显示尺寸只取决于**视口高度**（棋盘是竖的，宽度早就够），实测：
#   窗口          棋盘高   卡宽CSS   3x DPR 需要
#   1400x900        621      62        186
#   2560x1440      1107     110        331   (3440x1440 / 5120x1440 同此)
#   3840x2160      1755     175        525   (5120x2160 同此)
# 所以 4K 及以上全屏时必须 > 525px 才不虚（带鱼屏反而不用担心）。
# 取 576：覆盖到 4K@3x，也覆盖 5K/8K@2x。
CARD_WEBP_WIDTH = 576
CARD_WEBP_QUALITY = 88
BG_WEBP_QUALITY = 88


def ensure(p: Path):
    p.mkdir(parents=True, exist_ok=True)
    return p


def export_cards(mapping, folder, out_dir, extra_dirs=()):
    """extra_dirs: 额外搜索目录（素材偶尔会放错阵营的文件夹）。"""
    search = [folder, *extra_dirs]
    total_before = 0
    total_after = 0
    for role, name in mapping.items():
        src = next((d / name for d in search if (d / name).exists()), None)
        if src is None:
            raise SystemExit(f"缺少素材: {name}（找过 {[str(d) for d in search]}）")
        im = Image.open(src).convert("RGBA")
        # 只缩不放：源图本来就更窄时保持原尺寸
        if im.width > CARD_WEBP_WIDTH:
            im = im.resize(
                (CARD_WEBP_WIDTH, round(im.height * CARD_WEBP_WIDTH / im.width)),
                Image.LANCZOS,
            )
        # 用白色做底再转 RGB：卡面本身不透明，避免 WebP 里留无用的 alpha 通道
        flat = Image.new("RGB", im.size, (255, 255, 255))
        flat.paste(im, mask=im.split()[3])
        dst = out_dir / f"{role}.webp"
        flat.save(dst, "WEBP", quality=CARD_WEBP_QUALITY, method=6)
        total_before += src.stat().st_size
        total_after += dst.stat().st_size
        print(f"  card  {src.parent.name}/{name} -> {dst.relative_to(ROOT)}  {flat.size}")
    print(f"        {folder.name}: {total_before/1048576:.1f}MB -> {total_after/1048576:.1f}MB")


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
    只做等比缩放 + 转 WebP 以减小体积，不调色、不归一化、不改亮度。"""
    src = SRC_GER / "R-C.jpg"
    if not src.exists():
        raise SystemExit(f"缺少背景: {src}")
    im = Image.open(src).convert("RGB")
    if im.width > BG_MAX:
        im = im.resize((BG_MAX, round(im.height * BG_MAX / im.width)), Image.LANCZOS)
    dst = ensure(OUT) / "background.webp"
    im.save(dst, "WEBP", quality=BG_WEBP_QUALITY, method=6)
    arr = np.asarray(im).astype(float)
    print(f"  background -> {dst.relative_to(ROOT)}  {im.size}  "
          f"{src.stat().st_size/1048576:.2f}MB -> {dst.stat().st_size/1048576:.2f}MB  "
          f"原图直出（亮度均值 {arr.mean():.1f}）")


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
