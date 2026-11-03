import vscode = require('vscode');
import { CommandFactory } from './commands';
import { getGnoConfig } from './config';
import { isGoFile } from './gnoMode';

/**
 * A chain that transactions and queries are sent to, from `gno.networks`.
 */
export interface GnoNetwork {
	name: string;
	remote: string;
	chainId: string;
}

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Returns the networks of `gno.networks`, in the order they are configured.
 */
export function getNetworks(): GnoNetwork[] {
	const networks = getGnoConfig().get<Record<string, Omit<GnoNetwork, 'name'>>>('networks') ?? {};
	return Object.entries(networks).map(([name, n]) => ({ name, remote: n.remote, chainId: n.chainId }));
}

/**
 * Returns the network named by `gno.network`, or the first network when it is
 * empty. Returns undefined when the named network is not in `gno.networks`.
 */
export function getSelectedNetwork(): GnoNetwork | undefined {
	const networks = getNetworks();
	const selected = getGnoConfig().get<string>('network');
	return selected ? networks.find((n) => n.name === selected) : networks[0];
}

/**
 * Shows an error for a `gno.network` that is not in `gno.networks`, with an
 * action to select another network.
 */
export async function showUnknownNetworkError() {
	const selected = getGnoConfig().get<string>('network');
	const action = await vscode.window.showErrorMessage(
		`Network "${selected}" is not in gno.networks.`,
		'Select Network'
	);
	if (action) {
		await vscode.commands.executeCommand('gno.network.select');
	}
}

export const selectNetwork: CommandFactory = () => async () => {
	const current = getSelectedNetwork()?.name;
	const picked = await vscode.window.showQuickPick(
		getNetworks().map((n) => ({
			label: n.name,
			description: `${n.name === current ? '$(check) ' : ''}${n.remote} (chain ID ${n.chainId})`
		})),
		{ placeHolder: 'Select the network for Gno transactions and queries' }
	);
	if (picked) {
		const target = vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await getGnoConfig().update('network', picked.label, target);
	}
};

/**
 * Shows the selected network in the status bar while a Gno file is open.
 */
export function setupNetworkStatusBar(ctx: vscode.ExtensionContext) {
	statusBarItem = vscode.window.createStatusBarItem('gno.network', vscode.StatusBarAlignment.Right, 100);
	statusBarItem.name = 'Gno Network';
	statusBarItem.command = 'gno.network.select';
	ctx.subscriptions.push(
		statusBarItem,
		vscode.window.onDidChangeActiveTextEditor(updateNetworkStatusBar),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('gno.networks') || e.affectsConfiguration('gno.network')) {
				updateNetworkStatusBar();
			}
		})
	);
	updateNetworkStatusBar();
}

function updateNetworkStatusBar() {
	if (!statusBarItem) {
		return;
	}
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isGoFile(editor.document)) {
		statusBarItem.hide();
		return;
	}
	const network = getSelectedNetwork();
	if (network) {
		statusBarItem.text = `$(globe) ${network.name}`;
		statusBarItem.tooltip = `Gno network: ${network.remote} (chain ID ${network.chainId}). Click to change.`;
		statusBarItem.backgroundColor = undefined;
	} else {
		statusBarItem.text = `$(globe) ${getGnoConfig().get<string>('network')}?`;
		statusBarItem.tooltip = 'The selected network is not in gno.networks. Click to select another one.';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	}
	statusBarItem.show();
}
