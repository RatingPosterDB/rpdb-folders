
const needle = require('needle')
const async = require('async')
const path = require('path')
const fs = require('fs')
const logging = require('./logging')
const browser = require('./browser')
const fileHelper = require('./files')

const cache = { movie: {}, series: {} }

const plex = { connected: false }

const rpdbAppName = 'Rating Poster Database'
const rpdbAppId = 'c41f9cfd-c5a6-478c-8558-338bcf042cf3'

plex.getLibraries = (settings, type, cb) => {
	if (settings.plex.protocol && settings.plex.host && settings.plex.port && settings.plex.token) {
		const plexType = type ? type == 'series' ? 'show' : 'movie' : false
		const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections?X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
		needle.get(url, (err, res) => {
			if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((res.body || {}).children || []).length) {
				plex.connected = true
				let libsByType = []
				if (plexType)
					res.body.children.forEach(el => {
						if (((el || {}).attributes || {}).type == plexType)
							libsByType.push(el)
					})
				else
					libsByType = res.body.children
				cb(libsByType)
			} else {
				cb(false)
			}
		})
	} else {
		cb(false)
	}
}

plex.testConnection = (settings, cb) => {
	plex.getLibraries(settings, null, resp => {
		plex.connected = !!resp
		cb(plex.connected)
	})
}

plex.findMovieBySize = (settings, movieFile, mediaSize, cb, mediaFolder) => {
	if (movieFile && cache.movie[movieFile]) {
		cb(cache.movie[movieFile])
		return
	}
	if (!(settings || {}).plex || !movieFile || !mediaSize) {
		cb(false)
		return
	}
	plex.getLibraries(settings, 'movie', libsByType => {
		if ((libsByType || []).length) {
			const libKeys = libsByType.map(el => el.attributes.key)
			let libCount = libKeys.length
			let libRespond = false
			function libEnd(mediaIds) {
				if (mediaIds) {
					libRespond = true
					cb(mediaIds)
				}
				libCount--
				if (!libCount && !libRespond)
					cb(false)
			}
			libKeys.forEach(libKey => {
				const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + libKey + '/all?mediaSize=' + mediaSize + '&includeGuids=1&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
				needle.get(url, (err, res) => {
					if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
						plex.connected = true
						let mediaObj = false
						res.body.children.some(mediaEl => {
							return mediaEl.children.some(el => {
								if ((el || {}).name == 'Media') {
									if ((((el.children || {})[0] || {}).attributes || {}).file && el.children[0].attributes.file.endsWith(path.basename(movieFile))) {
										mediaObj = el
										mediaObjParent = mediaEl
										return true
									}
								}
							})
						})
						if (mediaObj) {
							const mediaIds = { plex: mediaObjParent.attributes.ratingKey }
							mediaObjParent.children.forEach(el => {
								if (el.name == 'Guid') {
									if (((el.attributes || {}).id || '').startsWith('imdb://')) {
										mediaIds.imdb = el.attributes.id.replace('imdb://', '')
									} else if (((el.attributes || {}).id || '').startsWith('tmdb://')) {
										mediaIds.tmdb = el.attributes.id.replace('tmdb://', '')
									} else if (((el.attributes || {}).id || '').startsWith('tvdb://')) {
										mediaIds.tvdb = el.attributes.id.replace('tvdb://', '')
									}
								}
							})
							if (movieFile)
								cache.movie[movieFile] = mediaIds
							libEnd(mediaIds)
						} else {
							libEnd()
						}
					} else {
						libEnd()
					}
				})
			})
		} else {
			cb(false)
		}
	})
}

plex.findSeriesByEpisodeSize = (settings, episodeFile, mediaSize, cb, mediaFolder) => {
	if (episodeFile && cache.series[episodeFile]) {
		cb(cache.series[episodeFile])
		return
	}
	if (!(settings || {}).plex || !episodeFile || !mediaSize) {
		cb(false)
		return
	}
	plex.getLibraries(settings, 'series', libsByType => {
		if ((libsByType || []).length) {
			const libKeys = libsByType.map(el => el.attributes.key)
			let libCount = libKeys.length
			let libRespond = false
			function libEnd(mediaIds) {
				if (mediaIds) {
					libRespond = true
					cb(mediaIds)
				}
				libCount--
				if (!libCount && !libRespond)
					cb(false)
			}
			libKeys.forEach(libKey => {
			 	const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + libKey + '/all?mediaSize=' + mediaSize + '&type=4&includeCollections=0&includeExternalMedia=0&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
				needle.get(url, (err, res) => {
					if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
						plex.connected = true
						const foundMedia = res.body.children.some(mediaEl => {
							return mediaEl.children.some(el => {
								if ((el || {}).name == 'Media') {
									if ((((el.children || {})[0] || {}).attributes || {}).file && el.children[0].attributes.file.endsWith(path.basename(episodeFile))) {
										if ((mediaEl.attributes || {}).grandparentKey) {
										 	const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + mediaEl.attributes.grandparentKey + '?X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
											needle.get(url, (err, res) => {
												if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
													const mediaObjParent = res.body.children[0]
													const mediaIds = { plex: mediaEl.attributes.grandparentKey.split('/').pop() }
													mediaObjParent.children.forEach(el => {
														if (el.name == 'Guid') {
															if (((el.attributes || {}).id || '').startsWith('imdb://')) {
																mediaIds.imdb = el.attributes.id.replace('imdb://', '')
															} else if (((el.attributes || {}).id || '').startsWith('tmdb://')) {
																mediaIds.tmdb = el.attributes.id.replace('tmdb://', '')
															} else if (((el.attributes || {}).id || '').startsWith('tvdb://')) {
																mediaIds.tvdb = el.attributes.id.replace('tvdb://', '')
															}
														}
													})
													if (episodeFile)
														cache.series[episodeFile] = mediaIds
													libEnd(mediaIds)
												} else {
													libEnd()
												}
											})
											return true
										}
									}
								}
							})
						})
						if (!foundMedia)
							libEnd()
					} else {
						libEnd()
					}
				})
			})
		} else {
			cb(false)
		}
	})
}

plex.refreshById = (settings, mediaIds, cb) => {
	if (settings.plex.protocol && settings.plex.host && settings.plex.port && settings.plex.token && (mediaIds || {}).plex) {
		const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/metadata/' + mediaIds.plex + '/refresh'
		needle.put(url, null, { headers: {  'X-Plex-Product': rpdbAppName, 'X-Plex-Client-Identifier': rpdbAppId, 'X-Plex-Token': settings.plex.token, origin: 'https://app.plex.tv', referer: 'https://app.plex.tv/' } }, (err, res) => {
			if (!err && (res || {}).statusCode == 200) {
				plex.connected = true
				cb(true)
			} else {
				cb(false)
			}
		})
	} else {
		cb(false)
	}
}

plex.refreshByFile = (settings, file, mediaType, cb, mediaFolder) => {
	plex.idsByFile(settings, file, mediaType, mediaIds => {
		if ((mediaIds || {}).plex) {
			plex.refreshById(settings, mediaIds, cb, mediaFolder)
		} else {
			cb(false)
		}
	}, mediaFolder)
}

plex.idsByFile = (settings, file, mediaType, cb, mediaFolder) => {
	const func = mediaType == 'movie' ? 'findMovieBySize' : 'findSeriesByEpisodeSize'
	plex[func](null, null, null, mediaIds => {
		if (Object.keys(mediaIds || {}).length) {
			cb(mediaIds)
		} else {
			let mediaSize
			try {
				mediaSize = fs.statSync(file).size
			} catch(e) {
				logging.log('Warning: Cannot get file size for "' + file + '"')
				logging.log('Warning: Without the file size, we cannot match this media to Plex')
			}
			if (mediaSize) {
				plex[func](settings, file, mediaSize, cb, mediaFolder)
			} else
				cb(false)
		}
	}, mediaFolder)
}

async function getSeriesFile(mediaType, file) {
	if (mediaType == 'series') {
		// this becomes more complicated here, we will need to find the first video in this folder

		let foundSeriesVideo = false
		let newFileLoc = false

		const folders = await browser(file)

		if ((folders || []).length) {

			const seasonFolder = folders[0]

			if ((seasonFolder || {}).path) {
				const foldersAndVideos = await browser(seasonFolder.path, true)
				if ((foldersAndVideos || []).length) {
					foldersAndVideos.some(el => {
						if (fileHelper.isVideo((el || {}).path || '')) {
							newFileLoc = el.path
							return true
						}
					})
					if (newFileLoc) {
						foundSeriesVideo = true
					}
				}
			}
		}
		return foundSeriesVideo ? newFileLoc : false
	} else
		return false
}

plex.pollForRefreshByFile = async (settings, file, mediaType, cb, mediaFolder) => {
	if (!((settings || {}).plex || {}).token) {
		cb(false)
		return
	}	
	if (mediaType == 'series') {
		const episodeFile = await getSeriesFile(mediaType, file)
		if (!episodeFile) {
			logging.log('Warning: Could not find any video file for the series in order to refresh metadata in Plex.')
			cb(false)
			return
		} else
			file = episodeFile
	}
	const retrier = async.queue((task, taskCb) => {
		plex.refreshByFile(task.settings, task.file, task.mediaType, result => {
			if (result) {
				cb(result)
				taskCb()
			} else {
				if (!task.retries) task.retries = 0
				if (task.retries < 6) {
					task.retries++
					logging.log('Could not find "'+task.file+'" in Plex, trying again in 1m')
					retrier.push(task)
					setTimeout(() => {
						taskCb()
					}, 1 * 60 * 1000) // try 6 times (once every 1m)
				} else {
					logging.log('Could not find "'+task.file+'" in Plex, giving up')
					cb(false)
					taskCb()
				}
			}
		}, task.mediaFolder)
	})
	retrier.push({ settings, file, mediaType, cb, mediaFolder })
}

plex.pollForIdsByFile = async (settings, file, mediaType, cb, mediaFolder) => {
	if (!((settings || {}).plex || {}).token) {
		cb(false)
		return
	}
	if (mediaType == 'series') {
		const episodeFile = await getSeriesFile(mediaType, file)
		if (!episodeFile) {
			logging.log('Warning: Could not find any video file for the series in order to refresh metadata in Plex.')
			cb(false)
			return
		} else
			file = episodeFile
	}
	const retrier = async.queue((task, taskCb) => {
		plex.idsByFile(task.settings, task.file, task.mediaType, result => {
			if (Object.keys(result || {}).length) {
				cb(result)
				taskCb()
				return
			} else {
				if (!task.retries) task.retries = 0
				if (task.retries < 6) {
					task.retries++
					logging.log('Could not find "'+task.file+'" in Plex, trying again in 1m')
					retrier.push(task)
					setTimeout(() => {
						taskCb()
					}, 1 * 60 * 1000) // try 6 times (once every 1m)
				} else {
					logging.log('Could not find "'+task.file+'" in Plex, giving up')
					taskCb()
				}
			}
		}, task.mediaFolder)
	})
	retrier.push({ settings, file, mediaType, cb, mediaFolder })
}

plex.pollForRefreshByFilePromise = (settings, file, mediaType, cb, mediaFolder) => {
	return new Promise((resolve, reject) => {
		plex.pollForRefreshByFile(settings, file, mediaType, result => {
			resolve(result)
		}, mediaFolder)
	})
}

plex.pollForIdsByFilePromise = (settings, file, mediaType, cb, mediaFolder) => {
	return new Promise((resolve, reject) => {
		plex.pollForIdsByFile(settings, file, mediaType, result => {
			resolve(result)
		}, mediaFolder)
	})
}

module.exports = plex
