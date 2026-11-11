import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ['client/sidebar.jsx'], bundle: true,
  format: 'cjs', platform: 'browser', external: ['react'], write: false, target: 'es2022' });
await writeFile(new URL('./client.js', import.meta.url),
  `// Built by npm run build:client.\nwindow.__ModuleLoader__.load({id:"dsh-a2a-connector",factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`);
