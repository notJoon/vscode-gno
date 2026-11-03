/*---------------------------------------------------------
 * Copyright 2026 The Gno Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

/**
 * Client for the interactive gnovm debugger started with `gno run -debug-addr`.
 *
 * The debugger has no protocol meant for programs. It reads one command per
 * line and answers with plain text ending with the "dbg> " prompt. Everything
 * in this file depends on that text format, defined in
 * gnovm/pkg/gnolang/debugger.go.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

const PROMPT = 'dbg> ';

/** A source location reported by the debugger. */
export interface GnoLocation {
	/** Absolute path of the source file, or the printed path if it was not found. */
	file: string;
	line: number;
	column: number;
}

/** The position where the program stopped. */
export interface GnoStop {
	/** Function name, such as "main.add", or the package name outside of functions. */
	func: string;
	loc: GnoLocation;
}

/** A frame of the call stack, the innermost one having index 0. */
export interface GnoFrame extends GnoStop {
	index: number;
}

/** A value printed by the debugger. */
export interface GnoValue {
	value: string;
	/** Type name, empty when the debugger printed none. */
	type: string;
}

/** Connection to one debugger, which runs one command at a time. */
export class GnoDebugClient {
	private socket?: net.Socket;
	private buf = '';
	private pending?: { resolve: (s: string) => void; reject: (e: Error) => void };
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;

	/** Called once the debugger closes the connection, e.g. when the program ends. */
	onClose?: () => void;

	/**
	 * Connects to the debugger, retrying until it listens, and waits for its first prompt.
	 *
	 * @param port - Port given to `gno run -debug-addr` on 127.0.0.1.
	 * @param timeoutMs - How long to retry before giving up.
	 * @returns The output printed before the first prompt.
	 */
	async connect(port: number, timeoutMs = 10000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				this.socket = await new Promise<net.Socket>((resolve, reject) => {
					const s: net.Socket = net.connect(port, '127.0.0.1', () => resolve(s));
					s.once('error', reject);
				});
				break;
			} catch (e) {
				if (Date.now() > deadline) {
					throw e;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		this.socket.setEncoding('utf8');
		this.socket.on('data', (d: string) => this.onData(d));
		this.socket.on('error', () => this.socket?.destroy());
		this.socket.on('close', () => this.onSocketClose());
		return this.await();
	}

	/**
	 * Runs one debugger command.
	 *
	 * Commands run one after the other. A command sent while the program runs,
	 * after continue, next or step, waits until the program stops.
	 *
	 * @param cmd - Command line, without its newline. Newlines in it become spaces.
	 * @returns The output of the command, once the debugger prompts again.
	 */
	send(cmd: string): Promise<string> {
		const run = () => {
			if (this.closed || !this.socket) {
				return Promise.reject(new Error('debugger connection closed'));
			}
			const p = this.await();
			this.socket.write(cmd.replace(/[\r\n]+/g, ' ') + '\n');
			return p;
		};
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => undefined);
		return p;
	}

	/** Closes the connection. */
	close(): void {
		this.socket?.destroy();
	}

	private await(): Promise<string> {
		return new Promise((resolve, reject) => (this.pending = { resolve, reject }));
	}

	private onData(data: string) {
		this.buf += data;
		if (this.buf.endsWith(PROMPT) && this.pending) {
			const out = this.buf.slice(0, -PROMPT.length);
			this.buf = '';
			const p = this.pending;
			this.pending = undefined;
			p.resolve(out);
		}
	}

	private onSocketClose() {
		this.closed = true;
		this.pending?.reject(new Error('debugger connection closed'));
		this.pending = undefined;
		this.onClose?.();
	}
}

/** Directories where relative source files are looked up. */
export interface Dirs {
	gnoRoot?: string;
	/** Directory of the debugged program, whose files are relative when it lives under GNOROOT. */
	programDir?: string;
	/** Files already resolved from their printed path, filled by {@link parseLocation}. */
	resolved?: Map<string, string>;
}

/**
 * Parses a location printed by the debugger.
 *
 * Files of the debugged program are usually absolute, so the pkgpath prefix is
 * dropped. Files of imported packages are relative to their pkgpath and are
 * looked up in GNOROOT.
 *
 * @param raw - Location in the form "<pkgpath>/<file>:<line>:<col>".
 * @param dirs - Directories where relative files are looked up.
 * @returns The location, or undefined if raw is not a location.
 */
export function parseLocation(raw: string, dirs: Dirs = {}): GnoLocation | undefined {
	const m = raw.trim().match(/^(.*):(\d+):(\d+)$/);
	if (!m) {
		return undefined;
	}
	let file = dirs.resolved?.get(m[1]);
	if (file === undefined) {
		file = resolveFile(m[1], dirs);
		dirs.resolved?.set(m[1], file);
	}
	return { file, line: Number(m[2]), column: Number(m[3]) };
}

function resolveFile(p: string, { gnoRoot, programDir }: Dirs): string {
	for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
		const rest = p.slice(i + 1);
		if (path.isAbsolute(rest) || /^[A-Za-z]:[\\/]/.test(rest)) {
			return rest;
		}
	}
	if (gnoRoot) {
		for (const dir of [path.join(gnoRoot, 'gnovm', 'stdlibs'), path.join(gnoRoot, 'examples')]) {
			const f = path.join(dir, p);
			if (fs.existsSync(f)) {
				return f;
			}
		}
	}
	if (programDir) {
		const f = path.join(programDir, path.basename(p));
		if (fs.existsSync(f)) {
			return f;
		}
	}
	return p;
}

/**
 * Extracts the current position from the output of continue, next, step and stepout.
 *
 * @param out - Command output, such as "> main.add() main//tmp/x/main.gno:6:7".
 * @param dirs - Directories where relative files are looked up.
 * @returns The position, or undefined if the output has none.
 */
export function parseStop(out: string, dirs?: Dirs): GnoStop | undefined {
	const m = out.match(/^> (\S+?)(?:\(\))? (.+:\d+:\d+)$/m);
	const loc = m && parseLocation(m[2], dirs);
	return m && loc ? { func: m[1], loc } : undefined;
}

/**
 * Parses the output of the "stack" command.
 *
 * @param out - Command output.
 * @param dirs - Directories where relative files are looked up.
 * @returns The frames, the innermost first.
 */
export function parseStack(out: string, dirs?: Dirs): GnoFrame[] {
	const frames: GnoFrame[] = [];
	const re = /^(\d+)\tin (.+)\n\tat (.+)$/gm;
	for (let m = re.exec(out); m; m = re.exec(out)) {
		const loc = parseLocation(m[3], dirs);
		if (loc) {
			frames.push({ index: Number(m[1]), func: m[2], loc });
		}
	}
	return frames;
}

/**
 * Parses the output of the "print" command.
 *
 * @param out - Command output, such as "(1 int)" or "(struct{(2 int)} main.T)".
 * @returns The value, or undefined when the command failed.
 */
export function parseValue(out: string): GnoValue | undefined {
	const s = out.trim();
	if (!s || s.startsWith('Command failed:')) {
		return undefined;
	}
	if (s === '(undefined)') {
		return { value: 'undefined', type: '' };
	}
	// The type is after the last space, so a type containing spaces, such as a
	// func type, is split wrong.
	const m = s.match(/^\((.*) (\S+)\)$/s);
	return m ? { value: m[1], type: m[2] } : { value: s, type: '' };
}

/**
 * Returns the error message of a failed command.
 *
 * @param out - Command output.
 * @returns The message, or undefined if the command succeeded.
 */
export function commandError(out: string): string | undefined {
	const m = out.match(/^Command failed: (.*)$/m);
	return m?.[1];
}

/**
 * Guesses the variables visible at a line, since the debugger has no command to list locals.
 *
 * The names are the receiver and parameters of the enclosing function and the
 * names declared before the line in its body. The guess reads lines of text and
 * ignores block scopes. A lister using go/ast in gno would be exact.
 *
 * @param lines - Lines of the source file.
 * @param line - Line number, counted from 1.
 * @returns The names, in order of declaration.
 */
export function localNames(lines: string[], line: number): string[] {
	let start = -1;
	for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
		if (/^func\b/.test(lines[i])) {
			start = i;
			break;
		}
		if (i < line - 1 && /^}/.test(lines[i])) {
			break;
		}
	}
	if (start < 0) {
		return [];
	}
	const names: string[] = [];
	const add = (list: string) => {
		for (const part of list.split(',')) {
			const id = part.trim().split(/\s+/)[0];
			if (/^[A-Za-z_]\w*$/.test(id) && id !== '_' && !names.includes(id)) {
				names.push(id);
			}
		}
	};
	// Receiver and parameters: "func (r *T) name(a, b int, c string) ...".
	const sig = lines[start].match(/^func\s*(?:\(([^)]*)\))?\s*\w+\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/);
	if (sig) {
		if (sig[1]) {
			add(sig[1]);
		}
		add(sig[2]);
	}
	for (let i = start + 1; i < line - 1 && i < lines.length; i++) {
		const l = lines[i];
		const short = l.match(/^\s*(?:for\s+|if\s+|switch\s+)?([\w\s,]+?)\s*:=/);
		if (short) {
			add(short[1]);
		}
		const v = l.match(/^\s*var\s+([\w\s,]+?)(?:\s+[^\s,=]+)?\s*(?:=|$)/);
		if (v) {
			add(v[1]);
		}
	}
	return names;
}
