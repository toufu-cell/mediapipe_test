/**
 * モーション解析の型定義
 */

/** 解析対象の関節名 */
export type JointName =
    | 'leftShoulder'
    | 'rightShoulder'
    | 'leftElbow'
    | 'rightElbow'
    | 'leftWrist'
    | 'rightWrist';

/** 3次元座標 */
export interface Position3D {
    x: number;
    y: number;
    z: number;
}

/** 関節角度定義（3点のランドマークindexで角度を定義） */
export interface JointAngleDefinition {
    name: string;
    /** 点A のランドマークindex */
    pointA: number;
    /** 頂点B のランドマークindex（角度を計算する点） */
    vertex: number;
    /** 点C のランドマークindex */
    pointC: number;
}

/** 角度名 */
export type AngleName = 'leftElbowAngle' | 'rightElbowAngle' | 'leftShoulderAngle' | 'rightShoulderAngle' | 'leftWristAngle' | 'rightWristAngle';

/** 1フレーム分のモーション計算済みデータ */
export interface MotionDataPoint {
    /** タイムスタンプ (ms) */
    timestamp: number;
    /** フレーム番号 */
    frameIndex: number;
    /** 各関節の平滑化済み座標（null=欠損） */
    positions: Record<JointName, Position3D | null>;
    /** 関節角度（度数法、null=欠損） */
    angles: Record<AngleName, number | null>;
    /** 擬似加速度（正規化座標/秒^2、null=欠損または計算不可） */
    accelerations: Record<JointName, Position3D | null>;
    /** 擬似角速度（度/秒、null=欠損または計算不可） */
    angularVelocities: Record<AngleName, number | null>;
}

/** グラフ表示設定 */
export interface MotionGraphSettings {
    /** 表示する時間窓（秒） */
    timeWindow: number;
    /** 表示するメトリクス */
    visibleMetrics: {
        angles: boolean;
        accelerations: boolean;
        angularVelocities: boolean;
    };
    /** 表示する関節 */
    visibleJoints: Record<JointName, boolean>;
    /** 表示する角度 */
    visibleAngles: Record<AngleName, boolean>;
}

/** 入力ソース */
export type InputSource = 'camera' | 'videoFile' | 'skeletonPlayer' | 'skeleton3D';

/** 関節名からランドマークindexへのマッピング */
export const JOINT_LANDMARK_MAP: Record<JointName, number> = {
    leftShoulder: 11,
    rightShoulder: 12,
    leftElbow: 13,
    rightElbow: 14,
    leftWrist: 15,
    rightWrist: 16,
};

/** 関節角度の定義（6つ） */
export const JOINT_ANGLE_DEFINITIONS: Record<AngleName, JointAngleDefinition> = {
    leftElbowAngle: { name: '左肘角度', pointA: 11, vertex: 13, pointC: 15 },
    rightElbowAngle: { name: '右肘角度', pointA: 12, vertex: 14, pointC: 16 },
    leftShoulderAngle: { name: '左肩角度', pointA: 23, vertex: 11, pointC: 13 },
    rightShoulderAngle: { name: '右肩角度', pointA: 24, vertex: 12, pointC: 14 },
    leftWristAngle: { name: '左手首角度', pointA: 13, vertex: 15, pointC: 19 },
    rightWristAngle: { name: '右手首角度', pointA: 14, vertex: 16, pointC: 20 },
};

/** 全関節名の配列 */
export const ALL_JOINT_NAMES: JointName[] = [
    'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
];

/** 全角度名の配列 */
export const ALL_ANGLE_NAMES: AngleName[] = [
    'leftElbowAngle', 'rightElbowAngle', 'leftShoulderAngle', 'rightShoulderAngle',
    'leftWristAngle', 'rightWristAngle',
];

/** バッファ上限（表示用・エクスポート用共通） */
export const MAX_BUFFER_FRAMES = 18000;

/** デフォルトのグラフ設定 */
export const DEFAULT_MOTION_GRAPH_SETTINGS: MotionGraphSettings = {
    timeWindow: 10,
    visibleMetrics: {
        angles: true,
        accelerations: false,
        angularVelocities: false,
    },
    visibleJoints: {
        leftShoulder: true,
        rightShoulder: true,
        leftElbow: true,
        rightElbow: true,
        leftWrist: true,
        rightWrist: true,
    },
    visibleAngles: {
        leftElbowAngle: true,
        rightElbowAngle: true,
        leftShoulderAngle: true,
        rightShoulderAngle: true,
        leftWristAngle: true,
        rightWristAngle: true,
    },
};

/** グラフカラーパレット */
export const JOINT_COLORS: Record<JointName, string> = {
    leftShoulder: '#0D9488',
    rightShoulder: '#10B981',
    leftElbow: '#F59E0B',
    rightElbow: '#EF4444',
    leftWrist: '#8B5CF6',
    rightWrist: '#EC4899',
};

/** 角度カラーパレット */
export const ANGLE_COLORS: Record<AngleName, string> = {
    leftElbowAngle: '#F59E0B',
    rightElbowAngle: '#EF4444',
    leftShoulderAngle: '#0D9488',
    rightShoulderAngle: '#10B981',
    leftWristAngle: '#8B5CF6',
    rightWristAngle: '#EC4899',
};
