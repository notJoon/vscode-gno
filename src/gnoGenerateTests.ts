/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { CommandFactory } from './commands';

/**
 * Toggles between file in current active editor and the corresponding test file.
 */
export const toggleTestFile: CommandFactory = () => () => {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage('Cannot toggle test file. No editor selected.');
		return;
	}
	const currentFilePath = editor.document.fileName;
	if (!currentFilePath.endsWith('.gno')) {
		vscode.window.showInformationMessage('Cannot toggle test file. File in the editor is not a Go file.');
		return;
	}
	let targetFilePath = '';
	if (currentFilePath.endsWith('_test.gno')) {
		targetFilePath = currentFilePath.substr(0, currentFilePath.lastIndexOf('_test.gno')) + '.gno';
	} else {
		targetFilePath = currentFilePath.substr(0, currentFilePath.lastIndexOf('.gno')) + '_test.gno';
	}
	for (const doc of vscode.window.visibleTextEditors) {
		if (doc.document.fileName === targetFilePath) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetFilePath), doc.viewColumn);
			return;
		}
	}
	vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetFilePath));
};
