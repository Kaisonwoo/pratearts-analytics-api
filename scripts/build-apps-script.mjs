import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

async function sourceFiles(root, extension, folder = 'src') {
  const entries = await readdir(path.join(root, folder), { withFileTypes: true });
  const lists = await Promise.all(entries.map(entry => {
    const relative = path.posix.join(folder, entry.name);
    return entry.isDirectory() ? sourceFiles(root, extension, relative) : [relative];
  }));
  return lists.flat().filter(file => file.endsWith(extension)).sort();
}

export async function buildRuntime(root, revision = 'uncommitted') {
  const files = await sourceFiles(root, '.gs');
  const htmlPaths = await sourceFiles(root, '.html');
  if (!files.length) throw new Error('Nenhum módulo Apps Script encontrado.');
  const chunks = await Promise.all(files.map(async file => ({
    file,
    content: await readFile(path.join(root, file), 'utf8')
  })));
  const htmlFiles = await Promise.all(htmlPaths.map(async file => ({
    file,
    name: path.basename(file),
    content: await readFile(path.join(root, file), 'utf8')
  })));
  const duplicateHtmlNames = htmlFiles.filter((item, index) =>
    htmlFiles.findIndex(candidate => candidate.name === item.name) !== index);
  if (duplicateHtmlNames.length) {
    throw new Error('Arquivos HTML precisam de nomes únicos no Apps Script.');
  }
  const manifest = await readFile(path.join(root, 'src/appsscript.json'), 'utf8');
  JSON.parse(manifest);
  const sourceHash = createHash('sha256')
    .update(JSON.stringify([chunks, htmlFiles, manifest]))
    .digest('hex');
  const metadata = 'var PRA_RUNTIME_METADATA = Object.freeze(' +
    JSON.stringify({ revision, sourceHash }) + ');\n';
  const code = `// Pratearts Analytics API | revision: ${revision}\n// Source SHA-256: ${sourceHash}\n` +
    metadata + chunks.map(({ file, content }) =>
      `\n// BEGIN ${file}\n${content}\n// END ${file}\n`).join('');
  new vm.Script(code, { filename: 'Runtime.gs' });
  return { code, manifest, files, htmlFiles, sourceHash, revision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const output = process.argv[2];
  if (!output) throw new Error('Uso: node scripts/build-apps-script.mjs <pasta-de-saida>');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], {
    cwd: root,
    encoding: 'utf8'
  }).trim();
  const result = await buildRuntime(root, sha + (dirty ? '+dirty' : ''));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'Runtime.gs'), result.code);
  await writeFile(path.join(output, 'appsscript.json'), result.manifest);
  await Promise.all(result.htmlFiles.map(file =>
    writeFile(path.join(output, file.name), file.content)));
  console.log(JSON.stringify({
    revision: result.revision,
    modules: result.files.length,
    htmlFiles: result.htmlFiles.length,
    sourceHash: result.sourceHash
  }));
}
