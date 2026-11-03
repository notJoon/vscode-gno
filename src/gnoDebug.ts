/*---------------------------------------------------------
 * Copyright 2026 The Gno Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

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
					if (vscode.window.activeTextEditor?.document.languageId !== 'gno') {
						return undefined;
					}
					config.type = 'gno';
					config.name = 'Debug Gno package';
					config.request = 'launch';
					config.program = '${fileDirname}';
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
