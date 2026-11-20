/*---------------------------------------------------------
 * Copyright 2022 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

import { CommandFactory } from '.';
import { getCurrentGoPath as utilGetCurrentGoPath } from '../util';

export const getCurrentGoPath: CommandFactory = () => {
	return () => {
		const gopath = utilGetCurrentGoPath();
		vscode.window.showInformationMessage(`${gopath} is the current GNOPATH.`);
		return gopath;
	};
};
