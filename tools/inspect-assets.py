"""量卡面构图：插画区到底占多高？顺便看背景被压暗到什么程度。"""
from PIL import Image
import numpy as np

for p in ["苏联/步兵第 554 团_zh-Hans.png", "德国/第 18 步兵团_zh-Hans.png"]:
    im = Image.open(p).convert("RGBA")
    a = np.asarray(im)
    h, w = a.shape[:2]
    alpha = a[..., 3]
    print(f"\n=== {p}  {w}x{h} ===")
    # 每行的"彩色度"（饱和度）——插画彩色，统计栏偏灰白
    rgb = a[..., :3].astype(int)
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = (mx - mn)
    row_sat = sat.mean(axis=1)
    row_bright = rgb.mean(axis=(1, 2))
    # 找插画结束的位置：饱和度明显下降的地方
    for y in range(0, h, 20):
        bar = "#" * int(row_sat[y] / 3)
        print(f"  y={y:3d} sat={row_sat[y]:6.1f} bright={row_bright[y]:6.1f} {bar}")
    # 综合判断边界
    thr = row_sat.mean() * 0.7
    below = np.where(row_sat < thr)[0]
    print(f"  饱和度低于均值70%的首行: y={below[0] if len(below) else 'none'}")

print("\n=== 背景图 R-C.jpg 原始与压暗后的亮度 ===")
bg = np.asarray(Image.open("德国/R-C.jpg").convert("RGB")).astype(float)
print("  原始 mean RGB:", bg.mean(axis=(0, 1)).round(1), " 亮度均值:", bg.mean().round(1))
# 模拟我的处理：画到画布 + scrim rgba(10,14,18,0.62)
scrim = np.array([10, 14, 18], dtype=float)
out = bg * 0.38 + scrim * 0.62
print("  叠加 scrim 0.62 后:", out.mean(axis=(0, 1)).round(1), " 亮度均值:", out.mean().round(1))
out2 = bg * 0.7 + scrim * 0.3
print("  叠加 scrim 0.30 后:", out2.mean(axis=(0, 1)).round(1), " 亮度均值:", out2.mean().round(1))
