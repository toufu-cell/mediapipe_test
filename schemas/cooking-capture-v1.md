# Cooking capture v1

一回の調理記録は、同じ`sessionId`に属する次の成果物で構成する。

| 成果物 | 形式 | 必須 |
| --- | --- | --- |
| 調理映像 | 音声trackを持たない1920×1080、30 fpsのMOV | 必須 |
| Hand landmarks | `*_hand_landmarks.csv` | 必須 |
| 右手首IMU | `*_right_wrist_imu.csv` | 必須 |
| 同期結果 | `*_sync_metadata.json` | 同期処理後に必須 |
| 校正結果 | `*_calibration.json` | 姿勢・回転表示を使う場合に必須 |
| 品質manifest | `*_quality_manifest.json` | 必須 |

## Hand CSV

各映像frameについてLeftとRightを一行ずつ保存する。
未検出側も行を省略せず、`detected=false`と`missing_reason`を保存する。

先頭の互換列は`timestamp_ms,frame_index,hand_index,handedness,score`とし、その後に21点の`x,y,z`を置く。
末尾へ`detected,missing_reason,raw_handedness,timestamp_source`を置く。
`timestamp_source`は`container_pts`または`frame_index_fps_fallback`である。

## IMU CSV

既存列の順序を維持し、末尾へ次を追加する。

```text
core_motion_timestamp_s,core_motion_elapsed_ms,
gravity_x,gravity_y,gravity_z,
quaternion_x,quaternion_y,quaternion_z,quaternion_w
```

同期の正本は`core_motion_elapsed_ms`とする。
`timestamp_ms`はwall-clock、`elapsed_ms`は予定開始時刻からのwall-clock経過時間として互換用途に残す。
quaternionの順序は`x,y,z,w`、reference frameは`xArbitraryZVertical`である。

## 同期結果

開始直後と終了直前の3回振り、合計6点から次式をfitする。

```text
videoTimeMs = scale * coreMotionElapsedMs + interceptMs
```

自動検出に失敗した場合は、`--manual-video-times-ms`と`--manual-imu-times-ms`へ開始3点、終了3点を順に指定する。
手動補正時は`manual_correction=true`と`auto_sync_failure_reason`を保存し、元のPTSとCoreMotion時刻は変更しない。自動affine同期が成功する収録では手動6点を受け付けない。

## 校正結果

`status=valid`とする場合、次のfieldを必須とする。

```text
baselineQuaternion,watchToWristQuaternion,
cameraToScreenRotationDeg,mirrored,calibrationErrorDeg,
referenceFrame,quaternionConvention
```

quaternionは`x,y,z,w`の単位quaternionとする。

## 品質manifest

`capture_quality_manifest.py`が次のtop-level fieldを生成する。

```text
schemaVersion,sessionId,participantId,trialId,condition,status,
files,video,hand,imu,sync,calibration,vlm,
technicalExclusions,fallbacks,issues
```

`status`は`valid`、`warning`、`invalid`のいずれかである。
未処理の同期、校正、VLMはfield自体を省略せず、`not_processed`と理由を保存する。
映像の実測frame数、推定frame drop、Handとのframe数一致、IMUの実測sample rate、gap、時刻resetも保存する。
数値へ`NaN`や`Infinity`は保存しない。
