import net from 'node:net';

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 8192;
const MAX_REQUEST_BYTES = 16 * 1024;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateHost(host) {
    if (typeof host !== 'string' || host.trim() === '') {
        throw new Error('host is required');
    }

    const trimmed = host.trim();
    if (trimmed.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(trimmed)) {
        throw new Error('host must be an IP address or hostname');
    }

    return trimmed;
}

function validatePort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('port must be an integer from 1 to 65535');
    }
    return port;
}

function validateCommand(command) {
    if (!isPlainObject(command)) {
        throw new Error('command must be an object');
    }

    if (command.type !== 'start' && command.type !== 'stop') {
        throw new Error('command.type must be start or stop');
    }

    return command;
}

function validateToken(token) {
    if (typeof token !== 'string') {
        throw new Error('pairing token is required');
    }

    const trimmed = token.trim();
    if (trimmed.length < 16 || trimmed.length > 256) {
        throw new Error('pairing token must be 16 to 256 characters');
    }
    return trimmed;
}

function parseResponseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        throw new Error('iPhone response is not valid JSON');
    }
}

export function sendCaptureCommand({
    host,
    port = DEFAULT_PORT,
    token,
    command,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
    const targetHost = validateHost(host);
    const targetPort = validatePort(port);
    const validatedToken = validateToken(token);
    const validatedCommand = validateCommand(command);

    return new Promise((resolve, reject) => {
        let settled = false;
        let responseBuffer = '';
        let responseBytes = 0;

        const settle = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            callback(value);
        };

        const socket = net.createConnection({ host: targetHost, port: targetPort }, () => {
            socket.write(`${JSON.stringify({
                token: validatedToken,
                command: validatedCommand,
            })}\n`);
        });

        socket.setTimeout(timeoutMs, () => {
            settle(reject, new Error('Timed out waiting for iPhone recorder'));
        });

        socket.on('data', chunk => {
            responseBytes += chunk.byteLength;
            if (responseBytes > maxResponseBytes) {
                settle(reject, new Error('iPhone response is too large'));
                return;
            }

            responseBuffer += chunk.toString('utf8');
            const newlineIndex = responseBuffer.indexOf('\n');
            if (newlineIndex >= 0) {
                try {
                    settle(resolve, parseResponseLine(responseBuffer.slice(0, newlineIndex)));
                } catch (error) {
                    settle(reject, error);
                }
            }
        });

        socket.on('end', () => {
            try {
                settle(resolve, parseResponseLine(responseBuffer) ?? { ok: true });
            } catch (error) {
                settle(reject, error);
            }
        });

        socket.on('error', error => {
            settle(reject, error);
        });
    });
}

function readRequestBody(req, maxBytes = MAX_REQUEST_BYTES) {
    return new Promise((resolve, reject) => {
        let body = '';
        let bytes = 0;

        req.on('data', chunk => {
            bytes += chunk.byteLength;
            if (bytes > maxBytes) {
                reject(new Error('Request body is too large'));
                req.destroy();
                return;
            }
            body += chunk.toString('utf8');
        });

        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function writeJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
}

export function isSameOriginRequest(req) {
    const origin = req.headers.origin;
    if (!origin) {
        return false;
    }

    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

export function createCaptureCommandMiddleware() {
    return async function captureCommandMiddleware(req, res, next) {
        const url = req.url ? new URL(req.url, 'http://localhost') : null;
        if (!url || url.pathname !== '/api/capture-command') {
            next();
            return;
        }

        if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'Method not allowed' });
            return;
        }

        if (!isSameOriginRequest(req)) {
            writeJson(res, 403, { ok: false, error: 'Origin is not allowed' });
            return;
        }

        try {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || '{}');
            const host = validateHost(payload.host);
            const port = validatePort(payload.port ?? DEFAULT_PORT);
            const token = validateToken(payload.token);
            const command = validateCommand(payload.command);

            if (port !== DEFAULT_PORT) {
                writeJson(res, 400, { ok: false, error: 'port must be 8765 for iPhone recorder commands' });
                return;
            }

            const response = await sendCaptureCommand({ host, port, token, command });
            writeJson(res, 200, { ok: true, response, host, port });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Capture command failed';
            const statusCode = message.includes('Timed out') ? 504 : 400;
            writeJson(res, statusCode, { ok: false, error: message });
        }
    };
}
