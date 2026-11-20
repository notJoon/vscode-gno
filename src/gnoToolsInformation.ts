// <!-- Everything below this line is generated. DO NOT EDIT. -->

import moment = require('moment');
import semver = require('semver');
import { Tool } from './gnoTools';

export const allToolsInformation: { [key: string]: Tool } = {
	gnopls: {
		name: 'gnopls',
		importPath: 'github.com/gnoverse/gnopls',
		modulePath: 'github.com/gnoverse/gnopls',
		replacedByGopls: false, // lol
		isImportant: true,
		description: 'Language Server Protocol for Gnolang',
		latestVersion: semver.parse('%s'),
		latestVersionTimestamp: moment('%s', 'YYYY-MM-DD'),
		latestPrereleaseVersion: semver.parse('%s'),
		latestPrereleaseVersionTimestamp: moment('%s', 'YYYY-MM-DD')
	}
};
