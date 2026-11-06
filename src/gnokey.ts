import cp = require('child_process');
import { toolExecutionEnvironment } from './gnoEnv';
import { gnokeyError } from './gnoRealmFuncs';
import { outputChannel } from './gnoStatus';
import { getBinPath } from './util';

/**
 * Runs gnokey with `args`, writing `password` to its stdin when set, and
 * resolves once it succeeds.
 */
export function runGnokey(args: string[], cwd: string | undefined, password?: string): Promise<void> {
	const gnokey = getBinPath('gnokey');
	outputChannel.appendLine(`$ ${gnokey} ${args.join(' ')}`);
	return new Promise((resolve, reject) => {
		const child = cp.spawn(gnokey, args, { cwd, env: toolExecutionEnvironment() });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.stdin.end(password === undefined ? '' : `${password}\n`);
		child.on('error', (err) => reject(new Error(`gnokey failed: ${err.message}`)));
		child.on('close', (code) => {
			outputChannel.append(stdout + stderr.replace(/^Enter password\.\n?/m, ''));
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(gnokeyError(stderr) ?? `gnokey exited with code ${code}`));
			}
		});
	});
}
