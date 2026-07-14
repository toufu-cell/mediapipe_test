import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30_000,
    expect: {
        timeout: 5_000,
    },
    use: {
        baseURL: 'http://127.0.0.1:5174',
        trace: 'on-first-retry',
    },
    webServer: {
        command: './node_modules/.bin/vite --host 127.0.0.1 --port 5174',
        url: 'http://127.0.0.1:5174',
        reuseExistingServer: false,
        timeout: 120_000,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
