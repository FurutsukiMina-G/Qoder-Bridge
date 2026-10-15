import { copyFile, lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Copy real user files without following runtime junctions into the installation.
const destination = resolve(process.argv[2] ?? `.runtime/update-backup-${Date.now()}`);
const roots = [
  { id: 'harness-home', path: process.env.DSH_HOME ?? join(homedir(), '.dsh') },
  { id: 'official-desktop', path: join(process.env.APPDATA!, '@deepseek-ai', 'dsh-desktop') },
  { id: 'legacy-desktop', path: join(process.env.APPDATA!, 'dsh-desktop') },
];
type Entry = { root: string; path: string; bytes?: number; sha256?: string; target?: string };
const files: Entry[] = [];
const links: Entry[] = [];
await mkdir(destination, { recursive: false });
async function walk(root: typeof roots[number], relative = ''): Promise<void> {
  const source = join(root.path, relative);
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    links.push({ root: root.id, path: relative, target: await readlink(source) });
  } else if (info.isDirectory()) {
    await mkdir(join(destination, root.id, relative), { recursive: true });
    for (const entry of await readdir(source)) await walk(root, join(relative, entry));
  } else if (info.isFile()) {
    const target = join(destination, root.id, relative);
    const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
    await copyFile(source, target);
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== sha256)
      throw new Error(`Backup checksum mismatch: ${root.id}/${relative}`);
    files.push({ root: root.id, path: relative, bytes: info.size, sha256 });
  }
}
for (const root of roots) {
  try { await lstat(root.path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  await walk(root);
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
  roots, files, links }, null, 2));
console.log(JSON.stringify({ backup: destination, files: files.length,
  bytes: files.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), linksRecorded: links.length,
  sessionFiles: files.filter(entry => entry.root === 'harness-home' && entry.path.startsWith('sessions')).length,
  verified: true }, null, 2));
