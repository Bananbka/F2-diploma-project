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

/**
 * Locate a Playwright-managed Chromium.
 *
 * The executable's location inside a build directory is not stable across Playwright versions —
 * `chrome-win` became `chrome-win64`, and the headless shell is packaged separately under its own
 * `chromium_headless_shell-*` directory with a different binary name. Probing a single hardcoded
 * path meant a machine that *had* a usable browser still reported "cannot start ChromeHeadless",
 * which is precisely the misleading failure this file exists to prevent.
 *
 * Newest build first, so a stale one left behind by an upgrade is not preferred over the current.
 */
function playwrightChromium() {
    const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
    if (!existsSync(root)) {
        return null;
    }

    const layouts = [
        ['chrome-win64', 'chrome.exe'],
        ['chrome-win', 'chrome.exe'],
        ['chrome-linux', 'chrome'],
        ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
        ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ];

    const builds = readdirSync(root)
        .filter((entry) => entry.startsWith('chromium-') || entry.startsWith('chromium_headless_shell-'))
        .sort()
        .reverse();

    for (const build of builds) {
        for (const [dir, binary] of layouts) {
            const candidate = join(root, build, dir, binary);
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

/**
 * Resolution order: an explicit CHROME_BIN, then a Playwright Chromium, then Chrome, then Edge.
 *
 * Playwright's build comes *before* the system browsers because it is the one installed
 * deliberately for testing: it is version-pinned, it does not update underneath a run, and it is
 * the same build CI would use. A system Edge, in particular, has proved unstable headless here —
 * runs disconnected part-way through with no failing assertion, which looks like a broken test
 * suite rather than a browser problem.
 */
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

    return playwrightChromium() ?? candidates.find((path) => existsSync(path)) ?? undefined;
}

const browser = resolveBrowser();
if (browser) {
    process.env.CHROME_BIN = browser;
} else {
    // Say so plainly rather than letting the launcher report a Karma fault. Nothing downstream
    // can tell the difference between "the browser crashed" and "there is no browser".
    console.error(
        '\nNo Chromium-based browser found. Install Chrome or Edge, run `npx playwright install chromium`,\n' +
            'or set CHROME_BIN to an executable.\n'
    );
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
