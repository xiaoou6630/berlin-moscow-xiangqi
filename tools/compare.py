"""并排对比：参考图（8×9 的卡牌棋盘皮肤） vs 标准象棋盘（9 路 × 10 线）。"""
from PIL import Image, ImageDraw

ref = Image.open("ref/board-ref.png").convert("RGB")
mine = Image.open("preview/board.png").convert("RGB")

W = 1160
ref_s = ref.resize((W, round(W * ref.height / ref.width)), Image.LANCZOS)
mine_s = mine.resize((W, round(W * mine.height / mine.width)), Image.LANCZOS)

pad = 18
label_h = 34
H = label_h + ref_s.height + pad + label_h + mine_s.height + pad * 2
canvas = Image.new("RGB", (W, H), (38, 38, 42))
d = ImageDraw.Draw(canvas)
try:
    from PIL import ImageFont
    font = ImageFont.load_default(20)
except Exception:
    font = None

y = pad
d.text((10, y), "REFERENCE  (8 x 9 card board - the skin)", fill=(255, 200, 90), font=font)
y += label_h
canvas.paste(ref_s, (0, y))
y += ref_s.height + pad
d.text((10, y), "STANDARD XIANGOI  (9 files x 10 ranks = 90 points)", fill=(120, 230, 150), font=font)
y += label_h
canvas.paste(mine_s, (0, y))

canvas.save("preview/compare.png")
print("compare.png", canvas.size)
