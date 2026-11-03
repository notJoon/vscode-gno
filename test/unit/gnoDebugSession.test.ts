import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { GnoDebugSession } from '../../src/debugAdapter/gnoDebugSession';

const MAIN = `package main

func add(a, b int) int {
	c := a + b
	return c
}

func main() {
	x := 1
	y := add(x, 2)
	println("result", y)
}
`;

function gnoRoot(): string | undefined {
	try {
		return execFileSync('gno', ['env', 'GNOROOT']).toString().trim();
	} catch {
		return undefined;
	}
}

// UPPER calls strings.ToUpper, so that a breakpoint can be set in a stdlib.
const UPPER = `package main

import "strings"

func main() {
	println(strings.ToUpper("ab"))
}
`;

/**
 * Returns the line number, counted from 1, of the first line of src matching re.
 *
 * @param from - Number of lines to skip at the start of src.
 */
function lineOf(src: string, re: RegExp, from = 0): number {
	return src.split('\n').findIndex((l, i) => i >= from && re.test(l)) + 1;
}

// Drives a real `gno run -debug-addr` through the adapter. Skipped without gno.
suite('GnoDebugSession', function () {
	this.timeout(30000);
	let dir: string;
	let server: net.Server;
	let dc: DebugClient;
	let root: string;
	let stdFile: string;
	let stdLine: number;
	const launchArgs = () => ({ type: 'gno', request: 'launch', program: dir });

	/** Connects a new client to the adapter server. */
	async function connect() {
		dc = new DebugClient('node', '', 'gno');
		await dc.start((server.address() as net.AddressInfo).port);
	}

	/** Replaces the client, ending its session, to launch the program again. */
	async function restart() {
		await dc.stop();
		await connect();
	}

	suiteSetup(function () {
		const r = gnoRoot();
		if (!r) {
			this.skip();
		}
		root = fs.realpathSync(r);
		stdFile = path.join(root, 'gnovm', 'stdlibs', 'strings', 'strings.gno');
		// A statement of strings.ToUpper. The VM never stops at some statements
		// such as its first one, assigning constants.
		const src = fs.readFileSync(stdFile, 'utf8');
		stdLine = lineOf(src, /^\t\tc := s\[i\]$/, lineOf(src, /^func ToUpper\(/));
	});

	setup(async () => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gnodbg-')));
		fs.writeFileSync(path.join(dir, 'main.gno'), MAIN);
		server = net
			.createServer((s) => {
				const session = new GnoDebugSession();
				// Without server mode the session exits the process on disconnect.
				session.setRunAsServer(true);
				session.start(s, s);
			})
			.listen(0);
		await connect();
	});

	teardown(async () => {
		await dc.stop();
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('stops at a breakpoint, shows locals and steps to the end', async () => {
		const file = path.join(dir, 'main.gno');
		await dc.hitBreakpoint(launchArgs(), { path: file, line: 4 });

		const st = await dc.stackTraceRequest({ threadId: 1 });
		assert.deepStrictEqual(
			st.body.stackFrames.map((f) => [f.name, f.line, f.source?.path]),
			[
				['main.add', 4, file],
				['main.main', 10, file]
			]
		);

		const vars = await dc.variablesRequest({ variablesReference: 1 });
		assert.deepStrictEqual(
			vars.body.variables.map((v) => [v.name, v.value, v.type]),
			[
				['a', '1', 'int'],
				['b', '2', 'int']
			]
		);
		// Frame 1 (main) sees its own locals.
		const x = await dc.evaluateRequest({ expression: 'x', frameId: 1 });
		assert.strictEqual(x.body.result, '1');
		const c = await dc.evaluateRequest({ expression: 'a + 1', frameId: 0 }).catch((e: Error) => e);
		assert.ok(c instanceof Error, 'unsupported expressions are reported as errors');

		await Promise.all([dc.nextRequest({ threadId: 1 }), dc.assertStoppedLocation('step', { path: file, line: 5 })]);
		// Step out lands on the call site in main, not on the return statement of add.
		await Promise.all([
			dc.stepOutRequest({ threadId: 1 }),
			dc.assertStoppedLocation('step', { path: file, line: 10 })
		]);
		const out = await dc.stackTraceRequest({ threadId: 1 });
		assert.strictEqual(out.body.stackFrames[0].name, 'main.main');

		await Promise.all([
			dc.continueRequest({ threadId: 1 }),
			dc.assertOutput('stdout', 'result 3'),
			dc.waitForEvent('terminated')
		]);
	});

	// The VM stops several times on a breakpoint line during one execution of it.
	test('stops once per execution of a breakpoint line', async () => {
		const file = path.join(dir, 'main.gno');

		// An expression statement, then the end of the program.
		await dc.hitBreakpoint(launchArgs(), { path: file, line: 4 });
		await Promise.all([
			dc.continueRequest({ threadId: 1 }),
			dc.assertOutput('stdout', 'result 3'),
			dc.waitForEvent('terminated')
		]);

		// A call line and a breakpoint in the callee: the call line does not
		// stop again when the callee returns.
		await restart();
		await dc.hitBreakpoint(launchArgs(), { path: file, line: 10 });
		await dc.setBreakpointsRequest({ source: { path: file }, breakpoints: [{ line: 10 }, { line: 4 }] });
		await Promise.all([dc.continueRequest({ threadId: 1 }), dc.assertStoppedLocation('breakpoint', { line: 4 })]);
		await Promise.all([dc.continueRequest({ threadId: 1 }), dc.waitForEvent('terminated')]);

		// A loop body stops once per iteration.
		fs.writeFileSync(
			file,
			'package main\n\nfunc main() {\n\ts := 0\n\tfor i := 0; i < 3; i++ {\n\t\ts += i\n\t}\n\tprintln(s)\n}\n'
		);
		await restart();
		await dc.hitBreakpoint(launchArgs(), { path: file, line: 6 });
		for (let i = 1; i < 3; i++) {
			await Promise.all([
				dc.continueRequest({ threadId: 1 }),
				dc.assertStoppedLocation('breakpoint', { line: 6 })
			]);
			const v = await dc.evaluateRequest({ expression: 'i', frameId: 0 });
			assert.strictEqual(v.body.result, String(i));
		}
		await Promise.all([dc.continueRequest({ threadId: 1 }), dc.waitForEvent('terminated')]);
	});

	test('steps into a function and into a stdlib', async () => {
		const file = path.join(dir, 'main.gno');
		await dc.hitBreakpoint(launchArgs(), { path: file, line: 10 });
		await Promise.all([
			dc.stepInRequest({ threadId: 1 }),
			dc.assertStoppedLocation('step', { path: file, line: 4 })
		]);
		// Step out from the first line of add, not from its return statement.
		await Promise.all([
			dc.stepOutRequest({ threadId: 1 }),
			dc.assertStoppedLocation('step', { path: file, line: 10 })
		]);

		fs.writeFileSync(file, UPPER);
		await restart();
		await dc.hitBreakpoint(launchArgs(), { path: file, line: 6 });
		const [, stopped] = await Promise.all([dc.stepInRequest({ threadId: 1 }), dc.waitForEvent('stopped')]);
		assert.strictEqual(stopped.body.reason, 'step');
		const st = await dc.stackTraceRequest({ threadId: 1 });
		const top = st.body.stackFrames[0];
		assert.strictEqual(top.name, 'strings.ToUpper');
		assert.strictEqual(top.source?.path, stdFile);
		assert.ok(top.line > lineOf(fs.readFileSync(stdFile, 'utf8'), /^func ToUpper\(/), `line ${top.line}`);
	});

	test('stops at a breakpoint in a stdlib', async () => {
		fs.writeFileSync(path.join(dir, 'main.gno'), UPPER);
		await dc.hitBreakpoint(launchArgs(), { path: stdFile, line: stdLine });
		const st = await dc.stackTraceRequest({ threadId: 1 });
		assert.strictEqual(st.body.stackFrames[0].name, 'strings.ToUpper');
		const s = await dc.evaluateRequest({ expression: 's', frameId: 0 });
		assert.strictEqual(s.body.result, '"ab"');
	});

	// A program under GNOROOT is known to the VM by relative file names, like
	// the stdlibs. The fake GNOROOT reuses the real stdlibs.
	suite('program under GNOROOT', () => {
		let fakeRoot: string;
		let pkg: string;
		let launch: { type: string; request: string; program: string; env: { [key: string]: string } };

		setup(() => {
			fakeRoot = path.join(dir, 'root');
			pkg = path.join(fakeRoot, 'examples', 'gno.land', 'p', 'demo', 'dbgt');
			fs.mkdirSync(pkg, { recursive: true });
			fs.symlinkSync(path.join(root, 'gnovm'), path.join(fakeRoot, 'gnovm'));
			launch = { type: 'gno', request: 'launch', program: pkg, env: { GNOROOT: fakeRoot } };
		});

		test('stops at a breakpoint in the program', async () => {
			const file = path.join(pkg, 'main.gno');
			fs.writeFileSync(file, MAIN);
			await dc.hitBreakpoint(launch, { path: file, line: 4 });
		});

		test('skips a breakpoint hit in a file of another package with the same name', async () => {
			// The program has its own strings.gno, executing a statement at the
			// line of the stdlib breakpoint before strings.ToUpper is called.
			const pad = '\n'.repeat(stdLine - 3);
			fs.writeFileSync(path.join(pkg, 'strings.gno'), `package main\n\nfunc pad() {${pad}\tprintln("pad")\n}\n`);
			assert.strictEqual(
				lineOf(fs.readFileSync(path.join(pkg, 'strings.gno'), 'utf8'), /println\("pad"\)/),
				stdLine
			);
			fs.writeFileSync(path.join(pkg, 'main.gno'), UPPER.replace('func main() {', 'func main() {\n\tpad()'));
			await dc.hitBreakpoint(launch, {
				path: path.join(fakeRoot, 'gnovm', 'stdlibs', 'strings', 'strings.gno'),
				line: stdLine
			});
			const st = await dc.stackTraceRequest({ threadId: 1 });
			assert.strictEqual(st.body.stackFrames[0].name, 'strings.ToUpper');
		});
	});
});
