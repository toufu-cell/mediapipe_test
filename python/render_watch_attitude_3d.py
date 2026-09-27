"""Render recorded Watch attitudes with a shared fixed 3D viewpoint."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial.transform import Rotation

from compare_watch_attitude import CLIP_SECONDS, CLIP_STARTS, COLORS, sampleIndices, unitQuaternions


METHODS = ("CoreMotion", "Madgwick_0.1")
WIDTH, HEIGHT, VIDEO_WIDTH, FPS = 1280, 720, 405, 15
PANEL_SIZE = (420, 390)
BACKGROUND = (246, 248, 250)
CAMERA = np.array([-4.0, 6.0, 5.0])
CAMERA /= np.linalg.norm(CAMERA)
RIGHT = np.cross([0, 0, 1], CAMERA)
RIGHT /= np.linalg.norm(RIGHT)
UP = np.cross(CAMERA, RIGHT)
VIEW = np.array([RIGHT, UP, CAMERA])
FONT_PATH = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"
RING_COLORS = ((205, 70, 61), (45, 137, 74), (48, 105, 205))
RING_RADIUS = 3.15
TRAIL_SECONDS = 0.8
WATCH_OFFSET = np.array([0, 0, 0.85])
MARKER_POINTS = RING_RADIUS * np.array([[0, 0.8, 0.6], [0.6, 0, 0.8], [0.8, 0.6, 0]])


def project(points):
    view = np.asarray(points) @ VIEW.T
    return np.column_stack((210 + 46 * view[:, 0], 190 - 46 * view[:, 1], view[:, 2]))


def watchMesh(color):
    faces = []

    def surface(points, fill):
        faces.append((np.array(points, dtype=float), fill))

    def box(profile, lower, upper, fill):
        bottom = [(x, y, lower) for x, y in profile]
        top = [(x, y, upper) for x, y in profile]
        surface(top, fill)
        surface(bottom[::-1], fill)
        for index in range(len(profile)):
            nextIndex = (index + 1) % len(profile)
            surface([bottom[index], bottom[nextIndex], top[nextIndex], top[index]], fill)

    def rounded(width, height, radius):
        points = []
        for x, y, start in [(width-radius, height-radius, 0),
                             (-width+radius, height-radius, 90),
                             (-width+radius, -height+radius, 180),
                             (width-radius, -height+radius, 270)]:
            for angle in np.radians(np.linspace(start, start + 90, 5)):
                points.append((x + radius * np.cos(angle), y + radius * np.sin(angle)))
        return points

    box(rounded(0.73, 0.9, 0.2), -0.19, 0.19, (184, 197, 209))
    box([(0.70, 0.32), (0.91, 0.32), (0.91, 0.58), (0.70, 0.58)],
        -0.11, 0.11, (184, 197, 209))
    surface([(x, y, 0.195) for x, y in rounded(0.63, 0.79, 0.16)], (20, 32, 45))
    surface([(-0.43, -0.50, 0.20), (0.43, -0.50, 0.20),
             (0.43, -0.35, 0.20), (-0.43, -0.35, 0.20)], color)
    surface([(-0.13, -0.1, 0.20), (0.13, -0.1, 0.20), (0, 0.53, 0.20)], color)
    angles = np.linspace(0, 2 * np.pi, 32, endpoint=False)[::-1]
    surface([(0.43*np.cos(t), 0.43*np.sin(t), -0.195) for t in angles], (38, 45, 53))
    surface([(0.24*np.cos(t), 0.24*np.sin(t), -0.20) for t in angles], (119, 137, 149))
    return [(points + WATCH_OFFSET, fill) for points, fill in faces]


def armMesh():
    faces = []
    skin = (207, 179, 150)
    angles = np.linspace(0, 2 * np.pi, 25)
    forearm = [np.column_stack((np.full(len(angles), x), radius*np.cos(angles),
                               0.8*radius*np.sin(angles)))
               for x, radius in [(-3.5, 0.88), (0.65, 0.65)]]
    faces.append((forearm[0][:-1][::-1], skin))
    faces.append((forearm[1][:-1], skin))
    for index in range(len(angles)-1):
        faces.append((np.array([forearm[0][index], forearm[0][index+1],
                               forearm[1][index+1], forearm[1][index]]), skin))

    def block(x0, x1, y0, y1, z0, z1):
        bottom = np.array([[x0,y0,z0], [x1,y0,z0], [x1,y1,z0], [x0,y1,z0]])
        top = bottom.copy()
        top[:, 2] = z1
        faces.extend([(top, skin), (bottom[::-1], skin)])
        for index in range(4):
            nextIndex = (index+1) % 4
            faces.append((np.array([bottom[index], bottom[nextIndex], top[nextIndex], top[index]]), skin))

    block(0.6, 1.9, -0.7, 0.7, -0.36, 0.36)
    for y, end in [(0.52, 3.35), (0.17, 3.65), (-0.18, 3.45), (-0.53, 3.05)]:
        block(1.8, end, y-0.145, y+0.145, -0.28, 0.28)
    block(0.75, 1.65, 0.58, 1.18, -0.30, 0.24)
    band = (55, 66, 80)
    for index in range(len(angles)-1):
        for side in (-1, 1):
            theta0, theta1 = angles[index:index+2]
            inner = [(side*0.34, 0.78*np.cos(t), 0.61*np.sin(t)) for t in [theta0, theta1]]
            outer = [(side*0.34, 0.86*np.cos(t), 0.69*np.sin(t)) for t in [theta0, theta1]]
            cap = np.array([inner[0], outer[0], outer[1], inner[1]])
            faces.append((cap if side > 0 else cap[::-1], band))
        for radiusY, radiusZ, outward in [(0.86, 0.69, True), (0.78, 0.61, False)]:
            strip = np.array([(x, radiusY*np.cos(t), radiusZ*np.sin(t))
                              for x, t in [(-0.34, theta0), (-0.34, theta1), (0.34, theta1), (0.34, theta0)]])
            faces.append((strip if outward else strip[::-1], band))
    # Dorsal right-wrist mount: Crown toward elbow, fingers -X, thumb -Y.
    return [(points * [-1, -1, 1], fill) for points, fill in faces]


def markerHistory(quaternions):
    matrices = Rotation.from_quat(unitQuaternions(quaternions)).as_matrix()
    return np.einsum("nij,kj->nki", matrices, MARKER_POINTS)


def recentHistory(quaternions, sample, clipStart):
    start = max(clipStart, sample - round(TRAIL_SECONDS * FPS))
    return quaternions[start:sample+1]


def drawSpatialPath(pixels, depth, points, color, radius=1, fadeRear=False):
    projected = project(points)
    samples = []
    for a, b in zip(projected[:-1], projected[1:]):
        steps = max(2, int(np.ceil(np.max(np.abs(b[:2]-a[:2]))))*2)
        samples.append(np.linspace(a, b, steps))
    projected = np.concatenate(samples) if samples else projected
    centers = np.rint(projected[:, :2]).astype(int)
    colors = np.tile(np.asarray(color, dtype=float), (len(projected), 1))
    if fadeRear:
        rear = projected[:, 2] < 0
        colors[rear] = 0.38*colors[rear] + 0.62*np.asarray(BACKGROUND)
    for dy in range(-radius, radius+1):
        for dx in range(-radius, radius+1):
            if dx*dx+dy*dy > radius*radius:
                continue
            xy = centers + [dx, dy]
            inside = (xy[:, 0] >= 0) & (xy[:, 0] < PANEL_SIZE[0]) & (xy[:, 1] >= 0) & (xy[:, 1] < PANEL_SIZE[1])
            x, y = xy[inside].T
            z = projected[inside, 2]
            visible = z >= depth[y, x] - 0.012
            pixels[y[visible], x[visible]] = colors[inside][visible]


def drawRings(pixels, depth, quaternion, history):
    rotation = Rotation.from_quat(quaternion)
    angles = np.linspace(0, 2*np.pi, 181)
    for axis, color in enumerate(RING_COLORS):
        circle = np.zeros((len(angles), 3))
        circle[:, (axis+1) % 3] = RING_RADIUS*np.cos(angles)
        circle[:, (axis+2) % 3] = RING_RADIUS*np.sin(angles)
        drawSpatialPath(pixels, depth, rotation.apply(circle), color, fadeRear=True)
    markers = markerHistory(history)
    for axis, color in enumerate(RING_COLORS):
        for index in range(1, len(markers)):
            fade = index / max(1, len(markers)-1)
            fill = fade*np.asarray(color) + (1-fade)*np.asarray(BACKGROUND)
            drawSpatialPath(pixels, depth, markers[index-1:index+1, axis], fill, radius=2)
        current = markers[-1, axis:axis+1]
        drawSpatialPath(pixels, depth, current, (255, 255, 255), radius=6)
        drawSpatialPath(pixels, depth, current, color, radius=4)


def renderWatch(quaternion, color, history=None):
    rotation = Rotation.from_quat(unitQuaternions(np.asarray(quaternion)[None, :])[0])
    canvas = Image.new("RGB", PANEL_SIZE, BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    for offset in np.linspace(-3.5, 3.5, 5):
        for line in [[[-3.5, offset, -3.8], [3.5, offset, -3.8]],
                     [[offset, -3.5, -3.8], [offset, 3.5, -3.8]]]:
            draw.line([tuple(p[:2]) for p in project(line)], fill="#dce2e8", width=1)
    pixels = np.array(canvas)
    depth = np.full(pixels.shape[:2], -np.inf)
    light = np.array([-0.3, -0.5, 0.8])
    light /= np.linalg.norm(light)
    for local, fill in armMesh() + watchMesh(color):
        world = rotation.apply(local)
        normal = np.cross(world[1] - world[0], world[2] - world[0])
        normal /= np.linalg.norm(normal)
        if normal @ CAMERA <= 1e-9:
            continue
        shade = np.clip(np.asarray(fill) * (0.70 + 0.30 * max(0, normal @ light)), 0, 255)
        vertices = project(world)
        for index in range(1, len(vertices) - 1):
            a, b, c = vertices[[0, index, index + 1]]
            x0, y0 = np.maximum(np.floor(np.min([a[:2], b[:2], c[:2]], axis=0)), 0).astype(int)
            x1, y1 = np.minimum(np.ceil(np.max([a[:2], b[:2], c[:2]], axis=0)),
                                np.array(PANEL_SIZE) - 1).astype(int)
            if x1 < x0 or y1 < y0:
                continue
            yy, xx = np.mgrid[y0:y1+1, x0:x1+1].astype(float)
            xx += 0.5
            yy += 0.5
            denominator = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1])
            if abs(denominator) < 1e-8:
                continue
            wa = ((b[1]-c[1])*(xx-c[0]) + (c[0]-b[0])*(yy-c[1])) / denominator
            wb = ((c[1]-a[1])*(xx-c[0]) + (a[0]-c[0])*(yy-c[1])) / denominator
            wc = 1 - wa - wb
            candidate = wa*a[2] + wb*b[2] + wc*c[2]
            region = depth[y0:y1+1, x0:x1+1]
            visible = (wa >= -1e-8) & (wb >= -1e-8) & (wc >= -1e-8) & (candidate > region)
            pixels[y0:y1+1, x0:x1+1][visible] = shade
            region[visible] = candidate[visible]
    if history is None:
        history = np.asarray(quaternion)[None, :]
    drawRings(pixels, depth, quaternion, history)
    canvas = Image.fromarray(pixels)
    draw = ImageDraw.Draw(canvas)
    draw.line([(32, 104), (32, 48)], fill="#52616e", width=2)
    draw.polygon([(32, 42), (27, 53), (37, 53)], fill="#52616e")
    draw.text((20, 15), "上", font=ImageFont.truetype(FONT_PATH, 17), fill="#52616e")
    return canvas


def readAttitudes(path):
    table = pd.read_csv(path)
    times = table.video_time_s.to_numpy(dtype=float)
    if len(times) == 0 or not np.isfinite(times).all() or np.any(np.diff(times) <= 0):
        raise ValueError("Video times must be nonempty / finite / strictly increasing")
    attitudes = [unitQuaternions(table[[f"{method}_q{axis}" for axis in "xyzw"]].to_numpy())
                 for method in METHODS]
    targets = np.concatenate([start + np.arange(CLIP_SECONDS * FPS) / FPS for start in CLIP_STARTS])
    indices, valid = sampleIndices(times, targets)
    if not valid.all():
        raise ValueError("Every video frame requires an IMU sample within 100 ms")
    return targets, [values[indices] for values in attitudes]


def composeFrame(raw, time, quaternions, fonts, histories=None):
    title, body, small = fonts
    canvas = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    canvas.paste(Image.frombytes("RGB", (VIDEO_WIDTH, HEIGHT), raw), (0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text((433, 24), "右腕とWatchの傾きを比較", font=title, fill="#192b38")
    draw.text((433, 70), f"元動画{time:.2f}秒", font=body, fill="#52616e")
    draw.text((433, 111), "腕・手・Watchが一緒に傾く／丸印の尾は直前0.8秒の動き", font=small, fill="#52616e")
    for index, (name, quaternion) in enumerate(zip(("CoreMotion", "Madgwick"), quaternions)):
        x = 427 + index * 425
        color = tuple(bytes.fromhex(COLORS[index][1:]))
        draw.text((x + 18, 158), name, font=title, fill=COLORS[index])
        history = histories[index] if histories is not None else None
        canvas.paste(renderWatch(quaternion, color, history), (x, 205))
        normal = Rotation.from_quat(quaternion).apply([0, 0, 1])
        angle = np.degrees(np.arccos(np.clip(normal[2], -1, 1)))
        draw.text((x + 18, 585), f"文字盤の傾き  {angle:.1f}°", font=body, fill=COLORS[index])
    draw.text((445, 626), "0°：上向き／90°：横向き／180°：下向き", font=small, fill="#52616e")
    for axis, label in enumerate(("赤：X軸のリング", "緑：Y軸のリング", "青：Z軸のリング")):
        draw.text((445 + axis*240, 660), label, font=small, fill=RING_COLORS[axis])
    draw.text((445, 689), "右手・文字盤：甲側・Crown：肘側／比較用の固定視点。撮影カメラとの向き合わせは未実施。", font=ImageFont.truetype(FONT_PATH, 15), fill="#52616e")
    return canvas


def makeVideo(video, attitude, output):
    if output.exists():
        raise FileExistsError(output)
    targets, quaternions = readAttitudes(attitude)
    fonts = [ImageFont.truetype(FONT_PATH, size) for size in (28, 22, 18)]
    previews = []
    with tempfile.TemporaryDirectory(prefix="watch-3d-", dir=output.parent) as temporary:
        temporaryVideo = Path(temporary) / "comparison.mp4"
        encoder = subprocess.Popen([
            "ffmpeg", "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0", "-an",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(temporaryVideo),
        ], stdin=subprocess.PIPE)
        try:
            sample = 0
            for start in CLIP_STARTS:
                clipStart = sample
                decoder = subprocess.Popen([
                    "ffmpeg", "-v", "error", "-ss", str(start), "-i", str(video),
                    "-t", str(CLIP_SECONDS), "-vf", f"fps={FPS},scale={VIDEO_WIDTH}:{HEIGHT}",
                    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
                ], stdout=subprocess.PIPE)
                try:
                    for frame in range(CLIP_SECONDS * FPS):
                        raw = decoder.stdout.read(VIDEO_WIDTH * HEIGHT * 3)
                        if len(raw) != VIDEO_WIDTH * HEIGHT * 3:
                            raise ValueError("Video ended before the requested clip")
                        histories = [recentHistory(q, sample, clipStart) for q in quaternions]
                        canvas = composeFrame(raw, targets[sample], [q[sample] for q in quaternions], fonts, histories)
                        encoder.stdin.write(canvas.tobytes())
                        sample += 1
                        if frame == 8 * FPS:
                            previews.append(canvas)
                finally:
                    decoder.stdout.close()
                    if decoder.poll() is None:
                        decoder.terminate()
                    decoder.wait()
                print(f"Rendered source clip {start} s", flush=True)
        finally:
            encoder.stdin.close()
            code = encoder.wait()
        if code:
            raise RuntimeError("Video encoding failed")
        result = subprocess.run([
            "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=nb_read_frames,duration", "-of", "json", str(temporaryVideo),
        ], check=True, capture_output=True, text=True)
        stream = json.loads(result.stdout)["streams"][0]
        if int(stream["nb_read_frames"]) != len(targets) or abs(float(stream["duration"]) - len(targets)/FPS) > 0.001:
            raise ValueError("Encoded frame count or duration differs from requested clips")
        subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(temporaryVideo), "-f", "null", "-"], check=True)
        os.link(temporaryVideo, output)
    previews[0].save(output.with_name(output.stem + "-preview.png"))
    contact = Image.new("RGB", (1280, 720))
    for index, preview in enumerate(previews):
        contact.paste(preview.resize((640, 360), Image.Resampling.LANCZOS), ((index % 2)*640, (index // 2)*360))
    contact.save(output.with_name(output.stem + "-verification.png"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--attitude", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    makeVideo(args.video, args.attitude, args.output)
