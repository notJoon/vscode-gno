import vscode = require('vscode');
import { CommandFactory } from './commands';
import { requireSelectedNetwork } from './gnoNetwork';
import { diagnosticsStatusBarItem } from './gnoStatus';
import { askSigner, nonEmpty, runGnokey, txFlags } from './gnokey';

// Constants
const GNO_ADD_PKG_COMMAND = 'gno.maketx.addpkg';
const GNOLAND_PREFIX = 'gno.land/';

/**
 * Adds a new package to the Gno blockchain.
 */
export function addPackage(): CommandFactory {
	return () => async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('No editor is active, cannot determine workspace context');
			return;
		}

		diagnosticsStatusBarItem.show();
		diagnosticsStatusBarItem.text = 'Adding package...';

		try {
			await executeAddPackage(editor.document.uri);
			diagnosticsStatusBarItem.hide();
		} catch (err) {
			vscode.window.showErrorMessage(`Add package failed: ${(err as Error).message}`);
			diagnosticsStatusBarItem.text = 'Add Package Failed';
		}
	};
}

/**
 * Asks for the package to add and the key that signs it, and adds it to the
 * selected network.
 *
 * @param uri Document uri, whose configuration sets the transaction flags.
 */
async function executeAddPackage(uri: vscode.Uri): Promise<void> {
	const rootDir = await getWorkspaceRootDir();
	const network = requireSelectedNetwork();
	if (!network) {
		return;
	}

	const title = `Add package to ${network.name} (${network.remote})`;
	const pkgDir = await promptUserInput(title, 'Enter package dir', rootDir, nonEmpty);
	const pkgPath = await promptUserInput(title, 'Enter package name', GNOLAND_PREFIX, (v) =>
		v.length === 0 ? `should start with ${GNOLAND_PREFIX}` : null
	);
	const send = await promptUserInput(
		title,
		'Enter amount to send to the package, such as 1000000ugnot (optional)',
		''
	);
	const signer = await askSigner(title);
	if (!signer) {
		return;
	}

	const args = ['maketx', 'addpkg', '-pkgpath', pkgPath, '-pkgdir', pkgDir];
	if (send) {
		args.push('-send', send);
	}
	args.push(...txFlags(network, uri), signer.key);
	await runGnokey(args, { cwd: rootDir, password: signer.password });
}

/**
 * Gets the workspace root directory.
 */
async function getWorkspaceRootDir(): Promise<string> {
	const wsFolders = vscode.workspace.workspaceFolders;
	if (!wsFolders || wsFolders.length === 0) {
		throw new Error(`${GNO_ADD_PKG_COMMAND}: No workspace folder found`);
	}
	return wsFolders[0].uri.fsPath;
}

/**
 * Prompts the user for input with validation, and throws when canceled.
 */
async function promptUserInput(
	title: string,
	prompt: string,
	defaultValue: string,
	validateInput?: (value: string) => string | null
): Promise<string> {
	const input = await vscode.window.showInputBox({ title, prompt, value: defaultValue, validateInput });
	if (input === undefined) {
		throw new Error(`${GNO_ADD_PKG_COMMAND}: ${prompt} is required`);
	}
	return input;
}
