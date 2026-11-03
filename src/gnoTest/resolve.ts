/*---------------------------------------------------------
 * Copyright 2021 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/
import {
	CancellationToken,
	DocumentSymbol,
	FileType,
	Range,
	SymbolKind,
	TestController,
	TestItem,
	TestItemCollection,
	TextDocument,
	Uri,
	workspace,
	WorkspaceFolder
} from 'vscode';
import path = require('path');
import vscode = require('vscode');
import { outputChannel } from '../gnoStatus';
import { getCurrentGoPath } from '../util';
import { getGnoConfig } from '../config';
import { testPackageDir } from '../testUtils';
import { dispose, disposeIfEmpty, FileSystem, GoTest, GoTestKind, findModuleName, isInTest, Workspace } from './utils';
import { walk, WalkStop } from './walk';

export type ProvideSymbols = (doc: TextDocument, token?: CancellationToken) => Thenable<DocumentSymbol[]>;

const testFuncRegex = /^(?<name>(?<kind>Test|Benchmark|Example|Fuzz)($|\P{Ll}.*))/u;
const testMethodRegex = /^\(\*(?<type>[^)]+)\)\.(?<name>(?<kind>Test)($|\P{Ll}.*))$/u;
const runTestSuiteRegex = /^\s*suite\.Run\(\w+,\s*(?:&?(?<type1>\w+)\{\}|new\((?<type2>\w+)\))\)/mu;

interface TestSuite {
	func?: TestItem;
	methods: Set<TestItem>;
}

export class GoTestResolver {
	public readonly all = new Map<string, TestItem>();
	public readonly isDynamicSubtest = new WeakSet<TestItem>();
	public readonly isTestMethod = new WeakSet<TestItem>();
	public readonly isTestSuiteFunc = new WeakSet<TestItem>();
	private readonly testSuites = new Map<string, TestSuite>();

	constructor(
		private readonly workspace: Workspace,
		private readonly ctrl: TestController,
		private readonly provideDocumentSymbols: ProvideSymbols
	) {
		ctrl.resolveHandler = async (item) => {
			try {
				await this.resolve(item);
				this.updateGoTestContext();
			} catch (error) {
				if (isInTest()) throw error;

				const m = 'Failed to resolve tests';
				outputChannel.error(`${m}: ${error}`);
			}
		};
	}

	get items() {
		return this.ctrl.items;
	}

	async resolve(item?: TestItem) {
		// Expand the root item - find all modules and workspaces
		if (!item) {
			// Dispose of package entries at the root if they are now part of a workspace folder
			this.ctrl.items.forEach((item) => {
				const { kind } = GoTest.parseId(item.id);
				if (kind !== 'package') {
					return;
				}

				if (item.uri && this.workspace.getWorkspaceFolder(item.uri)) {
					dispose(this, item);
				}
			});

			// Create entries for all modules and workspaces
			for (const folder of this.workspace.workspaceFolders || []) {
				const found = await walkWorkspaces(this.workspace.fs, folder.uri);
				let needWorkspace = false;
				for (const [uri, isMod] of found.entries()) {
					if (!isMod) {
						needWorkspace = true;
						continue;
					}

					await this.getModule(Uri.parse(uri));
				}

				// If the workspace folder contains any Go files not in a module, create a workspace entry
				if (needWorkspace) {
					await this.getWorkspace(folder);
				}
			}
			return;
		}

		const { kind } = GoTest.parseId(item.id);

		if (!item.uri) return;
		// The user expanded a module or workspace - find all packages
		if (kind === 'module' || kind === 'workspace') {
			await walkPackages(this.workspace.fs, item.uri, async (uri) => {
				await this.getPackage(uri);
			});
		}

		// The user expanded a module or package. Find all test files, including
		// the filetests in a filetests directory.
		if (kind === 'module' || kind === 'package') {
			for (const [file, type] of await this.workspace.fs.readDirectory(item.uri)) {
				if (type === FileType.File && isTestFile(file)) {
					await this.getFile(Uri.joinPath(item.uri, file));
				}
				if (type !== FileType.Directory || file !== 'filetests') {
					continue;
				}
				const dir = Uri.joinPath(item.uri, file);
				for (const [file, type] of await this.workspace.fs.readDirectory(dir)) {
					if (type === FileType.File && file.endsWith('_filetest.gno')) {
						await this.getFile(Uri.joinPath(dir, file));
					}
				}
			}
		}

		// The user expanded a file - find all functions
		if (kind === 'file') {
			const doc = await this.workspace.openTextDocument(item.uri);
			await this.processDocument(doc);
		}

		// TODO(firelizzard18): If uri.query is test or benchmark, this is where we
		// would discover sub tests or benchmarks, if that is feasible.
	}

	// Find test items related to the given resource
	find(resource: Uri): TestItem[] {
		const findStr = resource.toString();
		const found: TestItem[] = [];

		function find(items: TestItemCollection) {
			items.forEach((item) => {
				const itemStr = item.uri?.toString();
				if (findStr === itemStr) {
					found.push(item);
					find(item.children);
				} else if (itemStr && findStr.startsWith(itemStr)) {
					find(item.children);
				}
			});
		}

		find(this.ctrl.items);
		return found;
	}

	get allItems() {
		function* it(coll: TestItemCollection): Generator<TestItem> {
			const arr: TestItem[] = [];
			coll.forEach((x) => arr.push(x));

			for (const item of arr) {
				yield item;
				yield* it(item.children);
			}
		}

		return it(this.items);
	}

	// Create or Retrieve a sub test or benchmark. This is always dynamically
	// called while processing test run output.
	// The parent's uri is of the form:
	//     file:///path/to/mod/file.go?test#TestXxx%2fA%2fB%2fC
	// The name is the name of the subtest to get or create.
	// The label is the title presented in the UI.
	// We expect the caller to call getOrCreateSubTest with the
	// right parent.
	// For example, if TestXxx has subtests and we are processing
	// TestXxx/Sub1/Sub2, the parent item should be a node corresponding
	// to TestXxx/Sub1, the label is Sub2 while the name is TestXxx/Sub1/Sub2.
	getOrCreateSubTest(parent: TestItem, label: string, name: string): TestItem | undefined {
		if (!parent.uri) return;
		const { kind } = GoTest.parseId(parent.id);

		let existing: TestItem | undefined;
		parent.children.forEach((child) => {
			if (child.label === label) existing = child;
		});
		if (existing) return existing;

		parent.canResolveChildren = true;
		const sub = this.createItem(label, parent.uri, kind, name);
		parent.children.add(sub);

		this.isDynamicSubtest.add(sub);
		if (this.shouldSetRange(parent)) {
			sub.range = parent.range;
		}

		return sub;
	}

	// Processes a Go document, calling processSymbol for each symbol in the
	// document.
	//
	// Any previously existing tests that no longer have a corresponding symbol in
	// the file will be disposed. If the document contains no tests, it will be
	// disposed.
	async processDocument(doc: TextDocument, ranges?: Range[]) {
		const seen = new Set<string>();
		const item = await this.getFile(doc.uri);
		if (doc.uri.path.endsWith('_filetest.gno')) {
			// A filetest runs as a whole, so it has a single test item. Edits do
			// not move it, it stays at the top of the file.
			const name = path.basename(doc.uri.path);
			seen.add(name);
			this.getOrCreateItem(item, 'main', doc.uri, 'filetest', name).range = doc.lineAt(0).range;
			ranges = undefined;
		} else {
			const symbols = await this.provideDocumentSymbols(doc);
			for (const symbol of symbols) {
				await this.processSymbol(doc, item, seen, false, symbol);
			}
		}

		item.children.forEach((child) => {
			const { name } = GoTest.parseId(child.id);
			if (!name || !seen.has(name)) {
				dispose(this, child);
				return;
			}

			if (ranges?.some((r) => !!child.range?.intersection(r))) {
				item.children.forEach((x) => dispose(this, x));
			}
		});

		disposeIfEmpty(this, item);
	}

	public updateGoTestContext() {
		const items = [];
		for (const item of this.allItems) {
			items.push(item.id);
		}
		vscode.commands.executeCommand('setContext', 'gno.tests', items);
	}

	// Retrieve or create an item for a Go file.
	public async getFile(uri: Uri): Promise<TestItem> {
		const dir = testPackageDir(uri.path);
		const pkg = await this.getPackage(uri.with({ path: dir, query: '', fragment: '' }));
		const existing = this.getItem(pkg, uri, 'file');
		if (existing) {
			return existing;
		}

		const label = path.basename(uri.path);
		const item = this.getOrCreateItem(pkg, label, uri, 'file');
		item.canResolveChildren = true;
		return item;
	}

	/* ***** Private ***** */

	private shouldSetRange(item: TestItem): boolean {
		const config = getGnoConfig(item.uri);
		return !!config.get<boolean>('testExplorer.showDynamicSubtestsInEditor');
	}

	// Create an item.
	private createItem(label: string, uri: Uri, kind: GoTestKind, name?: string): TestItem {
		const id = GoTest.id(uri, kind, name);
		const item = this.ctrl.createTestItem(id, label, uri.with({ query: '', fragment: '' }));
		this.all.set(id, item);
		return item;
	}

	// Retrieve an item.
	private getItem(parent: TestItem | undefined, uri: Uri, kind: GoTestKind, name?: string): TestItem | undefined {
		return (parent?.children || this.ctrl.items).get(GoTest.id(uri, kind, name));
	}

	// Create or retrieve an item.
	private getOrCreateItem(
		parent: TestItem | undefined,
		label: string,
		uri: Uri,
		kind: GoTestKind,
		name?: string
	): TestItem {
		const existing = this.getItem(parent, uri, kind, name);
		if (existing) return existing;

		const item = this.createItem(label, uri, kind, name);
		(parent?.children || this.ctrl.items).add(item);
		return item;
	}

	// If a test/benchmark with children is relocated, update the children's
	// location.
	private relocateChildren(item: TestItem) {
		item.children.forEach((child) => {
			if (!this.isDynamicSubtest.has(child)) return;
			if (!this.shouldSetRange(child)) return;

			child.range = item.range;
			this.relocateChildren(child);
		});
	}

	// Retrieve or create an item for a Go module.
	private async getModule(uri: Uri): Promise<TestItem> {
		const existing = this.getItem(undefined, uri, 'module');
		if (existing) {
			return existing;
		}

		const contents = await readModFile(this.workspace.fs, uri);
		if (!contents) {
			throw new Error(`no gnomod.toml or gno.mod in ${uri.fsPath}`);
		}

		// Use the module name as the label
		const label = findModuleName(contents.toString());
		const item = this.getOrCreateItem(undefined, label, uri, 'module');
		item.canResolveChildren = true;
		return item;
	}

	// Retrieve or create an item for a workspace folder that is not a module.
	private async getWorkspace(ws: WorkspaceFolder): Promise<TestItem> {
		const existing = this.getItem(undefined, ws.uri, 'workspace');
		if (existing) {
			return existing;
		}

		// Use the workspace folder name as the label
		const item = this.getOrCreateItem(undefined, ws.name, ws.uri, 'workspace');
		item.canResolveChildren = true;
		return item;
	}

	// Retrieve or create an item for a Go package.
	private async getPackage(uri: Uri): Promise<TestItem | undefined> {
		let item: TestItem;

		const nested = getGnoConfig(uri).get('testExplorer.packageDisplayMode') === 'nested';
		const wsfolder = workspace.getWorkspaceFolder(uri);
		const modDir = await findModuleDir(this.workspace.fs, uri, wsfolder);
		if (modDir) {
			// If the package is in a module, add it as a child of the module
			let parent = await this.getModule(modDir);
			if (uri.path === parent.uri?.path) {
				return parent;
			}

			if (nested) {
				const bits = parent.uri ? path.relative(parent.uri.fsPath, uri.fsPath).split(path.sep) : [];
				while (bits.length > 1) {
					if (!parent.uri?.path) continue;
					const dir = bits.shift();
					if (!dir) continue;
					const dirUri = uri.with({
						path: Uri.file(path.join(parent.uri.fsPath, dir)).path,
						query: '',
						fragment: ''
					});
					parent = this.getOrCreateItem(parent, dir, dirUri, 'package');
				}
			}

			const label =
				parent.uri && uri.path.startsWith(parent.uri.path)
					? uri.path.substring(parent.uri.path.length + 1)
					: uri.path;
			item = this.getOrCreateItem(parent, label, uri, 'package');
		} else if (wsfolder) {
			// If the package is in a workspace folder, add it as a child of the workspace
			const workspace = await this.getWorkspace(wsfolder);
			const existing = this.getItem(workspace, uri, 'package');
			if (existing) {
				return existing;
			}

			const label = uri.path.startsWith(wsfolder.uri.path)
				? uri.path.substring(wsfolder.uri.path.length + 1)
				: uri.path;
			item = this.getOrCreateItem(workspace, label, uri, 'package');
		} else {
			// Otherwise, add it directly to the root
			const existing = this.getItem(undefined, uri, 'package');
			if (existing) {
				return existing;
			}

			const srcPath = path.join(getCurrentGoPath(uri), 'src');
			const label = uri.path.startsWith(srcPath) ? uri.path.substring(srcPath.length + 1) : uri.path;
			item = this.getOrCreateItem(undefined, label, uri, 'package');
		}

		item.canResolveChildren = true;
		return item;
	}

	private getTestSuite(type: string): TestSuite {
		if (this.testSuites.has(type)) {
			return this.testSuites.get(type) as TestSuite;
		}

		const methods = new Set<TestItem>();
		const suite = { methods };
		this.testSuites.set(type, suite);
		return suite;
	}

	// Recursively process a Go AST symbol. If the symbol represents a test, fuzz test,
	// benchmark, or example function, a test item will be created for it, if one
	// does not already exist. If the symbol is not a function and contains
	// children, those children will be processed recursively.
	private async processSymbol(
		doc: TextDocument,
		file: TestItem,
		seen: Set<string>,
		importsTestify: boolean,
		symbol: DocumentSymbol
	) {
		// Skip TestMain(*testing.M) - allow TestMain(*testing.T)
		if (symbol.name === 'TestMain' && /\*testing.M\)/.test(symbol.detail)) {
			return;
		}

		// Recursively process symbols that are nested
		if (symbol.kind !== SymbolKind.Function && symbol.kind !== SymbolKind.Method) {
			for (const sym of symbol.children) await this.processSymbol(doc, file, seen, importsTestify, sym);
			return;
		}

		const match = symbol.name.match(testFuncRegex) || (importsTestify && symbol.name.match(testMethodRegex));
		if (!match) {
			return;
		}

		seen.add(symbol.name);

		const kind = match.groups?.kind.toLowerCase() as GoTestKind;
		const suite = match.groups?.type ? this.getTestSuite(match.groups.type) : undefined;
		const existing =
			this.getItem(file, doc.uri, kind, symbol.name) ||
			(suite?.func && this.getItem(suite?.func, doc.uri, kind, symbol.name));

		if (existing) {
			if (!existing.range?.isEqual(symbol.range)) {
				existing.range = symbol.range;
				this.relocateChildren(existing);
			}
			return existing;
		}

		const item = this.getOrCreateItem(
			suite?.func || file,
			match.groups?.name ?? '<none>',
			doc.uri,
			kind,
			symbol.name
		);
		item.range = symbol.range;

		if (suite) {
			this.isTestMethod.add(item);
			if (!suite.func) suite.methods.add(item);
			return;
		}

		if (!importsTestify) {
			return;
		}

		// Runs any suite
		const text = doc.getText(symbol.range);
		if (text.includes('suite.Run(')) {
			this.isTestSuiteFunc.add(item);
		}

		// Runs a specific suite
		// - suite.Run(t, new(MySuite))
		// - suite.Run(t, MySuite{})
		// - suite.Run(t, &MySuite{})
		const matchRunSuite = text.match(runTestSuiteRegex);
		if (matchRunSuite) {
			const g = matchRunSuite.groups;
			const suite = this.getTestSuite(g?.type1 || g?.type2 || '');
			suite.func = item;

			for (const method of suite.methods) {
				if (!method.parent || GoTest.parseId(method.parent.id).kind !== 'file') {
					continue;
				}

				method.parent.children.delete(method.id);
				item.children.add(method);
			}
		}
	}
}

// Walk the workspace, looking for Go modules. Returns a map indicating paths
// that are modules (value == true) and paths that are not modules but contain
// Go files (value == false).
async function walkWorkspaces(fs: FileSystem, uri: Uri): Promise<Map<string, boolean>> {
	const found = new Map<string, boolean>();
	await walk(fs, uri, async (dir, file, type) => {
		if (type !== FileType.File) {
			return;
		}

		if (modFiles.includes(file)) {
			// BUG(firelizard18): This does not create a separate entry for
			// modules within a module. Thus, tests in a module within another
			// module will appear under the top-level module's tree. This may or
			// may not be acceptable.
			found.set(dir.toString(), true);
			return WalkStop.Current;
		}

		if (file.endsWith('.gno')) {
			found.set(dir.toString(), false);
		}
	});
	return found;
}

/**
 * Walks the workspace, calling the callback for any package directory that
 * contains a test file or a filetest, directly or in its filetests directory.
 */
async function walkPackages(fs: FileSystem, uri: Uri, cb: (uri: Uri) => Promise<unknown>) {
	await walk(fs, uri, async (dir, file) => {
		if (isTestFile(file)) {
			await cb(Uri.file(testPackageDir(Uri.joinPath(dir, file).fsPath)));
			return WalkStop.Files;
		}
	});
}

/**
 * Files that declare a module, gnomod.toml first.
 */
const modFiles = ['gnomod.toml', 'gno.mod'];

/**
 * Returns whether the file holds unit tests or is a filetest.
 */
function isTestFile(file: string): boolean {
	return file.endsWith('_test.gno') || file.endsWith('_filetest.gno');
}

/**
 * Reads the module file of a directory.
 *
 * @returns The contents, or undefined if the directory has no module file.
 */
async function readModFile(fs: FileSystem, dir: Uri): Promise<Uint8Array | undefined> {
	for (const file of modFiles) {
		try {
			return await fs.readFile(Uri.joinPath(dir, file));
		} catch {
			// Try the next one.
		}
	}
	return undefined;
}

/**
 * Finds the module of a package, which is the closest directory with a module
 * file from the package directory up to the workspace folder.
 *
 * @returns The module directory, or undefined outside of a module.
 */
async function findModuleDir(fs: FileSystem, dir: Uri, ws?: WorkspaceFolder): Promise<Uri | undefined> {
	for (let d = dir; ;) {
		if (await readModFile(fs, d)) {
			return d;
		}
		const parent = Uri.joinPath(d, '..');
		if (parent.path === d.path || !ws || !parent.path.startsWith(ws.uri.path)) {
			return undefined;
		}
		d = parent;
	}
}
