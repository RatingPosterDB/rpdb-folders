
const needle = require('needle')
const path = require('path')
const fs = require('fs')
const logging = require('./logging')

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
	if (mediaFolder && cache.movie[mediaFolder]) {
		cb(cache.movie[mediaFolder])
		return
	}
	if (!(settings || {}).plex || !movieFile || !mediaSize) {
		cb(false)
		return
	}
	plex.getLibraries(settings, 'movie', libsByType => {
		if ((libsByType || []).length) {
			const libKeys = libsByType.map(el => el.attributes.key)
			libKeys.forEach(libKey => {
				const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + libKey + '/all?mediaSize=' + mediaSize + '&includeGuids=1&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
				needle.get(url, (err, res) => {
					if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
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
							const mediaIds = { plex: mediaObj.attributes.id }
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
							if (mediaFolder)
								cache.movie[mediaFolder] = mediaIds
							cb(mediaIds)
						} else {
							cb(false)
						}
					} else {
						cb(false)
					}
				})
			})
		} else {
			cb(false)
		}
	})
}

plex.findSeriesByEpisodeSize = (settings, episodeFile, mediaSize, cb, mediaFolder) => {
	if (mediaFolder && cache.series[mediaFolder]) {
		cb(cache.series[mediaFolder])
		return
	}
	if (!(settings || {}).plex || !movieFile || !mediaSize) {
		cb(false)
		return
	}
	plex.getLibraries(settings, 'series', libsByType => {
		if ((libsByType || []).length) {
			const libKeys = libsByType.map(el => el.attributes.key)
			libKeys.forEach(libKey => {
			 	const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + libKey + '/all?mediaSize=' + mediaSize + '&type=4&includeCollections=0&includeExternalMedia=0&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
				needle.get(url, (err, res) => {
					if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
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
													if (mediaFolder)
														cache.series[mediaFolder] = mediaIds
													cb(mediaIds)
												} else {
													cb(false)
												}
											})
											return true
										}
									}
								}
							})
						})
						if (!foundMedia)
							cb(false)
					} else {
						cb(false)
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
	const func = mediaType == 'movie' ? 'refreshByMovieSize' : 'refreshSeriesByEpisodeSize'
	plex[func](null, null, null, mediaIds => {
		if ((mediaIds || {}).plex) {
			plex.refreshById(settings, mediaIds, cb, mediaFolder)
		} else {
			let mediaSize
			try {
				mediaSize = fs.statSync(file).size
			} catch(e) {
				logging.log('Warning: Cannot get file size for "' + file + '"')
				logging.log('Warning: Without the file size, we cannot match this media to Plex')
			}
			if (mediaSize) {
				plex[func](settings, file, mediaSize, mediaIds => {
					if ((mediaIds || {}).plex) {
						plex.refreshById(settings, mediaIds, cb, mediaFolder)
					} else {
						cb(false)
					}
				})
			} else
				cb(false)
		}
	}, mediaFolder)
}

plex.idsByFile = (settings, file, mediaType, cb, mediaFolder) => {
	const func = mediaType == 'movie' ? 'refreshByMovieSize' : 'refreshSeriesByEpisodeSize'
	plex[func](null, null, null, mediaIds => {
		if (Object.keys(mediaIds || {}).length) {
			cb(mediaIds)
		} else {
			let mediaSize
			try {
				mediaSize = fs.statSync(file).size
			} catch(e) {}
			if (mediaSize) {
				plex[func](settings, file, mediaSize, cb, mediaFolder)
			} else
				cb(false)
		}
	}, mediaFolder)
}

plex.pollForRefreshByFile = (settings, file, mediaType, cb, mediaFolder) => {
	const func = mediaType == 'movie' ? 'refreshByMovieSize' : 'refreshSeriesByEpisodeSize'
	const retrier = async.queue((task, taskCb) => {
		plex.refreshByFile(task.settings, task.file, task.mediaType, result => {
			if (result) {
				cb(result)
				taskCb()
				return
			} else {
				if (!task.retries) task.retries = 0
				if (task.retries < 4) {
					task.retries++
					logging.log('Could not find "'+mediaFolder+'" in Plex, trying again in 3m')
					retrier.push(task)
				} else {
					logging.log('Could not find "'+mediaFolder+'" in Plex, giving up')
				}
			}
			setTimeout(() => {
				taskCb()
			}, 3 * 60 * 1000) // try 4 times every 3m
		}, task.mediaFolder)
	})
	retrier.push({ settings, file, mediaType, cb, mediaFolder })
}

plex.pollForIdsByFile = (settings, file, mediaType, cb, mediaFolder) => {
	const func = mediaType == 'movie' ? 'refreshByMovieSize' : 'refreshSeriesByEpisodeSize'
	const retrier = async.queue((task, taskCb) => {
		plex.idsByFile(task.settings, task.file, task.mediaType, result => {
			if (Object.keys(result || {}).length) {
				cb(result)
				taskCb()
				return
			} else {
				if (!task.retries) task.retries = 0
				if (task.retries < 3) {
					task.retries++
					logging.log('Could not find "'+mediaFolder+'" in Plex, trying again in 3m')
					retrier.push(task)
				} else {
					logging.log('Could not find "'+mediaFolder+'" in Plex, giving up')
				}
			}
			setTimeout(() => {
				taskCb()
			}, 3 * 60 * 1000) // try every 3m
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
