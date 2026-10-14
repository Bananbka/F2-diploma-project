import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Copies the Twemoji SVG set from `@twemoji/svg` (a devDependency, used only here) into
 * `public/assets/emoji/`, where Angular's asset glob picks it up and nginx's static-asset cache
 * regex serves it with a long-lived immutable cache header — same pattern as `fetch-fonts.mjs`
 * self-hosting Inter/JetBrains Mono, just copied from an installed package instead of fetched
 * over HTTP, because the package already ships exactly the files needed.
 *
 * The whole set is copied, not a curated subset: message text is arbitrary Unicode typed by
 * another user, so any emoji they send has to resolve to a real asset, not just the ~200 in the
 * hand-picked emoji-picker grid. Regenerate by re-running this script after bumping
 * `@twemoji/svg`.
 *
 * Run automatically (`postinstall` / `prebuild` in package.json) so a fresh checkout never ships
 * without this directory — it used to depend on a developer remembering to run it by hand, and
 * `public/assets/emoji/` is untracked, so nobody else's build had it. Skips the actual copy when
 * `public/assets/emoji/` already has the right number of SVGs, since this runs on every
 * `npm install`/`npm run build` and copying ~3700 small files on every one is wasted work; pass
 * `--force` to re-copy anyway (e.g. after bumping `@twemoji/svg`).
 */
const SRC = 'node_modules/@twemoji/svg';
const DEST = 'public/assets/emoji';
const FORCE = process.argv.includes('--force');

const srcSvgCount = readdirSync(SRC).filter((entry) => entry.endsWith('.svg')).length;
const destSvgCount = existsSync(DEST)
    ? readdirSync(DEST).filter((entry) => entry.endsWith('.svg')).length
    : 0;

if (!FORCE && destSvgCount === srcSvgCount && destSvgCount > 0) {
    console.log(`${DEST} already has all ${destSvgCount} emoji SVGs, skipping copy`);
    process.exit(0);
}

mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const entry of readdirSync(SRC)) {
    if (!entry.endsWith('.svg')) {
        continue;
    }
    copyFileSync(join(SRC, entry), join(DEST, entry));
    copied += 1;
}

writeFileSync(
    join(DEST, 'ATTRIBUTION.txt'),
    'Emoji graphics by Twemoji (https://github.com/jdecked/twemoji), licensed CC-BY 4.0 ' +
        '(https://creativecommons.org/licenses/by/4.0/). Copied from the @twemoji/svg npm package ' +
        'and self-hosted under this app\'s own origin.\n'
);

console.log(`copied ${copied} emoji SVGs into ${DEST}`);
