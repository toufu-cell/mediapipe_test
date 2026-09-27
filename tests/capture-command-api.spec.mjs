import net from 'node:net';
import { expect, test } from '@playwright/test';

import {
    isSameOriginRequest,
    sendCaptureCommand,
} from '../server/capture-command.mjs';

const TEST_TOKEN = 'ABCD2345';

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

test('sendCaptureCommand sends one authenticated JSON line to the iPhone server', async () => {
    const receivedLines = [];
    const server = net.createServer(socket => {
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
                receivedLines.push(buffer.slice(0, newlineIndex));
                socket.end('{"ok":true}\n');
            }
        });
    });

    await listen(server);
    const address = server.address();
    expect(typeof address).toBe('object');

    try {
        const command = {
            type: 'start',
            sessionId: 'capture_test',
            startAt: '2026-05-25T01:30:00.000+09:00',
            expectedDurationSec: 180,
            syncGesture: 'wrist_shake_3_times',
            video: { device: 'iphone', filename: 'capture_test.mov' },
            watch: { device: 'apple_watch', sampleRateHz: 50, filename: 'capture_test_wrist_imu.csv' },
        };
        const response = await sendCaptureCommand({
            host: '127.0.0.1',
            port: address.port,
            token: TEST_TOKEN,
            command,
            timeoutMs: 1000,
        });

        expect(JSON.parse(receivedLines[0])).toEqual({ token: TEST_TOKEN, command });
        expect(response).toEqual({ ok: true });
    } finally {
        await close(server);
    }
});

test('sendCaptureCommand rejects an iPhone unauthorized response', async () => {
    const server = net.createServer(socket => {
        socket.on('data', () => socket.end('{"ok":false,"error":"unauthorized"}\n'));
    });
    await listen(server);
    const address = server.address();
    expect(typeof address).toBe('object');

    try {
        try {
            await sendCaptureCommand({
                host: '127.0.0.1',
                port: address.port,
                token: TEST_TOKEN,
                command: {
                    type: 'stop',
                    sessionId: 'capture_test',
                    stopAt: '2026-05-25T01:31:00.000+09:00',
                },
                timeoutMs: 1000,
            });
            throw new Error('Expected the iPhone rejection to fail');
        } catch (error) {
            expect(error).toMatchObject({
                message: 'iPhone recorder rejected command: unauthorized',
                code: 'iphone_command_rejected',
            });
        }
    } finally {
        await close(server);
    }
});

test('sendCaptureCommand rejects invalid input and non-JSON responses', async () => {
    expect(() => sendCaptureCommand({
        host: '127.0.0.1',
        port: 8765,
        token: TEST_TOKEN,
        command: { type: 'delete' },
        timeoutMs: 100,
    })).toThrow('command.type must be start, stop, or watch-live');

    expect(() => sendCaptureCommand({
        host: '127.0.0.1',
        port: 8765,
        token: '',
        command: {
            type: 'stop',
            sessionId: 'capture_test',
            stopAt: '2026-05-25T01:31:00.000+09:00',
        },
        timeoutMs: 100,
    })).toThrow('pairing code must be 8 to 256 characters');

    const server = net.createServer(socket => {
        socket.on('data', () => socket.end('not-json\n'));
    });
    await listen(server);
    const address = server.address();
    expect(typeof address).toBe('object');
    try {
        await expect(sendCaptureCommand({
            host: '127.0.0.1',
            port: address.port,
            token: TEST_TOKEN,
            command: {
                type: 'stop',
                sessionId: 'capture_test',
                stopAt: '2026-05-25T01:31:00.000+09:00',
            },
            timeoutMs: 1000,
        })).rejects.toThrow('iPhone response is not valid JSON');
    } finally {
        await close(server);
    }
});

test('capture middleware rejects requests without an Origin header', () => {
    expect(isSameOriginRequest({ headers: { host: '127.0.0.1:5173' } })).toBe(false);
    expect(isSameOriginRequest({
        headers: {
            host: '127.0.0.1:5173',
            origin: 'http://127.0.0.1:5173',
        },
    })).toBe(true);
});

test('watch-live forwards authentication and returns sensor data across TCP chunks', async () => {
    const received = [];
    const response = { ok: true, live: { sample: { sequence: 7, gyro: [-1, 2, 3] }, ageMs: 12 } };
    const server = net.createServer(socket => {
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (!buffer.includes('\n')) return;
            received.push(JSON.parse(buffer.split('\n')[0]));
            const encoded = JSON.stringify(response);
            socket.write(encoded.slice(0, 12));
            socket.end(`${encoded.slice(12)}\n`);
        });
    });
    await listen(server);
    try {
        expect(await sendCaptureCommand({
            host: '127.0.0.1', port: server.address().port, token: TEST_TOKEN,
            command: { type: 'watch-live' }, timeoutMs: 1000,
        })).toEqual(response);
        expect(received).toEqual([{ token: TEST_TOKEN, command: { type: 'watch-live' } }]);
    } finally {
        await close(server);
    }
});

test('watch-live HTTP requests enforce same-origin and fixed port before opening a socket', async ({ request }) => {
    const payload = { host: '127.0.0.1', token: TEST_TOKEN, command: { type: 'watch-live' } };
    const forbidden = await request.post('/api/capture-command', {
        headers: { Origin: 'https://unrelated.invalid' }, data: payload,
    });
    expect(forbidden.status()).toBe(403);
    const badPort = await request.post('/api/capture-command', {
        headers: { Origin: 'http://127.0.0.1:5174' }, data: { ...payload, port: 8766 },
    });
    expect(badPort.status()).toBe(400);
    expect((await badPort.json()).error).toContain('port must be 8765');
});
