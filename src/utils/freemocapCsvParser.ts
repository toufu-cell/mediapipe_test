import type { BoundingBox3D, FreeMoCap3DData, Point3D, Skeleton3DFrame } from '../types/skeleton3D';

const BODY_LANDMARK_COUNT = 33;
const HAND_LANDMARK_COUNT = 21;
const BODY_COLUMN_COUNT = BODY_LANDMARK_COUNT * 3;
const HAND_COLUMN_COUNT = HAND_LANDMARK_COUNT * 3;
const FALLBACK_FPS = 30;

function isFiniteNumber(value: string): boolean {
    return Number.isFinite(Number(value.trim()));
}

function hasHeaderRow(row: string[], expectedColumns: number): boolean {
    return row
        .slice(0, expectedColumns)
        .some(cell => !isFiniteNumber(cell));
}

function normalizeCsvRows(text: string): string[][] {
    return text
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.split(',').map(cell => cell.trim()));
}

function transformCoordinate(rawX: number, rawY: number, rawZ: number): Point3D {
    return {
        x: rawX,
        y: rawZ,
        z: rawY,
    };
}

function parseLandmarkRow(row: string[], landmarkCount: number): Point3D[] | null {
    const points: Point3D[] = [];

    for (let index = 0; index < landmarkCount; index++) {
        const baseIndex = index * 3;
        const rawX = Number(row[baseIndex]);
        const rawY = Number(row[baseIndex + 1]);
        const rawZ = Number(row[baseIndex + 2]);

        if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawZ)) {
            return null;
        }

        points.push(transformCoordinate(rawX, rawY, rawZ));
    }

    return points;
}

function parseCsvFrames(text: string, expectedColumns: number, landmarkCount: number): Point3D[][] | (Point3D[] | null)[] {
    const rows = normalizeCsvRows(text);
    if (rows.length === 0) {
        return [];
    }

    const dataRows = hasHeaderRow(rows[0], expectedColumns)
        ? rows.slice(1)
        : rows;

    const frames: (Point3D[] | null)[] = [];

    for (const row of dataRows) {
        if (row.length < expectedColumns) {
            continue;
        }

        frames.push(parseLandmarkRow(row, landmarkCount));
    }

    return frames;
}

function accumulateBoundingBox(box: BoundingBox3D | null, points: Point3D[]): BoundingBox3D {
    if (box === null) {
        const firstPoint = points[0];
        return {
            min: { ...firstPoint },
            max: { ...firstPoint },
            center: { ...firstPoint },
        };
    }

    const nextBox: BoundingBox3D = {
        min: { ...box.min },
        max: { ...box.max },
        center: { ...box.center },
    };

    for (const point of points) {
        nextBox.min.x = Math.min(nextBox.min.x, point.x);
        nextBox.min.y = Math.min(nextBox.min.y, point.y);
        nextBox.min.z = Math.min(nextBox.min.z, point.z);
        nextBox.max.x = Math.max(nextBox.max.x, point.x);
        nextBox.max.y = Math.max(nextBox.max.y, point.y);
        nextBox.max.z = Math.max(nextBox.max.z, point.z);
    }

    nextBox.center = {
        x: (nextBox.min.x + nextBox.max.x) / 2,
        y: (nextBox.min.y + nextBox.max.y) / 2,
        z: (nextBox.min.z + nextBox.max.z) / 2,
    };

    return nextBox;
}

const FPS_KEYS = ['framerate', 'frameRate', 'fps', 'sampling_rate'];

/**
 * オブジェクトツリーからFPS値を探す。
 * FPS関連キー（framerate, fps 等）を全階層で優先的に探し、
 * 無関係な数値（num_processes 等）を誤って拾わないようにする。
 */
function findFpsValue(value: unknown): number | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    // BFS: まず全階層で FPS_KEYS に該当するキーだけを探す
    const queue: unknown[] = [value];

    while (queue.length > 0) {
        const current = queue.shift();

        if (Array.isArray(current)) {
            for (const item of current) {
                if (item && typeof item === 'object') {
                    queue.push(item);
                }
            }
            continue;
        }

        if (current && typeof current === 'object') {
            const record = current as Record<string, unknown>;

            for (const key of FPS_KEYS) {
                if (key in record) {
                    const raw = record[key];
                    const num = typeof raw === 'string' ? Number(raw) : raw;
                    if (typeof num === 'number' && Number.isFinite(num) && num > 0) {
                        return num;
                    }
                }
            }

            for (const nested of Object.values(record)) {
                if (nested && typeof nested === 'object') {
                    queue.push(nested);
                }
            }
        }
    }

    return null;
}

async function readOptionalJson(file?: File): Promise<unknown | null> {
    if (!file) {
        return null;
    }

    const text = await file.text();
    return JSON.parse(text);
}

function buildBoundingBox(frames: Skeleton3DFrame[]): BoundingBox3D {
    let box: BoundingBox3D | null = null;

    for (const frame of frames) {
        if (frame.bodyLandmarks) {
            box = accumulateBoundingBox(box, frame.bodyLandmarks);
        }
        if (frame.leftHandLandmarks) {
            box = accumulateBoundingBox(box, frame.leftHandLandmarks);
        }
        if (frame.rightHandLandmarks) {
            box = accumulateBoundingBox(box, frame.rightHandLandmarks);
        }
    }

    if (box === null) {
        throw new Error('有効な3D座標が見つかりませんでした。');
    }

    box.center = {
        x: (box.min.x + box.max.x) / 2,
        y: (box.min.y + box.max.y) / 2,
        z: (box.min.z + box.max.z) / 2,
    };

    return box;
}

export async function parseFreeMoCapCsvFiles(
    bodyFile: File,
    leftHandFile?: File,
    rightHandFile?: File,
    paramsFile?: File,
): Promise<FreeMoCap3DData> {
    const [bodyText, leftHandText, rightHandText, paramsJson] = await Promise.all([
        bodyFile.text(),
        leftHandFile?.text() ?? Promise.resolve(null),
        rightHandFile?.text() ?? Promise.resolve(null),
        readOptionalJson(paramsFile),
    ]);

    const bodyFrames = parseCsvFrames(bodyText, BODY_COLUMN_COUNT, BODY_LANDMARK_COUNT);
    if (bodyFrames.length === 0) {
        throw new Error('body CSV に有効なフレームがありません。');
    }

    const leftHandFrames = leftHandText
        ? parseCsvFrames(leftHandText, HAND_COLUMN_COUNT, HAND_LANDMARK_COUNT)
        : [];
    const rightHandFrames = rightHandText
        ? parseCsvFrames(rightHandText, HAND_COLUMN_COUNT, HAND_LANDMARK_COUNT)
        : [];

    const fps = findFpsValue(paramsJson) ?? FALLBACK_FPS;
    const frames: Skeleton3DFrame[] = [];

    for (let frameIndex = 0; frameIndex < bodyFrames.length; frameIndex++) {
        frames.push({
            frameIndex,
            timestampMs: (frameIndex / fps) * 1000,
            bodyLandmarks: bodyFrames[frameIndex] ?? null,
            leftHandLandmarks: frameIndex < leftHandFrames.length ? leftHandFrames[frameIndex] ?? null : null,
            rightHandLandmarks: frameIndex < rightHandFrames.length ? rightHandFrames[frameIndex] ?? null : null,
        });
    }

    const hasValidBodyFrame = frames.some(frame => frame.bodyLandmarks !== null);
    if (!hasValidBodyFrame) {
        throw new Error('body CSV に有効な座標フレームがありません。');
    }

    const boundingBox = buildBoundingBox(frames);
    const durationMs = frames.length > 0 ? frames[frames.length - 1].timestampMs : 0;

    return {
        metadata: {
            frameCount: frames.length,
            fps,
            durationMs,
            hasLeftHand: frames.some(frame => frame.leftHandLandmarks !== null),
            hasRightHand: frames.some(frame => frame.rightHandLandmarks !== null),
            boundingBox,
        },
        frames,
    };
}
