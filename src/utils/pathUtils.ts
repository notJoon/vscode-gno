/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Modification copyright 2020 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

/**
 * This file is loaded by both the extension and debug adapter, so it cannot import 'vscode'
 */
import fs = require('fs');
import os = require('os');
import path = require('path');
import { promisify } from 'util';

const binPathCache: { [bin: string]: string } = {};

export const getEnvPath = () => process.env['PATH'] || (process.platform === 'win32' ? process.env['Path'] : null);
export const initialEnvPath = getEnvPath();

// find the tool's path from the given PATH env var, or null if the tool is not found.
export function getBinPathFromEnvVar(
	toolName: string,
	envVarValue: string | null | undefined,
	appendBinToPath: boolean
): string | null {
	toolName = correctBinname(toolName);
	if (envVarValue) {
		const paths = envVarValue.split(path.delimiter);
		for (const p of paths) {
			const binpath = path.join(p, appendBinToPath ? 'bin' : '', toolName);
			if (executableFileExists(binpath)) {
				return binpath;
			}
		}
	}
	return null;
}

/** Returns the path of the tool binary and why that path was chosen. */
export function getBinPathWithPreferredGopathGorootWithExplanation(
	toolName: string,
	preferredGopaths: string[],
	alternateTool?: string,
	useCache = true
): { binPath: string; why?: string } {
	if (alternateTool && path.isAbsolute(alternateTool) && executableFileExists(alternateTool)) {
		binPathCache[toolName] = alternateTool;
		return { binPath: alternateTool, why: 'alternateTool' };
	}

	/** FIXIT: this cache needs to be invalidated when gno.alternateTools is changed. */
	if (useCache && binPathCache[toolName]) {
		return { binPath: binPathCache[toolName], why: 'cached' };
	}

	const binname = alternateTool && !path.isAbsolute(alternateTool) ? alternateTool : toolName;
	const found = (why: string) => (binname === toolName ? why : 'alternateTool');
	const pathFromGoBin = getBinPathFromEnvVar(binname, process.env['GNOBIN'], false);
	if (pathFromGoBin) {
		binPathCache[toolName] = pathFromGoBin;
		return {
			binPath: pathFromGoBin,
			why: binname === toolName ? 'gnobin' : 'alternateTool'
		};
	}

	for (const preferred of preferredGopaths) {
		if (typeof preferred === 'string') {
			// Search in the preferred GOPATH workspace's bin folder
			const pathFrompreferredGoPath = getBinPathFromEnvVar(binname, preferred, true);
			if (pathFrompreferredGoPath) {
				binPathCache[toolName] = pathFrompreferredGoPath;
				return {
					binPath: pathFrompreferredGoPath,
					why: found('gnopath')
				};
			}
		}
	}

	// Check GOROOT (go, gofmt, godoc would be found here)
	const pathFromGoRoot = getBinPathFromEnvVar(binname, getCurrentGoRoot(), true);
	if (pathFromGoRoot) {
		binPathCache[toolName] = pathFromGoRoot;
		return { binPath: pathFromGoRoot, why: found('gnoroot') };
	}

	// Finally search PATH parts
	let pathFromPath = getBinPathFromEnvVar(binname, getEnvPath(), false);
	if (pathFromPath) {
		if (toolName === 'gno' && pathFromPath === '/snap/bin/go') {
			// Workaround for the snapd issue (golang/vscode-go#166)
			// https://bugs.launchpad.net/ubuntu/+source/snapd/+bug/1849753
			console.log('using /snap/go/current/bin/gno instead of /snap/bin/gno (see golang/vscode-go#166)');
			pathFromPath = '/snap/go/current/bin/gno';
		}
		binPathCache[toolName] = pathFromPath;
		return { binPath: pathFromPath, why: found('path') };
	}

	// Check common paths for go
	if (toolName === 'go') {
		const defaultPathsForGo =
			process.platform === 'win32'
				? ['C:\\Program Files\\Go\\bin\\gno.exe', 'C:\\Program Files (x86)\\Go\\bin\\gno.exe']
				: ['/usr/local/go/bin/gno', '/usr/local/bin/gno'];
		for (const p of defaultPathsForGo) {
			if (executableFileExists(p)) {
				binPathCache[toolName] = p;
				return { binPath: p, why: 'default' };
			}
		}
		return { binPath: '' };
	}

	// Else return the binary name directly (this will likely always fail downstream)
	return { binPath: toolName };
}

/**
 * Returns the goroot path if it exists, otherwise returns an empty string
 */
let currentGoRoot = '';
export function getCurrentGoRoot(): string {
	return currentGoRoot || process.env['GNOROOT'] || '';
}

export function setCurrentGoRoot(goroot: string) {
	currentGoRoot = goroot;
}

export function correctBinname(toolName: string) {
	if (process.platform === 'win32') {
		return toolName + '.exe';
	}
	return toolName;
}

export function executableFileExists(filePath: string): boolean {
	let exists = true;
	try {
		exists = fs.statSync(filePath).isFile();
		if (exists) {
			fs.accessSync(filePath, fs.constants.F_OK | fs.constants.X_OK);
		}
	} catch {
		exists = false;
	}
	return exists;
}

export async function dirExists(p: string): Promise<boolean> {
	try {
		const stat = promisify(fs.stat);
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Exapnds ~ to homedir in non-Windows platform
 */
export function resolveHomeDir(inputPath: string): string {
	if (!inputPath || !inputPath.trim()) {
		return inputPath;
	}
	return inputPath.startsWith('~') ? path.join(os.homedir(), inputPath.substr(1)) : inputPath;
}

// Workaround for issue in https://github.com/Microsoft/vscode/issues/9448#issuecomment-244804026
export function fixDriveCasingInWindows(pathToFix: string): string {
	return process.platform === 'win32' && pathToFix
		? pathToFix.substr(0, 1).toUpperCase() + pathToFix.substr(1)
		: pathToFix;
}

/**
 * Returns the tool name (executable's basename) from the given path to the tool
 * @param toolPath
 */
export function getToolFromToolPath(toolPath: string): string | undefined {
	if (!toolPath) {
		return;
	}
	let tool = path.basename(toolPath);
	if (process.platform === 'win32' && tool.endsWith('.exe')) {
		tool = tool.substr(0, tool.length - 4);
	}
	return tool;
}
