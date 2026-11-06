import vscode = require('vscode');
import fs = require('fs');
import path = require('path');
import { CommandFactory } from './commands';
import { getGnoConfig } from './config';
import { requireSelectedNetwork } from './gnoNetwork';
import { GO_MODE } from './gnoMode';
import { CrossingFunc, crossingFuncs, isGnoTestFile } from './gnoRealmFuncs';
import { askSigner, nonEmpty, runGnokey, txFlags } from './gnokey';
import { outputChannel } from './gnoStatus';
import { editorRealm, gnoEditorUri } from './gnodev/gnodev';

let lastEval = '';

/** Runs gnokey with a progress notification, and shows its output or error. */
async function runWithProgress(title: string, args: string[], password?: string) {
	outputChannel.show(true);
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
			runGnokey(args, { password })
		);
	} catch (err) {
		vscode.window.showErrorMessage(`${title} failed: ${(err as Error).message}`);
	}
}

/** Returns the realm package path of the active Gno file, or shows an error. */
async function activeRealm(): Promise<{ uri: vscode.Uri; module: string } | undefined> {
	const uri = gnoEditorUri();
	const module = await editorRealm(uri);
	if (!uri || !module) {
		vscode.window.showErrorMessage('Open a file of a realm, a package whose gnomod.toml module path has /r/.');
		return undefined;
	}
	return { uri, module };
}

/**
 * Returns the exported crossing functions of the package of `uri`, from the
 * unsaved text of open files and else from disk, with the file declaring each.
 */
async function packageFuncs(uri: vscode.Uri): Promise<(CrossingFunc & { file: string })[]> {
	const dir = path.dirname(uri.fsPath);
	const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.gno') && !isGnoTestFile(f)).sort();
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

/** Asks which of `funcs` of realm `module` to call, or shows an error when there is none. */
async function pickFunc(funcs: (CrossingFunc & { file: string })[], module: string) {
	if (!funcs.length) {
		vscode.window.showErrorMessage(`${module} has no exported crossing function, func F(cur realm, ...).`);
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		funcs.map((f) => ({
			label: f.name,
			description: `(${f.params.map((p) => `${p.name} ${p.type}`).join(', ')}) in ${f.file}`,
			func: f
		})),
		{ placeHolder: `Function of ${module} to call` }
	);
	return picked?.func;
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
	const funcs = await packageFuncs(realm.uri);
	const func = funcs.find((f) => f.name === args?.func) ?? (await pickFunc(funcs, realm.module));
	const network = func && requireSelectedNetwork();
	if (!func || !network) {
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
	const signer = send !== undefined && (await askSigner(title));
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
			...(send?.trim() ? ['-send', send.trim()] : []),
			...txFlags(network, realm.uri),
			signer.key
		],
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
	await runWithProgress(title, ['maketx', 'run', ...txFlags(network, doc.uri), signer.key, file], signer.password);
};

/**
 * Asks for the input of a query of the realm of the active file, and sends
 * `query` with data `<realm><sep><input>`.
 */
async function queryRealm(
	query: string,
	sep: string,
	title: string,
	input: vscode.InputBoxOptions
): Promise<string | undefined> {
	const realm = await activeRealm();
	const network = realm && requireSelectedNetwork();
	if (!realm || !network) {
		return undefined;
	}
	const value = await vscode.window.showInputBox({ ...input, title: `${title} ${realm.module} on ${network.name}` });
	if (value === undefined) {
		return undefined;
	}
	const data = `${realm.module}${sep}${value.trim()}`;
	await runWithProgress(`${title} ${data}`, ['query', query, '-data', data, '-remote', network.remote]);
	return value.trim();
}

/** Evaluates an expression in the realm of the active file with `vm/qeval`. */
export const evalRealm: CommandFactory = () => async () => {
	lastEval =
		(await queryRealm('vm/qeval', '.', 'Evaluate in', {
			prompt: 'Expression, such as Counter() or Render("")',
			value: lastEval,
			validateInput: nonEmpty
		})) ?? lastEval;
};

/** Shows the Render output of the realm of the active file with `vm/qrender`. */
export const queryRender: CommandFactory = () => async () => {
	await queryRealm('vm/qrender', ':', 'Query Render of', {
		prompt: 'Path passed to Render, empty for the realm home'
	});
};

/** Registers the code lens that calls exported crossing functions of realms. */
export function setupCallCodeLens(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.languages.registerCodeLensProvider(GO_MODE, {
			async provideCodeLenses(document) {
				const codeLens = getGnoConfig(document.uri).get<{ call?: boolean }>('enableCodeLens');
				if (codeLens?.call === false || isGnoTestFile(document.fileName)) {
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
