import { Fragment } from 'react';
import { Line } from '@react-three/drei';
import { POSE_CONNECTIONS } from '../../utils/poseConnections';
import type { Point3D } from '../../types/skeleton3D';

type Vector3Tuple = [number, number, number];

interface SkeletonBody3DProps {
    landmarks: Point3D[] | null;
}

function toVector(point: Point3D): Vector3Tuple {
    return [point.x, point.y, point.z];
}

export function SkeletonBody3D({ landmarks }: SkeletonBody3DProps) {
    if (!landmarks) {
        return null;
    }

    return (
        <group>
            {POSE_CONNECTIONS.map(([startIndex, endIndex]) => {
                const startPoint = landmarks[startIndex];
                const endPoint = landmarks[endIndex];

                if (!startPoint || !endPoint) {
                    return null;
                }

                return (
                    <Line
                        key={`body-line-${startIndex}-${endIndex}`}
                        points={[toVector(startPoint), toVector(endPoint)]}
                        color="#0D9488"
                        lineWidth={2}
                    />
                );
            })}

            {landmarks.map((point, index) => (
                <Fragment key={`body-point-${index}`}>
                    <mesh position={toVector(point)}>
                        <sphereGeometry args={[18, 16, 16]} />
                        <meshStandardMaterial color="#0D9488" emissive="#0A5F57" />
                    </mesh>
                </Fragment>
            ))}
        </group>
    );
}
