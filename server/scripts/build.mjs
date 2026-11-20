// Bundle the server (and the TS-source shared package) into dist/index.js.
// npm dependencies stay external and are installed in the runtime image.
// SQL migrations are copied next to the bundle with the same folder layout.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@afterhours/'));

rmSync(join(root, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/seed.ts'), join(root, 'src/import-participants.ts')],
  outdir: join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

let copied = 0;
function copySql(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) copySql(p);
    else if (name.endsWith('.sql')) {
      const dest = join(root, 'dist', relative(join(root, 'src'), p));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(p, dest);
      copied++;
    }
  }
}
copySql(join(root, 'src'));
console.log(`copied ${copied} migration file(s) into dist/`);
