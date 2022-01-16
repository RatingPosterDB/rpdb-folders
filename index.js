
const express = require('express')
const app = express()
const needle = require('needle')
const async = require('async')
const chokidar = require('chokidar')
const isDocker = require('is-docker')
const fs = require('fs')
const path = require('path')
const tnp = require('torrent-name-parser')
const open = require('open')
const getPort = require('get-port')
const nameToImdb = require('name-to-imdb')
const querystring = require('querystring')
const bp = require('body-parser')
const config = require('./config')
const browser = require('./browser')
const searchStrings = require('./searchStrings')
const fileHelper = require('./files')
const stringHelper = require('./strings')
const imdbMatching = require('./matching/imdb')
const tmdbMatching = require('./matching/tmdb')
const tvdbMatching = require('./matching/tvdb')
const probeHelper = require('./probe')
const logging = require('./logging')

const plex = require('./plex')

let queueDisabled = false

const idToYearCache = {}

function getCached(folderName, folderType, forced) {
	if (settings.overwriteMatches[folderType][folderName]) {
		return settings.overwriteMatches[folderType][folderName]
	}

	const shouldUseCache = forced || settings.cacheMatches

	if (shouldUseCache && settings.imdbCache[folderType][folderName]) {
		return settings.imdbCache[folderType][folderName]
	}
}

function within2Years(thisYear, currentYear) {
	return !!(thisYear && thisYear >= currentYear -1 && thisYear <= currentYear +1)
}

function saveYear(res, thisYear) {
	if (settings.overwriteLast2Years && res && thisYear)
		idToYearCache[res] = thisYear
}

function folderNameToImdb(folderName, folderType, cb, isForced, posterExists, avoidYearMatch) {

	function respond(imdbId, noUnmatched) {
		if (!noUnmatched) {
			if (imdbId) {
				if (settings.unmatched[folderType][folderName])
					delete settings.unmatched[folderType][folderName]
			} else
				settings.unmatched[folderType][folderName] = true
		}
		cb(imdbId)
	}

	// is it already an IMDB ID?
	if (folderName.startsWith('tt') && !isNaN(folderName.replace('tt',''))) {
		respond(folderName)
		return
	}

	folderName = folderName || ''

	// we skip cache to ensure item is not from last 2 years
	// if it is, we will check the cache again later on
	const skipCache = !!(!avoidYearMatch && isForced && posterExists && settings.overwriteLast2Years)

	if (!skipCache) {
		const cached = getCached(folderName, folderType)
		if (cached) {
			respond(cached)
			return
		}
	}

	// clean up folderName:

	const cleanFolderName = stringHelper.cleanFolderName(fileHelper.isVideo(folderName) ? fileHelper.removeExtension(folderName) : folderName)

	const obj = { type: folderType, providers: ['imdbFind'] }

	// it's important to use these regex matches separate:

	// ends with year in parantheses:

	const yearMatch1 = cleanFolderName.match(/ \((\d{4}|\d{4}\-\d{4})\)$/)

	if ((yearMatch1 || []).length > 1) {
		obj.year = yearMatch1[1]
		obj.name = cleanFolderName.replace(/ \((\d{4}|\d{4}\-\d{4})\)$/, '')
	} else {

		// ends with year without parantheses:

		const yearMatch2 = cleanFolderName.match(/ (\d{4}|\d{4}\-\d{4})$/)
		if ((yearMatch2 || []).length > 1) {
			obj.year = yearMatch2[1]
			obj.name = cleanFolderName.replace(/ (\d{4}|\d{4}\-\d{4})$/, '')
		} else {

			// ends with year in brackets:

			const yearMatch2 = cleanFolderName.match(/ \[(\d{4}|\d{4}\-\d{4})\]$/)
			if ((yearMatch2 || []).length > 1) {
				obj.year = yearMatch2[1]
				obj.name = cleanFolderName.replace(/ \[(\d{4}|\d{4}\-\d{4})\]$/, '')
			} else {
				const tnpParsed = tnp(cleanFolderName)

				if (tnpParsed.title) {
					obj.name = tnpParsed.title
					if (tnpParsed.year) {
						obj.year = tnpParsed.year
					} else if (stringHelper.shouldNotParseName(cleanFolderName)) {
						// this is leads to a better match for series
						// possibly for movies too
						obj.name = cleanFolderName
					}
				}
			}

		}
	}

	if (!obj.name)
		obj.name = cleanFolderName.toLowerCase()
	else
		obj.name = obj.name.toLowerCase()

	// "Marvel's ..." can be a special case...
	if (obj.type == 'series' && obj.name.startsWith('marvel'))
		obj.name = obj.name.replace(/^marvel ?'?s /,'')

	if (skipCache) {
		// figure out the year of the media
		const currentYear = new Date().getFullYear()
		const cached = getCached(folderName, folderType, true)
		if (cached) {
			if (within2Years(obj.year, currentYear)) {
				respond(cached)
			} else if (!obj.year) {
				respond(cached)
			} else {
				respond(false, true)
			}
			return
		}
	}
	if (settings.scanOrder == 'tmdb-imdb') {
		tmdbMatching.folderNameFromTMDBtoImdb(obj, res => {
			if ((res || '').startsWith('tt')) {
				logging.log('Matched ' + folderName + ' by TMDB Search')
				settings.imdbCache[folderType][folderName] = res
				respond(res)
			} else {
				imdbMatching.folderNameToImdb(obj, (res, inf) => {
					if (res) {
						saveYear(res, ((inf || {}).meta || {}).year)
						logging.log('Matched ' + folderName + ' by IMDB Search')
						settings.imdbCache[folderType][folderName] = res
						respond(res)
					} else respond(false)
				})
			}
		})
	} else if (settings.scanOrder == 'imdb') {
		imdbMatching.folderNameToImdb(obj, (res, inf) => {
			if (res) {
				saveYear(res, ((inf || {}).meta || {}).year)
				logging.log('Matched ' + folderName + ' by IMDB Search')
				settings.imdbCache[folderType][folderName] = res
				respond(res)
			} else {
				respond(false)
			}
		})
	} else if (settings.scanOrder == 'tmdb') {
		tmdbMatching.folderNameFromTMDBtoImdb(obj, res => {
			if ((res || '').startsWith('tt')) {
				logging.log('Matched ' + folderName + ' by TMDB Search')
				settings.imdbCache[folderType][folderName] = res
				respond(res)
			} else {
				respond(false)
			}
		})
	} else {
		// 'imdb-tmdb'
		imdbMatching.folderNameToImdb(obj, (res, inf) => {
			if (res) {
				saveYear(res, ((inf || {}).meta || {}).year)
				logging.log('Matched ' + folderName + ' by IMDB Search')
				settings.imdbCache[folderType][folderName] = res
				respond(res)
			} else {
				tmdbMatching.folderNameFromTMDBtoImdb(obj, res => {
					if ((res || '').startsWith('tt')) {
						logging.log('Matched ' + folderName + ' by TMDB Search')
						settings.imdbCache[folderType][folderName] = res
						respond(res)
					} else respond(false)
				})
			}
		})
	}
}

function posterFromImdbId(imdbId, mediaType, folderLabel, badgeString, badgePos, badgeSize) {
	let posterType = settings[mediaType + 'PosterType']
	let customPoster = ''
	if (settings.customPosters[imdbId]) {
		customPoster = settings.customPosters[imdbId].replace('[[api-key]]', settings.apiKey).replace('[[poster-type]]', posterType).replace('[[imdb-id]]', imdbId)
	} else {
		if (settings[mediaType + 'Textless'])
			posterType = posterType.replace('poster-', 'textless-')
		customPoster = 'https://api.ratingposterdb.com/' + settings.apiKey + '/imdb/' + posterType + '/' + imdbId + '.jpg'
		if (settings.posterLang[mediaType] != 'en') {
			if (customPoster.includes('?')) customPoster += '&'
			else customPoster += '?'
			customPoster += 'lang=' + settings.posterLang[mediaType]
		}
	}
	if (settings.itemLabels[imdbId] || folderLabel) {
		if (customPoster.includes('?')) customPoster += '&'
		else customPoster += '?'
		customPoster += 'label=' + (settings.itemLabels[imdbId] || folderLabel)
	}
	if (settings.itemBadges[imdbId] || badgeString) {
		if (customPoster.includes('?')) customPoster += '&'
		else customPoster += '?'
		customPoster += 'badges=' + (settings.itemBadges[imdbId] || badgeString)
	}
	if (settings.itemBadgePositions[imdbId] || badgePos) {
		if (customPoster.includes('?')) customPoster += '&'
		else customPoster += '?'
		customPoster += 'badgePos=' + (settings.itemBadgePositions[imdbId] || badgePos)
	}
	if (settings.itemBadgeSizes[imdbId] || badgeSize) {
		if (customPoster.includes('?')) customPoster += '&'
		else customPoster += '?'
		customPoster += 'badgeSize=' + (settings.itemBadgeSizes[imdbId] || badgeSize)
	}
	return customPoster
}

function getVideoFile(task) {
	let videoFile = false
	if (!task.isFile && task.type == 'movie') {
		if (fs.lstatSync(task.folder).isDirectory()) {
			// get video filename
			const folderVideos = getVideos(task.folder)
			if ((folderVideos || []).length) {
				folderVideos.some(el => {
					if (!el) return
					if (!path.basename(el).toLowerCase().includes('-trailer.')) {
						videoFile = el
						return true
					}
				})
			}
		} else {
			// to not skip probing
			videoFile = true
		}
	}
	return videoFile
}

const nameQueue = async.queue((task, cb) => {

	if (queueDisabled) {
		cb()
		return
	}

	logging.log('Items left in queue: ' + nameQueue.length())

	const parentMediaFolder = task.isFile ? task.folder : path.resolve(task.folder, '..')

	const folderLabel = settings.labels[parentMediaFolder]

	let badgeString = settings.badges[parentMediaFolder]

	const badgePos = settings.badgePositions[parentMediaFolder]

	const badgeSize = settings.badgeSizes[parentMediaFolder]

	const posterName = task.posterName || 'poster.jpg'

	const backdropName = task.backdropName || 'background.jpg'

	let targetFolder = task.folder

	if (task.type == 'movie') {
		// handle strange case of concatenated folders
		// - Movie Name (Year)
		// - - Movie Name (Year)
		// - - - Video File

		// if only one item exists in the folder and that item is a folder itself, go one level down
		const folderContents = getDirectories(targetFolder, true)
		if ((folderContents || []).length == 1 && !fileHelper.isVideo(folderContents[0] || '')) {
			targetFolder = folderContents[0]
		}
	}

	if (settings.noPostersToEmptyFolders) {
		const folderHasContents = getDirectories(targetFolder, true)
		if (!(folderHasContents || []).length) {
			logging.log(`Skipping empty folder: ${task.name}`)
			cb()
			return
		}
	}

	const posterExists = fs.existsSync(path.join(targetFolder, posterName))

	let backdropExists = false

	if (settings.backdrops) {
		backdropExists = fs.existsSync(path.join(targetFolder, backdropName))
	}

	if (fullScanRunning && !posterExists && settings.retryFrequency) {
		const d = new Date()
		const thisMonth = d.getMonth() + 1
		const validRetryPeriod = thisMonth < settings.lastRetryMonth ? (settings.lastRetryMonth + settings.retryFrequency < thisMonth + 12) : (settings.lastRetryMonth + settings.retryFrequency < thisMonth)
		if (settings.lastRetryMonth == -1 || validRetryPeriod) {
			const dirStats = fs.statSync(parentMediaFolder)
			if (dirStats.birthtime) {
				function isValidDate(d) { return d instanceof Date && !isNaN(d) }
				const createDate = new Date(dirStats.birthtime)
				if (isValidDate(createDate)) {
					const nowDate = new Date()
					const retryMonths6 = 6 * 30 * 24 * 60 * 60 * 1000
					if (createDate.getTime() < nowDate.getTime() - retryMonths6) {
						logging.log(`Skipping due to retry frequency setting, folder: ${task.name}`)
						cb()
						return
					}
				}
			}
		}
	}

	let noSkip = false
	if (posterExists && !task.forced) {
		const folderAutoBadgeData = settings.autoBadges[parentMediaFolder]
		// don't skip if auto badge turned on and no rpdb.json exists
		if (folderAutoBadgeData && fs.lstatSync(task.folder).isDirectory() && !probeHelper.getDbFile(task.folder, task.isFile))
			noSkip = true
	}

	if (!noSkip) {
		if (posterExists && !settings.backdrops) {
			if (!task.forced) {
				setTimeout(() => { cb() }, 100)
				return
			}
		}

		if (settings.backdrops && posterExists && backdropExists) {
			if (!task.forced) {
				setTimeout(() => { cb() }, 100)
				return
			}
		}
	}

	let once = false

	let countTasks = 0

	const totalTasks = settings.backdrops ? 2 : 1

	function endIt() {
		countTasks++
		if (countTasks < totalTasks)
			return
		if (once) return
		once = true
		setTimeout(() => {
			cb()

			if (!plexMediaFile)
				plexMediaFile = getVideoFile(task)

			let reqPlex = {}

			if (task.type == 'movie' && !task.isFile && !plexMediaFile) {
				logging.log('Warning: Could not find video file in order to refresh metadata in Plex')
			} else {
				// have media file
				reqPlex = { settings, mediaFile: task.type == 'series' ? task.folder : task.isFile ? path.join(task.folder, task.name) : plexMediaFile, type: task.type, mediaFolder: parentMediaFolder }
				if (settings.plexDelayType == 'tod')
					plexTodQueue.push(reqPlex)
			}

			if (reqPlex.mediaFile && settings.plexDelayType != 'tod')
				setTimeout(() => {
					plex.pollForRefreshByFile(reqPlex.settings, reqPlex.mediaFile, reqPlex.type, result => {
						if (!result || !Object.keys(reqPlex).length) {
							if (((settings || {}).plex || {}).token)
								logging.log('Warning: Could not refresh metadata in Plex for "' + reqPlex.mediaFile + '"')
						} else
							logging.log('Refreshed metadata in Plex for "' + reqPlex.mediaFile + '"')
					}, reqPlex.mediaFolder)
				}, settings.plexDelayType == 'delay' ? (settings.plexRefreshDelay || 0) : 0)
		}, 1000) // 1s
	}

	async function getPoster(imdbId) {
		const autoBadgeData = settings.itemAutoBadges[imdbId] || settings.autoBadges[parentMediaFolder]
		if (posterExists && !task.forced) {
			// don't skip if auto badge turned on and no rpdb.json exists
			if (!noSkip && !(autoBadgeData && fs.lstatSync(task.folder).isDirectory() && !probeHelper.getDbFile(task.folder, task.isFile))) {
				endIt()
				return
			} else {
				logging.log('Missing rpdb.json, continuing to probe video file.')
			}
		}

		if (autoBadgeData) {
			// overwrite badge string if auto badges are loaded
			let videoFile = plexMediaFile || getVideoFile(task)
			let skipProbing = false
			if (task.type == 'movie' && !task.isFile && !videoFile) {
				logging.log('Warning: Could not find any video file for the movie in order to probe')
				skipProbing = true
			}
			if (!skipProbing) {
				const fileProbed = await probeHelper.probe(task.type == 'series' ? task.folder : task.isFile ? path.join(task.folder, task.name) : videoFile, task.isFile, !!(task.type == 'series'), imdbId, settings.overwriteProbeData)
				badgeString = probeHelper.getQueryString(fileProbed, querystring.parse(autoBadgeData), task.type == 'series' ? task.folder : task.isFile ? path.join(task.folder, task.name) : videoFile, settings.defaultBadges || {})
				if (fileProbed.matchedImdbByMediaInfo && fileProbed.imdbId && fileProbed.imdbId != imdbId && !settings.overwriteMatches[task.type][task.name])
					imdbId = fileProbed.imdbId
			}
		}

		const posterUrl = posterFromImdbId(imdbId, task.type, folderLabel, badgeString, badgePos, badgeSize)

		needle.get(posterUrl, (err, res) => {
			if (!err && (res || {}).statusCode == 200) {
				fs.writeFile(path.join(targetFolder, posterName), res.raw, (err) => {
					if (err) {
						if (!task.retry) {
							logging.log(`Warning: Could not write poster to folder for ${task.name}, trying again in 4h`)
							setTimeout(() => {
								task.retry = true
								nameQueue.push(task)
							}, 4 * 60 * 60 * 1000)
						} else {
							logging.log(`Warning: Could not write poster to folder for ${task.name}, tried twice`)
						}
					} else {
						logging.log(`Poster for ${task.name} downloaded`)
						if (settings.missingPosters[task.type][task.name])
							delete settings.missingPosters[task.type][task.name]
					}
					endIt()
				})
			} else {
				if ((res || {}).statusCode == 403) {
					// we will purge the queue, this can only happen if:
					// - API request limit is reached
					// - requests are done for an unsupported poster type
					// - API key is invalid / disabled
					logging.log(res.body)
					queueDisabled = true
				} else {
					logging.log('No poster available for ' + task.name)
					settings.missingPosters[task.type][task.name] = true
				}
				endIt()
			}
		})
	}

	function getBackdrop(imdbId) {
		if (backdropExists && !task.forced) {
			endIt()
			return
		}
		const backdropUrl = 'https://api.ratingposterdb.com/' + settings.apiKey + '/imdb/backdrop-default/' + imdbId + '.jpg'
		needle.get(backdropUrl, (err, res) => {
			if (!err && (res || {}).statusCode == 200) {
				fs.writeFile(path.join(targetFolder, backdropName), res.raw, (err) => {
					if (err) {
						logging.log(`Warning: Could not write backdrop to folder for ${task.name}`)
					} else
						logging.log(`Backdrop for ${task.name} downloaded`)
					endIt()
				})
			} else {
				endIt()
			}
		})
	}

	function getImages(imdbId) {
		// need to remove unmatched here too, due to overwrite matches
		if (settings.unmatched[task.type][task.name])
			delete settings.unmatched[task.type][task.name]
		if (settings.checkForLocalImdbId) {
			const localFileImdbId = probeHelper.getImdbId(path.join(task.folder, task.name), task.isFile)
			if (localFileImdbId && localFileImdbId != imdbId)
				imdbId = localFileImdbId
		}
		const checkWithin2Years = !!(!task.avoidYearMatch && task.forced && posterExists && settings.overwriteLast2Years)
		const currentYear = new Date().getFullYear()
		function retrievePosters() {
			getPoster(imdbId)
			if (settings.backdrops) {
				if (avoidOptimizedBackdropsScan) {
					getBackdrop(imdbId)
				} else {
					let noBackdrop = false

					if (posterExists && !backdropExists)
						noBackdrop = true

					// allow checking for backdrop rarely (1/2 times) on the off chance that it received one
					// this is to reduce hitting request usage as there is a very low chance for a backdrop to be available after the first scan
					if (noBackdrop && idToYearCache[imdbId] && idToYearCache[imdbId] == currentYear && Math.floor(Math.random() * 2))
						noBackdrop = false

					if (!noBackdrop)
						getBackdrop(imdbId)
					else
						endIt()
				}
			}
		}
		function failPosters() {
			if (checkWithin2Years)
				logging.log('Not within last 2 years, skipping: ' + task.name)
			else
				logging.log('Could not match ' + task.name)
			endIt()
			if (settings.backdrops) // end again
				endIt()
		}
		if ((imdbId || '').startsWith('tt')) {
			if (!checkWithin2Years) {
				retrievePosters()
			} else {
				if (idToYearCache[imdbId]) {
					if (within2Years(idToYearCache[imdbId], currentYear))
						retrievePosters()
					else
						failPosters()
				} else {
					imdbMatching.folderNameToImdb({ name: imdbId, type: task.type, providers: ['imdbFind'] }, (res, inf) => {
						if (res && res == imdbId && within2Years(((inf || {}).meta || {}).year, currentYear)) {
							saveYear(imdbId, inf.meta.year)
							retrievePosters()
						} else {
							failPosters()
						}
					})
				}
			}
		} else {
			failPosters()
		}
	}

	function matchBySearch() {
		folderNameToImdb(task.name, task.type, getImages, task.forced, posterExists, task.avoidYearMatch)
	}

	let plexMediaFile = false

	if (settings.overwriteMatches[task.type][task.name]) {
		getImages(settings.overwriteMatches[task.type][task.name])
	} else if (task.imdbId) {
		settings.overwriteMatches[task.type][task.name] = task.imdbId
		getImages(task.imdbId)
	} else if (task.tmdbId) {
		tmdbMatching.tmdbToImdb(task.tmdbId, task.type == 'movie' ? 'movie' : 'tv', imdbId => {
			if (imdbId) {
				settings.overwriteMatches[task.type][task.name] = imdbId
				getImages(imdbId)
			} else {
				matchBySearch()
			}
		})
	} else if (task.tvdbId) {
		tvdbMatching.tvdbToImdb(task.tvdbId, imdbId => {
			if (imdbId) {
				settings.overwriteMatches[task.type][task.name] = imdbId
				getImages(imdbId)
			} else {
				matchBySearch()
			}
		})
	} else {
		plexMediaFile = getVideoFile(task)

		let reqPlex = {}

		if (task.type == 'movie' && !task.isFile && !plexMediaFile) {
			logging.log('Warning: Could not find any video file for the movie in order to probe')
		} else {
			// have media file
			reqPlex = { settings, mediaFile: task.type == 'series' ? task.folder : task.isFile ? path.join(task.folder, task.name) : plexMediaFile, type: task.type, mediaFolder: parentMediaFolder }
		}

		plex.pollForIdsByFile(reqPlex.settings, reqPlex.mediaFile, reqPlex.type, mediaIds => {
			mediaIds = mediaIds || {}
			if (mediaIds.imdb) {
				logging.log('Matched ' + task.name + ' through Plex: ' + mediaIds.imdb)
				settings.overwriteMatches[task.type][task.name] = mediaIds.imdb
				getImages(mediaIds.imdb)
			} else if (mediaIds.tmdb) {
				tmdbMatching.tmdbToImdb(mediaIds.tmdb, task.type == 'movie' ? 'movie' : 'tv', imdbId => {
					if (imdbId) {
						logging.log('Matched ' + task.name + ' through Plex: ' + imdbId)
						settings.overwriteMatches[task.type][task.name] = imdbId
						getImages(imdbId)
					} else {
						matchBySearch()
					}
				})
			} else if (mediaIds.tvdb) {
				tvdbMatching.tvdbToImdb(mediaIds.tvdb, imdbId => {
					if (imdbId) {
						logging.log('Matched ' + task.name + ' through Plex: ' + imdbId)
						settings.overwriteMatches[task.type][task.name] = imdbId
						getImages(imdbId)
					} else {
						matchBySearch()
					}
				})
			} else {

				// check to see if folder name already contains an id

				const imdbIdInFolderName = imdbMatching.idInFolder(task.name)

				if (imdbIdInFolderName) {
					logging.log('Matched ' + task.name + ' by IMDB ID in folder name')
					getImages(imdbIdInFolderName)
				} else {
					const tmdbIdInFolderName = tmdbMatching.idInFolder(task.name)
					if (tmdbIdInFolderName) {
						tmdbMatching.tmdbToImdb(tmdbIdInFolderName, task.type == 'movie' ? 'movie' : 'tv', imdbId => {
							if (imdbId) {
								logging.log('Matched ' + task.name + ' by TMDB ID in folder name')
								getImages(imdbId)
							} else {
								matchBySearch()
							}
						})
					} else {
						const tvdbIdInFolderName = tvdbMatching.idInFolder(task.name)
						if (tvdbIdInFolderName && task.type == 'series') {
							// only series supports converting to imdb id
							tvdbMatching.tvdbToImdb(tvdbIdInFolderName, imdbId => {
								if (imdbId) {
									logging.log('Matched ' + task.name + ' by TVDB ID in folder name')
									getImages(imdbId)
								} else {
									matchBySearch()
								}
							})
						} else {
							matchBySearch()
						}
					}
				}
			}
		}, reqPlex.mediaFolder)
	}

}, 1)

nameQueue.drain(() => {
	config.set('imdbCache', settings.imdbCache)
	if (fullScanRunning) {
		if (settings.retryFrequency) {
			const d = new Date()
			const thisMonth = d.getMonth() + 1
			const validRetryPeriod = thisMonth < settings.lastRetryMonth ? (settings.lastRetryMonth + settings.retryFrequency < thisMonth + 12) : (settings.lastRetryMonth + settings.retryFrequency < thisMonth)
			if (settings.lastRetryMonth == -1 || validRetryPeriod) {
				config.set('lastRetryMonth', thisMonth)
			}
		}
	}
	fullScanRunning = false
	queueDisabled = false
	avoidOptimizedBackdropsScan = false
	config.set('unmatched', settings.unmatched)
	config.set('missingPosters', settings.missingPosters)
})

const isDirectoryOrVideo = (withVideos, source) => { try { return fs.lstatSync(source).isDirectory() || (withVideos && fileHelper.isVideo(source)) } catch(e) { return false } }
const getDirectories = (source, withVideos) => { try { return fs.readdirSync(source).map(name => path.join(source, name)).filter(isDirectoryOrVideo.bind(null, withVideos)) } catch(e) { console.error(e); return [] } }
const isVideo = (source) => { try { return !fs.lstatSync(source).isDirectory() && fileHelper.isVideo(source) } catch(e) { return false } }
const getVideos = (source) => { try { return fs.readdirSync(source).map(name => path.join(source, name)).filter(isVideo) } catch(e) { console.error(e); return [] } }


let fullScanRunning = false

function startFetchingPosters(theseFolders, type, forced, avoidYearMatch) {
	let allFolders = []
	theseFolders.forEach(mediaFolder => {
		const subFolders = getDirectories(mediaFolder)
		if ((subFolders || []).length)
			allFolders = allFolders.concat(subFolders)
		else {
			// check if this media folder includes video Files
			const videoFiles = getVideos(mediaFolder, true)
			if ((videoFiles || []).length) {
				videoFiles.forEach(el => {
					if (!el) return;
					const name = el.split(path.sep).pop()
					const nameNoExt = fileHelper.removeExtension(name)
					nameQueue.push({ name, folder: path.dirname(el), type, forced, isFile: true, posterName: nameNoExt + '.jpg', backdropName: nameNoExt + '-fanart.jpg', avoidYearMatch })
				})
			}
		}
	})
	if (allFolders.length) {
		fullScanRunning = true
		allFolders.forEach((el) => { if (!el) return; const name = el.split(path.sep).pop(); nameQueue.push({ name, folder: el, type, forced, avoidYearMatch }) })
	}
}

let watcher = {}

function startWatcher() {

	if (!settings.useWebhook) {

		watcher = chokidar.watch('dir', {
			ignored: /(^|[\/\\])\../, // ignore dotfiles
			persistent: true,
			depth: settings.watchFolderDepth || 0,
			usePolling: settings.usePolling || false,
			interval: settings.pollingInterval || 100,
			ignoreInitial: settings.ignoreInitialScan || false,
		})

		watcher.on('addDir', el => {
			let type
			let parentFolder
			for (const [folderType, folders] of Object.entries(settings.mediaFolders)) {
				if (folders.includes(el))
					return
				if (!type)
					folders.some(mediaFolder => {
						if (el.startsWith(mediaFolder + path.sep)) {
							type = folderType
							parentFolder = mediaFolder
							return true
						}
					})
			}
			if (settings.watchFolderDepth) {
				if (type == 'series') {
					// only allow increasing folder depth for movies
					return
				}
				const folderPart = el.replace(parentFolder + path.sep, '')
				if (folderPart.includes(path.sep)) {
					// if folder depth has been increased, only process the primary folder
					el = path.join(parentFolder, folderPart.split(path.sep)[0])
				}
			}
			const folderPart = el.replace(parentFolder + path.sep, '')
			const name = el.split(path.sep).pop()
			if (name.toLowerCase() == 'new folder')
				return
			logging.log(`Directory ${name} has been added to ${type}`)
			nameQueue.push({ name, folder: el, type, forced: false }) 
		})

		watcher.on('add', el => {
			const name = el.split(path.sep).pop()
			if (!fileHelper.isVideo(name)) {
				return
			}
			let type
			for (const [folderType, folders] of Object.entries(settings.mediaFolders)) {
				if (folders.includes(el))
					return
				if (!type)
					folders.some(mediaFolder => {
						if (el.startsWith(mediaFolder)) {
							type = folderType
							return true
						}
					})
			}
			if (type !== 'movie') {
				return
			}
			logging.log(`File ${name} has been added to ${type}`)
			const nameNoExt = fileHelper.removeExtension(name)
			nameQueue.push({ name, folder: path.dirname(el), type, forced: false, isFile: true, posterName: nameNoExt + '.jpg', backdropName: nameNoExt + '-fanart.jpg' }) 
		})

	}

	return Promise.resolve()

}

function shouldOverwrite(type) {
	// this logic is put in place so users do not
	// consume too many requests by overwriting
	// posters with full scans
	if (!!settings.overwrite && settings.lastOverwrite[type] < Date.now() - settings.minOverwritePeriod)
		return true

	return false
}

function fullUpdate() {
	let anyOverwrite = false
	for (const [type, folders] of Object.entries(settings.mediaFolders)) {
		if (settings.lastFullUpdate[type] < Date.now() - settings.fullUpdate) {
			logging.log(`Initiating periodic update of all ${type} folders`)
			settings.lastFullUpdate[type] = Date.now()
			const overwrite = shouldOverwrite(type)
			if (overwrite) {
				anyOverwrite = true
				settings.lastOverwrite[type] = Date.now()
			}
			startFetchingPosters(folders, type, overwrite)
		}
	}
	config.set('lastFullUpdate', settings.lastFullUpdate)
	if (anyOverwrite)
		config.set('lastOverwrite', settings.lastOverwrite)
	setTimeout(() => { fullUpdate() }, settings.checkFullUpdate)
}

let watchedFolders = []

function addToWatcher(arr) {
	if (settings.useWebhook) { return }
	const newArr = []
	arr.forEach(el => {
		if (!watchedFolders.includes(el))
			newArr.push(el)
	})
	watchedFolders = watchedFolders.concat(newArr)
	watcher.add(newArr)
}

function removeFromWatcher(folder) {
	if (settings.useWebhook) { return }
	const idx = watchedFolders.indexOf(folder)
	if (idx !== -1) {
		watchedFolders.splice(idx, 1)
		watcher.unwatch(folder)
	}
}

function addMediaFolder(type, folder, label, badges, badgePos, badgeSize, autoBadges) {
	const idx = settings.mediaFolders[type].indexOf(folder)
	if (idx == -1) {
		settings.mediaFolders[type].push(folder)
		config.set('mediaFolders', settings.mediaFolders)
		if (label && label != 'none') {
			settings.labels[folder] = label
			config.set('labels', settings.labels)
		}
		if (badges && badges != 'none') {
			if (autoBadges) {
				settings.autoBadges[folder] = badges
				config.set('autoBadges', settings.autoBadges)
				if (settings.badges[folder]) {
					delete settings.badges[folder]
					config.set('badges', settings.badges)
				}
			} else {
				settings.badges[folder] = badges
				config.set('badges', settings.badges)
				if (settings.autoBadges[folder]) {
					delete settings.autoBadges[folder]
					config.set('autoBadges', settings.autoBadges)
				}
			}
		}
		if (badgePos && badgePos != 'none' && badgePos != 'left') {
			settings.badgePositions[folder] = badgePos
			config.set('badgePositions', settings.badgePositions)
		} else {
			delete settings.badgePositions[folder]
			config.set('badgePositions', settings.badgePositions)
		}
		if (badgeSize && badgeSize != 'none' && badgeSize != 'normal') {
			settings.badgeSizes[folder] = badgeSize
			config.set('badgeSizes', settings.badgeSizes)
		} else {
			delete settings.badgeSizes[folder]
			config.set('badgeSizes', settings.badgeSizes)
		}
		addToWatcher([folder])
	}
}

function removeMediaFolder(type, folder) {
	const idx = settings.mediaFolders[type].indexOf(folder)
	if (idx !== -1) {
		settings.mediaFolders[type].splice(idx, 1)
		config.set('mediaFolders', settings.mediaFolders)
		if (settings.labels[folder]) {
			delete settings.labels[folder]
			config.set('labels', settings.labels)
		}
		if (settings.badges[folder]) {
			delete settings.badges[folder]
			config.set('badges', settings.badges)
		}
		if (settings.autoBadges[folder]) {
			delete settings.autoBadges[folder]
			config.set('autoBadges', settings.autoBadges)
		}
		if (settings.badgePositions[folder]) {
			delete settings.badgePositions[folder]
			config.set('badgePositions', settings.badgePositions)
		}
		if (settings.badgeSizes[folder]) {
			delete settings.badgeSizes[folder]
			config.set('badgeSizes', settings.badgeSizes)
		}
		removeFromWatcher(folder)
	}
}

function updateSetting(name, value) {
	settings[name] = value
	config.set(name, value)
}

function init() {
	if (!settings.useWebhook) {
		let allFolders = []
		for (const [type, folders] of Object.entries(settings.mediaFolders))
			allFolders = allFolders.concat(folders)
		if (allFolders.length)
			addToWatcher(allFolders)
		if (!settings.overwrite) {
			// we consider adding the folders to watcher a full scan
			// on init, only if overwrite is disabled, because it will
			// actually act like a full scan by re-checking all folders
			settings.lastFullUpdate['movie'] = Date.now()
			settings.lastFullUpdate['series'] = Date.now()
			config.set('lastFullUpdate', settings.lastFullUpdate)
		}
	}
	fullUpdate()
}

function validateApiKey() {
	return new Promise((resolve, reject) => {
		needle.get('https://api.ratingposterdb.com/' + settings.apiKey + '/isValid', (err, resp, body) => {
			if (!err && (resp || {}).statusCode == 200) {
				init()
				resolve()
			} else {
				reject()
			}
		})
	})
}

function passwordValid(req, res, cb) {
	if (settings.pass) {
		if (((req || {}).query || {}).pass == settings.pass) {
			cb(req, res)
			return
		}
		res.status(500)
		res.send('Password Incorrect')
		return
	}
	cb(req, res)
}

let baseUrl = config.get('baseUrl') || '/'

if (!baseUrl.startsWith('/'))
	baseUrl = '/' + baseUrl

if (!baseUrl.endsWith('/'))
	baseUrl += '/'

app.use(bp.json())
app.use(bp.urlencoded({ extended: true }))

app.get(baseUrl+'checkPass', (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: !!(settings.pass == (req.query || {}).pass) })
})

app.get(baseUrl+'needsPass', (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true, required: !!settings.pass })
})

app.get(baseUrl+'savePass', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	if (((req || {}).query || {}).newpass) {
		settings.pass = req.query.newpass
		config.set('pass', settings.pass)
		res.send({ success: true })
		return
	}
	res.send({ success: false })
}))

let avoidOptimizedBackdropsScan = false

let plexTodTimeout = false

let plexTodQueue = []

const plexTodRefreshQueue = async.queue((task, cb) => {
	const reqPlex = task
	plex.pollForRefreshByFile(reqPlex.settings, reqPlex.mediaFile, reqPlex.type, result => {
		if (!result || !Object.keys(reqPlex).length) {
			if (((settings || {}).plex || {}).token)
				logging.log('Warning: Could not refresh metadata in Plex for "' + reqPlex.mediaFile + '"')
		} else
			logging.log('Refreshed metadata in Plex for "' + reqPlex.mediaFile + '"')
		setTimeout(() => {
			cb()
		}, 1000)
	}, reqPlex.mediaFolder)
}, 1)

function setPlexTodUpdate() {
	if (settings.plexDelayType == 'tod') {
		const now = new Date()
		let millisTillTrigger = new Date(now.getFullYear(), now.getMonth(), now.getDate(), settings.plexTodHour + (settings.plexTodAmPm == 'PM' ? 12 : 0), settings.plexTodMin, 0, 0)
		if (millisTillTrigger < 0)
			millisTillTrigger += 86400000 // after target time, set for tomorrow
		plexTodTimeout = setTimeout(() => {
			if (plexTodQueue.length) {
				logging.log('Starting metadata refresh for items in Plex, items queued: ' + plexTodQueue.length)
				plexTodQueue.forEach(el => {
					plexTodRefreshQueue.push(el)
				})
				plexTodQueue = []
			}
			setTimeout(() => {
				setPlexTodUpdate()
			}, 61 * 1000)
		}, millisTillTrigger)
	}
}

app.get(baseUrl+'savePlexRefreshSettings', (req, res) => passwordValid(req, res, (req, res) => {
	if (plexTodTimeout) {
		clearTimeout(plexTodTimeout)
		plexTodTimeout = false
	}
	let plexDelayType = (req.query || {}).plexDelayType || 'none'
	if (plexDelayType == 'none')
		plexDelayType = false
	const plexRefreshDelay = parseInt((req.query || {}).plexRefreshDelay || '0')
	const plexTodHour = parseInt((req.query || {}).plexTodHour || '1')
	const plexTodMin = parseInt((req.query || {}).plexTodMin || '0')
	const plexTodAmPm = (req.query || {}).plexTodAmPm || 'AM'
	if (plexDelayType != settings.plexDelayType) {
		settings.plexDelayType = plexDelayType
		config.set('plexDelayType', settings.plexDelayType)
	}
	if (plexRefreshDelay != settings.plexRefreshDelay) {
		settings.plexRefreshDelay = plexRefreshDelay
		config.set('plexRefreshDelay', settings.plexRefreshDelay)
	}
	if (plexTodHour != settings.plexTodHour) {
		settings.plexTodHour = plexTodHour
		config.set('plexTodHour', settings.plexTodHour)
	}
	if (plexTodMin != settings.plexTodMin) {
		settings.plexTodMin = plexTodMin
		config.set('plexTodMin', settings.plexTodMin)
	}
	if (plexTodAmPm != settings.plexTodAmPm) {
		settings.plexTodAmPm = plexTodAmPm
		config.set('plexTodAmPm', settings.plexTodAmPm)
	}
	setPlexTodUpdate()
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true })
}))

app.get(baseUrl+'setSettings', (req, res) => passwordValid(req, res, (req, res) => {
	const moviePosterType = (req.query || {}).moviePosterType || 'poster-default'
	if (moviePosterType != settings.moviePosterType) {
		settings.moviePosterType = moviePosterType
		config.set('moviePosterType', settings.moviePosterType)
	}
	const seriesPosterType = (req.query || {}).seriesPosterType || 'poster-default'
	if (seriesPosterType != settings.seriesPosterType) {
		settings.seriesPosterType = seriesPosterType
		config.set('seriesPosterType', settings.seriesPosterType)
	}
	const moviePosterLang = (req.query || {}).moviePosterLang || 'en'
	const seriesPosterLang = (req.query || {}).seriesPosterLang || 'en'
	if (JSON.stringify(settings.posterLang) != JSON.stringify({ movie: moviePosterLang, series: seriesPosterLang })) {
		settings.posterLang = { movie: moviePosterLang, series: seriesPosterLang }
		config.set('posterLang', settings.posterLang)
	}
	const retryFrequency = parseInt((req.query || {}).retryFrequency || '0')
	if (retryFrequency !== settings.retryFrequency) {
		settings.retryFrequency = retryFrequency
		config.set('retryFrequency', settings.retryFrequency)
	}
	const overwritePeriod = (req.query || {}).overwritePeriod || 'overwrite-monthly'
	settings.minOverwritePeriod = overwritePeriod == 'overwrite-monthly' ? 29 * 24 * 60 * 60 * 1000 : 14 * 24 * 60 * 60 * 1000
	config.set('minOverwritePeriod', settings.minOverwritePeriod)
	const overwrite = (req.query || {}).overwrite || false
	if (overwrite == 1 && !settings.overwrite) {
		// this is here to ensure we don't consume too many requests needlessly
		settings.lastOverwrite = { movie: Date.now(), series: Date.now() }
		config.set('lastOverwrite', settings.lastOverwrite)
	}
	settings.overwrite = overwrite == 1 ? true : false
	config.set('overwrite', settings.overwrite)
	const overwrite2years = (req.query || {}).overwrite2years || false
	const overwriteLast2Years = overwrite2years == 1 ? true : false
	if (overwriteLast2Years !== settings.overwriteLast2Years) {
		settings.overwriteLast2Years = overwriteLast2Years
		config.set('overwriteLast2Years', settings.overwriteLast2Years)
	}
	const noEmptyFolders = (req.query || {}).noEmptyFolders || false
	const noPostersToEmptyFolders = noEmptyFolders == 1 ? true : false
	if (noPostersToEmptyFolders !== settings.noPostersToEmptyFolders) {
		settings.noPostersToEmptyFolders = noPostersToEmptyFolders
		config.set('noPostersToEmptyFolders', settings.noPostersToEmptyFolders)
	}
	const noScanOnStart = (req.query || {}).noScanOnStart || false
	const doNotScanOnAppStart = noScanOnStart == 1 ? true : false
	if (doNotScanOnAppStart !== settings.ignoreInitialScan) {
		settings.ignoreInitialScan = doNotScanOnAppStart
		config.set('ignoreInitialScan', settings.ignoreInitialScan)
	}
	const shouldCacheMatches = (req.query || {}).cacheMatches || false
	const cacheMatches = shouldCacheMatches == 1 ? true : false
	if (cacheMatches !== settings.cacheMatches) {
		settings.cacheMatches = cacheMatches
		config.set('cacheMatches', settings.cacheMatches)
	}
	const shouldOverwriteProbe = (req.query || {}).overwriteProbe || false
	const overwriteProbe = shouldOverwriteProbe == 1 ? true : false
	if (overwriteProbe !== settings.overwriteProbeData) {
		settings.overwriteProbeData = overwriteProbe
		config.set('overwriteProbeData', settings.overwriteProbeData)
	}
	const backdrops = (req.query || {}).backdrops || false
	const valBackdrops = backdrops == 1 ? true : false
	if (settings.backdrops != valBackdrops) {
		settings.backdrops = valBackdrops
		if (settings.backdrops)
			avoidOptimizedBackdropsScan = true
		config.set('backdrops', settings.backdrops)
	}
	const movieTextless = (req.query || {}).movieTextless || false
	const valMovieTextless = movieTextless == 1 ? true : false
	if (settings.movieTextless != valMovieTextless) {
		settings.movieTextless = valMovieTextless
		config.set('movieTextless', settings.movieTextless)
	}
	const seriesTextless = (req.query || {}).seriesTextless || false
	const valSeriesTextless = seriesTextless == 1 ? true : false
	if (settings.seriesTextless != valSeriesTextless) {
		settings.seriesTextless = valSeriesTextless
		config.set('seriesTextless', settings.seriesTextless)
	}
	const usePolling = (req.query || {}).usePolling || false
	const valUsePolling = usePolling == 1 ? true : false
	if (settings.usePolling != valUsePolling) {
		settings.usePolling = valUsePolling
		config.set('usePolling', settings.usePolling)
	}
	const useWebhook = (req.query || {}).useWebhook || false
	const valUseWebhook = useWebhook == 1 ? true : false
	if (settings.useWebhook != valUseWebhook) {
		settings.useWebhook = valUseWebhook
		config.set('useWebhook', settings.useWebhook)
	}
	const webhookDelay = (req.query || {}).webhookDelay || '0'
	const valWebhookDelay = parseInt(webhookDelay)
	if (settings.webhookDelay != valWebhookDelay) {
		settings.webhookDelay = valWebhookDelay
		config.set('webhookDelay', settings.webhookDelay)
	}	
	const pollingInterval = (req.query || {}).pollingInterval || '100'
	const valPollingInterval = parseInt(pollingInterval)
	if (settings.pollingInterval != valPollingInterval) {
		settings.pollingInterval = valPollingInterval
		config.set('pollingInterval', settings.pollingInterval)
	}
	const defBadges = {
		dolbyvision: (req.query || {}).doviBadge || 'dolbyvision',
		hdr: (req.query || {}).hdrBadge || 'hdrcolor',
		remux: (req.query || {}).remuxBadge || 'remuxgold',
	}

	if (JSON.stringify(defBadges) != JSON.stringify(settings.defaultBadges)) {
		settings.defaultBadges = defBadges
		config.set('defaultBadges', settings.defaultBadges)
	}

	const plexObj = {
		protocol: (req.query || {}).plexProtocol || 'https',
		host: (req.query || {}).plexHost || '',
		port: (req.query || {}).plexPort || '32400',
		token: (req.query || {}).plexToken || ''
	}

	if (plexObj.protocol != settings.plex.protocol || plexObj.host != settings.plex.host || plexObj.port != settings.plex.port || plexObj.token != settings.plex.token) {
		settings.plex = plexObj
		config.set('plex', plexObj)
	}

	const scanOrder = (req.query || {}).scanOrder || false
	if (scanOrder != settings.scanOrder) {
		settings.scanOrder = scanOrder || settings.scanOrder
		config.set('scanOrder', settings.scanOrder)
	}
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true })	
}))

app.get(baseUrl+'getSettings', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	res.send({
		success: true,
		pkgVersion,
		overwrite: settings.overwrite,
		overwrite2years: settings.overwriteLast2Years,
		noEmptyFolders: settings.noPostersToEmptyFolders,
		noScanOnStart: settings.ignoreInitialScan,
		backdrops: settings.backdrops,
		minOverwritePeriod: settings.minOverwritePeriod,
		movieFolders: settings.mediaFolders.movie,
		seriesFolders: settings.mediaFolders.series,
		historyCount: Object.keys(settings.imdbCache.movie || []).length + Object.keys(settings.imdbCache.series || []).length,
		apiKeyPrefix: settings.apiKey ? settings.apiKey.substr(0, 3) : false,
		scanOrder: settings.scanOrder,
		cacheMatches: settings.cacheMatches,
		movieTextless: settings.movieTextless,
		seriesTextless: settings.seriesTextless,
		moviePosterType: settings.moviePosterType,
		seriesPosterType: settings.seriesPosterType,
		usePolling: settings.useWebhook ? 'webhook' : settings.usePolling ? 'polling' : 'fsevents',
		pollingInterval: settings.pollingInterval,
		moviePosterLang: settings.posterLang.movie,
		seriesPosterLang: settings.posterLang.series,
		overwriteProbe: settings.overwriteProbeData,
		defaultBadges: settings.defaultBadges,
		webhookDelay: settings.webhookDelay,
		webhookSonarr: 'http://localhost:'+port+baseUrl+'sonarr',
		webhookRadarr: 'http://localhost:'+port+baseUrl+'radarr',
		plexProtocol: settings.plex.protocol,
		plexHost: settings.plex.host,
		plexPort: settings.plex.port,
		plexToken: settings.plex.token,
		plexDelayType: settings.plexDelayType,
		plexRefreshDelay: settings.plexRefreshDelay,
		plexTodHour: settings.plexTodHour,
		plexTodMin: settings.plexTodMin,
		plexTodAmPm: settings.plexTodAmPm,
		retryFrequency: settings.retryFrequency,
	})
}))

app.get(baseUrl+'disconnectPlex', (req, res) => passwordValid(req, res, (req, res) => {
	settings.plex = {
		protocol: 'https',
		host: '',
		port: '32400',
		token: ''
	}
	config.set('plex', settings.plex)
	plex.connected = false
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true })
}))

app.get(baseUrl+'testPlex', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const testPlexData = {
		plex: {
			protocol: req.query.plexProtocol,
			host: req.query.plexHost,
			port: req.query.plexPort,
			token: req.query.plexToken
		}
	}
	if (!testPlexData.plex.protocol || !testPlexData.plex.host || !testPlexData.plex.port || !testPlexData.plex.token) {
		plex.connected = false
		internalError()
		return
	}
	plex.testConnection(testPlexData, result => {
		if (result) {
			res.setHeader('Content-Type', 'application/json')
			res.send({ success: true })
		} else
			internalError()
	})
}))

app.get(baseUrl+'getBadgeSettings', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.folder
	const mediaType = req.query.type
	if (!mediaName && !mediaType) {
		res.setHeader('Content-Type', 'application/json')
		res.send({ success: true })
		return
	}
	if (mediaType) {
		folderNameToImdb(mediaName, mediaType, imdbId => {
			if (imdbId) {
				const badgeSettings = { success: true }
				if (settings.itemLabels[imdbId])
					badgeSettings.label = settings.itemLabels[imdbId]
				if (settings.itemAutoBadges[imdbId])
					badgeSettings.autoBadges = settings.itemAutoBadges[imdbId]
				if (settings.itemBadges[imdbId])
					badgeSettings.badges = settings.itemBadges[imdbId]
				if (settings.itemBadgePositions[imdbId])
					badgeSettings.badgePos = settings.itemBadgePositions[imdbId]
				if (settings.itemBadgeSizes[imdbId])
					badgeSettings.badgeSize = settings.itemBadgeSizes[imdbId]
				res.setHeader('Content-Type', 'application/json')
				res.send(badgeSettings)
			} else
				internalError()
		})
	} else {
		const badgeSettings = { success: true }
		if (settings.labels[mediaName])
			badgeSettings.label = settings.labels[mediaName]
		if (settings.autoBadges[mediaName])
			badgeSettings.autoBadges = settings.autoBadges[mediaName]
		if (settings.badges[mediaName])
			badgeSettings.badges = settings.badges[mediaName]
		if (settings.badgePositions[mediaName])
			badgeSettings.badgePos = settings.badgePositions[mediaName]
		if (settings.badgeSizes[mediaName])
			badgeSettings.badgeSize = settings.badgeSizes[mediaName]
		res.setHeader('Content-Type', 'application/json')
		res.send(badgeSettings)
	}
}))

app.get(baseUrl+'browse', (req, res) => passwordValid(req, res, async (req, res) => {
	const folder = (req.query || {}).folder || ''
	res.setHeader('Content-Type', 'application/json')
	res.send({
		success: true,
		folders: await browser(folder)
	})
}))

app.get(baseUrl+'editFolderLabel', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const folder = (req.query || {}).folder || ''
	const label = (req.query || {}).label || ''
	const badges = (req.query || {}).badges || ''
	const badgePos = (req.query || {}).badgePos || ''
	const badgeSize = (req.query || {}).badgeSize || ''
	const autoBadges = (req.query || {}).autoBadges || ''
	if (!folder) {
		internalError()
		return
	}
	if (label == 'none' && badges == 'none') {
		internalError()
		return
	}
	if (label) {
		settings.labels[folder] = label
		config.set('labels', settings.labels)
	} else if (settings.labels[folder]) {
		delete settings.labels[folder]
		config.set('labels', settings.labels)
	}
	if (badges) {
		if (autoBadges) {
			settings.autoBadges[folder] = badges
			config.set('autoBadges', settings.autoBadges)
			if (settings.badges[folder]) {
				delete settings.badges[folder]
				config.set('badges', settings.badges)
			}
		} else {
			settings.badges[folder] = badges
			config.set('badges', settings.badges)
			if (settings.autoBadges[folder]) {
				delete settings.autoBadges[folder]
				config.set('autoBadges', settings.autoBadges)				
			}
		}
	} else {
		if (settings.badges[folder]) {
			delete settings.badges[folder]
			config.set('badges', settings.badges)
		}
		if (settings.autoBadges[folder]) {
			delete settings.autoBadges[folder]
			config.set('autoBadges', settings.autoBadges)
		}
	}
	if (badgePos && badgePos != 'none') {
		settings.badgePositions[folder] = badgePos
		config.set('badgePositions', settings.badgePositions)
	} else if (settings.badgePositions[folder]) {
		delete settings.badgePositions[folder]
		config.set('badgePositions', settings.badgePositions)
	}
	if (badgeSize && badgeSize != 'normal') {
		settings.badgeSizes[folder] = badgeSize
		config.set('badgeSizes', settings.badgeSizes)
	} else if (settings.badgeSizes[folder]) {
		delete settings.badgeSizes[folder]
		config.set('badgeSizes', settings.badgeSizes)
	}
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true })
}))

function removeFolderLogic(res, type, folder) {
	if (folder)
		removeMediaFolder(type, folder)
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true })
}

app.get(baseUrl+'removeMovieFolder', (req, res) => passwordValid(req, res, (req, res) => {
	removeFolderLogic(res, 'movie', (req.query || {}).folder || '')
}))

app.get(baseUrl+'removeSeriesFolder', (req, res) => passwordValid(req, res, (req, res) => {
	removeFolderLogic(res, 'series', (req.query || {}).folder || '')
}))

function addFolderLogic(res, type, folder, label, badges, badgePos, badgeSize, autoBadges) {
	if (folder)
		addMediaFolder(type, folder, label, badges, badgePos, badgeSize, autoBadges)
	res.setHeader('Content-Type', 'application/json')
	res.send({ success: true })
}

app.get(baseUrl+'addMovieFolder', (req, res) => passwordValid(req, res, (req, res) => {
	addFolderLogic(res, 'movie', (req.query || {}).folder || '', (req.query || {}).label || '', (req.query || {}).badges || '', (req.query || {}).badgePos || '', (req.query || {}).badgeSize || '', (req.query || {}).autoBadges || '')
}))

app.get(baseUrl+'addSeriesFolder', (req, res) => passwordValid(req, res, (req, res) => {
	addFolderLogic(res, 'series', (req.query || {}).folder || '', (req.query || {}).label || '', (req.query || {}).badges || '', (req.query || {}).badgePos || '', (req.query || {}).badgeSize || '', (req.query || {}).autoBadges || '')
}))

app.get(baseUrl+'setApiKey', (req, res) => passwordValid(req, res, (req, res) => {
	const key = (req.query || {}).key || ''
	res.setHeader('Content-Type', 'application/json')
	if ((key || '').length > 3) {
		settings.apiKey = key
		config.set('apiKey', key)
		res.send({ success: true })
	} else {
		res.send({ success: false })
	}
}))

function changePosterForFolder(folder, imdbId, type) {
	return new Promise((resolve, reject) => {
		if (folder && imdbId && type) {
			if (folder == imdbId) {
				// IMDB ID used as Folder Name
				var foundName = false
				Object.keys(settings.overwriteMatches[type]).some(el => {
					if (settings.overwriteMatches[type][el] == imdbId) {
						foundName = el
						return true
					}
				})
				if (!foundName) {
					Object.keys(settings.imdbCache[type]).some(el => {
						if (settings.imdbCache[type][el] == imdbId) {
							foundName = el
							return true
						}
					})
				}
				if (!foundName) {
					resolve({ success: false, message: `Could not match IMDB ID to any ${type} folders` })
					return
				} else
					folder = foundName
			}
			let mediaFolders = []
			settings.mediaFolders[type].forEach(folders => {
				mediaFolders = mediaFolders.concat(folders)
			})
			if (mediaFolders.length) {
				let allFolders = []
				mediaFolders.forEach(mediaFolder => { allFolders = allFolders.concat(getDirectories(mediaFolder, !!(type == 'movie'))) })

				if (allFolders.length) {
					const simplifiedFolder = folder.trim().toLowerCase()
					let folderMatch
					allFolders.some(fldr => {
						const fldrName = fldr.split(path.sep).pop()
						if (fldrName.trim().toLowerCase() == simplifiedFolder) {
							folderMatch = fldrName

							settings.overwriteMatches[type][folderMatch] = imdbId
							config.set('overwriteMatches', settings.overwriteMatches)

							if (fileHelper.isVideo(fldrName)) {
								const nameNoExt = fileHelper.removeExtension(fldrName)
								nameQueue.unshift({ name: fldrName, folder: path.dirname(fldr), type, forced: true, isFile: true, posterName: nameNoExt + '.jpg', backdropName: nameNoExt + '-fanart.jpg', avoidYearMatch: true }) 
							} else {
								nameQueue.unshift({ name: fldrName, folder: fldr, type, forced: true, avoidYearMatch: true })
							}
							return true
						}
					})
					if (folderMatch) {
						resolve({ success: true })
						return
					}
				}

			}
			resolve({ success: false, message: `The folder could not be found within your ${type} folders` })
			return
		}
		resolve({ success: false, message: `One or more required parameters are missing or invalid` })
	})
}

app.get(baseUrl+'addFixMatch', (req, res) => passwordValid(req, res, async(req, res) => {
	const folder = (req.query || {}).folder || ''
	const imdbPart = (req.query || {}).imdb || ''
	const type = (req.query || {}).type || ''
	res.setHeader('Content-Type', 'application/json')
	if (folder.includes(path.sep)) {
		res.send({ success: false, message: `The folder name cannot include "${path.sep}"` })
		return
	}

	let imdbId

	if (imdbPart)
		imdbId = imdbMatching.imdbIdFromUrl(imdbPart)

	if (!imdbId) {
		res.send({ success: false, message: `Invalid IMDB URL / IMDB ID` })
		return
	}
	const respObj = await changePosterForFolder(folder, imdbId, type)
	res.send(respObj)
}))

let noSpamScan = false

app.get(baseUrl+'runFullScan', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	if (noSpamScan) {
		res.send({ success: false, message: `Full scan already running` })
		return
	}
	noSpamScan = true
	setTimeout(() => {
		noSpamScan = false
	}, 5000)
	if (!fullScanRunning) {
		if (((req || {}).query || {}).folder && req.query.type) {
			const idx = settings.mediaFolders[req.query.type].indexOf(req.query.folder)
			if (idx !== -1) {
				const overwrite = shouldOverwrite(req.query.type)
				startFetchingPosters([req.query.folder], req.query.type, overwrite)
				res.send({ success: true })
				return
			}
		}
		let anyOverwrite = false
		for (const [type, folders] of Object.entries(settings.mediaFolders)) {
			logging.log(`Full scan forced to start for ${type} folders`)
			settings.lastFullUpdate[type] = Date.now()
			const overwrite = shouldOverwrite(type)
			if (overwrite) {
				anyOverwrite = true
				settings.lastOverwrite[type] = Date.now()
			}
			startFetchingPosters(folders, type, overwrite)
		}
		config.set('lastFullUpdate', settings.lastFullUpdate)
		if (anyOverwrite)
			config.set('lastOverwrite', settings.lastOverwrite)
		res.send({ success: true })
		return
	}
	res.send({ success: false, message: `Full scan already running` })
}))

app.get(baseUrl+'forceOverwriteScan', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	if (noSpamScan) {
		res.send({ success: false, message: `Full scan already running` })
		return
	}
	noSpamScan = true
	setTimeout(() => {
		noSpamScan = false
	}, 5000)
	if (((req || {}).query || {}).folder && req.query.type) {
		const idx = settings.mediaFolders[req.query.type].indexOf(req.query.folder)
		if (idx !== -1) {
			startFetchingPosters([req.query.folder], req.query.type, true, true)
			res.send({ success: true })
			return
		}
	}
	for (const [type, folders] of Object.entries(settings.mediaFolders)) {
		logging.log(`Overwrite scan forced to start for ${type} folders`)
		settings.lastFullUpdate[type] = Date.now()
		startFetchingPosters(folders, type, true)
	}
	res.send({ success: true })
}))

app.get(baseUrl+'cancelScan', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	if (nameQueue.length())
		queueDisabled = true
	res.send({ success: true })
}))

app.get(baseUrl+'pollData', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	let lastFullUpdate = 0
	if (settings.lastFullUpdate['movie'] > settings.lastFullUpdate['series'])
		lastFullUpdate = settings.lastFullUpdate['movie']
	else
		lastFullUpdate = settings.lastFullUpdate['series']
	res.send({
		success: true,
		lastFullUpdate,
		historyCount: Object.keys(settings.imdbCache.movie || []).length + Object.keys(settings.imdbCache.series || []).length,
		scanItems: nameQueue.length() || 0,
		plexConnected: plex.connected,
	})
}))

const semver = require('semver')

const pkgVersion = require('./package.json').version

app.get(baseUrl+'needsUpdate', (req, res) => {

	res.setHeader('Content-Type', 'application/json')

	const files = new Array()
	const platform = process.platform == 'win32' ? 'win' : process.platform == 'darwin' ? 'osx' : process.platform
	files.push(platform + '-rpdb-folders-' + process.arch + '.zip')
	files.push(platform + '-rpdb-folders.zip')

	let updateRequired = false

	needle.get('https://api.github.com/repositories/340865291/releases', (err, resp, body) => {
		if (body && Array.isArray(body) && body.length) {
			const tag = body[0].tag_name
			if (semver.compare(pkgVersion, tag) === -1) {
				updateRequired = true
				if (isDocker()) {
					return
				}
				// update required
				let zipBall
				(body[0].assets || []).some(el => {
					if (files.indexOf(el.name) > -1) {
						zipBall = el.browser_download_url
						return true
					}
				})
				if (updateRequired) {
					if (isDocker()) {
						res.send({ needsUpdate: true, dockerUpdate: true })
						return
					} else if (zipBall) {
						res.send({ needsUpdate: true, zipBall })
						return
					}
				}
			}
		} else {
// we will hide the update check error for now
//			if (err)
//				console.error(err)
		}
		res.send({ needsUpdate: false })
	})
})

app.get(baseUrl+'searchStrings', (req, res) => passwordValid(req, res, async (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaType = req.query.type
	if (!mediaType || !(settings.mediaFolders[mediaType] || []).length) {
		internalError()
		return
	}

	let foundSearchFolderName = false

	const reqFolder = req.query.searchfolder

	if (reqFolder) {
		if (reqFolder == 'Unmatched' || reqFolder == 'Missing Posters') {
			foundSearchFolderName = reqFolder
		} else {
			settings.mediaFolders[mediaType].some(el => {
				if (el.endsWith(path.sep + req.query.searchfolder)) {
					foundSearchFolderName = el
					return true
				}
			})
		}
	}

	const searchStringsResp = await searchStrings(foundSearchFolderName ? [foundSearchFolderName] : settings.mediaFolders[mediaType], mediaType, settings.unmatched, settings.missingPosters)
	searchStringsResp.folderChoices = (settings.mediaFolders[mediaType] || []).map(el => el.split(path.sep).pop())
	searchStringsResp.folderChoices.push('Unmatched')
	searchStringsResp.folderChoices.push('Missing Posters')
	res.setHeader('Content-Type', 'application/json')
	res.send(searchStringsResp)	
}))

app.get(baseUrl+'poster', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.name
	const mediaType = req.query.type
	if (!mediaName || !mediaType) {
		internalError()
		return
	}
	function pipePoster(imdbId) {
		const posterUrl = posterFromImdbId(imdbId, mediaType)
		needle.get(posterUrl).pipe(res)
	}
	folderNameToImdb(mediaName, mediaType, imdbId => {
		if (imdbId)
			pipePoster(imdbId)
		else
			internalError()
	})
}))

app.get(baseUrl+'preview', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaImdb = req.query.imdb || 'tt0068646'
	const mediaLabel = req.query.label
	const mediaBadges = req.query.badges
	const mediaBadgePos = req.query.badgePos
	const mediaBadgeSize = req.query.badgeSize
	let queryString = ''
	if (mediaLabel) queryString = '?label=' + mediaLabel
	if (mediaBadges) {
		if (queryString) queryString += '&'
		else queryString = '?'
		queryString += 'badges=' + mediaBadges
	}
	if (mediaBadgePos) {
		if (queryString) queryString += '&'
		else queryString = '?'
		queryString += 'badgePos=' + mediaBadgePos
	}
	if (mediaBadgeSize && mediaBadgeSize != 'normal') {
		if (queryString) queryString += '&'
		else queryString = '?'
		queryString += 'badgeSize=' + mediaBadgeSize
	}
	const posterUrl = 'https://api.ratingposterdb.com/' + settings.apiKey + '/imdb/poster-default/' + mediaImdb + '.jpg' + queryString
	needle.get(posterUrl).pipe(res)
}))

function extendedDataCreatePoster(imdbId, imdbType, tmdbId, tmdbType, posterImage, cb) {
	if ((!imdbId || !posterImage) && tmdbId && tmdbType) {
		tmdbMatching.tmdbToImdb(tmdbId, tmdbType, (foundImdbId, foundPoster) => {
			if (foundImdbId && !imdbId)
				imdbId = foundImdbId
			if (foundPoster && !posterImage)
				posterImage = 'https://image.tmdb.org/t/p/w780' + foundPoster
			cb(imdbId, posterImage)
		})
	} else if (imdbId && !posterImage) {
		nameToImdb({ name: imdbId, type: imdbType }, (err, res, inf) => {
			if (res == imdbId && (((inf || {}).meta || {}).image || {}).src)
				posterImage = inf.meta.image.src.replace('._V1_.', '._V1_SX580.')
			cb(imdbId, posterImage)
		})
	} else {
		if (!imdbId) {
			let newKey = 1
			for (let i = 1; settings.customPosters['tt' + i]; i++) {
				newKey = i
			}
			newKey += 1
			imdbId = 'tt' + newKey
		}
		cb(imdbId, posterImage)
	}
}

app.get(baseUrl+'create-preview', (req, res) => passwordValid(req, res, (req, res) => {
	let imdbId
	let tmdbId
	let posterImage
	let tmdbType = req.query.mediaType == 'movie' ? 'movie' : 'tv'

	if (req.query.imdbUrl)
		imdbId = imdbMatching.imdbIdFromUrl(req.query.imdbUrl)

	if (req.query.img)
		posterImage = req.query.img

	if (req.query.tmdbUrl)
		tmdbId = tmdbMatching.tmdbIdFromUrl(req.query.tmdbUrl)

	extendedDataCreatePoster(imdbId, req.query.mediaType, tmdbId, tmdbType, posterImage, (imdbId, posterImage) => {
		const posterUrl = 'https://api.ratingposterdb.com/' + settings.apiKey + '/imdb/' + req.query.posterType + '/create-poster/' + imdbId + '.jpg?ratings=' + req.query.ratings + (!req.query.img && posterImage ? '&img=' + encodeURIComponent(posterImage) : '') + (req.query.extras ? '&' + req.query.extras : '')
		needle.get(posterUrl).pipe(res)
	})
}))

app.get(baseUrl+'create-poster', (req, res) => passwordValid(req, res, (req, res) => {
	let imdbId
	let tmdbId
	let posterImage
	let tmdbType = req.query.mediaType == 'movie' ? 'movie' : 'tv'

	if (req.query.imdbUrl)
		imdbId = imdbMatching.imdbIdFromUrl(req.query.imdbUrl)

	if (req.query.img)
		posterImage = req.query.img

	if (req.query.tmdbUrl)
		tmdbId = tmdbMatching.tmdbIdFromUrl(req.query.tmdbUrl)

	extendedDataCreatePoster(imdbId, req.query.mediaType, tmdbId, tmdbType, posterImage, async (imdbId, posterImage) => {
		settings.customPosters[imdbId] = 'https://api.ratingposterdb.com/[[api-key]]/imdb/' + req.query.posterType + '/create-poster/' + imdbId + '.jpg?ratings=' + req.query.ratings + (!req.query.img && posterImage ? '&img=' + encodeURIComponent(posterImage) : '') + (req.query.extras ? '&' + req.query.extras : '')
		config.set('customPosters', settings.customPosters)
		const mediaName = req.query.folder
		const mediaType = req.query.mediaType
		const respObj = await changePosterForFolder(mediaName, imdbId, mediaType)
		res.setHeader('Content-Type', 'application/json')
		res.send(respObj)
	})
}))

app.get(baseUrl+'submit-poster', (req, res) => passwordValid(req, res, (req, res) => {
	let imdbId
	let tmdbId
	let posterImage
	let tmdbType = req.query.mediaType == 'movie' ? 'movie' : 'tv'

	if (req.query.imdbUrl)
		imdbId = imdbMatching.imdbIdFromUrl(req.query.imdbUrl)

	if (req.query.img)
		posterImage = req.query.img

	if (req.query.tmdbUrl)
		tmdbId = tmdbMatching.tmdbIdFromUrl(req.query.tmdbUrl)

	extendedDataCreatePoster(imdbId, req.query.mediaType, tmdbId, tmdbType, posterImage, (imdbId, posterImage) => {
		const queryObj = querystring.parse('ratings=' + req.query.ratings + (!req.query.img && posterImage ? '&img=' + posterImage : '') + (req.query.extras ? '&' + req.query.extras : '')) || {}
		if (imdbId && imdbId.length > 7) {
			if (!queryObj.imdb)
				queryObj.imdb = imdbId
			if (!queryObj.imdbUrl)
				queryObj.imdbUrl = 'https://www.imdb.com/title/' + imdbId + '/'
		}
		const submitStr = JSON.stringify(queryObj)
		let buff = Buffer.from(submitStr)
		let submitData = buff.toString('base64')
		const submitUrl = 'https://api.ratingposterdb.com/' + settings.apiKey + '/submit?imageType=' + req.query.posterType + '&data=' + encodeURIComponent(submitData)
		needle.get(submitUrl, (err, resp, body) => {
			res.setHeader('Content-Type', 'application/json')
			res.send({ success: true })
		})
	})
}))

app.get(baseUrl+'checkRequests', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	needle.get('https://api.ratingposterdb.com/' + settings.apiKey + '/requests?break=' + Date.now(), (err, resp, body) => {
		if ((body || {}).limit) {
			body.success = true
			res.send(body)
		} else {
			res.send({ success: false })
		}
	})
}))

const ISO6391 = require('iso-639-1')

const tmdbKey = require('./tmdbKey').key

app.get(baseUrl+'poster-choices', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.name
	const mediaType = req.query.type
	if (!mediaName || !mediaType) {
		internalError()
		return
	}
	folderNameToImdb(mediaName, mediaType, imdbId => {
		if (imdbId) {
			const tmdbType = mediaType == 'movie' ? mediaType : 'tv'
			needle.get('https://api.themoviedb.org/3/find/'+imdbId+'?api_key='+tmdbKey+'&language=en-US&external_source=imdb_id', (err, resp, body) => {
				if (!err && (resp || {}).statusCode == 200 && (((body || {})[tmdbType + '_results'] || [])[0] || {}).id) {
					const tmdbId = body[tmdbType + '_results'][0].id
					needle.get('https://api.themoviedb.org/3/'+tmdbType+'/'+tmdbId+'/images?api_key='+tmdbKey, (err, resp, body) => {
						if (((body || {}).posters || []).length) {
							res.setHeader('Content-Type', 'application/json')
							res.send({ items: body.posters.map(el => { return { file_path: el.file_path, lang: el['iso_639_1'] ? ISO6391.getName(el['iso_639_1']) : null } }) })
						} else {
							internalError()
						}
					})
				} else {
					internalError()
				}
			})
		} else
			internalError()
	})
}))

app.get(baseUrl+'tmdb-poster', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.folder
	const mediaType = req.query.type
	const mediaTmdbPoster = req.query.tmdbPoster
	if (!mediaName || !mediaType || !mediaTmdbPoster) {
		internalError()
		return
	}
	folderNameToImdb(mediaName, mediaType, async (imdbId) => {
		if (imdbId) {
			settings.customPosters[imdbId] = 'https://api.ratingposterdb.com/[[api-key]]/imdb/[[poster-type]]/tmdb-poster/[[imdb-id]]/' + mediaTmdbPoster
			config.set('customPosters', settings.customPosters)
			res.setHeader('Content-Type', 'application/json')
			const respObj = await changePosterForFolder(mediaName, imdbId, mediaType)
			res.send(respObj)
		} else
			internalError()
	})
}))

app.get(baseUrl+'update-ratings-poster', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.folder
	const mediaType = req.query.type
	if (!mediaName || !mediaType) {
		internalError()
		return
	}
	folderNameToImdb(mediaName, mediaType, async (imdbId) => {
		if (imdbId) {
			res.setHeader('Content-Type', 'application/json')
			const respObj = await changePosterForFolder(mediaName, imdbId, mediaType)
			res.send(respObj)
		} else
			internalError()
	})
}))

app.get(baseUrl+'custom-poster', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.folder
	const mediaType = req.query.type
	const mediaCustomPoster = req.query.customPoster
	if (!mediaName || !mediaType || !mediaCustomPoster) {
		internalError()
		return
	}
	folderNameToImdb(mediaName, mediaType, async (imdbId) => {
		if (imdbId) {
			settings.customPosters[imdbId] = 'https://api.ratingposterdb.com/[[api-key]]/imdb/[[poster-type]]/custom-poster/[[imdb-id]].jpg?img=' + encodeURIComponent(mediaCustomPoster)
			config.set('customPosters', settings.customPosters)
			res.setHeader('Content-Type', 'application/json')
			const respObj = await changePosterForFolder(mediaName, imdbId, mediaType)
			res.send(respObj)
		} else
			internalError()
	})
}))

app.get(baseUrl+'editItemLabel', (req, res) => passwordValid(req, res, (req, res) => {
	function internalError() {
		res.status(500)
		res.send('Internal Server Error')
	}
	const mediaName = req.query.folder
	const mediaType = req.query.type
	if (!mediaName || !mediaType) {
		internalError()
		return
	}
	const mediaLabel = req.query.label
	const mediaBadges = req.query.badges
	const mediaBadgePos = req.query.badgePos
	const mediaBadgeSize = req.query.badgeSize
	const mediaAutoBadges = (req.query || {}).autoBadges || ''
	folderNameToImdb(mediaName, mediaType, async (imdbId) => {
		if (imdbId) {
			if (mediaLabel && mediaLabel != 'none') {
				settings.itemLabels[imdbId] = mediaLabel
				config.set('itemLabels', settings.itemLabels)
			} else if (settings.itemLabels[imdbId]) {
				delete settings.itemLabels[imdbId]
				config.set('itemLabels', settings.itemLabels)
			}
			if (mediaBadges && mediaBadges != 'none') {
				if (mediaAutoBadges) {
					settings.itemAutoBadges[imdbId] = mediaBadges
					config.set('itemAutoBadges', settings.itemAutoBadges)
					if (settings.itemBadges[imdbId]) {
						delete settings.itemBadges[imdbId]
						config.set('itemBadges', settings.itemBadges)
					}
				} else {
					settings.itemBadges[imdbId] = mediaBadges
					config.set('itemBadges', settings.itemBadges)
					if (settings.itemAutoBadges[imdbId]) {
						delete settings.itemAutoBadges[imdbId]
						config.set('itemAutoBadges', settings.itemAutoBadges)
					}
				}
			} else {
				if (settings.itemBadges[imdbId]) {
					delete settings.itemBadges[imdbId]
					config.set('itemBadges', settings.itemBadges)
				}
				if (settings.itemAutoBadges[imdbId]) {
					delete settings.itemAutoBadges[imdbId]
					config.set('itemAutoBadges', settings.itemAutoBadges)
				}
			}
			if (mediaBadgePos && mediaBadgePos != 'none') {
				settings.itemBadgePositions[imdbId] = mediaBadgePos
				config.set('itemBadgePositions', settings.itemBadgePositions)
			} else {
				delete settings.itemBadgePositions[imdbId]
				config.set('itemBadgePositions', settings.itemBadgePositions)
			}
			if (mediaBadgeSize && mediaBadgeSize != 'normal') {
				settings.itemBadgeSizes[imdbId] = mediaBadgeSize
				config.set('itemBadgeSizes', settings.itemBadgeSizes)
			} else {
				delete settings.itemBadgeSizes[imdbId]
				config.set('itemBadgeSizes', settings.itemBadgeSizes)
			}
			res.setHeader('Content-Type', 'application/json')
			const respObj = await changePosterForFolder(mediaName, imdbId, mediaType)
			res.send(respObj)
		} else
			internalError()
	})
}))

app.post(baseUrl+'radarr', (req, res) => {
	if (settings.pass) {
		let passedCheck = false
		if (req.headers.authorization) {
			const base64Credentials = req.headers.authorization.split(' ')[1]
			const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8')
			const [username, password] = credentials.split(':')
			if (username && password && username.toLowerCase() === 'rpdb' && password === settings.pass) {
				passedCheck = true
			}
		}
		if (!passedCheck) {
			logging.log('Radarr Webhook Error: Password incorrect')
			res.status(500)
			res.send('Password Incorrect')
			return
		}
	}
	if ((req.body || {}).eventType == 'Download' && !req.body.isUpgrade && (req.body.movie || {}).folderPath) {
		let folderPath = req.body.movie.folderPath
		const fldrName = folderPath.split(path.sep).pop()
		logging.log('Radarr Webhook Log: Received download event for: ' + folderPath)
		if (!fs.existsSync(folderPath)) {
			logging.log('Radarr Webhook Warning: Path "' + folderPath + '" is not accessible')
			logging.log('Radarr Webhook Log: Scanning known movie folders for "' + fldrName + '"')
			let foundFolder = false
			settings.mediaFolders['movie'].some(el => {
				if (fs.existsSync(path.join(el, fldrName))) {
					logging.log('Radarr Webhook Log: Found "' + fldrName + '" in "' + el + '"')
					foundFolder = true
					folderPath = path.join(el, fldrName)
					return true
				}
				return false
			})
			if (!foundFolder) {
				logging.log('Radarr Webhook Error: Could not find "' + fldrName + '" in known movie folders')
				res.status(500)
				res.send('Path inaccessible')
				return
			}
		}
		const reqObj = { folder: folderPath, forced: true, avoidYearMatch: true, type: 'movie' }
		reqObj.name = fldrName
		if (req.body.movie.imdbId)
			reqObj.imdbId = req.body.movie.imdbId
		if (req.body.movie.tmdbId)
			reqObj.tmdbId = req.body.movie.tmdbId
		setTimeout(() => {
			nameQueue.unshift(reqObj)
		}, settings.webhookDelay || 0)
		logging.log(`${req.body.movie.title} has been added to movie`)
		res.send('Success')
	} else {
//		logging.log('Radarr Webhook Log: "'+(req.body || {}).eventType+'" event not useful (not a download event or upgrading video)')
		res.send((req.body || {}).eventType+' event is not useful')
	}
})

app.post(baseUrl+'sonarr', (req, res) => {
	if (settings.pass) {
		let passedCheck = false
		if (req.headers.authorization) {
			const base64Credentials = req.headers.authorization.split(' ')[1]
			const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8')
			const [username, password] = credentials.split(':')
			if (username && password && username.toLowerCase() === 'rpdb' && password === settings.pass) {
				passedCheck = true
			}
		}
		if (!passedCheck) {
			logging.log('Sonarr Webhook Error: Password incorrect')
			res.status(500)
			res.send('Password Incorrect')
			return
		}
	}
	if ((req.body || {}).eventType == 'Download' && !req.body.isUpgrade && (req.body.series || {}).path) {
		let folderPath = req.body.series.path
		const fldrName = folderPath.split(path.sep).pop()
		logging.log('Sonarr Webhook Log: Received download event for: ' + folderPath)
		if (!fs.existsSync(folderPath)) {
			logging.log('Sonarr Webhook Warning: Path "' + folderPath + '" is not accessible')
			logging.log('Sonarr Webhook Log: Scanning known series folders for "' + fldrName + '"')
			let foundFolder = false
			settings.mediaFolders['series'].some(el => {
				if (fs.existsSync(path.join(el, fldrName))) {
					logging.log('Sonarr Webhook Log: Found "' + fldrName + '" in "' + el + '"')
					foundFolder = true
					folderPath = path.join(el, fldrName)
					return true
				}
				return false
			})
			if (!foundFolder) {
				logging.log('Sonarr Webhook Error: Could not find "' + fldrName + '" in known series folders')
				res.status(500)
				res.send('Path inaccessible')
				return
			}
		}
		const reqObj = { folder: folderPath, avoidYearMatch: true, type: 'series' }
		reqObj.name = fldrName
		if (req.body.series.imdbId)
			reqObj.imdbId = req.body.series.imdbId
		if (req.body.series.tmdbId)
			reqObj.tmdbId = req.body.series.tmdbId
		if (req.body.series.tvdbId)
			reqObj.tvdbId = req.body.series.tvdbId
		setTimeout(() => {
			nameQueue.unshift(reqObj)
		}, settings.webhookDelay || 0)
		logging.log(`${req.body.series.title} has been added to series`)
		res.send('Success')
	} else {
//		logging.log('Sonarr Webhook Log: "'+(req.body || {}).eventType+'" event not useful (not a download event or upgrading video)')
		res.send((req.body || {}).eventType+' event is not useful')
	}
})

app.get(baseUrl+'backup.json', (req, res) => passwordValid(req, res, (req, res) => {
	const dt = new Date()
	res.setHeader('Content-Type', 'application/json')
	res.setHeader("Content-Disposition", 'attachment; filename="backup-'+dt.toDateString()+'.json";')
	res.sendFile(config.configPath)
}))

app.get(baseUrl+'getConfigPath', (req, res) => passwordValid(req, res, (req, res) => {
	res.setHeader('Content-Type', 'application/json')
	res.send({ path: config.configPath })
}))


let staticPath = path.join(path.dirname(process.execPath), 'static')

if (!fs.existsSync(staticPath))
	staticPath = path.join(__dirname, 'static')

if (baseUrl !== '/')
	app.use(baseUrl, express.static(staticPath))
else
	app.use(express.static(staticPath))

let settings = {}

let port

const processArgs = process.argv || []

let noBrowser = false
let remoteCommand = false

processArgs.forEach(el => {
	if (el == '--no-browser') {
		noBrowser = true
	} else if (el.startsWith('--remote=')) {
		remoteCommand = el.replace('--remote=', '').replace(/['"]+/g, '')
		const supportedCommands = ['full-scan', 'force-overwrite-scan', 'tv-scan', 'movie-scan', 'overwrite-tv-scan', 'overwrite-movie-scan']
		if (!supportedCommands.includes(remoteCommand))
			throw Error('Unknown remote command passed with "--remote=", supported commands are: ' + supportedCommands.join(', '))
	}
})

setTimeout(async () => {
	if (!remoteCommand) {
		port = await getPort({ port: config.get('port') })
		app.listen(port, async () => {
			settings = config.getAll()

			const httpServer = `http://127.0.0.1:${port}${baseUrl}`
			logging.log(`RPDB Folders running at: ${httpServer}`)
			await startWatcher()
			if (settings.apiKey) {
				await validateApiKey()
			}
			if (!noBrowser) {
				try {
					await open(httpServer)
				} catch(e) {}
			}
			// test plex connection to get status
			plex.testConnection({ plex: settings.plex }, result => {
				setTimeout(() => {
					setPlexTodUpdate()
				}, 60 * 1000)
			})
		})
	} else {
		// process remote commands
		const remotePass = config.get('pass')
		const remoteMediaFolders = config.get('mediaFolders')
		let remoteHost = 'http://127.0.0.1:' + config.get('port') + baseUrl
		const remoteUrls = []
		if (remoteCommand == 'full-scan') {
			remoteUrls.push(remoteHost+'runFullScan?pass=' + encodeURIComponent(remotePass || ''))
		} else if (remoteCommand == 'force-overwrite-scan') {
			remoteUrls.push(remoteHost+'forceOverwriteScan?pass=' + encodeURIComponent(remotePass || ''))
		} else if (remoteCommand == 'movie-scan') {
			remoteMediaFolders.movie.forEach(specificFolder => {
				remoteUrls.push(remoteHost+'runFullScan?folder=' + encodeURIComponent(specificFolder) + '&type=movie&pass=' + encodeURIComponent(remotePass || ''))
			})
		} else if (remoteCommand == 'overwrite-movie-scan') {
			remoteMediaFolders.movie.forEach(specificFolder => {
				remoteUrls.push(remoteHost+'forceOverwriteScan?folder=' + encodeURIComponent(specificFolder) + '&type=movie&pass=' + encodeURIComponent(remotePass || ''))
			})
		} else if (remoteCommand == 'tv-scan') {
			remoteMediaFolders.series.forEach(specificFolder => {
				remoteUrls.push(remoteHost+'runFullScan?folder=' + encodeURIComponent(specificFolder) + '&type=series&pass=' + encodeURIComponent(remotePass || ''))
			})
		} else if (remoteCommand == 'overwrite-tv-scan') {
			remoteMediaFolders.series.forEach(specificFolder => {
				remoteUrls.push(remoteHost+'forceOverwriteScan?folder=' + encodeURIComponent(specificFolder) + '&type=series&pass=' + encodeURIComponent(remotePass || ''))
			})
		}
		let remoteSuccess = false
		const remoteCommandsQueue = async.queue((task, cb) => {
			needle.get(task.url, (err, res) => {
				if (!err && (res || {}).statusCode == 200) {
					remoteSuccess = true // at least one valid success
				}
			})
		}, 1000)
		remoteCommandsQueue.drain(() => {
			if (remoteSuccess) {
				logging.log('Successfully sent remote commands')
			} else {
				logging.log('Failed sending remote commands')
			}
		})
		remoteUrls.forEach(remoteUrl => {
			remoteCommandsQueue.push({ url: remoteUrl })
		})
	}
})
