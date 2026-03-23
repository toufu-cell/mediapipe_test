import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Color } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { BoundingBox3D, Point3D } from '../../types/skeleton3D';
import { SkeletonBody3D } from './SkeletonBody3D';
import { SkeletonHand3D } from './SkeletonHand3D';

interface SkeletonPlayer3DCanvasProps {
    bodyLandmarks: Point3D[] | null;
    leftHandLandmarks: Point3D[] | null;
    rightHandLandmarks: Point3D[] | null;
    boundingBox: BoundingBox3D;
    showLeftHand: boolean;
    showRightHand: boolean;
}

function getCameraDistance(boundingBox: BoundingBox3D): number {
    const width = boundingBox.max.x - boundingBox.min.x;
    const height = boundingBox.max.y - boundingBox.min.y;
    const depth = boundingBox.max.z - boundingBox.min.z;
    const diagonal = Math.sqrt((width ** 2) + (height ** 2) + (depth ** 2));

    return Math.max(diagonal * 1.5, 1000);
}

function CameraReset({
    boundingBox,
    controlsRef,
}: {
    boundingBox: BoundingBox3D;
    controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
    const { camera } = useThree();

    useEffect(() => {
        const center = boundingBox.center;
        const distance = getCameraDistance(boundingBox);

        camera.position.set(
            center.x + distance,
            center.y + (distance * 0.6),
            center.z + distance,
        );
        camera.near = 1;
        camera.far = 10000;
        camera.updateProjectionMatrix();

        if (controlsRef.current) {
            controlsRef.current.target.set(center.x, center.y, center.z);
            controlsRef.current.update();
        } else {
            camera.lookAt(center.x, center.y, center.z);
        }
    }, [boundingBox, camera, controlsRef]);

    return null;
}

export function SkeletonPlayer3DCanvas({
    bodyLandmarks,
    leftHandLandmarks,
    rightHandLandmarks,
    boundingBox,
    showLeftHand,
    showRightHand,
}: SkeletonPlayer3DCanvasProps) {
    const controlsRef = useRef<OrbitControlsImpl | null>(null);

    const gridConfig = useMemo(() => {
        const distance = getCameraDistance(boundingBox);
        const size = Math.max(Math.ceil(distance / 500) * 500, 1000);
        const divisions = Math.max(Math.round(size / 100), 10);

        return {
            size,
            divisions,
            y: boundingBox.min.y - 50,
        };
    }, [boundingBox]);

    return (
        <div className="skeleton-player-3d-canvas-shell">
            <Canvas
                className="skeleton-player-3d-canvas"
                camera={{ near: 1, far: 10000, position: [0, 1000, 2000] }}
                onCreated={({ scene }) => {
                    scene.background = new Color('#081019');
                }}
            >
                <ambientLight intensity={0.8} />
                <directionalLight position={[800, 1400, 900]} intensity={1.2} color="#e6fffb" />
                <directionalLight position={[-800, 900, -900]} intensity={0.35} color="#dbeafe" />

                <gridHelper
                    args={[gridConfig.size, gridConfig.divisions, '#0D9488', '#1E293B']}
                    position={[boundingBox.center.x, gridConfig.y, boundingBox.center.z]}
                />

                <SkeletonBody3D landmarks={bodyLandmarks} />
                {showLeftHand && (
                    <SkeletonHand3D landmarks={leftHandLandmarks} color="#FF6B6B" />
                )}
                {showRightHand && (
                    <SkeletonHand3D landmarks={rightHandLandmarks} color="#4ECDC4" />
                )}

                <OrbitControls
                    ref={controlsRef}
                    enableDamping
                    dampingFactor={0.08}
                    makeDefault
                />
                <CameraReset boundingBox={boundingBox} controlsRef={controlsRef} />
            </Canvas>
        </div>
    );
}
