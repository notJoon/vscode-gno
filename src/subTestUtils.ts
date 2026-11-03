/*---------------------------------------------------------
 * Copyright 2022 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

/**
 * Escapes the subtest target name for the given test and subtest names.
 *
 * This function generates a name that matches a specific test by following Go
 * regexp rules for `go test -run` argument. Specifically it escapes slashes,
 * replaces whitespaces with underscores and wraps everything else with literal
 * escape sequences.
 *
 * @param testFuncName Name of the parent test function, e.g. "TestTask"
 * @param subTestName Name of the subtest, e.g. "GET /path/:id"
 */
export function escapeSubTestName(testFuncName: string, subTestName: string): string {
	return `${testFuncName}/${subTestName}`
		.replace(/\s/g, '_')
		.split('/')
		.map((part) => escapeRegExp(part), '')
		.join('$/^');
}

// escapeRegExp escapes regex metacharacters.
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
export function escapeRegExp(v: string) {
	return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the `gno test -run` pattern for a run of `gno test .` in the package
 * directory. Test functions are matched by exact name. A filetest has no test
 * function: gno names it `<dir>/<file>`, which is `./<file>` here, so its
 * pattern matches the two elements and no `TestXxx`. gno splits the pattern on
 * a top level `|` first, so both kinds can be selected at once.
 *
 * @param functions Names of the test functions to run.
 * @param filetests Base names of the `*_filetest.gno` files to run.
 * @returns The pattern, or undefined to run all tests.
 */
export function gnoTestRunPattern(functions: string[] = [], filetests: string[] = []): string | undefined {
	const patterns = [];
	if (functions.length > 0) {
		patterns.push(`^(${functions.join('|')})$`);
	}
	if (filetests.length > 0) {
		patterns.push(`^\\.$/^(${filetests.map(escapeRegExp).join('|')})$`);
	}
	return patterns.length > 0 ? patterns.join('|') : undefined;
}
