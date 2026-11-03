import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('activates and registers commands', async function () {
		this.timeout(60000);
		const ext = vscode.extensions.getExtension('Gnoverse.gnolang');
		assert.ok(ext, 'extension not found');
		await ext.activate();
		assert.ok(ext.isActive);
		const cmds = await vscode.commands.getCommands(true);
		assert.ok(cmds.includes('gno.languageserver.restart'));
		// Errors of the language client surface asynchronously after activation.
		await new Promise((r) => setTimeout(r, 5000));
	});
});
