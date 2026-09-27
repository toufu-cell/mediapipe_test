# Pancake comparison pilot

The two sessions below are prepared for exploratory use in the local comparison UI.

| Recording | Video | Hand CSV | Synced Watch CSV | Process interval |
| --- | --- | --- | --- | --- |
| A | `capture_20260825_061146_998_998/processed/capture_20260825_061146_998_998_comparison.mp4` | `capture_20260825_061146_998_998/processed/capture_20260825_061146_998_998_hand_landmarks.csv` | `capture_20260825_061146_998_998/processed/sync/capture_20260825_061146_998_998_synced_pose_imu.csv` | 6.0–498.0 s |
| B | `capture_20260823_230422_647_647/processed/capture_20260823_230422_647_647_comparison.mp4` | `capture_20260823_230422_647_647/processed/capture_20260823_230422_647_647_hand_landmarks.csv` | `capture_20260823_230422_647_647/processed/sync/capture_20260823_230422_647_647_synced_pose_imu.csv` | 6.0–446.0 s |

## Synchronization warning

Neither recording contains three detectable shake peaks near the end. The synced CSVs therefore use the start-only `three_shake_peak` offset and do not estimate clock drift. They are suitable for checking the comparison UI, but they do not meet the start-and-end affine synchronization requirement for formal research data.

Before formal evaluation, record replacement sessions with three clear shakes at both the start and end, or establish independently verified manual end points.
