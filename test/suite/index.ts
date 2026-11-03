import * as path from 'path';
import { glob } from 'glob';

export async function run(): Promise<void> {
	// mocha is ESM only, so it is loaded with a dynamic import.
	const { default: Mocha } = await import('mocha');
	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = path.resolve(__dirname, '..');
	const files = await glob('**/**.test.js', { cwd: testsRoot });
	files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

	return new Promise((resolve, reject) => {
		mocha.run((failures) => {
			if (failures > 0) {
				reject(new Error(`${failures} tests failed.`));
			} else {
				resolve();
			}
		});
	});
}
