import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createCaptureCommandMiddleware } from './server/capture-command.mjs';

export default defineConfig({
    plugins: [
        react(),
        {
            name: 'capture-command-api',
            configureServer(server) {
                server.middlewares.use(createCaptureCommandMiddleware());
            },
        },
    ],
    server: {
        port: 5173,
        host: '127.0.0.1',
    },
});
