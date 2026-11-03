/*---------------------------------------------------------
 * Copyright 2026 The Gno Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

// Client for the interactive gnovm debugger started with `gno run -debug-addr`.
// The debugger has no machine-readable protocol: it reads one command per line
// and answers with plain text terminated by the "dbg> " prompt. Everything in
// this file depends on that text format (gnovm/pkg/gnolang/debugger.go).

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

const PROMPT = 'dbg> ';

export interface GnoLocation {
	// Raw location as printed by the debugger, "<pkgpath>/<file>:<line>:<col>".
	raw: string;
	file: string;
	line: number;
	column: number;
}

export interface GnoStop {
	func: string;
	loc: GnoLocation;
}

export interface GnoFrame {
	index: number;
	func: string;
	loc: GnoLocation;
}

export interface GnoValue {
	value: string;
	type: string;
}

export class GnoDebugClient {
	private socket?: net.Socket;
	private buf = '';
	private pending?: { resolve: (s: string) => void; reject: (e: Error) => void };
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;

	onClose?: () => void;

	// connect retries until the debugger accepts the connection, then waits for its first prompt.
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

	get isClosed(): boolean {
		return this.closed;
	}

	// send runs one debugger command and resolves with its output, once the
	// debugger prompts again. Commands are serialized: a command sent while the
	// program runs (after continue/next/step) waits until the program stops.
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

// Dirs are the directories where relative source files are looked up.
export interface Dirs {
	gnoRoot?: string;
	// Directory of the debugged program, whose files are relative when it lives under GNOROOT.
	programDir?: string;
}

// parseLocation parses "<pkgpath>/<file>:<line>:<col>". Files of the debugged
// program are usually absolute, so the pkgpath prefix is dropped. Files of
// imported packages are relative to their pkgpath and are looked up in GNOROOT.
export function parseLocation(raw: string, dirs: Dirs = {}): GnoLocation | undefined {
	const m = raw.trim().match(/^(.*):(\d+):(\d+)$/);
	if (!m) {
		return undefined;
	}
	return { raw: raw.trim(), file: resolveFile(m[1], dirs), line: Number(m[2]), column: Number(m[3]) };
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

// parseStop extracts the current position from the output of continue, next,
// step and stepout, e.g. "> main.add() main//tmp/x/main.gno:6:7".
export function parseStop(out: string, dirs?: Dirs): GnoStop | undefined {
	const m = out.match(/^> (\S+?)(?:\(\))? (\S+:\d+:\d+)$/m);
	const loc = m && parseLocation(m[2], dirs);
	return m && loc ? { func: m[1], loc } : undefined;
}

// parseStack parses the output of the "stack" command.
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

// parseValue parses the output of "print", e.g. "(1 int)" or
// "(struct{(2 int)} main.T)". It returns undefined when the command failed.
export function parseValue(out: string): GnoValue | undefined {
	const s = out.trim();
	if (!s || s.startsWith('Command failed:')) {
		return undefined;
	}
	if (s === '(undefined)') {
		return { value: 'undefined', type: '' };
	}
	// ponytail: splits on the last space, so a type containing spaces (func types) is split wrong.
	const m = s.match(/^\((.*) (\S+)\)$/s);
	return m ? { value: m[1], type: m[2] } : { value: s, type: '' };
}

// commandError returns the message of a failed command, if any.
export function commandError(out: string): string | undefined {
	const m = out.match(/^Command failed: (.*)$/m);
	return m?.[1];
}

// localNames guesses the variables visible at line (1-based) in src: the
// parameters and receiver of the enclosing function and the names declared
// before line in its body. The debugger has no command to list locals.
// ponytail: line based heuristic, ignores block scoping; a go/ast based lister in gno would be exact.
export function localNames(src: string, line: number): string[] {
	const lines = src.split('\n');
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
