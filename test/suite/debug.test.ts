import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

suite('Gno debugger', () => {
	suiteSetup(function () {
		try {
			execFileSync('gno', ['env', 'GNOROOT']);
		} catch {
			this.skip();
		}
	});

	// F5 without a launch.json, while an output panel has the focus, so that
	// vscode.window.activeTextEditor and ${file} are the panel, not the file.
	test('F5 debugs the package of the active file', async function () {
		this.timeout(60000);
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gnof5-')));
		const file = path.join(dir, 'main.gno');
		fs.writeFileSync(file, 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n');
		try {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			vscode.window.createOutputChannel('focus').show(false);

			const started = new Promise<vscode.DebugSession>((resolve) => {
				const d = vscode.debug.onDidStartDebugSession((s) => {
					d.dispose();
					resolve(s);
				});
			});
			const ended = new Promise<void>((resolve) => {
				const d = vscode.debug.onDidTerminateDebugSession(() => {
					d.dispose();
					resolve();
				});
			});
			await vscode.commands.executeCommand('workbench.action.debug.start');
			const session = await Promise.race([
				started,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('F5 started no session')), 15000))
			]);
			assert.strictEqual(session.type, 'gno');
			assert.strictEqual(session.configuration.program, dir);
			await ended;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
