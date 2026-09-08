/**
 * Karma configuration.
 *
 * Exists mainly to find a browser. The default `ChromeHeadless` launcher looks only for Chrome at its
 * standard install path, which fails on machines that have Edge or a Playwright Chromium instead —
 * and the failure reads as "cannot start ChromeHeadless", not as "no browser installed".
 *
 * Resolution order: an explicit CHROME_BIN wins, then Chrome, then Edge, then a Playwright Chromium.
 * All three are Chromium, so the tests behave identically.
 */
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

function playwrightChromium() {
    const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
    if (!existsSync(root)) {
        return null;
    }

    const build = readdirSync(root).find((entry) => entry.startsWith('chromium-'));
    if (!build) {
        return null;
    }

    const candidate = join(root, build, 'chrome-win', 'chrome.exe');
    return existsSync(candidate) ? candidate : null;
}

function resolveBrowser() {
    if (process.env.CHROME_BIN) {
        return process.env.CHROME_BIN;
    }

    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    ];

    return candidates.find((path) => existsSync(path)) ?? playwrightChromium() ?? undefined;
}

const browser = resolveBrowser();
if (browser) {
    process.env.CHROME_BIN = browser;
}

module.exports = function (config) {
    config.set({
        basePath: '',
        frameworks: ['jasmine', '@angular-devkit/build-angular'],
        plugins: [
            require('karma-jasmine'),
            require('karma-chrome-launcher'),
            require('karma-jasmine-html-reporter'),
            require('karma-coverage'),
            require('@angular-devkit/build-angular/plugins/karma'),
        ],
        reporters: ['progress'],
        browsers: ['ChromeHeadlessCI'],
        customLaunchers: {
            ChromeHeadlessCI: {
                base: 'ChromeHeadless',
                // --no-sandbox is needed inside containers; harmless outside one.
                flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
            },
        },
        restartOnFileChange: true,
    });
};
