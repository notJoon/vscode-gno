import vscode = require('vscode');
import cp = require('child_process');
import { getGnoConfig } from './config';
import { toolExecutionEnvironment } from './gnoEnv';
import { GnoNetwork } from './gnoNetwork';
import { gnokeyError } from './gnoRealmFuncs';
import { outputChannel } from './gnoStatus';
import { getBinPath } from './util';

/** The key name last used to sign, offered again by the next transaction. */
let lastKey = '';

/**
 * Runs gnokey with `args`, writing `password` to its stdin when set, and
 * resolves once it succeeds.
 */
export function runGnokey(args: string[], opts: { cwd?: string; password?: string } = {}): Promise<void> {
	const gnokey = getBinPath('gnokey');
	outputChannel.appendLine(`$ ${gnokey} ${args.join(' ')}`);
	return new Promise((resolve, reject) => {
		const child = cp.spawn(gnokey, args, { cwd: opts.cwd, env: toolExecutionEnvironment() });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		// gnokey can exit before reading stdin, such as on a bad flag.
		child.stdin.on('error', () => undefined);
		child.stdin.end(opts.password === undefined ? '' : `${opts.password}\n`);
		child.on('error', (err) => reject(new Error(`gnokey failed: ${err.message}`)));
		child.on('close', (code) => {
			outputChannel.append(stdout + stderr);
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(gnokeyError(stderr) ?? `gnokey exited with code ${code}`));
			}
		});
	});
}

/**
 * Returns the gnokey flags that sign and send a transaction to `network`,
 * taking the password from stdin without prompting for it.
 */
export function txFlags(network: GnoNetwork, uri: vscode.Uri): string[] {
	const config = getGnoConfig(uri).get<{ broadcast?: boolean; gasFee?: string; gasWanted?: string }>('makeTx');
	const flags = [
		'-gas-fee',
		config?.gasFee ?? '1000000ugnot',
		'-gas-wanted',
		config?.gasWanted ?? '2000000',
		'-remote',
		network.remote,
		'-chainid',
		network.chainId,
		'-insecure-password-stdin',
		'-quiet'
	];
	if (config?.broadcast ?? true) {
		flags.push('-broadcast');
	}
	return flags;
}

/**
 * Asks for the key that signs the transaction and its password, or returns
 * undefined when canceled.
 */
export async function askSigner(title: string): Promise<{ key: string; password: string } | undefined> {
	const key = await vscode.window.showInputBox({
		title,
		prompt: 'Key name or address in gnokey that signs the transaction',
		value: lastKey,
		validateInput: nonEmpty
	});
	if (key === undefined) {
		return undefined;
	}
	const password = await vscode.window.showInputBox({ title, prompt: `Password of ${key}`, password: true });
	if (password === undefined) {
		return undefined;
	}
	lastKey = key.trim();
	return { key: lastKey, password };
}

/** Input box validation that rejects an empty value. */
export function nonEmpty(value: string): string | null {
	return value.trim() ? null : 'should not be empty';
}
