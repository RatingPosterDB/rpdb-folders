
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
		needle.get(url, { response_timeout: 15000, read_timeout: 15000 }, (err, res) => {
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
	if (!(settings || {}).plex || !mediaSize) {
		cb(false)
		return
	}
	plex.getLibraries(settings, 'movie', libsByType => {
		let libKeysLogs = []
		let clearLibKeysLogs = []
		libKeysLogs.push('Number of libraries to search: ' + (libsByType || []).length)
		if ((libsByType || []).length) {
			const libKeys = libsByType.map(el => el.attributes.key)
			let libCount = libKeys.length
			let libRespond = false
			let foundMediaIds = false
			function libEnd(mediaIds) {
				if (libRespond) return
				if (mediaIds) {
					foundMediaIds = true
					libRespond = true
					cb(mediaIds)
					return
				}
				libCount--
				if (!libCount) {
					libRespond = true
					cb(false)
				}
			}
			const libKeysQueue = async.queue((task, taskCb) => {
				if (foundMediaIds) {
					taskCb()
					return
				}
				function tryByLibUrl(url, tryType, tryCb) {
					needle.get(url, { response_timeout: 15000, read_timeout: 15000 }, (err, res) => {
						if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
							plex.connected = true
							let mediaObj = false
							res.body.children.some(mediaEl => {
								return mediaEl.children.some(el => {
									if ((el || {}).name == 'Media') {
										if (!movieFile || (((el.children || {})[0] || {}).attributes || {}).file && el.children[0].attributes.file.endsWith(filename)) {
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

								tryCb(mediaIds)
							} else {
								libKeysLogs.push('Could not find video in plex library ('+tryType+') results for key: ' + task.libKey + ' and filesize: ' + mediaSize)
								clearLibKeysLogs.push(res.body.children)
								tryCb()
							}
						} else {
							libKeysLogs.push('Failed searching library with key: ' + task.libKey)
							if (!((((res.body || {}).children || [])[0] || {}).children || []).length)
								libKeysLogs.push('No search results in library ('+tryType+') with key: ' + task.libKey + ' for filesize: ' + mediaSize)
							if (err)
								clearLibKeysLogs.push(err)
							tryCb()
						}
					})
				}
				const filename = path.basename(movieFile)
				const urlForSize = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + task.libKey + '/all?mediaSize=' + mediaSize + '&includeGuids=1&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
				const urlForName = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + task.libKey + '/all?file=' + encodeURIComponent(filename) + '&includeGuids=1&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
				tryByLibUrl(urlForSize, 'bySize', mediaIds => {
					if (!mediaIds) {
						tryByLibUrl(urlForName, 'byName', mediaIds => {
							libEnd(mediaIds)
							taskCb()
						})
					} else {
						libEnd(mediaIds)
						taskCb()
					}
				})
			}, 1)

			libKeysQueue.drain(() => {
				if (!foundMediaIds) {
					libKeysLogs.forEach(el => { logging.log(el) })
					clearLibKeysLogs.forEach(el => { console.log(el) })
				}
				libKeysLogs = null
				clearLibKeysLogs = null
			})

			libKeys.forEach(libKey => { libKeysQueue.push({ libKey }) })
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
		let libKeysLogs = []
		let clearLibKeysLogs = []
		libKeysLogs.push('Number of libraries to search: ' + (libsByType || []).length)
		if ((libsByType || []).length) {
			const libKeys = libsByType.map(el => el.attributes.key)
			let libCount = libKeys.length
			let libRespond = false
			let foundMediaIds = false
			function libEnd(mediaIds) {
				if (libRespond) return
				if (mediaIds) {
					foundMediaIds = true
					libRespond = true
					cb(mediaIds)
					return
				}
				libCount--
				if (!libCount) {
					libRespond = true
					cb(false)
				}
			}
			const libKeysQueue = async.queue((task, taskCb) => {
				if (foundMediaIds) {
					taskCb()
					return
				}
			 	function tryByLibUrl(url, tryType, tryCb) {
					needle.get(url, { response_timeout: 15000, read_timeout: 15000 }, (err, res) => {
						if (!err && (res || {}).statusCode == 200 && res.body && typeof res.body === 'object' && ((((res.body || {}).children || [])[0] || {}).children || []).length) {
							plex.connected = true
							const foundMedia = res.body.children.some(mediaEl => {
								return mediaEl.children.some(el => {
									if ((el || {}).name == 'Media') {
										if ((((el.children || {})[0] || {}).attributes || {}).file && el.children[0].attributes.file.endsWith(filename)) {
											if ((mediaEl.attributes || {}).grandparentKey) {
											 	const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + mediaEl.attributes.grandparentKey + '?X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
												needle.get(url, { response_timeout: 15000, read_timeout: 15000 }, (err, res) => {
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
														tryCb(mediaIds)
													} else {
														tryCb()
													}
												})
												return true
											}
										}
									}
								})
							})
							if (!foundMedia) {
								libKeysLogs.push('Could not find video in plex library ('+tryType+') results for key: ' + task.libKey + ' and filesize: ' + mediaSize)
								clearLibKeysLogs.push(res.body.children)
								tryCb()
							}
						} else {
							libKeysLogs.push('Failed searching library ('+tryType+') with key: ' + task.libKey)
							if (!((((res.body || {}).children || [])[0] || {}).children || []).length)
								libKeysLogs.push('No search results in library ('+tryType+') with key: ' + task.libKey + ' for filesize: ' + mediaSize)
							if (err)
								clearLibKeysLogs.push(err)
							tryCb()
						}
					})
				}
				const filename = path.basename(episodeFile)
			 	const urlForSize = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + task.libKey + '/all?mediaSize=' + mediaSize + '&type=4&includeCollections=0&includeExternalMedia=0&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
			 	const urlForName = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/sections/' + task.libKey + '/all?file=' + encodeURIComponent(filename) + '&type=4&includeCollections=0&includeExternalMedia=0&X-Plex-Token=' + settings.plex.token + '&X-Plex-Product=' + encodeURIComponent(rpdbAppName) + '&X-Plex-Client-Identifier=' + encodeURIComponent(rpdbAppId)
			 	tryByLibUrl(urlForSize, 'bySize', mediaIds => {
			 		if (!mediaIds) {
			 			tryByLibUrl(urlForName, 'byName', mediaIds => {
			 				libEnd(mediaIds)
			 				taskCb()
			 			})
			 		} else {
			 			libEnd(mediaIds)
			 			taskCb()
			 		}
			 	})
			}, 1)

			libKeysQueue.drain(() => {
				if (!foundMediaIds) {
					libKeysLogs.forEach(el => { logging.log(el) })
					clearLibKeysLogs.forEach(el => { console.log(el) })
				}
				libKeysLogs = null
				clearLibKeysLogs = null
			})

			libKeys.forEach(libKey => { libKeysQueue.push({ libKey }) })
		} else {
			cb(false)
		}
	})
}

plex.refreshById = (settings, mediaIds, cb) => {
	if (settings.plex.protocol && settings.plex.host && settings.plex.port && settings.plex.token && (mediaIds || {}).plex) {
		const url = settings.plex.protocol + '://' + settings.plex.host + ':' + settings.plex.port + '/library/metadata/' + mediaIds.plex + '/refresh'
		needle.put(url, { response_timeout: 15000, read_timeout: 15000 }, { headers: {  'X-Plex-Product': rpdbAppName, 'X-Plex-Client-Identifier': rpdbAppId, 'X-Plex-Token': settings.plex.token, origin: 'https://app.plex.tv', referer: 'https://app.plex.tv/' } }, (err, res) => {
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

const isVideo = (source) => { try { return !fs.lstatSync(source).isDirectory() && fileHelper.isVideo(source) } catch(e) { return false } }
const getVideos = (source) => { try { return fs.readdirSync(source).map(name => path.join(source, name)).filter(isVideo) } catch(e) { console.error(e); return [] } }

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
				function plexCb(result) {
					if (Object.keys(result || {}).length) {
						cb(result)
						return
					}
					if (mediaType == 'movie') {
						const videos = (getVideos(path.dirname(file)) || []).filter(el => !path.basename(el).toLowerCase().includes('-trailer.'))
						if (videos.length > 1) {
							logging.log('Detected possible movie with multiple video files, attempting to match')
							let sumSize = 0
							videos.forEach(el => {
								const partFileTags = ['cd','disc','disk','dvd','part','pt']
								const isPartFile = partFileTags.some(part => !!(path.basename(el).match(new RegExp(' '+part+'[1|2|3|4|5|6]\.','gi')) || []).length)
								if (!isPartFile)
									return
								let mediaSize
								try {
									mediaSize = fs.statSync(el).size
								} catch(e) {
									logging.log('Warning: Cannot get file size for "' + file + '"')
									logging.log('Warning: Without the file size, we cannot match this media to Plex')
								}
								if (!mediaSize)
									return
								sumSize += mediaSize
							})
							if (!sumSize) {
								logging.log('Warning: Failed to match media with multiple video files')
								cb(result)
							} else {
								plex[func](settings, null, sumSize, cb, mediaFolder)
							}
							return
						}
					}
					cb(result)
				}
				plex[func](settings, file, mediaSize, plexCb, mediaFolder)
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
	if (!((settings || {}).plex || {}).token || !plex.connected) {
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
					cb(false)
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
