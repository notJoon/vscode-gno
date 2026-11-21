/**
 * Writes ThirdPartyNotices.txt with the license of every package bundled into
 * dist/gnoMain.js, plus the projects this extension derives from.
 * With --check, fails if the file is out of date instead of writing it.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'ThirdPartyNotices.txt');

const derived = [
	{
		name: 'vscode-go',
		url: 'https://github.com/golang/vscode-go',
		use: 'Most of the extension source, media/welcome.*, the gno.mod grammar and the snippets',
		file: 'third_party/licenses/vscode-go.txt'
	},
	{
		name: 'go-syntax',
		url: 'https://github.com/worlpaker/go-syntax',
		use: 'syntaxes/gno.tmLanguage.json',
		file: 'third_party/licenses/go-syntax.txt'
	}
];

function packageDir(file) {
	for (let dir = path.dirname(file); dir.startsWith(root) && dir !== root; dir = path.dirname(dir)) {
		const manifest = path.join(dir, 'package.json');
		if (fs.existsSync(manifest)) {
			const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
			if (name && version) {
				return dir;
			}
		}
	}
}

async function bundledPackages() {
	const { metafile } = await esbuild.build({
		absWorkingDir: root,
		entryPoints: ['src/gnoMain.ts'],
		bundle: true,
		external: ['vscode'],
		format: 'cjs',
		platform: 'node',
		write: false,
		metafile: true,
		logLevel: 'silent'
	});
	const dirs = new Set();
	for (const input of Object.keys(metafile.inputs)) {
		if (!input.startsWith('src/')) {
			const dir = packageDir(path.join(root, input));
			if (!dir) {
				throw new Error(`no package.json for bundled file ${input}`);
			}
			dirs.add(dir);
		}
	}
	return [...dirs].map((dir) => {
		const { name, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		const licenseFile = fs.readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
		if (!licenseFile) {
			throw new Error(`no license file in ${path.relative(root, dir)}`);
		}
		return { name, license, text: fs.readFileSync(path.join(dir, licenseFile), 'utf8') };
	});
}

async function main() {
	const rule = '-'.repeat(78);
	const sections = derived.map(
		(d) => `${d.name}\n${d.url}\nUsed in: ${d.use}\n\n${fs.readFileSync(path.join(root, d.file), 'utf8').trim()}`
	);
	const packages = (await bundledPackages()).sort((a, b) => a.name.localeCompare(b.name));
	for (const p of packages) {
		sections.push(`${p.name} (${p.license})\n\n${p.text.trim()}`);
	}
	const text =
		'Third-party notices for Gno Tools\n\n' +
		'Gno Tools includes code from the projects and npm packages below. Their\n' +
		'copyright and license notices follow.\n\n' +
		sections.map((s) => `${rule}\n${s}\n`).join('\n');

	if (process.argv.includes('--check')) {
		if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) {
			console.error('ThirdPartyNotices.txt is out of date. Run `npm run notices`.');
			process.exit(1);
		}
		return;
	}
	fs.writeFileSync(out, text);
	console.log(`wrote ${path.relative(root, out)} (${packages.length} packages)`);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
