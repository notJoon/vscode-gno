/*---------------------------------------------------------
 * Copyright 2026 The Gno Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

import * as path from 'path';
import vscode = require('vscode');
import { GnoDebugSession } from './debugAdapter/gnoDebugSession';
import { toolExecutionEnvironment } from './gnoEnv';
import { getBinPath } from './util';

export function registerGnoDebugger(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('gno', {
			resolveDebugConfiguration(folder, config) {
				// F5 without a launch.json: debug the package of the active file.
				if (!config.type && !config.request && !config.name) {
					const file = activeGnoFile();
					if (!file) {
						void vscode.window.showErrorMessage('Open a .gno file to debug its package.');
						return undefined;
					}
					config.type = 'gno';
					config.name = 'Debug Gno package';
					config.request = 'launch';
					config.program = path.dirname(file);
				}
				config.gnoPath ??= getBinPath('gno');
				config.env = { ...toolExecutionEnvironment(folder?.uri, false), ...config.env };
				return config;
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory('gno', {
			createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new GnoDebugSession())
		})
	);
}

/**
 * Returns the .gno file of the active editor tab.
 *
 * When a panel such as the output has the focus, vscode.window.activeTextEditor
 * and ${file} refer to the panel, while the active tab is still the file.
 */
function activeGnoFile(): string | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const uri = input instanceof vscode.TabInputText ? input.uri : vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === 'file' && uri.fsPath.endsWith('.gno') ? uri.fsPath : undefined;
}
