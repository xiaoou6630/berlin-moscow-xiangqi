"""核对线上 Pages 的卡面是否与本地生成的一致。"""
import hashlib
import urllib.request
from pathlib import Path

BASE = "https://xiaoou6630.github.io/berlin-moscow-xiangqi/public/assets/cards"
ROOT = Path(__file__).resolve().parent.parent

ROLES = ["general", "advisor", "elephant", "horse", "chariot", "cannon", "pawn"]
bad = 0

for faction in ["soviet", "germany"]:
    print(f"=== {faction} ===")
    for role in ROLES:
        local = ROOT / "public" / "assets" / "cards" / faction / f"{role}.webp"
        try:
            remote = urllib.request.urlopen(f"{BASE}/{faction}/{role}.png", timeout=25).read()
        except Exception as e:  # noqa: BLE001
            print(f"  [X] {role:9} 拉不到: {e}")
            bad += 1
            continue
        lm = hashlib.md5(local.read_bytes()).hexdigest()
        rm = hashlib.md5(remote).hexdigest()
        ok = lm == rm
        print(f"  {'[OK]' if ok else '[X] '} {role:9} 线上 {len(remote):>7}B  本地 {local.stat().st_size:>7}B")
        if not ok:
            bad += 1
    print()

print("线上与本地完全一致" if bad == 0 else f"有 {bad} 处不一致")
raise SystemExit(1 if bad else 0)
