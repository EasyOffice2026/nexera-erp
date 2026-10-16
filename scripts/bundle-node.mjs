// Bundles a Node service into dist/ with esbuild. Run it from the service's folder:
//   node ../../scripts/bundle-node.mjs src/server.ts
//
// Packages in "dependencies" stay external because they are installed in production.
// Workspace packages (@nexera/*) are listed in "devDependencies", so they are bundled in.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const entry = process.argv[2];
if (!entry) {
  console.error('Usage: bundle-node.mjs <entry file>');
  process.exit(1);
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'));

await build({
  entryPoints: [entry],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: 'info',
});
