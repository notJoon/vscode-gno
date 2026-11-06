import vscode = require('vscode');
import fs = require('fs');
import path = require('path');
import { CommandFactory } from './commands';
import { getGnoConfig } from './config';
import { GnoNetwork, requireSelectedNetwork } from './gnoNetwork';
import { GO_MODE } from './gnoMode';
import { CrossingFunc, crossingFuncs } from './gnoRealmFuncs';
import { runGnokey } from './gnokey';
import { outputChannel } from './gnoStatus';
import { editorRealm } from './gnodev/gnodev';

/** The key name last used to sign, offered again by the next transaction. */
let lastKey = '';
let lastEval = '';

/** Runs gnokey with a progress notification, and shows its output or error. */
async function runWithProgress(title: string, args: string[], cwd?: string, password?: string) {
	outputChannel.show(true);
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
			runGnokey(args, cwd, password)
		);
	} catch (err) {
		vscode.window.showErrorMessage(`${title} failed: ${(err as Error).message}`);
	}
}

/** Returns the realm module path of the active Gno file, or shows an error. */
async function activeRealm(): Promise<{ editor: vscode.TextEditor; module: string } | undefined> {
	const editor = vscode.window.activeTextEditor;
	const module = editor?.document.languageId === 'gno' ? await editorRealm(editor.document.uri) : undefined;
	if (!editor || !module) {
		vscode.window.showErrorMessage('Open a file of a realm, a package whose gnomod.toml module path has /r/.');
		return undefined;
	}
	return { editor, module };
}

/**
 * Asks for the key that signs the transaction and its password, or returns
 * undefined when canceled.
 */
async function askSigner(title: string): Promise<{ key: string; password: string } | undefined> {
	const key = await vscode.window.showInputBox({
		title,
		prompt: 'Key name or address in gnokey that signs the transaction',
		value: lastKey,
		validateInput: (v) => (v.trim() ? null : 'should not be empty')
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

/** Returns the gnokey flags that sign and send a transaction to `network`. */
function txFlags(network: GnoNetwork, uri: vscode.Uri): string[] {
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
		'-insecure-password-stdin'
	];
	if (config?.broadcast ?? true) {
		flags.push('-broadcast');
	}
	return flags;
}

/**
 * Returns the exported crossing functions of the package of `uri`, from the
 * unsaved text of open files and else from disk, with the file declaring each.
 */
async function packageFuncs(uri: vscode.Uri): Promise<(CrossingFunc & { file: string })[]> {
	const dir = path.dirname(uri.fsPath);
	const files = (await fs.promises.readdir(dir))
		.filter((f) => f.endsWith('.gno') && !/_(file)?test\.gno$/.test(f))
		.sort();
	const funcs = await Promise.all(
		files.map(async (file) => {
			const full = path.join(dir, file);
			const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === full);
			const src = open ? open.getText() : await fs.promises.readFile(full, 'utf8');
			return crossingFuncs(src).map((f) => ({ ...f, file }));
		})
	);
	return funcs.flat();
}

/**
 * Calls a crossing function of the realm of the active file with
 * `gnokey maketx call`, asking for its arguments. Without a `func` argument,
 * the function is picked from the files of the package.
 */
export const callRealmFunction: CommandFactory = () => async (args?: { func?: string }) => {
	const realm = await activeRealm();
	if (!realm) {
		return;
	}
	const funcs = await packageFuncs(realm.editor.document.uri);
	let func: CrossingFunc | undefined = funcs.find((f) => f.name === args?.func);
	if (!func) {
		if (!funcs.length) {
			vscode.window.showErrorMessage(
				`${realm.module} has no exported crossing function, func F(cur realm, ...).`
			);
			return;
		}
		func = (
			await vscode.window.showQuickPick(
				funcs.map((f) => ({
					label: f.name,
					description: `(${f.params.map((p) => `${p.name} ${p.type}`).join(', ')}) in ${f.file}`,
					func: f
				})),
				{ placeHolder: `Function of ${realm.module} to call` }
			)
		)?.func;
		if (!func) {
			return;
		}
	}
	const network = requireSelectedNetwork();
	if (!network) {
		return;
	}

	const title = `Call ${realm.module}.${func.name} on ${network.name}`;
	const callArgs: string[] = [];
	for (const p of func.params) {
		const v = await vscode.window.showInputBox({ title, prompt: `${p.name} ${p.type}` });
		if (v === undefined) {
			return;
		}
		callArgs.push('-args', v);
	}
	const send = await vscode.window.showInputBox({
		title,
		prompt: 'Coins to send with the call, such as 1000000ugnot (optional)'
	});
	if (send === undefined) {
		return;
	}
	const signer = await askSigner(title);
	if (!signer) {
		return;
	}

	await runWithProgress(
		title,
		[
			'maketx',
			'call',
			'-pkgpath',
			realm.module,
			'-func',
			func.name,
			...callArgs,
			...(send.trim() ? ['-send', send.trim()] : []),
			...txFlags(network, realm.editor.document.uri),
			signer.key
		],
		path.dirname(realm.editor.document.uri.fsPath),
		signer.password
	);
};

/** Runs the `main` function of the active file with `gnokey maketx run`. */
export const runScript: CommandFactory = () => async () => {
	const doc = vscode.window.activeTextEditor?.document;
	if (doc?.languageId !== 'gno' || doc.uri.scheme !== 'file' || !/^func main\(/m.test(doc.getText())) {
		vscode.window.showErrorMessage('Open a Gno file with func main to run it.');
		return;
	}
	const network = requireSelectedNetwork();
	if (!network) {
		return;
	}
	const file = doc.uri.fsPath;
	const title = `Run ${path.basename(file)} on ${network.name}`;
	const signer = await askSigner(title);
	if (!signer || !(await doc.save())) {
		return;
	}
	await runWithProgress(
		title,
		['maketx', 'run', ...txFlags(network, doc.uri), signer.key, file],
		path.dirname(file),
		signer.password
	);
};

/** Evaluates an expression in the realm of the active file with `vm/qeval`. */
export const evalRealm: CommandFactory = () => async () => {
	const realm = await activeRealm();
	const network = realm && requireSelectedNetwork();
	if (!realm || !network) {
		return;
	}
	const expr = await vscode.window.showInputBox({
		title: `Evaluate in ${realm.module} on ${network.name}`,
		prompt: 'Expression, such as Counter() or Render("")',
		value: lastEval,
		validateInput: (v) => (v.trim() ? null : 'should not be empty')
	});
	if (expr === undefined) {
		return;
	}
	lastEval = expr.trim();
	await runWithProgress(`Evaluate ${realm.module}.${lastEval}`, [
		'query',
		'vm/qeval',
		'-data',
		`${realm.module}.${lastEval}`,
		'-remote',
		network.remote
	]);
};

/** Shows the Render output of the realm of the active file with `vm/qrender`. */
export const queryRender: CommandFactory = () => async () => {
	const realm = await activeRealm();
	const network = realm && requireSelectedNetwork();
	if (!realm || !network) {
		return;
	}
	const renderPath = await vscode.window.showInputBox({
		title: `Query Render of ${realm.module} on ${network.name}`,
		prompt: 'Path passed to Render, empty for the realm home'
	});
	if (renderPath === undefined) {
		return;
	}
	await runWithProgress(`Render ${realm.module}:${renderPath}`, [
		'query',
		'vm/qrender',
		'-data',
		`${realm.module}:${renderPath}`,
		'-remote',
		network.remote
	]);
};

/** Registers the code lens that calls exported crossing functions of realms. */
export function setupCallCodeLens(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.languages.registerCodeLensProvider(GO_MODE, {
			async provideCodeLenses(document) {
				const codeLens = getGnoConfig(document.uri).get<{ call?: boolean }>('enableCodeLens');
				if (codeLens?.call === false || /_(file)?test\.gno$/.test(document.fileName)) {
					return [];
				}
				const funcs = crossingFuncs(document.getText());
				if (!funcs.length || !(await editorRealm(document.uri))) {
					return [];
				}
				return funcs.map(
					(f) =>
						new vscode.CodeLens(document.lineAt(document.positionAt(f.offset).line).range, {
							title: 'call',
							command: 'gno.maketx.call',
							arguments: [{ func: f.name }]
						})
				);
			}
		})
	);
}
