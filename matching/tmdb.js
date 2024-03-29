
const needle = require('needle')
const stringHelper = require('../strings')

const tmdbKey = require('../tmdbKey').key

function tmdbToImdb(tmdbId, tmdbType, cb) {
	needle.get('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '?api_key=' + tmdbKey + '&append_to_response=external_ids', { response_timeout: 15000, read_timeout: 15000 }, (err, resp, body) => {
		if (((body || {}).external_ids || {}).imdb_id) {
			cb(body.external_ids.imdb_id, body.poster_path)
		} else cb(false)
	})
}

function folderNameFromTMDBtoImdb(obj, cb) {
	const tmdbObj = {
		type: obj.type == 'movie' ? 'movie' : 'tv',
		name: obj.name,
		year: obj.year,
	}
	needle.get('https://api.themoviedb.org/3/search/' + tmdbObj.type + '?api_key=' + tmdbKey + '&query=' + encodeURIComponent(tmdbObj.name) + '&include_adult=false' + (tmdbObj.year ? '&' + (tmdbObj.type == 'movie' ? 'year' : 'first_air_date_year') + '=' + tmdbObj.year : ''), { response_timeout: 15000, read_timeout: 15000 }, (err, resp, body) => {
		let shouldAcceptResult = !!(tmdbObj.year && (((body || {}).results || [])[0] || {}).id)
		if (!shouldAcceptResult && !tmdbObj.year)
			shouldAcceptResult = !!(
										(body || {}).total_results == 1 ||
										stringHelper.sanitizeName((((body || {}).results || [])[0] || {}).title || '') == stringHelper.sanitizeName(tmdbObj.name) ||
										stringHelper.sanitizeName((((body || {}).results || [])[0] || {}).original_title || '') == stringHelper.sanitizeName(tmdbObj.name)
									)
		if (shouldAcceptResult && (((body || {}).results || [])[0] || {}).id) {
			tmdbToImdb(body.results[0].id, tmdbObj.type, cb)
		} else {
			if (tmdbObj.year) {
				delete tmdbObj.year
				folderNameFromTMDBtoImdb(tmdbObj, cb)
			} else {
				cb(false)
			}
		}
	})
}

module.exports = {
	tmdbToImdb,
	folderNameFromTMDBtoImdb,
	tmdbIdFromUrl: tmdbUrl => {
		let tmdbTemp = tmdbUrl
		tmdbTemp = tmdbTemp.replace('https://www.themoviedb.org/movie/', '')
		tmdbTemp = tmdbTemp.replace('https://themoviedb.org/movie/', '')
		tmdbTemp = tmdbTemp.replace('http://www.themoviedb.org/movie/', '')
		tmdbTemp = tmdbTemp.replace('http://themoviedb.org/movie/', '')
		tmdbTemp = tmdbTemp.replace('https://www.themoviedb.org/tv/', '')
		tmdbTemp = tmdbTemp.replace('https://themoviedb.org/tv/', '')
		tmdbTemp = tmdbTemp.replace('http://www.themoviedb.org/tv/', '')
		tmdbTemp = tmdbTemp.replace('http://themoviedb.org/tv/', '')
		let tmdbId = false
		if (tmdbTemp.includes('-'))
			tmdbId = tmdbTemp.split('-')[0]
		return tmdbId
	},
	idInFolder: folderName => {
		folderName = folderName || ''
		folderName = folderName.toLowerCase()
		// tmdb id in curly brackets
		const tmdbIdMatches1 = folderName.match(/\s?\{tmdb[\-\:\=]([0-9]+)\}/)
		if ((tmdbIdMatches1 || []).length == 2) {
			return tmdbIdMatches1[1]
		} else {
			// tmdb id in brackets
			const tmdbIdMatches2 = folderName.match(/\s?\[tmdb[\-\:\=]([0-9]+)\]/)
			if ((tmdbIdMatches2 || []).length == 2) {
				return tmdbIdMatches2[1]
			}
		}
		return false
	}
}
