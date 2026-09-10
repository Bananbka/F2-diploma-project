import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// Latin for the UI, Cyrillic because the app is Ukrainian-facing. Greek and Vietnamese are
// dropped: unicode-range means an unused subset is never fetched, but it is still bytes in the
// repo and a face nobody here will render.
const KEEP = new Set(['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext']);

const FAMILIES = [
    { name: 'Inter', spec: 'Inter:wght@400;500;600;700', slug: 'inter' },
    { name: 'JetBrains Mono', spec: 'JetBrains+Mono:wght@400;500;600', slug: 'jetbrains-mono' },
];

mkdirSync('public/fonts', { recursive: true });

const out = [];
let downloaded = 0;

for (const family of FAMILIES) {
    const url = `https://fonts.googleapis.com/css2?family=${family.spec}&display=swap`;
    const css = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();

    // Each @font-face is preceded by a /* subset */ comment.
    const blocks = css.split('/*').slice(1);

    for (const block of blocks) {
        const subset = block.slice(0, block.indexOf('*/')).trim();
        if (!KEEP.has(subset)) continue;

        const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
        const src = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
        const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
        if (!weight || !src) continue;

        const file = `${family.slug}-${weight}-${subset}.woff2`;
        const bytes = Buffer.from(await (await fetch(src, { headers: { 'User-Agent': UA } })).arrayBuffer());
        writeFileSync(join('public/fonts', file), bytes);
        downloaded += 1;

        out.push(
            `@font-face {\n` +
            `    font-family: '${family.name}';\n` +
            `    font-style: normal;\n` +
            `    font-weight: ${weight};\n` +
            `    font-display: swap;\n` +
            `    src: url('/fonts/${file}') format('woff2');\n` +
            `    unicode-range: ${range};\n}`
        );
    }
}

writeFileSync('src/styles/_fonts.scss', out.join('\n\n') + '\n');
console.log(`downloaded ${downloaded} files, ${out.length} @font-face blocks`);
