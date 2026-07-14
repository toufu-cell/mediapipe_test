import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import {
    isSameOriginRequest,
    sendCaptureCommand,
} from '../server/capture-command.mjs';

const TEST_TOKEN = 'capture-test-token-1234';

test('sendCaptureCommand sends one newline-delimited JSON command to the iPhone TCP server', async () => {
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

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');

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

        assert.deepEqual(JSON.parse(receivedLines[0]), {
            token: TEST_TOKEN,
            command,
        });
        assert.deepEqual(response, { ok: true });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('sendCaptureCommand rejects invalid command types before opening TCP', async () => {
    await assert.rejects(
        () => sendCaptureCommand({
            host: '127.0.0.1',
            port: 8765,
            token: TEST_TOKEN,
            command: { type: 'delete' },
            timeoutMs: 100,
        }),
        /command.type must be start or stop/
    );
});

test('sendCaptureCommand rejects non-JSON iPhone responses', async () => {
    const server = net.createServer(socket => {
        socket.on('data', () => {
            socket.end('not-json\n');
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');

    try {
        await assert.rejects(
            () => sendCaptureCommand({
                host: '127.0.0.1',
                port: address.port,
                token: TEST_TOKEN,
                command: {
                    type: 'stop',
                    sessionId: 'capture_test',
                    stopAt: '2026-05-25T01:31:00.000+09:00',
                },
                timeoutMs: 1000,
            }),
            /iPhone response is not valid JSON/
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('sendCaptureCommand rejects a missing pairing token before opening TCP', async () => {
    await assert.rejects(
        () => sendCaptureCommand({
            host: '127.0.0.1',
            port: 8765,
            token: '',
            command: {
                type: 'stop',
                sessionId: 'capture_test',
                stopAt: '2026-05-25T01:31:00.000+09:00',
            },
            timeoutMs: 100,
        }),
        /pairing token must be 16 to 256 characters/
    );
});

test('capture middleware rejects requests without an Origin header', () => {
    assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:5173' } }), false);
    assert.equal(isSameOriginRequest({
        headers: {
            host: '127.0.0.1:5173',
            origin: 'http://127.0.0.1:5173',
        },
    }), true);
});
