/*---------------------------------------------------------
 * Copyright 2026 The Gno Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

// Debug adapter translating DAP requests into commands of the gnovm debugger.
// It does not import vscode so that it can run outside of the extension host.

import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
	DebugSession,
	Event,
	InitializedEvent,
	OutputEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import {
	commandError,
	Dirs,
	GnoDebugClient,
	GnoFrame,
	GnoLocation,
	localNames,
	parseStack,
	parseStop,
	parseValue
} from './gnoDebugClient';

export interface GnoLaunchArguments extends DebugProtocol.LaunchRequestArguments {
	// File or package directory passed to `gno run`.
	program: string;
	// Expression passed to `gno run -expr`, "main()" by default.
	expr?: string;
	cwd?: string;
	env?: { [key: string]: string };
	stopOnEntry?: boolean;
	// Path of the gno binary, "gno" by default.
	gnoPath?: string;
}

const THREAD_ID = 1;

export class GnoDebugSession extends DebugSession {
	private client = new GnoDebugClient();
	private proc?: ChildProcess;
	private dirs: Dirs = {};
	private stopOnEntry = false;
	private terminated = false;
	private frameLevel = 0;
	private frames: GnoFrame[] = [];
	private breakpoints = new Map<string, number[]>();

	constructor() {
		super();
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
		response.body = {
			supportsConfigurationDoneRequest: true,
			supportsEvaluateForHovers: true
		};
		this.sendResponse(response);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: GnoLaunchArguments): Promise<void> {
		await this.handle(response, async () => {
			const gno = args.gnoPath || 'gno';
			const cwd = args.cwd || path.dirname(path.resolve(args.program));
			const env = { ...process.env, ...args.env };
			this.stopOnEntry = !!args.stopOnEntry;
			const root = await gnoRoot(gno, cwd, env);

			// The VM matches a breakpoint against the file name it knows a source
			// by. With -debug it maps breakpoint paths under GNOROOT (stdlibs,
			// examples) to the relative names it uses for them, and other paths
			// stay absolute. The program is passed so that its own file names
			// follow the same rule: relative under GNOROOT, absolute elsewhere.
			let program = path.resolve(cwd, args.program);
			let runCwd = cwd;
			const programDir = isDir(program) ? program : path.dirname(program);
			const underRoot = !!root && isUnder(programDir, root);
			if (underRoot) {
				runCwd = programDir;
				program = program === programDir ? '.' : path.basename(program);
			}
			this.dirs = { gnoRoot: root, programDir: underRoot ? programDir : undefined };

			const port = await freePort();
			const runArgs = ['run', '-debug', '-debug-addr', `127.0.0.1:${port}`];
			if (args.expr) {
				runArgs.push('-expr', args.expr);
			}
			runArgs.push(program);
			this.output(`${gno} ${runArgs.join(' ')}\n`, 'console');

			const proc = spawn(gno, runArgs, { cwd: runCwd, env });
			this.proc = proc;
			proc.stdout?.on('data', (d) => this.output(d.toString(), 'stdout'));
			proc.stderr?.on('data', (d) =>
				this.output(
					d.toString().replace(/Waiting for debugger client to connect at \S+|^ connected!\n/g, ''),
					'stderr'
				)
			);
			const exited = new Promise<never>((_, reject) => {
				proc.on('error', reject);
				proc.on('exit', (code) => {
					this.sendEvent(new Event('exited', { exitCode: code ?? 0 }));
					this.terminate();
					reject(new Error(`gno exited with code ${code}`));
				});
			});
			exited.catch(() => undefined);
			this.client.onClose = () => this.terminate();
			await Promise.race([this.client.connect(port), exited]);
			this.sendEvent(new InitializedEvent());
		});
	}

	protected async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments
	): Promise<void> {
		await this.handle(response, async () => {
			const file = args.source.path ?? '';
			const lines = (args.breakpoints ?? []).map((b) => b.line);
			this.breakpoints.set(file, lines);
			// The debugger can only clear breakpoints by index and renumbers
			// them on clear, so every change resets all of them.
			await this.client.send('clear');
			const result: DebugProtocol.Breakpoint[] = [];
			for (const [f, ls] of this.breakpoints) {
				for (const line of ls) {
					const out = await this.client.send(`break ${f}:${line}`);
					if (f === file) {
						const err = commandError(out);
						result.push({ verified: !err, line, message: err });
					}
				}
			}
			response.body = { breakpoints: result };
		});
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
		this.sendResponse(response);
		if (this.stopOnEntry) {
			this.sendEvent(new StoppedEvent('entry', THREAD_ID));
		} else {
			this.resume('continue', 'breakpoint');
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse): void {
		response.body = { allThreadsContinued: true };
		this.sendResponse(response);
		this.resume('continue', 'breakpoint');
	}

	protected nextRequest(response: DebugProtocol.NextResponse): void {
		this.sendResponse(response);
		this.resume('next', 'step');
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse): void {
		this.sendResponse(response);
		this.resume('step', 'step');
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
		this.sendResponse(response);
		this.resume('stepout', 'step');
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = { threads: [new Thread(THREAD_ID, 'main')] };
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse): Promise<void> {
		await this.handle(response, async () => {
			this.frames = parseStack(await this.client.send('stack'), this.dirs);
			response.body = {
				stackFrames: this.frames.map(
					(f) => new StackFrame(f.index, f.func, source(f.loc), f.loc.line, f.loc.column)
				),
				totalFrames: this.frames.length
			};
		});
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		// Variable references must be positive, so frame n maps to reference n+1.
		response.body = { scopes: [new Scope('Locals', args.frameId + 1, false)] };
		this.sendResponse(response);
	}

	protected async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments
	): Promise<void> {
		await this.handle(response, async () => {
			const frame = this.frames.find((f) => f.index === args.variablesReference - 1);
			const variables: DebugProtocol.Variable[] = [];
			if (frame && fs.existsSync(frame.loc.file) && (await this.selectFrame(frame.index))) {
				const src = fs.readFileSync(frame.loc.file, 'utf8');
				for (const name of localNames(src, frame.loc.line)) {
					const v = parseValue(await this.client.send(`print ${name}`));
					if (v) {
						variables.push({ name, value: v.value, type: v.type, variablesReference: 0 });
					}
				}
			}
			response.body = { variables };
		});
	}

	protected async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments
	): Promise<void> {
		await this.handle(response, async () => {
			if (!(await this.selectFrame(args.frameId ?? 0))) {
				throw new Error('cannot select frame');
			}
			const out = await this.client.send(`print ${args.expression}`);
			const err = commandError(out);
			if (err) {
				throw new Error(err);
			}
			const v = parseValue(out);
			response.body = { result: v?.value ?? out.trim(), type: v?.type, variablesReference: 0 };
		});
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
		this.client.close();
		this.proc?.kill();
		this.sendResponse(response);
	}

	// resume runs a command which lets the program run, and reports the next stop.
	private async resume(cmd: string, reason: string) {
		this.frameLevel = 0;
		try {
			for (;;) {
				const out = await this.client.send(cmd);
				const stop = parseStop(out, this.dirs);
				// The VM matches breakpoints by file name and line only, so it
				// also stops in files of other packages with the same name.
				if (cmd === 'continue' && stop && !this.isBreakpoint(stop.loc)) {
					continue;
				}
				if (!stop && out.trim()) {
					this.output(out + '\n', 'console');
				}
				this.sendEvent(new StoppedEvent(reason, THREAD_ID));
				return;
			}
		} catch {
			this.terminate();
		}
	}

	// isBreakpoint reports whether loc is a breakpoint set by the user. A
	// location which could not be resolved to a file is assumed to be one.
	private isBreakpoint(loc: GnoLocation): boolean {
		if (!path.isAbsolute(loc.file)) {
			return true;
		}
		const file = canonical(loc.file);
		for (const [f, lines] of this.breakpoints) {
			if (lines.includes(loc.line) && canonical(f) === file) {
				return true;
			}
		}
		return false;
	}

	// selectFrame moves the debugger to frame n, so that print evaluates there.
	private async selectFrame(n: number): Promise<boolean> {
		if (n !== this.frameLevel) {
			const cmd = n > this.frameLevel ? `up ${n - this.frameLevel}` : `down ${this.frameLevel - n}`;
			const m = (await this.client.send(cmd)).match(/^Frame (\d+):/m);
			if (m) {
				this.frameLevel = Number(m[1]);
			}
		}
		return n === this.frameLevel;
	}

	private terminate() {
		if (!this.terminated) {
			this.terminated = true;
			this.sendEvent(new TerminatedEvent());
		}
	}

	private output(text: string, category: string) {
		if (text) {
			this.sendEvent(new OutputEvent(text, category));
		}
	}

	private async handle(response: DebugProtocol.Response, fn: () => Promise<void>) {
		try {
			await fn();
			this.sendResponse(response);
		} catch (e) {
			this.sendErrorResponse(response, 1, e instanceof Error ? e.message : String(e));
		}
	}
}

function source(loc: GnoLocation): Source | undefined {
	return path.isAbsolute(loc.file) ? new Source(path.basename(loc.file), loc.file) : undefined;
}

function canonical(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return p;
	}
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isUnder(p: string, dir: string): boolean {
	const rel = path.relative(canonical(dir), canonical(p));
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function gnoRoot(gno: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise((resolve) =>
		execFile(gno, ['env', 'GNOROOT'], { cwd, env }, (err, stdout) =>
			resolve(err ? undefined : stdout.trim() || undefined)
		)
	);
}
