import { Fragment } from 'react';
import { Line } from '@react-three/drei';
import type { Point3D } from '../../types/skeleton3D';
import { HAND_CONNECTIONS } from '../../utils/handConnections';

type Vector3Tuple = [number, number, number];

interface SkeletonHand3DProps {
    landmarks: Point3D[] | null;
    color: string;
}

function toVector(point: Point3D): Vector3Tuple {
    return [point.x, point.y, point.z];
}

export function SkeletonHand3D({ landmarks, color }: SkeletonHand3DProps) {
    if (!landmarks) {
        return null;
    }

    return (
        <group>
            {HAND_CONNECTIONS.map(([startIndex, endIndex]) => {
                const startPoint = landmarks[startIndex];
                const endPoint = landmarks[endIndex];

                if (!startPoint || !endPoint) {
                    return null;
                }

                return (
                    <Line
                        key={`hand-line-${startIndex}-${endIndex}-${color}`}
                        points={[toVector(startPoint), toVector(endPoint)]}
                        color={color}
                        lineWidth={1.5}
                    />
                );
            })}

            {landmarks.map((point, index) => (
                <Fragment key={`hand-point-${index}-${color}`}>
                    <mesh position={toVector(point)}>
                        <sphereGeometry args={[10, 14, 14]} />
                        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.2} />
                    </mesh>
                </Fragment>
            ))}
        </group>
    );
}
