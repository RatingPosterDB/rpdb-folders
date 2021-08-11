const isDocker = require('is-docker')
const path = require('path')

const forbiddenChar = process.platform == 'linux' || isDocker() ? '/' : ':'

const browser = require('./browser')

module.exports = async (mediaFolders, mediaType, unmatchedFolders) => {
	let folders = []
	if ((mediaFolders || []).length == 1 && mediaFolders[0] == 'Unmatched') {
		return {
			forbiddenChar,
			folders: forbiddenChar + Object.keys(unmatchedFolders[mediaType]).join(forbiddenChar + forbiddenChar) + forbiddenChar
		}
	} else {
		for (let i = 0; mediaFolders[i]; i++) {
			const dirScan = await browser(mediaFolders[i], !!(mediaType == 'movie'))
			folders = folders.concat(dirScan || [])
		}
		return {
			forbiddenChar,
			folders: forbiddenChar + folders.map(el => path.basename(el.path || '')).join(forbiddenChar + forbiddenChar) + forbiddenChar
		}
	}
}
