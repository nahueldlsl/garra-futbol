#!/usr/bin/env python3
"""Reproducible asset extraction and data conversion pipeline for Garra Fútbol Web.

Reads unpacked original PC game assets from the Fase 1 extraction directory and
generates:
  - /public/assets/images/**          (65 normalized 32-bit RGBA PNGs + original JPGs)
  - /public/assets/lang/images/**     (localized HUD/fonts/help assets)
  - /public/assets/audio/**           (18 OGG Vorbis SFX/music files)
  - /public/assets/manifests/*.json   (jugador, pelota, sprites, fonts, audio)
  - /src/data/*.json                  (colors, teams, formations, menu, texts, credits)

All numeric tables, sprite coordinates, pivots, bitmap font tables, audio
gains, and team formations are grounded directly in garrafut.exe disassembly
and original asset descriptors.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent


def resolve_source_assets_dir(cli_source: Path | None = None) -> Path:
    """Resolve source assets directory from CLI flag or GARRA_ASSETS_DIR env var."""
    if cli_source is not None:
        return cli_source
    env_dir = os.environ.get("GARRA_ASSETS_DIR")
    if env_dir:
        return Path(env_dir)
    raise SystemExit(
        "Source assets directory not provided. "
        "Pass --source <path> or set GARRA_ASSETS_DIR."
    )


SOURCE_ASSETS_DIR = Path(".")
PUBLIC_ASSETS_DIR = REPO_ROOT / "public" / "assets"
MANIFESTS_DIR = PUBLIC_ASSETS_DIR / "manifests"
DATA_DIR = REPO_ROOT / "src" / "data"

ESCAPE_MAP: dict[str, str] = {
    r"\a": "á",
    r"\e": "é",
    r"\i": "í",
    r"\o": "ó",
    r"\u": "ú",
    r"\m": "ñ",
    r"\M": "Ñ",
    r"\!": "¡",
    r"\¡": "¡",
    r"\?": "¿",
    r"\C": "Ç",
    r"\n": "\n",
}

ESCAPE_PATTERN = re.compile(r"\\(?:a|e|i|o|u|m|M|!|¡|\?|C|n)")

# Exact 106-glyph lookup table reconstructed from sub_40bbc0 (0x40bbc0..0x40d7c4)
FONT_GLYPHS: list[str] = (
    [chr(code) for code in range(0x21, 0x7F)]
    + [" "]
    + ["Ñ", "ñ", "á", "é", "í", "ó", "ú", "¡", "¿", "º", "Ç"]
)


def decode_game_text(raw: str) -> str:
    """Decode Garra Fútbol custom backslash escapes into UTF-8 text."""
    return ESCAPE_PATTERN.sub(lambda m: ESCAPE_MAP[m.group(0)], raw)


def parse_lenient_xml(xml_path: Path) -> ET.Element:
    """Parse game XML files that may contain unquoted attribute values."""
    raw_text = xml_path.read_bytes().decode("latin-1")

    def _quote_attr(match: re.Match[str]) -> str:
        return f'{match.group(1)}"{match.group(2)}"'

    fixed_text = re.sub(
        r'(\b[A-Za-z0-9_]+\s*=\s*)([^\s"\'/>][^>\s]*)',
        _quote_attr,
        raw_text,
    )
    return ET.fromstring(fixed_text)


def write_json(path: Path, payload: Any) -> None:
    """Write formatted UTF-8 JSON with trailing newline."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def frame_content_bbox(
    rgba_img: Image.Image,
    x: int,
    y: int,
    w: int,
    h: int,
) -> dict[str, int] | None:
    """Compute non-transparent bounding box inside a frame in frame-local coords."""
    crop_box = (
        max(0, x),
        max(0, y),
        min(rgba_img.width, x + w),
        min(rgba_img.height, y + h),
    )
    if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
        return None
    region = rgba_img.crop(crop_box)
    bbox = region.getbbox()
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return {
        "x": left,
        "y": top,
        "w": right - left,
        "h": bottom - top,
    }


def copy_and_normalize_assets() -> dict[str, dict[str, Any]]:
    """Copy all images and audio files into /public/assets/, normalizing PNGs to RGBA."""
    if PUBLIC_ASSETS_DIR.exists():
        # Preserve only non-generated files? Here public/assets is fully managed by this script.
        shutil.rmtree(PUBLIC_ASSETS_DIR)
    PUBLIC_ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    image_meta: dict[str, dict[str, Any]] = {}
    png_count = 0
    jpg_count = 0
    ogg_count = 0

    for src_path in sorted(SOURCE_ASSETS_DIR.rglob("*")):
        if not src_path.is_file():
            continue
        rel = src_path.relative_to(SOURCE_ASSETS_DIR).as_posix()
        suffix = src_path.suffix.lower()

        if suffix == ".png":
            dst_path = PUBLIC_ASSETS_DIR / rel
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(src_path) as im:
                orig_mode = im.mode
                rgba = im.convert("RGBA")
                rgba.save(dst_path, format="PNG")
                # Verify lossless RGBA preservation
                with Image.open(dst_path) as check:
                    assert check.mode == "RGBA", f"Expected RGBA output for {rel}"
                    assert check.size == rgba.size, f"Size mismatch for {rel}"
                    if orig_mode == "RGBA":
                        assert list(rgba.getdata()) == list(check.getdata()), (
                            f"Pixel mismatch after PNG normalization in {rel}"
                        )
                image_meta[rel] = {
                    "originalMode": orig_mode,
                    "outputMode": "RGBA",
                    "width": rgba.width,
                    "height": rgba.height,
                }
            png_count += 1
        elif suffix in (".jpg", ".jpeg"):
            dst_path = PUBLIC_ASSETS_DIR / rel
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
            with Image.open(dst_path) as im:
                image_meta[rel] = {
                    "originalMode": im.mode,
                    "outputMode": im.mode,
                    "width": im.width,
                    "height": im.height,
                }
            jpg_count += 1
        elif suffix == ".ogg":
            dst_path = PUBLIC_ASSETS_DIR / rel
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
            ogg_count += 1

    assert png_count + jpg_count == 65, f"Expected 65 images, got {png_count + jpg_count}"
    assert ogg_count == 18, f"Expected 18 audio files, got {ogg_count}"
    print(f"Copied/normalized {png_count} PNGs, {jpg_count} JPGs, {ogg_count} OGGs.")
    return image_meta


def parse_character_sheet(
    xml_rel: str,
    fgt_rel: str,
    png_rel: str,
    image_meta: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Build manifest from Sidewalk .xml atlas + Fighter Factory .fgt animation script."""
    xml_root = ET.parse(SOURCE_ASSETS_DIR / xml_rel).getroot()
    img_el = xml_root.find("img")
    assert img_el is not None, f"Missing <img> in {xml_rel}"

    framelist = xml_root.find("framelist")
    assert framelist is not None, f"Missing <framelist> in {xml_rel}"

    atlas_frames: list[dict[str, Any]] = []
    rgba_path = PUBLIC_ASSETS_DIR / png_rel
    with Image.open(rgba_path) as raw_im:
        rgba = raw_im.convert("RGBA")
        for idx, frame_el in enumerate(framelist.findall("frame")):
            x = int(frame_el.attrib["x"])
            y = int(frame_el.attrib["y"])
            w = int(frame_el.attrib["w"])
            h = int(frame_el.attrib["h"])
            atlas_frames.append(
                {
                    "index": idx,
                    "name": frame_el.attrib["name"],
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "regX": int(frame_el.attrib["regx"]),
                    "regY": int(frame_el.attrib["regy"]),
                    "contentBbox": frame_content_bbox(rgba, x, y, w, h),
                }
            )

    lines = [
        line.strip()
        for line in (SOURCE_ASSETS_DIR / fgt_rel)
        .read_text(encoding="latin-1")
        .splitlines()
        if line.strip()
    ]

    # Fighter image descriptors added via addImage:<groupId>,<frameIndex>,<pivotX>,<pivotY>
    images: list[dict[str, Any]] = []
    # Pending frames accumulated before each addAnim:<animId>,<loopTarget>
    pending_frames: list[dict[str, Any]] = []
    animations: list[dict[str, Any]] = []

    for line in lines:
        cmd, rest = line.split(":", 1)
        parts = [p.strip() for p in rest.split(",")]
        if cmd == "addImage":
            image_group_id = int(parts[0])
            frame_index = int(parts[1])
            pivot_x = int(parts[2])
            pivot_y = int(parts[3])
            seq_idx = len(images)
            suffix = f"#{image_group_id}_{frame_index:03d}.png".lower()
            frame_info = next(
                (f for f in atlas_frames if f["name"].lower().endswith(suffix)),
                atlas_frames[seq_idx] if seq_idx < len(atlas_frames) else atlas_frames[frame_index],
            )
            images.append(
                {
                    "index": seq_idx,
                    "groupId": image_group_id,
                    "frameIndex": frame_index,
                    "pivotX": pivot_x,
                    "pivotY": pivot_y,
                    "rect": {
                        "x": frame_info["x"],
                        "y": frame_info["y"],
                        "w": frame_info["w"],
                        "h": frame_info["h"],
                    },
                }
            )
        elif cmd == "addFrame":
            image_group_id = int(parts[0])
            local_frame = int(parts[1])
            dx = int(parts[2])
            dy = int(parts[3])
            ticks = int(parts[4])
            flip = parts[5]
            assert flip in ("NONE", "H", "V", "HV"), f"Unexpected flip mode: {flip}"
            pending_frames.append(
                {
                    "groupId": image_group_id,
                    "frameIndex": local_frame,
                    "offset": {"dx": dx, "dy": dy},
                    "ticks": ticks,
                    "flip": flip,
                    "scaleX": 1,
                    "scaleY": 1,
                }
            )
        elif cmd == "addAnim":
            anim_id = int(parts[0])
            loop_raw = int(parts[1])
            # Exact rule from sub_4189e0 (0x418a1f): if loopTarget != -1, decrement by 1 (0-based)
            loop_index = None if loop_raw == -1 else loop_raw - 1
            total_ticks = sum(f["ticks"] for f in pending_frames)
            animations.append(
                {
                    "id": anim_id,
                    "loop": loop_raw != -1,
                    "loopFrameRaw": loop_raw,
                    "loopFrameIndex": loop_index,
                    "totalTicks": total_ticks,
                    "frames": pending_frames,
                }
            )
            pending_frames = []
        else:
            raise ValueError(f"Unknown .fgt command in {fgt_rel}: {line}")

    assert not pending_frames, f"Dangling addFrame entries at end of {fgt_rel}"

    meta = image_meta[png_rel]
    return {
        "name": img_el.attrib["name"],
        "imagePath": png_rel,
        "textureSize": {"w": meta["width"], "h": meta["height"]},
        "defaultReg": {
            "x": float(img_el.attrib["regx"]),
            "y": float(img_el.attrib["regy"]),
        },
        "atlasFrames": atlas_frames,
        "fgtImages": images,
        "animations": animations,
    }


def _grid_frames(
    x0: int,
    y0: int,
    cw: int,
    ch: int,
    cols: int,
    rows: int,
    count: int | None = None,
    pivot_x: float | None = None,
    pivot_y: float | None = None,
) -> list[dict[str, Any]]:
    """Generate row-major grid frame descriptors (verified against timer.png 4x8)."""
    total = cols * rows if count is None else count
    frames: list[dict[str, Any]] = []
    px = cw * 0.5 if pivot_x is None else pivot_x
    py = ch * 0.5 if pivot_y is None else pivot_y
    for row in range(rows):
        for col in range(cols):
            if len(frames) >= total:
                break
            frames.append(
                {
                    "x": x0 + col * cw,
                    "y": y0 + row * ch,
                    "w": cw,
                    "h": ch,
                    "pivotX": px,
                    "pivotY": py,
                }
            )
    return frames


def build_sprites_manifest(image_meta: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Generate manifests/sprites.json matching sub_4031f0, sub_4045b0, sub_406ca0, sub_407830."""
    specs: list[dict[str, Any]] = [
        # --- sub_4045b0 (0x4045b0) ---
        {
            "key": "dot",
            "path": "images/misc/4x4.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 1, "h": 1, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "garraFutbolLogo",
            "path": "images/misc/mainScreen.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "pressEnter",
            "path": "lang/images/hud/pressEnter.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "fadeToBlack",
            "path": "images/hud/blackfade.jpg",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "BENCHMARK_NUMBERS",
            "path": "lang/images/fonts/benchmarkNumbers.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 80, "h": 8, "pivotX": 8.0, "pivotY": 0.0}],
            "notes": "sub_4045b0@0x404942 registers (0,0,80,8); full digit sheet in fonts.json",
        },
        {
            "key": "shadows",
            "path": "images/misc/shadows.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 0, "y": 0, "w": 26, "h": 6, "pivotX": 13.0, "pivotY": 3.0},
                {"x": 0, "y": 8, "w": 20, "h": 4, "pivotX": 10.0, "pivotY": 2.0},
            ],
        },
        {
            "key": "pitch1",
            "path": "images/bg/pitch1.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 1024, "h": 1024, "pivotX": 0.0, "pivotY": 512.0}],
        },
        {
            "key": "pitch2",
            "path": "images/bg/pitch2.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 1024, "pivotX": -1024.0, "pivotY": 512.0}],
        },
        {
            "key": "various",
            "path": "images/misc/various.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 0, "y": 15, "w": 16, "h": 10, "pivotX": 8.0, "pivotY": 5.0},
                {"x": 0, "y": 26, "w": 16, "h": 10, "pivotX": 8.0, "pivotY": 5.0},
                {"x": 17, "y": 24, "w": 12, "h": 6, "pivotX": 6.0, "pivotY": 3.0},
                {"x": 10, "y": 0, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
            ],
        },
        {
            "key": "selection_J1",
            "path": "images/misc/various.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 16, "y": 0, "w": 34, "h": 12, "pivotX": 17.0, "pivotY": 6.0},
                {"x": 16, "y": 12, "w": 34, "h": 12, "pivotX": 17.0, "pivotY": 6.0},
            ],
        },
        {
            "key": "selection_J2",
            "path": "images/misc/various.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 51, "y": 0, "w": 34, "h": 12, "pivotX": 17.0, "pivotY": 6.0},
                {"x": 51, "y": 12, "w": 34, "h": 12, "pivotX": 17.0, "pivotY": 6.0},
            ],
        },
        {
            "key": "minimap_J1",
            "path": "images/misc/various.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 0, "y": 0, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
                {"x": 0, "y": 5, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
                {"x": 0, "y": 10, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
            ],
        },
        {
            "key": "minimap_J2",
            "path": "images/misc/various.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 5, "y": 0, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
                {"x": 5, "y": 5, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
                {"x": 5, "y": 10, "w": 4, "h": 4, "pivotX": 2.0, "pivotY": 2.0},
            ],
        },
        {
            "key": "interface",
            "path": "images/misc/various.png",
            "mode": 4,
            "pivotMode": "explicit",
            "frames": [
                {"x": 86, "y": 0, "w": 136, "h": 14, "pivotX": 0.0, "pivotY": 0.0},
                {"x": 86, "y": 14, "w": 136, "h": 14, "pivotX": 0.0, "pivotY": 0.0},
                {"x": 87, "y": 28, "w": 76, "h": 14, "pivotX": 0.0, "pivotY": 0.0},
            ],
        },
        {
            "key": "backPattern_blue",
            "path": "images/hud/backPattern.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 150, "h": 162, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "backPattern_red",
            "path": "images/hud/backPattern2.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 150, "h": 162, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "props",
            "path": "images/bg/props.png",
            "mode": 4,
            "pivotMode": "explicit",
            "frames": [
                {"x": 242, "y": 0, "w": 8, "h": 40, "pivotX": 1.0, "pivotY": 40.0},
                {"x": 150, "y": 0, "w": 92, "h": 80, "pivotX": 2.0, "pivotY": 78.0},
                {"x": 0, "y": 0, "w": 150, "h": 196, "pivotX": 61.0, "pivotY": 195.0},
            ],
        },
        {
            "key": "saquedearco",
            "path": "lang/images/hud/signs/goalKick.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "gol",
            "path": "lang/images/hud/signs/goal.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 128, "pivotX": 256.0, "pivotY": 64.0}],
        },
        {
            "key": "lateral",
            "path": "lang/images/hud/signs/throwIn.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "tiroesquina",
            "path": "lang/images/hud/signs/cornerKick.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "endGame",
            "path": "lang/images/hud/signs/endGame.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "kickOff",
            "path": "lang/images/hud/signs/kickOff.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "firstTimeEnd",
            "path": "lang/images/hud/signs/firstTimeEnd.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "secondHalf",
            "path": "lang/images/hud/signs/secondHalf.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 64, "pivotX": 256.0, "pivotY": 32.0}],
        },
        {
            "key": "selectedPlayer",
            "path": "images/hud/selectedPlayer.png",
            "mode": 1,
            "pivotMode": "explicit",
            "frames": _grid_frames(0, 0, 22, 44, cols=12, rows=1, pivot_x=11.0, pivot_y=42.0),
        },
        {
            "key": "selectBase_blue",
            "path": "images/hud/selectBase.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 64, 20, cols=1, rows=12),
        },
        {
            "key": "selectBase_red",
            "path": "images/hud/selectBase2.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 64, 20, cols=1, rows=12),
        },
        {
            "key": "selectPanel",
            "path": "images/hud/selectPanel.png",
            "mode": 3,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 192, "h": 64, "pivotX": 96.0, "pivotY": 32.0}],
        },
        {
            "key": "enterTip",
            "path": "images/hud/tips/enterTip.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 32, 30, cols=1, rows=2),
        },
        {
            "key": "freeSelectTip",
            "path": "images/hud/tips/freeSelectTip.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 98, 36, cols=1, rows=6),
        },
        {
            "key": "helpTip",
            "path": "images/hud/tips/helpTip.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 78, 30, cols=1, rows=4),
        },
        {
            "key": "menuTip",
            "path": "images/hud/tips/menuTip.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 82, 30, cols=1, rows=4),
        },
        {
            "key": "backTip",
            "path": "images/hud/tips/backTip(WIN).png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 46, 18, cols=1, rows=2),
        },
        {
            "key": "speedIcon",
            "path": "images/hud/speedIcon.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 10, 14, cols=12, rows=1),
        },
        {
            "key": "timeIcon",
            "path": "images/hud/timeIcon.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 16, "h": 16, "pivotX": 8.0, "pivotY": 8.0}],
        },
        {
            "key": "soundIcon",
            "path": "images/hud/soundIcon.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 16, 16, cols=1, rows=4),
        },
        {
            "key": "minimap",
            "path": "images/misc/minimap.png",
            "mode": 3,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 128, "h": 64, "pivotX": 64.0, "pivotY": 32.0}],
        },
        {
            "key": "hudTimer",
            "path": "images/hud/timer.png",
            "mode": 2,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 16, 16, cols=4, rows=8, count=30),
        },
        {
            "key": "goalNameBanner",
            "path": "images/misc/goalNameBanner.png",
            "mode": 3,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 24, "pivotX": 200.0, "pivotY": 12.0}],
        },
        {
            "key": "goalNumbersBanner",
            "path": "images/misc/goalNameBanner.png",
            "mode": 3,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 64, "pivotX": 200.0, "pivotY": 32.0}],
        },
        {
            "key": "calcar",
            "path": "images/misc/logo_calcar.png",
            "mode": 3,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 64, "h": 32, "pivotX": 32.0, "pivotY": 16.0}],
        },
        {
            "key": "promotions",
            "path": "lang/images/promotions.png",
            "mode": 4,
            "pivotMode": "center",
            "frames": [
                {"x": 0, "y": 0, "w": 126, "h": 28, "pivotX": 63.0, "pivotY": 14.0},
                {"x": 0, "y": 30, "w": 126, "h": 28, "pivotX": 63.0, "pivotY": 14.0},
                {"x": 128, "y": 0, "w": 126, "h": 28, "pivotX": 63.0, "pivotY": 14.0},
                {"x": 128, "y": 30, "w": 126, "h": 28, "pivotX": 63.0, "pivotY": 14.0},
            ],
        },
        # --- sub_407830 (0x407830) ---
        {
            "key": "menuSelector",
            "path": "images/hud/menu/selector.png",
            "mode": 1,
            "pivotMode": "center",
            "frames": _grid_frames(0, 0, 256, 24, cols=1, rows=2),
        },
        {
            "key": "infoPanel",
            "path": "images/hud/infoPanel.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 300, "h": 36, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "selectBack_Blue",
            "path": "images/hud/selectBack.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 140, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "selectBack_Red",
            "path": "images/hud/selectBack2.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 140, "pivotX": 0.0, "pivotY": 0.0}],
        },
        # --- sub_4031f0 (0x4031f0) ---
        {
            "key": "creditsBg",
            "path": "lang/images/help/credits.png",
            "mode": 0,
            "pivotMode": "center",
            "frames": [{"x": 0, "y": 0, "w": 512, "h": 256, "pivotX": 256.0, "pivotY": 128.0}],
        },
        {
            "key": "helpBg",
            "path": "images/hud/helpPopUp.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "creditsFaderBottom",
            "path": "images/hud/creditsFader.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 280, "h": 10, "pivotX": 280.0, "pivotY": 10.0}],
        },
        {
            "key": "creditsFaderTop",
            "path": "images/hud/creditsFader.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 30, "w": 280, "h": 10, "pivotX": 280.0, "pivotY": 0.0}],
        },
        {
            "key": "creditsFaderBlackHelper",
            "path": "images/hud/creditsFader.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 10, "w": 280, "h": 20, "pivotX": 280.0, "pivotY": 0.0}],
        },
        {
            "key": "credits1",
            "path": "lang/images/hud/credits1.jpg",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 128, "h": 64, "pivotX": 128.0, "pivotY": 0.0}],
        },
        {
            "key": "credits2",
            "path": "lang/images/hud/batovi.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 80, "h": 56, "pivotX": 80.0, "pivotY": 0.0}],
        },
        {
            "key": "credits3",
            "path": "lang/images/hud/calcar.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 92, "h": 53, "pivotX": 92.0, "pivotY": 0.0}],
        },
        # --- Splash, Loading, Pause ---
        {
            "key": "loading",
            "path": "lang/images/hud/loading.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "calcarLogo",
            "path": "images/splashScreens/calcarLogo.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "batoviLogo",
            "path": "images/splashScreens/batoviLogo.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
        {
            "key": "pauseBackground",
            "path": "images/pause/background.png",
            "mode": 3,
            "pivotMode": "explicit",
            "frames": [{"x": 0, "y": 0, "w": 400, "h": 300, "pivotX": 0.0, "pivotY": 0.0}],
        },
    ]

    # Help popup overlays registered via sub_406ca0 (rect 108,30,296,196)
    for page in ("apuntar", "cabezazo", "controles", "controles2p", "credits", "pases", "superTiro"):
        specs.append(
            {
                "key": f"help_{page}",
                "path": f"lang/images/help/{page}.png",
                "mode": 3,
                "pivotMode": "center",
                "frames": [
                    {"x": 108, "y": 30, "w": 296, "h": 196, "pivotX": 148.0, "pivotY": 98.0}
                ],
            }
        )

    sprites_out: dict[str, Any] = {}
    for item in specs:
        rel_path = item["path"]
        meta = image_meta[rel_path]
        img_path = PUBLIC_ASSETS_DIR / rel_path
        with Image.open(img_path) as im:
            rgba = im.convert("RGBA")
            enriched_frames = []
            for frame in item["frames"]:
                enriched_frames.append(
                    {
                        **frame,
                        "contentBbox": frame_content_bbox(
                            rgba, frame["x"], frame["y"], frame["w"], frame["h"]
                        ),
                    }
                )
        entry: dict[str, Any] = {
            "path": rel_path,
            "originalColorMode": meta["originalMode"],
            "textureSize": {"w": meta["width"], "h": meta["height"]},
            "mode": item["mode"],
            "pivotMode": item["pivotMode"],
            "frames": enriched_frames,
        }
        if "notes" in item:
            entry["notes"] = item["notes"]
        sprites_out[item["key"]] = entry

    return {"virtualResolution": {"w": 400, "h": 300}, "sprites": sprites_out}


def build_fonts_manifest(image_meta: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Generate manifests/fonts.json from sub_40b750, sub_40d7d0, sub_40bbc0."""
    standard_fonts = [
        ("smallFont", "lang/images/fonts/smallFont.png", 8),
        ("smallFontEnabled", "lang/images/fonts/smallFontEnabled.png", 8),
        ("smallFontDisabled", "lang/images/fonts/smallFontDisabled.png", 8),
        ("mediumFont", "lang/images/fonts/mediumFont.png", 16),
        ("bigFont", "lang/images/fonts/bigFont.png", 32),
    ]

    fonts: dict[str, Any] = {}
    for key, rel_path, cell in standard_fonts:
        meta = image_meta[rel_path]
        glyphs: dict[str, Any] = {}
        with Image.open(PUBLIC_ASSETS_DIR / rel_path) as im:
            rgba = im.convert("RGBA")
            for idx, ch in enumerate(FONT_GLYPHS):
                col = idx % 32
                row = idx // 32
                gx = col * cell
                gy = row * cell
                glyphs[ch] = {
                    "index": idx,
                    "codePoint": ord(ch),
                    "x": gx,
                    "y": gy,
                    "w": cell,
                    "h": cell,
                    "contentBbox": frame_content_bbox(rgba, gx, gy, cell, cell),
                }
        fonts[key] = {
            "path": rel_path,
            "originalColorMode": meta["originalMode"],
            "textureSize": {"w": meta["width"], "h": meta["height"]},
            "cellWidth": cell,
            "cellHeight": cell,
            "advanceX": cell,
            "lineHeight": cell,
            "cols": 32,
            "rows": 4,
            "glyphCount": len(FONT_GLYPHS),
            "glyphs": glyphs,
        }

    # loadingBlock (sub_40d7d0): '0' at (0,0,8,8), '1' at (8,0,8,8)
    lb_rel = "images/hud/loadingBlock.png"
    lb_meta = image_meta[lb_rel]
    with Image.open(PUBLIC_ASSETS_DIR / lb_rel) as im:
        rgba = im.convert("RGBA")
        lb_glyphs = {
            "0": {
                "index": 0,
                "codePoint": ord("0"),
                "x": 0,
                "y": 0,
                "w": 8,
                "h": 8,
                "contentBbox": frame_content_bbox(rgba, 0, 0, 8, 8),
            },
            "1": {
                "index": 1,
                "codePoint": ord("1"),
                "x": 8,
                "y": 0,
                "w": 8,
                "h": 8,
                "contentBbox": frame_content_bbox(rgba, 8, 0, 8, 8),
            },
        }
    fonts["loadingBlock"] = {
        "path": lb_rel,
        "originalColorMode": lb_meta["originalMode"],
        "textureSize": {"w": lb_meta["width"], "h": lb_meta["height"]},
        "cellWidth": 8,
        "cellHeight": 8,
        "advanceX": 8,
        "lineHeight": 8,
        "cols": 2,
        "rows": 1,
        "glyphCount": 2,
        "glyphs": lb_glyphs,
    }

    # benchmarkNumbers.png (256x16): 10 digits '0'..'9' at 16x16 in x=0..160
    bm_rel = "lang/images/fonts/benchmarkNumbers.png"
    bm_meta = image_meta[bm_rel]
    bm_glyphs: dict[str, Any] = {}
    with Image.open(PUBLIC_ASSETS_DIR / bm_rel) as im:
        rgba = im.convert("RGBA")
        for idx, digit in enumerate("0123456789"):
            gx = idx * 16
            bm_glyphs[digit] = {
                "index": idx,
                "codePoint": ord(digit),
                "x": gx,
                "y": 0,
                "w": 16,
                "h": 16,
                "contentBbox": frame_content_bbox(rgba, gx, 0, 16, 16),
            }
    fonts["benchmarkNumbers"] = {
        "path": bm_rel,
        "originalColorMode": bm_meta["originalMode"],
        "textureSize": {"w": bm_meta["width"], "h": bm_meta["height"]},
        "cellWidth": 16,
        "cellHeight": 16,
        "advanceX": 16,
        "lineHeight": 16,
        "cols": 10,
        "rows": 1,
        "glyphCount": 10,
        "glyphs": bm_glyphs,
        "binarySpriteCropNote": (
            "sub_4045b0@0x404942 registers sprite key BENCHMARK_NUMBERS with rect (0,0,80,8); "
            "PNG itself contains 10 digits of 16x16 across x=0..160."
        ),
    }

    return {"glyphOrder": FONT_GLYPHS, "fonts": fonts}


def build_audio_manifest() -> dict[str, Any]:
    """Generate manifests/audio.json from sub_458db0 and 0x45b3d9."""
    entries = [
        ("bgmNormal", "audio/music/garrasoccer.ogg", "music", 0.25, True),
        ("tribunaNormal", "audio/music/tribunaNormal.ogg", "music", 0.75, True),
        ("strongHit", "audio/fx/menuSelect.ogg", "sfx", 1.0, False),
        ("action", "audio/fx/menuMove.ogg", "sfx", 0.75, False),
        ("tribuna:susto", "audio/fx/tribuna/suspenseEnd.ogg", "sfx", 1.0, False),
        ("tribuna:ovacion", "audio/fx/tribuna/success.ogg", "sfx", 1.0, False),
        ("tribuna:ovacionCorta", "audio/fx/tribuna/shortSuccess.ogg", "sfx", 1.0, False),
        ("seMuestraNombreDelQueMetioElGol", "audio/fx/tribuna/success.ogg", "sfx", 1.0, False),
        ("kick", "audio/fx/player/kick.ogg", "sfx", 1.0, False),
        ("powerKick", "audio/fx/player/powerKick.ogg", "sfx", 1.0, False),
        ("slide", "audio/fx/player/slide.ogg", "sfx", 0.4, False),
        ("catch", "audio/fx/player/catch.ogg", "sfx", 0.7, False),
        ("step", "audio/fx/player/step.ogg", "sfx", 0.2, False),
        ("whistle:start", "audio/fx/silbato/inicial.ogg", "sfx", 1.0, False),
        ("whistle:end", "audio/fx/silbato/final.ogg", "sfx", 1.0, False),
        ("whistle:goal", "audio/fx/silbato/gol.ogg", "sfx", 1.0, False),
        ("whistle:short", "audio/fx/silbato/corto.ogg", "sfx", 1.0, False),
        ("palo", "audio/fx/palo.ogg", "sfx", 1.0, False),
        ("introMusic", "audio/music/garra_soccer_intro.ogg", "music", 0.3, True),
    ]

    sounds: dict[str, Any] = {}
    for key, rel_path, category, vol, loop in entries:
        disk_path = PUBLIC_ASSETS_DIR / rel_path
        assert disk_path.is_file(), f"Missing audio file referenced by binary: {disk_path}"
        sounds[key] = {
            "path": rel_path,
            "category": category,
            "defaultVolume": vol,
            "loop": loop,
            "sizeBytes": disk_path.stat().st_size,
        }
    return {"sounds": sounds}


def _parse_hex_rgb(raw: str) -> dict[str, Any]:
    h = raw.strip().lstrip("#").upper()
    assert len(h) == 6, f"Unexpected hex color: {raw!r}"
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    return {"r": r, "g": g, "b": b, "hex": f"#{h}"}


def _parse_color_el(el: ET.Element, index: int) -> dict[str, Any]:
    return {
        "index": index,
        "name": el.tag,
        "c1": _parse_hex_rgb(el.attrib["c1"]),
        "c2": _parse_hex_rgb(el.attrib["c2"]),
    }


def build_colors_data() -> dict[str, Any]:
    """Convert assets/data/colors.xml into typed palette tables."""
    root = parse_lenient_xml(SOURCE_ASSETS_DIR / "data" / "colors.xml")
    colors_el = root.find("colors")
    assert colors_el is not None, "Missing <colors> in colors.xml"

    def _read_group(tag: str) -> dict[str, Any]:
        group_el = colors_el.find(tag)
        assert group_el is not None, f"Missing <{tag}> in colors.xml"
        entries = [_parse_color_el(child, i) for i, child in enumerate(group_el)]
        return {entry["name"]: entry for entry in entries}

    return {
        "fixedColors": {
            "outline": "#000000",
            "shoeDetail": "#ADADAD",
            "eyeSclera": "#FFFFFF",
        },
        "originalColors": _read_group("originalColors"),
        "hairColors": _read_group("hairColors"),
        "skinColors": _read_group("skinColors"),
        "eyeColors": _read_group("eyeColors"),
        "basicColors": _read_group("basicColors"),
    }


def build_teams_data() -> dict[str, Any]:
    """Convert assets/data/teams.xml into /src/data/teams.json."""
    root = parse_lenient_xml(SOURCE_ASSETS_DIR / "data" / "teams.xml")
    teams_el = root.find("teams")
    assert teams_el is not None, "Missing <teams> in teams.xml"

    teams: list[dict[str, Any]] = []
    for t_el in teams_el:
        players_el = t_el.find("players")
        assert players_el is not None, f"Missing <players> for team {t_el.tag}"
        players: list[dict[str, Any]] = []
        for idx, p_el in enumerate(players_el, start=1):
            players.append(
                {
                    "number": idx,
                    "id": p_el.tag,
                    "name": decode_game_text(p_el.attrib["name"]),
                    "hair": p_el.attrib["hair"],
                    "skin": p_el.attrib["skin"],
                    "eyes": p_el.attrib["eyes"],
                    "skill": float(p_el.attrib["skill"]),
                    "speed": float(p_el.attrib["speed"]),
                    "marking": float(p_el.attrib["marking"]),
                    "drivingFail": float(p_el.attrib["drivingFail"]),
                    "block": float(p_el.attrib["block"]),
                    "power": float(p_el.attrib["power"]),
                    "inaccuracy": float(p_el.attrib["inaccuracy"]),
                }
            )
        teams.append(
            {
                "id": t_el.tag,
                "category": int(t_el.attrib["category"]),
                "name": decode_game_text(t_el.attrib["name"]),
                "shortName": decode_game_text(t_el.attrib["shortName"]),
                "captain": int(t_el.attrib["captain"]),
                "formation": t_el.attrib["formation"],
                "colors": {
                    "tshirt": t_el.attrib["tshirt"],
                    "short": t_el.attrib["short"],
                    "socks": t_el.attrib["socks"],
                    "goalKeeperTshirt": t_el.attrib["goalKeeperTshirt"],
                    "goalKeeperShort": t_el.attrib["goalKeeperShort"],
                    "goalKeeperSocks": t_el.attrib["goalKeeperSocks"],
                    "goalKeeperGloves": t_el.attrib["goalKeeperGloves"],
                },
                "description": {
                    "info": decode_game_text(t_el.attrib["info"]),
                    "advantages": decode_game_text(t_el.attrib["advantages"]),
                    "disadvantages": decode_game_text(t_el.attrib["disadvantages"]),
                },
                "ratings": {
                    "offense": float(t_el.attrib["offense"]),
                    "middle": float(t_el.attrib["middle"]),
                    "defense": float(t_el.attrib["defense"]),
                    "goalKeeper": float(t_el.attrib["goalKeeper"]),
                },
                "players": players,
            }
        )

    assert len(teams) == 16, f"Expected 16 teams, got {len(teams)}"
    return {"teams": teams}


def build_formations_data() -> dict[str, Any]:
    """Export hardcoded tactical formations from sub_444f40 (0x444f40)."""
    raw_formations: dict[str, list[tuple[float, float]]] = {
        "442": [
            (0.27, 0.20),
            (0.27, 0.80),
            (0.25, 0.40),
            (0.25, 0.60),
            (0.47, 0.20),
            (0.47, 0.80),
            (0.45, 0.60),
            (0.70, 0.75),
            (0.45, 0.40),
            (0.70, 0.25),
        ],
        "433": [
            (0.27, 0.20),
            (0.27, 0.80),
            (0.25, 0.40),
            (0.25, 0.60),
            (0.47, 0.25),
            (0.70, 0.80),
            (0.47, 0.75),
            (0.70, 0.50),
            (0.45, 0.50),
            (0.70, 0.20),
        ],
        "352": [
            (0.27, 0.20),
            (0.27, 0.80),
            (0.25, 0.50),
            (0.45, 0.375),
            (0.47, 0.20),
            (0.45, 0.625),
            (0.47, 0.80),
            (0.70, 0.75),
            (0.47, 0.50),
            (0.70, 0.25),
        ],
    }

    formations: dict[str, Any] = {}
    for name, coords in raw_formations.items():
        formations[name] = {
            "id": name,
            "goalkeeperNumber": 1,
            "outfieldPositions": [
                {"playerNumber": idx + 2, "x": x, "y": y}
                for idx, (x, y) in enumerate(coords)
            ],
        }
    return {"formations": formations}


def build_menu_data() -> dict[str, Any]:
    """Convert assets/data/menu.xml into /src/data/menu.json."""
    root = parse_lenient_xml(SOURCE_ASSETS_DIR / "data" / "menu.xml")
    menu_def = root.find("menuDefinition")
    assert menu_def is not None, "Missing <menuDefinition> in menu.xml"

    bool_attrs = {"useBack", "showSelectedPlayer", "showContinue", "confirm"}
    nodes: dict[str, Any] = {}
    node_order: list[str] = []

    for menu_el in menu_def:
        node_id = menu_el.tag
        node_order.append(node_id)
        node_attrs: dict[str, Any] = {}
        for k, v in menu_el.attrib.items():
            if k in bool_attrs:
                node_attrs[k] = v.lower() == "true"
            elif k == "cancel":
                node_attrs[k] = decode_game_text(v)
            else:
                node_attrs[k] = v

        options: list[dict[str, Any]] = []
        for opt_el in menu_el:
            raw_text = opt_el.attrib["textKey"]
            opt_entry: dict[str, Any] = {
                "tag": opt_el.tag,
                "text": decode_game_text(raw_text),
                "rawText": raw_text,
            }
            if "link" in opt_el.attrib:
                opt_entry["link"] = opt_el.attrib["link"]
            if "action" in opt_el.attrib:
                opt_entry["action"] = opt_el.attrib["action"]
            if "info" in opt_el.attrib:
                opt_entry["info"] = decode_game_text(opt_el.attrib["info"])
            if "condFlag" in opt_el.attrib:
                opt_entry["condFlag"] = opt_el.attrib["condFlag"]
            options.append(opt_entry)

        nodes[node_id] = {
            "id": node_id,
            **node_attrs,
            "options": options,
        }

    return {"rootMenuId": "mainMenu", "nodeOrder": node_order, "nodes": nodes}


def build_texts_data() -> dict[str, Any]:
    """Convert assets/data/texts.xml into /src/data/texts.json."""
    root = parse_lenient_xml(SOURCE_ASSETS_DIR / "data" / "texts.xml")
    texts_el = root.find("texts")
    assert texts_el is not None, "Missing <texts> in texts.xml"

    texts: dict[str, dict[str, str]] = {}
    for node in texts_el.findall("node"):
        key = node.attrib["key"]
        raw = node.attrib["text"]
        texts[key] = {
            "text": decode_game_text(raw),
            "raw": raw,
        }
    return {"texts": texts}


def build_credits_data() -> dict[str, Any]:
    """Convert assets/data/credits.dat into structured /src/data/credits.json."""
    lines = (
        (SOURCE_ASSETS_DIR / "data" / "credits.dat")
        .read_bytes()
        .decode("latin-1")
        .splitlines()
    )
    items: list[dict[str, Any]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            items.append({"type": "spacer"})
        elif stripped.startswith("$"):
            items.append({"type": "image", "spriteKey": stripped[1:]})
        elif stripped.startswith("#"):
            raw = stripped[1:]
            items.append({"type": "heading", "text": decode_game_text(raw), "raw": raw})
        else:
            items.append({"type": "text", "text": decode_game_text(stripped), "raw": stripped})
    return {"entries": items}


def main() -> None:
    global SOURCE_ASSETS_DIR
    parser = argparse.ArgumentParser(
        description="Extract and convert Garra Fútbol assets into public/assets and src/data."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=None,
        help="Path to extracted original game assets directory (or set GARRA_ASSETS_DIR).",
    )
    args = parser.parse_args()
    SOURCE_ASSETS_DIR = resolve_source_assets_dir(args.source)

    if not SOURCE_ASSETS_DIR.is_dir():
        raise FileNotFoundError(f"Source assets directory not found: {SOURCE_ASSETS_DIR}")

    image_meta = copy_and_normalize_assets()

    jugador_manifest = parse_character_sheet(
        "images/characters/Jugador.xml",
        "images/characters/Jugador.fgt",
        "images/characters/Jugador.png",
        image_meta,
    )
    pelota_manifest = parse_character_sheet(
        "images/characters/Pelota.xml",
        "images/characters/Pelota.fgt",
        "images/characters/Pelota.png",
        image_meta,
    )
    sprites_manifest = build_sprites_manifest(image_meta)
    fonts_manifest = build_fonts_manifest(image_meta)
    audio_manifest = build_audio_manifest()

    write_json(MANIFESTS_DIR / "jugador.json", jugador_manifest)
    write_json(MANIFESTS_DIR / "pelota.json", pelota_manifest)
    write_json(MANIFESTS_DIR / "sprites.json", sprites_manifest)
    write_json(MANIFESTS_DIR / "fonts.json", fonts_manifest)
    write_json(MANIFESTS_DIR / "audio.json", audio_manifest)

    colors_data = build_colors_data()
    teams_data = build_teams_data()
    formations_data = build_formations_data()
    menu_data = build_menu_data()
    texts_data = build_texts_data()
    credits_data = build_credits_data()

    write_json(DATA_DIR / "colors.json", colors_data)
    write_json(DATA_DIR / "teams.json", teams_data)
    write_json(DATA_DIR / "formations.json", formations_data)
    write_json(DATA_DIR / "menu.json", menu_data)
    write_json(DATA_DIR / "texts.json", texts_data)
    write_json(DATA_DIR / "credits.json", credits_data)

    print(
        f"Manifests -> jugador({len(jugador_manifest['atlasFrames'])} frames, "
        f"{len(jugador_manifest['animations'])} anims), "
        f"pelota({len(pelota_manifest['atlasFrames'])} frames, "
        f"{len(pelota_manifest['animations'])} anims), "
        f"sprites({len(sprites_manifest['sprites'])}), "
        f"fonts({len(fonts_manifest['fonts'])}), "
        f"audio({len(audio_manifest['sounds'])})"
    )
    print(
        f"Data -> teams({len(teams_data['teams'])}), "
        f"formations({len(formations_data['formations'])}), "
        f"menu({len(menu_data['nodes'])}), "
        f"texts({len(texts_data['texts'])}), "
        f"credits({len(credits_data['entries'])})"
    )


if __name__ == "__main__":
    main()
