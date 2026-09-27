import json

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from compare_watch_attitude import (
    classify,
    gravityFromQuaternions,
    labelsAt,
    madgwick,
    readLabels,
    sampleIndices,
    tiltAngles,
)


@pytest.mark.parametrize("axis", [0, 1, 2])
@pytest.mark.parametrize("speed", [-0.8, 0.8])
def test_reconstructs_known_signed_rotations(axis, speed):
    times = np.arange(0, 2, 0.005)
    vectors = np.zeros((len(times), 3))
    vectors[:, axis] = times * speed
    truth = Rotation.from_rotvec(vectors)
    gyro = np.zeros((len(times), 3))
    gyro[:, axis] = speed
    force = truth.apply(np.tile([0, 0, 1], (len(times), 1)), inverse=True)
    estimated = madgwick(times, gyro, force, truth[0].as_quat())
    errors = (truth.inv() * Rotation.from_quat(estimated)).magnitude()
    assert np.degrees(errors).max() < 0.8
    assert np.allclose(np.linalg.norm(estimated, axis=1), 1)


def test_stationary_tilt_converges_with_zero_gyro_and_retains_tilt():
    times = np.arange(0, 6, 0.01)
    truth = Rotation.from_euler("xy", [20, -25], degrees=True)
    force = np.tile(truth.apply([0, 0, 1], inverse=True), (len(times), 1))
    estimated = madgwick(times, np.zeros_like(force), force, [0, 0, 0, 1])
    gravity = gravityFromQuaternions(estimated)
    angle = np.degrees(np.arccos(np.clip(gravity @ -force[0], -1, 1)))
    assert angle[0] > 30
    assert angle[-100:].max() < 0.3
    exact = madgwick(times, np.zeros_like(force), force, truth.as_quat())
    assert np.allclose(gravityFromQuaternions(exact), -force, atol=1e-6)
    face, _ = tiltAngles(gravity)
    assert face[-1] > 30


@pytest.mark.parametrize("invalid", ["duplicate", "gap", "nan", "zero_force", "bad_quaternion"])
def test_invalid_recording_inputs_fail(invalid):
    times = np.array([0.0, 0.02, 0.04])
    gyro = np.zeros((3, 3))
    force = np.tile([0.0, 0.0, 1.0], (3, 1))
    quaternion = [0, 0, 0, 1]
    if invalid == "duplicate":
        times[1] = 0
    elif invalid == "gap":
        times[2] = 1
    elif invalid == "nan":
        gyro[1, 0] = np.nan
    elif invalid == "zero_force":
        force[1] = 0
    else:
        quaternion = [0, 0, 0, 0]
    with pytest.raises(ValueError):
        madgwick(times, gyro, force, quaternion)


def test_label_frame_mapping_and_later_interval_ownership(tmp_path):
    path = tmp_path / "labels.json"
    def result(start, end, name):
        return {"type": "timelinelabels", "value": {
            "ranges": [{"start": start, "end": end}], "timelinelabels": [name],
        }}
    path.write_text(json.dumps([{"id": 24, "annotations": [{"id": 23, "result": [
        result(1, 61, "左傾き"), result(61, 121, "右傾き"),
    ]}], "predictions": [{"result": [result(1, 121, "中立")]}]}]))
    spans = readLabels(path)
    assert spans.tolist() == [[0, 2, 0], [2, 4, 2]]
    assert labelsAt([0, 1.9, 2, 3.9, 4], spans).tolist() == [0, 0, 2, 2, -1]
    assert labelsAt([0.5, 1, 1.5, 2, 3], spans, margin=0.5).tolist() == [-1, 0, -1, -1, 2]
    videoTimes = (np.array([0, 20, 40]) - 128) / 1000
    indices, valid = sampleIndices(videoTimes, np.array([-0.128, -0.11, -0.088, 0.2]))
    assert indices.tolist() == [0, 0, 2, 2]
    assert valid.tolist() == [True, True, True, False]


def test_quaternion_signs_preserve_gravity_and_neighbour_predictions():
    reference = Rotation.from_euler("y", np.array([0, 1, 2, 3, 4, 70, 71, 72, 73, 74])[:, None], degrees=True).as_quat()
    labels = np.array([0] * 5 + [2] * 5)
    targets = Rotation.from_euler("y", np.array([[2], [72]]), degrees=True).as_quat()
    signs = np.array([-1, 1] * 5)[:, None]
    assert np.allclose(gravityFromQuaternions(reference), gravityFromQuaternions(reference * signs))
    assert classify(reference, targets, labels, quaternion=True).tolist() == [0, 2]
    assert classify(reference * signs, -targets, labels, quaternion=True).tolist() == [0, 2]
