import vscode = require('vscode');
import cp = require('child_process');
import path = require('path');
import readline = require('readline');
import { CommandFactory } from '../commands';
import { getGnoConfig } from '../config';
import { toolExecutionEnvironment } from '../gnoEnv';
import { getBinPath, getWorkspaceFolderPath } from '../util';
import { GnodevLog, gnowebAddress, parseGnodevLog } from './logs';

const RUNNING_CONTEXT = 'gno.gnodev.running';
const VIEW_TYPE = 'gno.gnodev';

interface GnodevServer {
	process: cp.ChildProcess;
	/** gnoweb address as gnodev reports it, reachable from the extension host. */
	addr?: string;
	/** gnoweb address reachable from the UI, which differs in remote setups. */
	externalUri?: vscode.Uri;
	panel?: vscode.WebviewPanel;
}

let server: GnodevServer | undefined;
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
export const startGnodev: CommandFactory = (ctx) => async () => {
	stopGnodev();

	const editor =
		vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'gno');
	const uri = editor?.document.uri;
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
	const current: GnodevServer = { process: proc };
	server = current;
	vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, true);

	readline.createInterface({ input: proc.stdout }).on('line', (line) => {
		const log = parseGnodevLog(line);
		if (!log) {
			output().info(line);
			return;
		}
		writeLog(log);
		const addr = gnowebAddress(log);
		if (addr && server === current) {
			void onGnowebStarted(ctx.extensionUri, current, addr, openBrowser);
		}
	});
	readline.createInterface({ input: proc.stderr }).on('line', (line) => output().error(line));

	/** Clears the state unless the user already stopped this instance. */
	const onEnd = (message: string, failed: boolean) => {
		output().info(message);
		if (server !== current) {
			return;
		}
		stopGnodev();
		if (failed) {
			vscode.window.showErrorMessage(message, 'Show Output').then((s) => s && output().show());
		}
	};
	proc.on('error', (err) => onEnd(`failed to start gnodev: ${err.message}`, true));
	proc.on('exit', (code, signal) => onEnd(`gnodev exited with code ${code}, signal ${signal}`, code !== 0));
};

async function onGnowebStarted(extensionUri: vscode.Uri, s: GnodevServer, addr: string, openBrowser: string) {
	s.addr = addr;
	s.externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(addr));
	vscode.window.showInformationMessage(`gnodev started at ${addr}`);
	if (openBrowser === 'external') {
		vscode.env.openExternal(s.externalUri);
	} else if (openBrowser !== 'none') {
		showPanel(extensionUri, s, openBrowser === 'current' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside);
	}
}

function showPanel(extensionUri: vscode.Uri, s: GnodevServer, column: vscode.ViewColumn) {
	if (!s.panel) {
		s.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'gnodev', column, {
			enableScripts: true,
			retainContextWhenHidden: true
		});
		s.panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'media', 'gno-icon-light.png'),
			dark: vscode.Uri.joinPath(extensionUri, 'media', 'gno-icon-dark.png')
		};
		// Closing gnoweb stops gnodev, as the editor button is the only other control.
		s.panel.onDidDispose(() => {
			s.panel = undefined;
			if (server === s) {
				stopGnodev();
			}
		});
	}
	const url = s.externalUri!.toString();
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
	s.panel.reveal(column);
}

/**
 * Stops the running gnodev and closes its gnoweb panel.
 */
export function stopGnodev() {
	const s = server;
	if (!s) {
		return;
	}
	server = undefined;
	vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, false);
	s.panel?.dispose();
	if (s.process.exitCode === null) {
		output().info('stopping gnodev');
		s.process.kill();
	}
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
