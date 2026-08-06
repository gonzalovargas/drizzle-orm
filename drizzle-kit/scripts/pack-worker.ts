import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
	const root = process.cwd();
	const dist = path.join(root, 'dist');
	const staging = path.join(root, '.worker-package');
	const output = path.join(root, 'drizzle-kit-worker.tgz');

	await fs.rm(staging, { force: true, recursive: true });
	await fs.mkdir(staging, { recursive: true });

	const entries = await fs.readdir(dist);
	const files = entries.filter(
		(entry) => entry === 'api-postgres-worker.mjs' || entry.endsWith('.d.mts'),
	);

	await Promise.all([
		...files.map((file) => fs.copyFile(path.join(dist, file), path.join(staging, file))),
		fs.copyFile(
			path.join(root, 'worker-package/package.json'),
			path.join(staging, 'package.json'),
		),
		fs.copyFile(
			path.join(root, 'worker-package/README.md'),
			path.join(staging, 'README.md'),
		),
	]);

	await fs.rm(output, { force: true });
	await execFileAsync('npm', ['pack', '--pack-destination', root], {
		cwd: staging,
	});

	const archive = (await fs.readdir(root)).find(
		(entry) => entry.startsWith('dino-drizzle-kit-worker-') && entry.endsWith('.tgz'),
	);

	if (!archive) throw new Error('Worker package archive was not created');

	await fs.rename(path.join(root, archive), output);
	await fs.rm(staging, { force: true, recursive: true });

	console.log(`Created ${output}`);
}

void main();
