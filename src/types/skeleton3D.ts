export interface Point3D {
    x: number;
    y: number;
    z: number;
}

export interface BoundingBox3D {
    min: Point3D;
    max: Point3D;
    center: Point3D;
}

export interface Skeleton3DFrame {
    frameIndex: number;
    timestampMs: number;
    bodyLandmarks: Point3D[] | null;
    leftHandLandmarks: Point3D[] | null;
    rightHandLandmarks: Point3D[] | null;
}

export interface FreeMoCap3DData {
    metadata: {
        frameCount: number;
        fps: number;
        durationMs: number;
        hasLeftHand: boolean;
        hasRightHand: boolean;
        boundingBox: BoundingBox3D;
    };
    frames: Skeleton3DFrame[];
}
