import numpy as np
import pandas as pd
import pytest
from scipy.spatial.transform import Rotation

from render_watch_attitude_3d import (
    FPS, MARKER_POINTS, METHODS, WATCH_OFFSET, armMesh, markerHistory, project,
    readAttitudes, recentHistory, renderWatch,
)


def test_rendered_face_and_back_follow_full_attitude_and_quaternion_sign():
    color = (240, 30, 120)
    front = np.array(renderWatch([0, 0, 0, 1], color))
    assert np.count_nonzero((front[:, :, 0] > 130) & (front[:, :, 1] < 50)) > 100
    for axis in "xy":
        for degrees, faceVisible in [(90, False), (-90, True), (180, False)]:
            quaternion = Rotation.from_euler(axis, degrees, degrees=True).as_quat()
            rendered = np.array(renderWatch(quaternion, color))
            markerPixels = np.count_nonzero((rendered[:, :, 0] > 130) & (rendered[:, :, 1] < 50))
            assert (markerPixels > 100) if faceVisible else (markerPixels == 0)
    tilted = Rotation.from_euler("xyz", [25, 65, -40], degrees=True).as_quat()
    rendered = np.array(renderWatch(tilted, color))
    assert not np.array_equal(front, rendered)
    assert np.array_equal(rendered, np.array(renderWatch(-tilted, color)))
    assert np.array_equal(rendered, np.array(renderWatch(tilted, color)))


@pytest.mark.parametrize("invalid", ["empty", "reverse", "nan", "gap", "norm"])
def test_bad_attitude_csv_fails_before_rendering(tmp_path, invalid):
    times = np.arange(0, 413, 0.05)
    table = pd.DataFrame({"video_time_s": times})
    for method in METHODS:
        for axis in "xyzw":
            table[f"{method}_q{axis}"] = float(axis == "w")
    if invalid == "empty":
        table = table.iloc[:0]
    elif invalid == "reverse":
        table = table.iloc[::-1]
    elif invalid == "nan":
        table.loc[1, "video_time_s"] = np.nan
    elif invalid == "gap":
        table = table[~table.video_time_s.between(40, 42)]
    else:
        table.loc[1, "CoreMotion_qw"] = 0
    path = tmp_path / "attitude.csv"
    table.to_csv(path, index=False)
    with pytest.raises(ValueError):
        readAttitudes(path)


def test_arm_and_watch_follow_the_same_rotation_about_the_fixed_wrist():
    for degrees in (0, 60, -60):
        rotation = Rotation.from_euler("z", degrees, degrees=True)
        rendered = np.array(renderWatch(rotation.as_quat(), (240, 30, 120)))
        locations = project(rotation.apply([[2.4, 0, 0], [-0.3, -0.43, 0.20] + WATCH_OFFSET]))
        armX, armY = np.rint(locations[0, :2]).astype(int)
        watchX, watchY = np.rint(locations[1, :2]).astype(int)
        arm = rendered[armY, armX].astype(int)
        face = rendered[watchY, watchX].astype(int)
        assert arm[0] > arm[1] > arm[2] and arm[1] > 100
        assert face[0] > 130 and face[1] < 50 and face[2] > 70


def test_right_hand_has_fingers_opposite_crown_and_thumb_on_negative_y():
    vertices = np.concatenate([points for points, _ in armMesh()])
    hand = vertices[vertices[:, 0] < -0.7]
    assert hand[:, 1].min() < -1
    assert hand[:, 1].max() <= 0.7


@pytest.mark.parametrize("axis", [0, 1, 2])
@pytest.mark.parametrize("sign", [-1, 1])
def test_marker_tail_preserves_signed_rotation_and_past_world_positions(axis, sign):
    vectors = np.zeros((2, 3))
    vectors[1, axis] = sign*np.pi/2
    quaternions = Rotation.from_rotvec(vectors).as_quat()
    points = markerHistory(quaternions)
    expected = MARKER_POINTS.copy()
    first, second = (axis+1) % 3, (axis+2) % 3
    expected[:, first] = -sign*MARKER_POINTS[:, second]
    expected[:, second] = sign*MARKER_POINTS[:, first]
    assert np.allclose(points[0], MARKER_POINTS)
    assert np.allclose(points[-1], expected)
    assert np.allclose(markerHistory(-quaternions), points)


def test_tail_uses_only_the_current_clip_and_previous_eight_tenths_of_a_second():
    values = np.arange(400*4).reshape(400, 4)
    assert np.array_equal(recentHistory(values, 180, 180), values[180:181])
    assert np.array_equal(recentHistory(values, 184, 180), values[180:185])
    assert np.array_equal(recentHistory(values, 220, 180), values[220-round(0.8*FPS):221])
