import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import { trashIcon } from '../src/ui/trash-icon.js';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const project = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const greasyFork = process.argv.includes('--greasyfork');
const icon = `data:image/svg+xml;base64,${Buffer.from(trashIcon('#969690', 64)).toString('base64')}`;
const header = `// ==UserScript==
// @name         Del-Discord
// @namespace    local.del-discord
// @version      ${project.version}
// @author       Del-Discord contributors
// @icon         ${icon}
// @homepageURL  https://github.com/azhomy/del-discord
// @supportURL   https://github.com/azhomy/del-discord/issues
// @license      MIT
// @description  Personal message deletion, reaction removal, queues, exports, and DM history.
// @match        https://discord.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Local build. No remote updates or hosted dependencies.

`;
const license = await readFile(new URL('LICENSE', root), 'utf8');
await mkdir(new URL('dist/', root), { recursive: true });
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/index.js'],
  outfile: greasyFork ? 'dist/Del-Discord.greasyfork.user.js' : 'dist/Del-Discord-v1.user.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: !greasyFork,
  legalComments: 'none',
  loader: { '.html': 'text', '.css': 'text' },
  plugins: [{
    name: 'compact-styles',
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, async args => ({
        contents: (await transform(await readFile(args.path, 'utf8'), { loader: 'css', minify: !greasyFork })).code,
        loader: 'text',
      }));
    },
  }],
  banner: { js: header + '/*\n' + license + '*/' },
  metafile: true,
  write: false,
});
for (const output of result.outputFiles) await writeFile(output.path, output.contents);
if (!greasyFork) await writeFile(new URL('dist/build-manifest.json', root), JSON.stringify(result.metafile, null, 2) + '\n');
console.log(`Built Del-Discord v${project.version}${greasyFork ? ' for Greasy Fork with readable code' : ' from separate ES modules, HTML, and CSS'}.`);
