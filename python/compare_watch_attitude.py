"""Compare recorded CoreMotion attitude with six-axis Madgwick on one recording."""

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial.transform import Rotation


BETAS = (0.1, 0.01, 0.033)
CLASS_NAMES = ("left", "neutral", "right")
LABEL_IDS = {"左傾き": 0, "中立": 1, "右傾き": 2, "判定不能": -1}
CLIP_STARTS = (40, 100, 320, 400)
CLIP_SECONDS = 12
MAX_GAP_SECONDS = 0.1
COLORS = ("#147d92", "#b63688")


def unitQuaternions(values):
    values = np.asarray(values, dtype=float)
    if values.ndim != 2 or values.shape[1] != 4 or not np.isfinite(values).all():
        raise ValueError("Quaternions must be finite Nx4 values in xyzw order")
    norms = np.linalg.norm(values, axis=1)
    if np.any(abs(norms - 1) > 0.01):
        raise ValueError("Quaternion norms must be within 0.01 of one")
    return values / norms[:, None]


def gravityFromQuaternions(quaternions):
    values = unitQuaternions(quaternions)
    return Rotation.from_quat(values).apply(np.tile([0, 0, -1], (len(values), 1)), inverse=True)


def madgwick(times, gyroscope, acceleration, initialQuaternion, beta=0.1):
    """Use body angular velocity and upward specific force; return xyzw attitude."""
    times = np.asarray(times, dtype=float)
    gyroscope = np.asarray(gyroscope, dtype=float)
    acceleration = np.asarray(acceleration, dtype=float)
    if times.ndim != 1 or len(times) < 2 or not np.isfinite(times).all():
        raise ValueError("At least two finite times are required")
    intervals = np.diff(times)
    if np.any(intervals <= 0) or np.any(intervals > MAX_GAP_SECONDS):
        raise ValueError("Sample times must increase with gaps of at most 100 ms")
    if not math.isfinite(beta) or beta < 0:
        raise ValueError("Beta must be finite and nonnegative")
    for values in (gyroscope, acceleration):
        if values.shape != (len(times), 3) or not np.isfinite(values).all():
            raise ValueError("Sensor inputs must be finite Nx3 arrays")
    norms = np.linalg.norm(acceleration, axis=1)
    if np.any(norms < 1e-8):
        raise ValueError("Specific force must have a nonzero norm")
    acceleration = acceleration / norms[:, None]
    output = np.empty((len(times), 4))
    output[0] = unitQuaternions(np.asarray(initialQuaternion)[None, :])[0]
    quaternion = output[0][[3, 0, 1, 2]].copy()
    for index, dt in enumerate(intervals, start=1):
        w, x, y, z = quaternion
        gx, gy, gz = gyroscope[index]
        derivative = 0.5 * np.array([
            -x * gx - y * gy - z * gz,
            w * gx + y * gz - z * gy,
            w * gy - x * gz + z * gx,
            w * gz + x * gy - y * gx,
        ])
        ax, ay, az = acceleration[index]
        residual = np.array([
            2 * (x * z - w * y) - ax,
            2 * (w * x + y * z) - ay,
            1 - 2 * (x * x + y * y) - az,
        ])
        jacobian = np.array([
            [-2 * y, 2 * z, -2 * w, 2 * x],
            [2 * x, 2 * w, 2 * z, 2 * y],
            [0, -4 * x, -4 * y, 0],
        ])
        gradient = jacobian.T @ residual
        magnitude = np.linalg.norm(gradient)
        if magnitude > 1e-12:
            derivative -= beta * gradient / magnitude
        quaternion += derivative * dt
        quaternion /= np.linalg.norm(quaternion)
        output[index] = quaternion[[1, 2, 3, 0]]
    return output


def readLabels(path):
    tasks = json.loads(path.read_text())
    matching = [task for task in tasks if task["id"] == 24]
    if len(matching) != 1:
        raise ValueError("Expected one task with ID 24")
    annotations = [item for item in matching[0]["annotations"] if item["id"] == 23]
    if len(annotations) != 1:
        raise ValueError("Expected one completed annotation with ID 23")
    intervals = []
    for result in annotations[0]["result"]:
        if result["type"] != "timelinelabels":
            continue
        value = result["value"]
        if len(value["timelinelabels"]) != 1:
            raise ValueError("Each interval must have one label")
        label = LABEL_IDS[value["timelinelabels"][0]]
        for span in value["ranges"]:
            start, end = ((float(span[key]) - 1) / 30 for key in ("start", "end"))
            if not np.isfinite([start, end]).all() or start < 0 or end <= start:
                raise ValueError("Label intervals must have positive durations")
            intervals.append((start, end, label))
    intervals.sort()
    if not intervals or any(b[0] < a[1] - 1e-9 for a, b in zip(intervals, intervals[1:])):
        raise ValueError("Label intervals must be ordered and nonoverlapping")
    return np.array(intervals)


def labelsAt(times, intervals, margin=0.0):
    times = np.asarray(times)
    indices = np.searchsorted(intervals[:, 0], times, side="right") - 1
    safe = np.maximum(indices, 0)
    ends = intervals[safe, 1]
    valid = (indices >= 0) & (times < ends)
    if margin > 0:
        valid &= (times - intervals[safe, 0] > margin) & (ends - times > margin)
    return np.where(valid, intervals[safe, 2], -1).astype(int)


def sampleIndices(sampleTimes, targetTimes):
    indices = np.searchsorted(sampleTimes, targetTimes, side="right") - 1
    valid = (indices >= 0) & (targetTimes <= sampleTimes[-1])
    safe = np.maximum(indices, 0)
    valid &= targetTimes - sampleTimes[safe] <= MAX_GAP_SECONDS
    return indices, valid


def classify(reference, target, labels, quaternion=False):
    distance = np.sum((target[:, None, :] - reference[None, :, :]) ** 2, axis=2)
    if quaternion:
        distance = np.minimum(distance, np.sum((target[:, None, :] + reference[None, :, :]) ** 2, axis=2))
    neighbours = np.argsort(distance, axis=1, kind="stable")[:, :5]
    if len(reference) < 5:
        raise ValueError("Five reference samples are required")
    predictions = []
    for row in neighbours:
        ordered = labels[row]
        counts = np.bincount(ordered, minlength=3)
        winners = np.flatnonzero(counts == counts.max())
        predictions.append(next(label for label in ordered if label in winners))
    return np.asarray(predictions)


def metrics(actual, predicted):
    matrix = np.zeros((3, 3), dtype=int)
    np.add.at(matrix, (actual, predicted), 1)
    if np.any(matrix.sum(axis=1) == 0):
        raise ValueError("Each class must occur in evaluation")
    recalls = matrix.diagonal() / matrix.sum(axis=1)
    return {
        "accuracy": float(np.trace(matrix) / matrix.sum()),
        "macro_recall": float(recalls.mean()),
        "recall": dict(zip(CLASS_NAMES, recalls.tolist())),
        "confusion_rows_actual_columns_predicted": matrix.tolist(),
    }


def tiltAngles(gravity):
    face = np.degrees(np.arccos(np.clip(-gravity[:, 2], -1, 1)))
    signed = np.degrees(np.arctan2(-gravity[:, 0], -gravity[:, 2]))
    signed[np.hypot(gravity[:, 0], gravity[:, 2]) < 1e-6] = np.nan
    return face, signed


def makePlot(times, quaternions, intervals, output):
    figure, axes = plt.subplots(4, 1, figsize=(14, 9), sharex=True, layout="constrained")
    for index, name in enumerate(("CoreMotion", "Madgwick_0.1")):
        gravity = gravityFromQuaternions(quaternions[name])
        face, signed = tiltAngles(gravity)
        signed = signed[::5].copy()
        signed[1:][np.abs(np.diff(signed)) > 180] = np.nan
        axes[0].plot(times[::5], face[::5], color=COLORS[index], label=name, lw=1)
        axes[1].plot(times[::5], signed, color=COLORS[index], lw=1)
    original = gravityFromQuaternions(quaternions["CoreMotion"])
    for beta in BETAS:
        other = gravityFromQuaternions(quaternions[f"Madgwick_{beta}"])
        difference = np.degrees(np.arccos(np.clip(np.sum(original * other, axis=1), -1, 1)))
        axes[2].plot(times[::5], difference[::5], lw=0.8, label=f"beta={beta}")
    grid = np.arange(0, times[-1], 1 / 30)
    label = labelsAt(grid, intervals).astype(float)
    label[label < 0] = np.nan
    axes[3].step(grid, label, where="post", color="#444444", lw=1)
    axes[0].set(ylabel="Watch face tilt (deg)", ylim=(0, 180))
    axes[1].set(ylabel="Signed X tilt (deg)", ylim=(-180, 180))
    axes[2].set(ylabel="Tilt disagreement (deg)")
    axes[3].set(ylabel="Manual label", xlabel="Video time (s)", yticks=[0, 1, 2], yticklabels=CLASS_NAMES)
    for axis in axes:
        axis.grid(alpha=0.2)
        axis.axvspan(299, 301, color="#aaaaaa", alpha=0.2)
        axis.axvline(300, color="#777777", ls="--", lw=0.7)
    axes[0].legend(loc="upper right")
    axes[2].legend(loc="upper right")
    figure.suptitle("Same recording: CoreMotion vs Madgwick | exploratory comparison")
    figure.savefig(output, dpi=150)
    plt.close(figure)


def drawGauge(draw, center, angle, color):
    cx, cy = center
    draw.ellipse((cx - 62, cy - 62, cx + 62, cy + 62), outline="#cbd5dc", width=2)
    if not np.isfinite(angle):
        return
    theta = math.radians(angle)
    tip = (cx + 54 * math.sin(theta), cy - 54 * math.cos(theta))
    draw.line((cx, cy, *tip), fill=color, width=5)
    dx, dy = math.sin(theta), -math.cos(theta)
    draw.polygon([tip, (tip[0] - 12 * dx + 5 * dy, tip[1] - 12 * dy - 5 * dx),
                  (tip[0] - 12 * dx - 5 * dy, tip[1] - 12 * dy + 5 * dx)], fill=color)


def makeVideo(video, times, quaternions, intervals, output):
    width, height, videoWidth, fps = 1120, 720, 405, 15
    fontPath = "/System/Library/Fonts/Supplemental/Arial.ttf"
    font = ImageFont.truetype(fontPath, 22)
    small = ImageFont.truetype(fontPath, 17)
    titleFont = ImageFont.truetype(fontPath, 27)
    angles = [tiltAngles(gravityFromQuaternions(quaternions[name]))
              for name in ("CoreMotion", "Madgwick_0.1")]
    encoder = subprocess.Popen([
        "ffmpeg", "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-an",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(output),
    ], stdin=subprocess.PIPE)
    try:
        for start in CLIP_STARTS:
            decoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-ss", str(start), "-i", str(video),
                "-t", str(CLIP_SECONDS), "-vf", f"fps={fps},scale={videoWidth}:{height}",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
            ], stdout=subprocess.PIPE)
            try:
                for frame in range(CLIP_SECONDS * fps):
                    raw = decoder.stdout.read(videoWidth * height * 3)
                    if len(raw) != videoWidth * height * 3:
                        raise ValueError("Video ended before the requested clip")
                    time = start + frame / fps
                    index, valid = sampleIndices(times, np.array([time]))
                    if not valid[0]:
                        raise ValueError("A clip has no matching IMU sample")
                    sample = index[0]
                    canvas = Image.new("RGB", (width, height), "#f6f8fa")
                    canvas.paste(Image.frombytes("RGB", (videoWidth, height), raw), (0, 0))
                    draw = ImageDraw.Draw(canvas)
                    draw.text((430, 22), f"Video time {time:6.2f} s", fill="#192b38", font=titleFont)
                    label = labelsAt(np.array([time]), intervals)[0]
                    labelText = CLASS_NAMES[label] if label >= 0 else "unknown"
                    draw.text((430, 62), f"Manual label: {labelText}", fill="#192b38", font=font)
                    draw.text((430, 103), "Persistent tilt gauges / beta fixed at 0.1", fill="#52616e", font=small)
                    for method, name in enumerate(("CoreMotion", "Madgwick")):
                        x = 430 + method * 345
                        face, signed = (values[sample] for values in angles[method])
                        draw.text((x, 160), name, fill=COLORS[method], font=titleFont)
                        draw.text((x, 207), "Watch face inclination", fill="#192b38", font=font)
                        drawGauge(draw, (x + 125, 307), face, COLORS[method])
                        draw.text((x + 82, 381), f"{face:.1f} deg", fill=COLORS[method], font=font)
                        draw.text((x, 431), "Signed X tilt", fill="#192b38", font=font)
                        drawGauge(draw, (x + 125, 526), signed, COLORS[method])
                        draw.text((x + 75, 600), f"{signed:+.1f} deg", fill=COLORS[method], font=font)
                    draw.text((430, 649), "Face: 0 up / 90 sideways / 180 down", fill="#52616e", font=small)
                    draw.text((430, 678), "Watch coordinates; manual labels are a separate reference", fill="#52616e", font=small)
                    encoder.stdin.write(canvas.tobytes())
                    if start == CLIP_STARTS[0] and frame == fps * 5:
                        canvas.save(output.with_name("comparison-preview.png"))
            finally:
                decoder.stdout.close()
                if decoder.poll() is None:
                    decoder.terminate()
                decoder.wait()
    finally:
        encoder.stdin.close()
        code = encoder.wait()
    if code:
        raise RuntimeError("Video encoding failed")


def run(args):
    data = pd.read_csv(args.imu)
    sync = json.loads(args.sync.read_text())
    if data.session_id.nunique() != 1 or data.session_id.iloc[0] != sync["session_id"]:
        raise ValueError("IMU and synchronization session IDs differ")
    if not (data.wrist_side == "right").all() or sync["imu_timebase_column"] != "core_motion_elapsed_ms":
        raise ValueError("Expected right wrist with the recorded monotonic timebase")
    if sync["scale"] != 1 or sync["intercept_ms"] != -128:
        raise ValueError("Expected the historical start-only synchronization")
    sensorTimes = data.core_motion_timestamp_s.to_numpy()
    times = (data.core_motion_elapsed_ms.to_numpy() * sync["scale"] + sync["intercept_ms"]) / 1000
    if not np.isfinite(times).all() or np.any(np.diff(times) <= 0):
        raise ValueError("Video times must be finite and increasing")
    clockError = np.max(abs((sensorTimes - sensorTimes[0]) * 1000 - data.core_motion_elapsed_ms))
    if clockError > 1:
        raise ValueError("Monotonic time columns disagree by more than 1 ms")
    vector = lambda prefix: data[[f"{prefix}_{axis}" for axis in "xyz"]].to_numpy()
    original = unitQuaternions(data[[f"quaternion_{axis}" for axis in "xyzw"]].to_numpy())
    recordedGravity = vector("gravity")
    gravityRms = float(np.sqrt(np.mean((gravityFromQuaternions(original) - recordedGravity) ** 2)))
    if not math.isfinite(gravityRms) or gravityRms > 0.01:
        raise ValueError("Recorded quaternion convention does not match recorded gravity")
    quaternions = {"CoreMotion": original}
    for beta in BETAS:
        quaternions[f"Madgwick_{beta}"] = madgwick(
            sensorTimes, vector("gyro"), -(vector("accel") + recordedGravity), original[0], beta,
        )
    intervals = readLabels(args.labels)
    targets = np.arange(0, math.floor(times[-1]) + 1, dtype=float)
    indices, valid = sampleIndices(times, targets)
    labels = labelsAt(targets, intervals, margin=0.5)
    usable = valid & (labels >= 0)
    train = usable & (targets < 299)
    test = usable & (targets >= 301)
    if set(labels[train]) != {0, 1, 2}:
        raise ValueError("Each class must occur in the reference portion")
    result = {
        "session_id": sync["session_id"], "sample_count": len(data), "beta_primary": BETAS[0],
        "beta_sensitivity": list(BETAS[1:]), "gravity_convention_rms": gravityRms,
        "clock_column_difference_max_ms": float(clockError),
        "sample_dt_seconds": {"min": float(np.diff(sensorTimes).min()), "max": float(np.diff(sensorTimes).max())},
        "sync": {key: sync[key] for key in ("method", "scale", "intercept_ms", "end_imu_peaks_ms")},
        "reference_count": int(train.sum()), "evaluation_count": int(test.sum()),
        "reference_class_counts": np.bincount(labels[train], minlength=3).tolist(),
        "evaluation_class_counts": np.bincount(labels[test], minlength=3).tolist(),
        "classes": list(CLASS_NAMES), "methods": {},
        "clips": [{"start_s": start, "duration_s": CLIP_SECONDS} for start in CLIP_STARTS],
        "inputs": {name: {"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                   for name, path in (("imu", args.imu), ("labels", args.labels), ("sync", args.sync))},
    }
    table = {"video_time_s": times, "core_motion_timestamp_s": sensorTimes}
    predictionTable = {"video_time_s": targets[test], "manual_label": labels[test]}
    baselineGravity = gravityFromQuaternions(original)
    for name, attitude in quaternions.items():
        gravity = gravityFromQuaternions(attitude)
        face, signed = tiltAngles(gravity)
        disagreement = np.degrees(np.arccos(np.clip(np.sum(gravity * baselineGravity, axis=1), -1, 1)))
        result["methods"][name] = {"tilt_disagreement_degrees": {
            "median": float(np.median(disagreement)), "p95": float(np.quantile(disagreement, 0.95)),
            "max": float(disagreement.max()),
        }}
        for kind, feature in (("gravity_knn", gravity), ("quaternion_knn", attitude)):
            predicted = classify(feature[indices[train]], feature[indices[test]], labels[train], kind == "quaternion_knn")
            result["methods"][name][kind] = metrics(labels[test], predicted)
            predictionTable[f"{name}_{kind}"] = predicted
        table[f"{name}_face_deg"] = face
        table[f"{name}_signed_x_deg"] = signed
        for axis, column in zip("xyzw", attitude.T):
            table[f"{name}_q{axis}"] = column
        for axis, column in zip("xyz", gravity.T):
            table[f"{name}_gravity_{axis}"] = column
    args.output.mkdir(parents=True, exist_ok=False)
    pd.DataFrame(table).to_csv(args.output / "attitude.csv", index=False)
    pd.DataFrame(predictionTable).to_csv(args.output / "evaluation.csv", index=False)
    pd.DataFrame(intervals, columns=["start_s", "end_s", "label"]).to_csv(args.output / "manual-intervals.csv", index=False)
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    makePlot(times, quaternions, intervals, args.output / "timeline.png")
    makeVideo(args.video, times, quaternions, intervals, args.output / "comparison.mp4")
    print(json.dumps(result, indent=2, allow_nan=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("imu", "labels", "sync", "video", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
