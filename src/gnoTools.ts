/* eslint-disable @typescript-eslint/no-explicit-any */
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import semver = require('semver');
import { allToolsInformation } from './gnoToolsInformation';

export interface Tool {
	name: string;
	importPath: string;
	modulePath: string;
	isImportant: boolean;
	description: string;

	// If set, this string will be used when installing the tool
	// instead of the default 'latest'. It can be used when
	// we need to pin a tool version (`deadbeaf`) or to use
	// a dev version available in a branch (e.g. `master`).
	defaultVersion?: string;

	/**
	 * latestVersion is a hardcoded default value for the last known version
	 * of the given tool.
	 */
	latestVersion?: semver.SemVer | null;

	// minimumGoVersion and maximumGoVersion set the range for the versions of
	// Go with which this tool can be used.
	minimumGoVersion?: semver.SemVer | null;
	maximumGoVersion?: semver.SemVer | null;

	// close performs any shutdown tasks that a tool must execute before a new
	// version is installed. It returns a string containing an error message on
	// failure.
	close?: (env: NodeJS.Dict<string>) => Promise<string>;
}

/**
 * ToolAtVersion is a Tool at a specific version.
 * Lack of version implies the latest version.
 */
export interface ToolAtVersion extends Tool {
	version?: semver.SemVer;
}

export function getImportPathWithVersion(tool: Tool, version?: semver.SemVer | string | null): string {
	const importPath = tool.importPath;
	if (version) {
		if (version instanceof semver.SemVer) {
			return importPath + '@v' + version;
		} else {
			return importPath + '@' + version;
		}
	}
	if (tool.defaultVersion) {
		return importPath + '@' + tool.defaultVersion;
	}
	return importPath + '@latest';
}

export function containsTool(tools: Tool[], tool: Tool): boolean {
	return tools.indexOf(tool) > -1;
}

export function getTool(name: string): Tool {
	const [n] = name.split('@');
	return allToolsInformation[n];
}

export function getConfiguredTools(goConfig: { [key: string]: any }, goplsConfig: { [key: string]: any }): Tool[] {
	const useLanguageServer = goConfig['useLanguageServer'];

	const tools: Tool[] = [];
	function maybeAddTool(name: string) {
		const tool = allToolsInformation[name];
		if (tool) {
			tools.push(tool);
		}
	}

	// Add the language server if the user has chosen to do so.
	if (useLanguageServer) {
		maybeAddTool('gnopls');
	}

	// Add the linter that was chosen by the user, but don't add staticcheck
	// if it is enabled via gopls.
	const goplsStaticheckEnabled = useLanguageServer && goplsStaticcheckEnabled(goConfig, goplsConfig);
	if (goConfig['lintTool'] !== 'staticcheck' || !goplsStaticheckEnabled) {
		maybeAddTool(goConfig['lintTool']);
	}
	return tools;
}

export function goplsStaticcheckEnabled(
	goConfig: { [key: string]: any },
	goplsConfig: { [key: string]: any }
): boolean {
	if (
		goplsConfig['ui.diagnostic.staticcheck'] === false ||
		(goplsConfig['ui.diagnostic.staticcheck'] === undefined && goplsConfig['staticcheck'] !== true)
	) {
		return false;
	}
	return true;
}
