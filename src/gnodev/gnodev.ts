import vscode = require('vscode');
import cp = require('child_process');
import fs = require('fs');
import path = require('path');
import readline = require('readline');
import { CommandFactory } from '../commands';
import { getGnoConfig } from '../config';
import { toolExecutionEnvironment } from '../gnoEnv';
import { GO_MODE } from '../gnoMode';
import { isGnoTestFile } from '../gnoRealmFuncs';
import { findModuleName } from '../gnoTest/utils';
import { getBinPath, getWorkspaceFolderPath } from '../util';
import { killProcessTree } from '../utils/processUtils';
import { GnodevLog, gnowebAddress, parseGnodevLog } from './logs';
import { packagePath, renderUrlPath } from './render';

const RUNNING_CONTEXT = 'gno.gnodev.running';
const VIEW_TYPE = 'gno.gnodev';
const READY_DELAY_MS = 500;

interface GnodevServer {
	process: cp.ChildProcess;
	/** Resolves when the process has exited and released its ports. */
	exited: Promise<void>;
	/** gnoweb address as gnodev reports it, reachable from the extension host. */
	addr?: string;
	/** gnoweb address reachable from the UI, which differs in remote setups. */
	externalUri?: vscode.Uri;
	panel?: vscode.WebviewPanel;
	/** Set once the node is ready, with or without gnoweb. */
	ready?: boolean;
	/** Render output shown in the panel, or to show once gnoweb is ready. */
	preview?: RenderPreview;
	/** Workspace or package directory that gnodev loads, if it found one. */
	root: Promise<string | undefined>;
}

interface RenderPreview {
	/** Module path of the realm, such as `gno.land/r/demo/foo`. */
	module: string;
	/** The path argument of `Render`. */
	path: string;
}

let server: GnodevServer | undefined;
/** Resolves when the last stopped gnodev has exited. */
let lastExit: Promise<void> = Promise.resolve();
let channel: vscode.LogOutputChannel | undefined;

function output(): vscode.LogOutputChannel {
	return (channel ??= vscode.window.createOutputChannel('Gnodev', { log: true }));
}

function writeLog(log: GnodevLog) {
	const msg = log.group ? `[${log.group}] ${log.msg}` : log.msg;
	const args = Object.keys(log.args).length ? [log.args] : [];
	switch (log.level) {
		case 'debug':
			return output().debug(msg, ...args);
		case 'warn':
			return output().warn(msg, ...args);
		case 'error':
			return output().error(msg, ...args);
		default:
			return output().info(msg, ...args);
	}
}

/**
 * Starts gnodev in the directory of the active file, replacing a running
 * instance, and opens gnoweb as configured by `gno.gnodev.openBrowser`.
 * gnodev looks for a gnomod.toml or gnowork.toml from its working directory
 * upward, so this loads the package or workspace of the file as running gnodev
 * there in a terminal would. Without a file, it runs in the workspace folder.
 */
export const startGnodev: CommandFactory = (ctx) => () => start(ctx.extensionUri);

/** Returns the URI of the active editor, or of a visible Gno editor when a webview has focus. */
export function gnoEditorUri(): vscode.Uri | undefined {
	const editor =
		vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'gno');
	return editor?.document.uri;
}

async function start(extensionUri: vscode.Uri, preview?: RenderPreview) {
	// Wait for the previous gnodev to release its ports. Loop as another start
	// may have spawned or stopped one meanwhile.
	let exit: Promise<void>;
	do {
		exit = stopGnodev();
		await exit;
	} while (server || exit !== lastExit);

	const uri = gnoEditorUri();
	const cwd = uri?.scheme === 'file' ? path.dirname(uri.fsPath) : getWorkspaceFolderPath(uri);
	if (!cwd) {
		vscode.window.showErrorMessage('Open a Gno file or a workspace folder to start gnodev.');
		return;
	}
	const cfg = getGnoConfig(uri);
	const bin = getBinPath('gnodev');
	const args = [...cfg.get<string[]>('gnodev.flags', []), '-log-format', 'json'];
	const openBrowser = cfg.get<string>('gnodev.openBrowser', 'beside');

	output().info(`starting ${bin} ${args.join(' ')} in ${cwd}`);
	const proc = cp.spawn(bin, args, { cwd, env: toolExecutionEnvironment() });
	const exited = new Promise<void>((resolve) => proc.once('close', () => resolve()));
	const current: GnodevServer = { process: proc, exited, preview, root: loadRoot(cwd) };
	server = current;
	vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, true);

	/** The last error gnodev printed, shown when it exits with an error. */
	let lastError: string | undefined;
	readline.createInterface({ input: proc.stdout }).on('line', (line) => {
		const log = parseGnodevLog(line);
		if (!log) {
			output().info(line);
			return;
		}
		writeLog(log);
		if (log.level === 'error') {
			lastError = log.msg;
		}
		current.addr ??= gnowebAddress(log);
		if (log.msg === 'node is ready') {
			// gnodev logs "gnoweb started" and "node is ready" before gnoweb listens,
			// and exits right after when listening fails, such as on a port in use.
			// Wait a moment so that only the error is shown then.
			setTimeout(() => server === current && onReady(extensionUri, current, openBrowser), READY_DELAY_MS);
		}
	});
	readline.createInterface({ input: proc.stderr }).on('line', (line) => {
		output().error(line);
		if (line.trim()) {
			lastError = line.trim();
		}
	});

	/** Clears the state unless the user already stopped this instance. */
	let ended = false;
	const onEnd = (message: string, failed: boolean) => {
		// A process that fails to spawn emits both 'error' and 'close'.
		if (ended) {
			return;
		}
		ended = true;
		output().info(message);
		if (server !== current) {
			return;
		}
		void stopGnodev();
		if (failed) {
			vscode.window.showErrorMessage(message, 'Show Output').then((s) => s && output().show());
		}
	};
	proc.on('error', (err) => onEnd(`failed to start gnodev: ${err.message}`, true));
	// 'close' comes after the output is read, unlike 'exit', so lastError is set.
	proc.on('close', (code, signal) => {
		const status = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
		onEnd(`gnodev ${status}${code && lastError ? `: ${lastError}` : ''}`, code !== 0);
	});
}

async function onReady(extensionUri: vscode.Uri, s: GnodevServer, openBrowser: string) {
	s.ready = true;
	// gnoweb is started before the node is ready, so no address means `-no-web`.
	if (!s.addr) {
		vscode.window.showInformationMessage('gnodev is ready. gnoweb is disabled.');
		return;
	}
	const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(s.addr));
	if (server !== s) {
		return;
	}
	s.externalUri = externalUri;
	vscode.window.showInformationMessage(`gnodev started at ${s.addr}`);
	if (s.preview) {
		showPreview(extensionUri, s, panelColumn(openBrowser));
	} else if (openBrowser === 'external') {
		vscode.env.openExternal(externalUri);
	} else if (openBrowser !== 'none') {
		showPanel(extensionUri, s, externalUri.toString(), panelColumn(openBrowser));
	}
}

function panelColumn(openBrowser: string): vscode.ViewColumn {
	return openBrowser === 'current' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
}

/**
 * Shows gnoweb in the panel, revealing it in `column` if given. A preview
 * reveals it without taking the focus, so that editing can go on.
 */
function showPanel(
	extensionUri: vscode.Uri,
	s: GnodevServer,
	url: string,
	column?: vscode.ViewColumn,
	preserveFocus = false
) {
	if (!s.panel) {
		s.panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			'gnodev',
			{ viewColumn: column ?? vscode.ViewColumn.Beside, preserveFocus },
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);
		s.panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'media', 'gno-icon-light.png'),
			dark: vscode.Uri.joinPath(extensionUri, 'media', 'gno-icon-dark.png')
		};
		// Closing gnoweb stops gnodev, as the editor button is the only other control.
		s.panel.onDidDispose(() => {
			s.panel = undefined;
			if (server === s) {
				void stopGnodev();
			}
		});
	}
	const origin = new URL(url).origin;
	s.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';">
	<style>html, body, iframe { width: 100%; height: 100%; margin: 0; padding: 0; border: none; overflow: hidden; } iframe { background: white; }</style>
</head>
<body>
	<iframe src="${url}" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
</body>
</html>`;
	if (column !== undefined) {
		s.panel.reveal(column, preserveFocus);
	}
}

function showPreview(extensionUri: vscode.Uri, s: GnodevServer, column?: vscode.ViewColumn) {
	if (!s.externalUri || !s.preview) {
		return;
	}
	const urlPath = renderUrlPath(s.preview.module, s.preview.path) ?? '';
	showPanel(extensionUri, s, s.externalUri.toString().replace(/\/$/, '') + urlPath, column, true);
}

/**
 * Returns the package path of the realm in `dir`, the module path of the
 * closest gnomod.toml upward joined with the path of `dir` below it, or
 * undefined if there is none or it is not a realm.
 */
async function findRealm(dir: string): Promise<string | undefined> {
	const modDir = await findUp(dir, 'gnomod.toml');
	if (!modDir) {
		return undefined;
	}
	try {
		const module = findModuleName(await fs.promises.readFile(path.join(modDir, 'gnomod.toml'), 'utf8'));
		const pkgPath = packagePath(module, path.relative(modDir, dir));
		return renderUrlPath(pkgPath, '') ? pkgPath : undefined;
	} catch {
		return undefined;
	}
}

/** Returns the closest directory to `dir` upward that has a file named `name`. */
async function findUp(dir: string, name: string): Promise<string | undefined> {
	for (;;) {
		try {
			await fs.promises.access(path.join(dir, name));
			return dir;
		} catch {
			// No such file in this directory.
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * Returns the directory that gnodev run in `cwd` loads: the workspace of the
 * closest gnowork.toml upward, or else the package of the closest gnomod.toml.
 */
async function loadRoot(cwd: string): Promise<string | undefined> {
	return (await findUp(cwd, 'gnowork.toml')) ?? findUp(cwd, 'gnomod.toml');
}

/** Warns when `file` is outside the workspace or package that gnodev loads. */
async function warnIfNotLoaded(s: GnodevServer, file: vscode.Uri, module: string) {
	// TODO: gnodev only loads the workspace or package it was started in, so
	// gnoweb does not find a realm outside it. Restart gnodev for that realm, or
	// make gnodev load it, instead of only warning.
	const root = await s.root;
	const rel = root && path.relative(root, file.fsPath);
	if (rel !== undefined && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
		vscode.window.showWarningMessage(
			`${module} is outside ${root}, which gnodev loads, so gnoweb may not find it. Restart gnodev from a file of ${module} to preview it.`
		);
	}
}

export async function editorRealm(uri: vscode.Uri | undefined): Promise<string | undefined> {
	return uri?.scheme === 'file' ? findRealm(path.dirname(uri.fsPath)) : undefined;
}

/**
 * Previews the `Render` output of the realm of the active file in the gnodev
 * panel, starting gnodev if it is not running. Without a `path` argument, the
 * path passed to `Render` is asked for.
 */
export const previewRender: CommandFactory = (ctx) => async (args?: { path?: string }) => {
	const uri = gnoEditorUri();
	const module = await editorRealm(uri);
	if (!module) {
		vscode.window.showErrorMessage(
			'Open a file of a realm, a package whose gnomod.toml module path has /r/, to preview its Render output.'
		);
		return;
	}
	let renderPath = args?.path;
	if (renderPath === undefined) {
		renderPath = await vscode.window.showInputBox({
			title: `Preview Render of ${module}`,
			prompt: 'The path argument of Render, such as foo/bar. Leave empty for the realm home page.',
			value: server?.preview?.module === module ? server.preview.path : ''
		});
		if (renderPath === undefined) {
			return;
		}
	}
	const preview = { module, path: renderPath.trim() };
	if (!server) {
		await start(ctx.extensionUri, preview);
		return;
	}
	server.preview = preview;
	void warnIfNotLoaded(server, uri!, module);
	if (server.externalUri) {
		showPreview(
			ctx.extensionUri,
			server,
			panelColumn(getGnoConfig(uri).get<string>('gnodev.openBrowser', 'beside'))
		);
	} else if (server.ready && !server.addr) {
		vscode.window.showErrorMessage('gnoweb is disabled. Remove -no-web from gno.gnodev.flags to preview Render.');
	}
	// Otherwise gnodev is starting, and shows the preview once ready.
};

/**
 * Registers the code lens on `func Render(` of realms, and makes the preview
 * follow the active editor to the realm of its file.
 */
export function setupRenderPreview(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.languages.registerCodeLensProvider(GO_MODE, {
			async provideCodeLenses(document) {
				const codeLens = getGnoConfig(document.uri).get<{ render?: boolean }>('enableCodeLens');
				if (codeLens?.render === false || isGnoTestFile(document.fileName)) {
					return [];
				}
				const match = /^func Render\(/m.exec(document.getText());
				if (!match || !(await editorRealm(document.uri))) {
					return [];
				}
				const range = document.lineAt(document.positionAt(match.index).line).range;
				return [
					new vscode.CodeLens(range, {
						title: 'preview render',
						command: 'gno.render.preview',
						arguments: [{ path: '' }]
					}),
					new vscode.CodeLens(range, { title: 'preview render path...', command: 'gno.render.preview' })
				];
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(async (editor) => {
			const s = server;
			if (!s?.panel || !s.preview || editor?.document.languageId !== 'gno') {
				return;
			}
			const module = await editorRealm(editor.document.uri);
			if (module && module !== s.preview.module && server === s && s.preview) {
				s.preview = { module, path: '' };
				showPreview(ctx.extensionUri, s);
				void warnIfNotLoaded(s, editor.document.uri, module);
			}
		})
	);
}

/**
 * Stops the running gnodev and closes its gnoweb panel. Resolves once the
 * last stopped gnodev has exited, even when none is running anymore.
 */
export function stopGnodev(): Promise<void> {
	const s = server;
	if (!s) {
		return lastExit;
	}
	server = undefined;
	vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, false);
	s.panel?.dispose();
	lastExit = s.exited;
	if (s.process.exitCode === null && s.process.signalCode === null) {
		output().info('stopping gnodev');
		void killProcessTree(s.process, (msg) => output().error(msg));
	}
	return lastExit;
}

/**
 * Calls a gnodev control endpoint: `reload` reloads the packages, `reset` also
 * resets the realms state.
 */
function control(endpoint: 'reload' | 'reset'): CommandFactory {
	return () => async () => {
		if (!server?.addr) {
			vscode.window.showInformationMessage('gnodev is not running.');
			return;
		}
		try {
			const res = await fetch(new URL(endpoint, server.addr));
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
		} catch (err) {
			vscode.window.showErrorMessage(`gnodev ${endpoint} failed: ${err instanceof Error ? err.message : err}`);
		}
	};
}

export const reloadGnodev = control('reload');
export const resetGnodev = control('reset');

export const openGnodevExternal: CommandFactory = () => () => {
	if (server?.externalUri) {
		vscode.env.openExternal(server.externalUri);
	}
};
