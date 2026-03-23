import type { MotionGraphSettings, JointName, AngleName } from '../../types/motion';
import { ALL_JOINT_NAMES, ALL_ANGLE_NAMES, JOINT_COLORS, ANGLE_COLORS } from '../../types/motion';

interface MotionGraphControlsProps {
    settings: MotionGraphSettings;
    onChange: (settings: MotionGraphSettings) => void;
}

/** 関節名の日本語ラベル */
const JOINT_LABELS: Record<JointName, string> = {
    leftShoulder: '左肩',
    rightShoulder: '右肩',
    leftElbow: '左肘',
    rightElbow: '右肘',
    leftWrist: '左手首',
    rightWrist: '右手首',
};

/** 角度名の日本語ラベル */
const ANGLE_LABELS: Record<AngleName, string> = {
    leftElbowAngle: '左肘角度',
    rightElbowAngle: '右肘角度',
    leftShoulderAngle: '左肩角度',
    rightShoulderAngle: '右肩角度',
    leftWristAngle: '左手首角度',
    rightWristAngle: '右手首角度',
};

export function MotionGraphControls({ settings, onChange }: MotionGraphControlsProps) {
    const toggleMetric = (key: keyof MotionGraphSettings['visibleMetrics']) => {
        onChange({
            ...settings,
            visibleMetrics: {
                ...settings.visibleMetrics,
                [key]: !settings.visibleMetrics[key],
            },
        });
    };

    const toggleJoint = (joint: JointName) => {
        onChange({
            ...settings,
            visibleJoints: {
                ...settings.visibleJoints,
                [joint]: !settings.visibleJoints[joint],
            },
        });
    };

    const toggleAngle = (angle: AngleName) => {
        onChange({
            ...settings,
            visibleAngles: {
                ...settings.visibleAngles,
                [angle]: !settings.visibleAngles[angle],
            },
        });
    };

    return (
        <div className="motion-graph-controls">
            <div className="control-group">
                <h4>メトリクス</h4>
                <div className="toggle-row">
                    <label className="toggle-label">
                        <input
                            type="checkbox"
                            checked={settings.visibleMetrics.angles}
                            onChange={() => toggleMetric('angles')}
                        />
                        関節角度
                    </label>
                    <label className="toggle-label">
                        <input
                            type="checkbox"
                            checked={settings.visibleMetrics.accelerations}
                            onChange={() => toggleMetric('accelerations')}
                        />
                        擬似加速度
                    </label>
                    <label className="toggle-label">
                        <input
                            type="checkbox"
                            checked={settings.visibleMetrics.angularVelocities}
                            onChange={() => toggleMetric('angularVelocities')}
                        />
                        擬似角速度
                    </label>
                </div>
            </div>

            <div className="control-group">
                <h4>関節 (加速度)</h4>
                <div className="toggle-row">
                    {ALL_JOINT_NAMES.map((joint) => (
                        <label key={joint} className="toggle-label">
                            <input
                                type="checkbox"
                                checked={settings.visibleJoints[joint]}
                                onChange={() => toggleJoint(joint)}
                            />
                            <span
                                className="color-dot"
                                style={{ backgroundColor: JOINT_COLORS[joint] }}
                            />
                            {JOINT_LABELS[joint]}
                        </label>
                    ))}
                </div>
            </div>

            <div className="control-group">
                <h4>角度</h4>
                <div className="toggle-row">
                    {ALL_ANGLE_NAMES.map((angle) => (
                        <label key={angle} className="toggle-label">
                            <input
                                type="checkbox"
                                checked={settings.visibleAngles[angle]}
                                onChange={() => toggleAngle(angle)}
                            />
                            <span
                                className="color-dot"
                                style={{ backgroundColor: ANGLE_COLORS[angle] }}
                            />
                            {ANGLE_LABELS[angle]}
                        </label>
                    ))}
                </div>
            </div>

            <div className="control-group">
                <h4>時間窓</h4>
                <div className="slider-row">
                    <input
                        type="range"
                        min={3}
                        max={30}
                        step={1}
                        value={settings.timeWindow}
                        onChange={(e) => onChange({
                            ...settings,
                            timeWindow: Number(e.target.value),
                        })}
                    />
                    <span>{settings.timeWindow}秒</span>
                </div>
            </div>
        </div>
    );
}
