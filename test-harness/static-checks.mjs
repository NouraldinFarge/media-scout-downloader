import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2];
const allFiles = await walk(root);
const sourceFiles = allFiles.filter((file) => /\.(?:css|html|js|json|md|mjs|ya?ml)$/i.test(file));

if (mode === 'format') await checkFormatting(sourceFiles);
else if (mode === 'syntax') await checkSyntax(allFiles.filter((file) => /\.(?:js|mjs)$/i.test(file)));
else if (mode === 'lint') await checkRepository();
else throw new Error('Usage: node test-harness/static-checks.mjs <format|lint|syntax>');

console.log(`Static ${mode} checks passed.`);

async function checkFormatting(files) {
  const failures = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    if (text.includes('\r')) failures.push(`${relative}: contains CRLF/CR line endings`);
    if (text && !text.endsWith('\n')) failures.push(`${relative}: missing final newline`);
    if (/[^\S\r\n]+$/m.test(text)) failures.push(`${relative}: contains trailing whitespace`);
  }
  failIfAny(failures);
}

async function checkSyntax(files) {
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${String(result.stderr || result.stdout).trim()}`);
  }
  failIfAny(failures);
}

async function checkRepository() {
  const failures = [];
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.manifest_version !== 3) failures.push('manifest.json: only Manifest V3 is supported');
  if (manifest.version !== packageJson.version) failures.push('manifest.json and package.json versions differ');
  if (String(manifest.description || '').length > 132) failures.push('manifest.json: description exceeds Chrome\'s 132-character limit');
  for (const forbidden of ['cookies', 'history', 'webRequestBlocking', 'debugger', 'management']) {
    if (manifest.permissions?.includes(forbidden)) failures.push(`manifest.json: forbidden permission ${forbidden}`);
  }
  if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(['http://*/*', 'https://*/*'])) failures.push('manifest.json: host access must stay optional and limited to HTTP(S)');
  if (!/script-src 'self'/.test(manifest.content_security_policy?.extension_pages || '') || /unsafe-eval|https?:/.test(manifest.content_security_policy?.extension_pages || '')) failures.push('manifest.json: extension CSP must stay local-only without unsafe-eval');

  const manifestPaths = [
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);
  for (const relative of manifestPaths) {
    try { await access(path.join(root, relative)); }
    catch (_error) { failures.push(`manifest.json: missing referenced file ${relative}`); }
  }

  for (const required of ['format', 'format:check', 'lint', 'typecheck', 'test', 'build', 'check']) {
    if (!packageJson.scripts?.[required]) failures.push(`package.json: missing ${required} script`);
  }
  if (packageJson.dependencies || packageJson.devDependencies) failures.push('package.json: unexpected third-party runtime or development dependencies');

  const codeFiles = allFiles.filter((file) => /\.(?:js|mjs)$/i.test(file));
  for (const file of codeFiles) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    if (/\beval\s*\(|new\s+Function\s*\(|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(text)) failures.push(`${relative}: dynamic HTML/code execution is not allowed`);
    if (/\.(?:innerHTML|outerHTML)\s*=/.test(text)) failures.push(`${relative}: HTML string assignment is not allowed`);
    if (/(?:from\s*|import\s*\()['"]https?:\/\//.test(text)) failures.push(`${relative}: remote module imports are not allowed`);
    for (const specifier of relativeImports(text)) {
      const target = path.resolve(path.dirname(file), specifier);
      try { await access(target); }
      catch (_error) { failures.push(`${relative}: missing local import ${specifier}`); }
    }
  }

  for (const file of allFiles.filter((item) => item.endsWith('.html'))) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    const ids = [...text.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length) failures.push(`${relative}: duplicate id(s): ${[...new Set(duplicates)].join(', ')}`);
    let labelDepth = 0;
    for (const token of text.matchAll(/<\/?label\b[^>]*>/gi)) {
      if (token[0].startsWith('</')) labelDepth -= 1;
      else {
        if (labelDepth > 0) failures.push(`${relative}: nested label element`);
        labelDepth += 1;
      }
    }
    if (labelDepth !== 0) failures.push(`${relative}: unbalanced label elements`);
    for (const button of text.matchAll(/<button\b([^>]*)>/gi)) {
      if (!/\btype=["'](?:button|submit|reset)["']/i.test(button[1])) failures.push(`${relative}: button without explicit type`);
    }
  }

  try { await access(path.join(root, 'src', 'shared', 'types.js')); failures.push('src/shared/types.js: obsolete unused type sentinel still exists'); }
  catch (_error) {}

  const tokens = await readFile(path.join(root, 'src', 'shared', 'ui', 'tokens.css'), 'utf8');
  const faint = cssColor(tokens, '--text-faint');
  const soft = cssColor(tokens, '--bg-softer');
  if (!faint || !soft || contrastRatio(faint, soft) < 4.5) failures.push('tokens.css: faint text contrast on the soft background is below 4.5:1');
  const textOnAccent = cssColor(tokens, '--text-on-accent');
  const accent = cssColor(tokens, '--accent');
  const accent2 = cssColor(tokens, '--accent-2');
  if (!textOnAccent || !accent || !accent2 || contrastRatio(textOnAccent, accent) < 4.5 || contrastRatio(textOnAccent, accent2) < 4.5) {
    failures.push('tokens.css: primary-button text contrast is below 4.5:1 at a gradient endpoint');
  }
  for (const relative of ['src/popup/popup.css', 'src/sidepanel/sidepanel.css', 'src/options/options.css']) {
    const css = await readFile(path.join(root, relative), 'utf8');
    if (!/\.primary[\s\S]{0,320}?color:\s*var\(--text-on-accent\)/.test(css)) failures.push(`${relative}: primary controls must use the verified accent foreground token`);
  }

  failIfAny(failures);
}

function relativeImports(text) {
  const values = [];
  for (const match of text.matchAll(/(?:from\s*|import\s*\()["'](\.{1,2}\/[^"']+)["']/g)) values.push(match[1]);
  return values;
}

function cssColor(text, variable) {
  const match = new RegExp(`${variable}\\s*:\\s*#([0-9a-f]{6})`, 'i').exec(text);
  return match ? match[1].match(/../g).map((value) => Number.parseInt(value, 16)) : null;
}

function contrastRatio(left, right) {
  const luminance = (rgb) => rgb.map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function failIfAny(failures) {
  if (failures.length) throw new Error(`Static check failures:\n- ${failures.join('\n- ')}`);
}
