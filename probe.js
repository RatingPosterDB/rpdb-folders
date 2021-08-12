
const fs = require('fs')
const path = require('path')

const browser = require('./browser')

const fileHelper = require('./files')

const convert3To1 = require('iso-639-3-to-1')

const tnp = require('torrent-name-parser')

const logging = require('./logging')

let MediaInfoFactory = false
let mediainfo = false

const isSubFile = (mustStartWith, source) => { try { return fileHelper.isSub(source) && path.basename(source).startsWith(mustStartWith) } catch(e) { return false } }
const getSubs = (source, mustStartWith) => { try { return fs.readdirSync(source).map(name => path.join(source, name)).filter(isSubFile.bind(null, mustStartWith)) } catch(e) { return [] } }

const getSubFileLangs = fileLoc => {
	const filename = path.basename(fileLoc)

	const dirname = path.dirname(fileLoc)

	const nameNoExt = fileHelper.removeExtension(filename)

	const subFiles = getSubs(dirname, nameNoExt) || []

	return subFiles.map(el => {
		const lang = fileHelper.removeExtension(path.basename(el).replace(nameNoExt, '')).substr(1)
		const langLength = (lang || '').length
		if (langLength == 3) {
			return (convert3To1(lang) || '').toLowerCase()
		} else if (langLength == 2) {
			return lang.toLowerCase()
		} else if (langLength > 3 || langLength < 2) {
			return false
		}
	}).filter(el => !!el)
}

const getImdbId = (fileLoc, isDirectFile) => {

	const filename = path.basename(fileLoc)

	const dirname = path.dirname(fileLoc)

	const nameNoExt = fileHelper.removeExtension(filename)

	const dbFile = isDirectFile ? path.join(dirname, nameNoExt + '-rpdb.json') : path.join(dirname, 'rpdb.json')

	if (fs.existsSync(dbFile)) {
		let dbData = false
		try {
			dbData = JSON.parse(fs.readFileSync(dbFile))
		} catch(e) {}

		if (dbData && Object.keys(dbData).length) {
			if (dbData.imdbId) {
				return dbData.imdbId
			}
		}
	}

	return false
}

const analyze = file => {

	return new Promise(async (resolve, reject) => {

		if (!MediaInfoFactory)
			MediaInfoFactory = require('mediainfo.js')

		if (!mediainfo)
			try {
				mediainfo = await MediaInfoFactory({ format: 'object', coverData: false })
			} catch(e) {
				logging.log('Warning: Unable to initiate mediainfo library in order to probe video')
				return resolve(false)
			}

		if (!mediainfo) {
			logging.log('Warning: Could not load mediainfo library in order to probe video')
			return resolve(false)
		}

		let fileSize = false
		let fileHandle = false

		const readChunk = async (size, offset) => {
			return new Promise((resolve, reject) => {
				const buffer = new Uint8Array(size)
				fs.read(fileHandle, buffer, 0, size, offset, (err) => {
					if (err) {
						logging.log('Warning: There was an issue while reading the video file when attempting to probe')
						console.error(err)
						resolve(false)
						end()
						return
					}

					resolve(buffer)
				})
			})
		}

		fs.open(file, 'r', async (err, handle) => {
			if (err) {
				logging.log('Warning: Could not open video file in order to probe video')
				console.error(err)
				resolve(false)
				end()
				return
			}
			fileHandle = handle
			fs.fstat(fileHandle, async (err, stat) => {
				if (err) {
					logging.log('Warning: Could not retrieve video file stats in order to probe video')
					console.error(err)
					resolve(false)
					end()
					return
				}
				fileSize = stat.size
				mediainfo.analyzeData(() => fileSize, readChunk).then(result => {
					resolve((((result || {}).media || {}).track || []).some(el => !!((el || {})['@type'] == 'Video')) ? result : false)
				}).catch(e => {
					if (mediainfo) {
						mediainfo.close()
						mediainfo = false
					}
					logging.log('Warning: Could not probe video file')
					console.error(e)
					resolve(false)
				})
			})
		})

		function end() {
			// mediainfo.close() ?
			if (fileHandle)
				fs.close(fileHandle, () => {})
		}
	})
}

const getDbFile = (dirname, isDirectFile) => {
	const dbFile = isDirectFile ? path.join(dirname, nameNoExt + '-rpdb.json') : path.join(dirname, 'rpdb.json')
	return !!(fs.existsSync(dbFile))
}

const probe = (fileLoc, isDirectFile, isSeries, imdbId, overwriteProbeData) => {
	return new Promise(async (resolve, reject) => {

		let dirname = false

		if (isSeries) {
			// this becomes more complicated here, we will need to find the first video in this folder

			dirname = fileLoc

			let foundSeriesVideo = false

			const folders = await browser(fileLoc)

			if ((folders || []).length) {

				const seasonFolder = folders[0]

				if ((seasonFolder || {}).path) {
					const foldersAndVideos = await browser(seasonFolder.path, true)
					if ((foldersAndVideos || []).length) {
						let newFileLoc = false
						foldersAndVideos.some(el => {
							if (fileHelper.isVideo((el || {}).path || '')) {
								newFileLoc = el.path
								return true
							}
						})
						if (newFileLoc) {
							fileLoc = newFileLoc
							foundSeriesVideo = true
						}
					}
				}
			}
			if (!foundSeriesVideo) {
				logging.log('Warning: Could not find any video file for the series in order to probe')
				resolve(false)
				return
			}
		} else {
			dirname = path.dirname(fileLoc)
		}

		const filename = path.basename(fileLoc)

		const nameNoExt = fileHelper.removeExtension(filename)

		const dbFile = isDirectFile ? path.join(dirname, nameNoExt + '-rpdb.json') : path.join(dirname, 'rpdb.json')

		if (!overwriteProbeData && fs.existsSync(dbFile)) {
			let dbData = false
			try {
				dbData = JSON.parse(fs.readFileSync(dbFile))
			} catch(e) {}

			if (dbData && Object.keys(dbData).length) {
				if (dbData.filename == filename) {
					resolve(dbData)
					return
				}
			}
		}

		const info = await analyze(fileLoc)
		if (!info) {
			console.error(Error('Warning: Missing video probing response'))
			resolve(false)
			return
		}
		const fileDb = {
			codecs: {
				video: [],
				audio: [],
				audioCommercial: [],
			},
			languages: {
				subtitles: [],
				audio: [],
			},
			videoHeight: false,
			videoWidth: false,
			matchedImdbByMediaInfo: false,
		}
		let hasVideoStream = false
		const videoRes = { width: 0, height: 0 }
		let audioChans = 0
		info.media.track.forEach(stream => {
			if (stream['@type'] == 'General') {
				if (stream.extra) {
					if (stream.extra['IMDB']) {
						fileDb.matchedImdbByMediaInfo = true
						fileDb.imdbId = stream.extra['IMDB']
					} else if (stream.extra['TMDB']) {
						fileDb.tmdbId = stream.extra['TMDB']
					}
				}
			} else if (stream['@type'] == 'Video') {
				hasVideoStream = true
				if (stream['Format'])
					if (!fileDb.codecs.video.includes(stream['Format']))
						fileDb.codecs.video.push(stream['Format'].toLowerCase())
				if (stream['Height'] && stream['Width']) {
					const vidHeight = parseInt(stream['Height'])
					const vidWidth = parseInt(stream['Width'])
					if (vidHeight > videoRes.height && vidWidth > videoRes.width) {
						videoRes.height = vidHeight
						videoRes.width = vidWidth
					}
				}
				if (!fileDb.isHdr) {
					if (stream['HDR_Format'])
						fileDb.isHdr = true
					else if (stream['BitDepth'] && stream['colour_primaries'] && stream['transfer_characteristics']) {
						if (stream['BitDepth'] == '10' && stream['colour_primaries'] == 'BT.2020') {
							if (stream['transfer_characteristics'] == 'PQ' || stream['transfer_characteristics'] == 'HLG')
								fileDb.isHdr = true
						}
					}
				}
				if (!fileDb.isDolbyVision && (stream['HDR_Format'] || '').toLowerCase().includes('dolby vision'))
					fileDb.isDolbyVision = true
			} else if (stream['@type'] == 'Audio') {
				if (stream['Language'])
					if (!fileDb.languages.audio.includes(stream['Language']))
						fileDb.languages.audio.push(stream['Language'])
				if (stream['Format'])
					if (!fileDb.codecs.audio.includes(stream['Format']))
						fileDb.codecs.audio.push(stream['Format'])
				if (stream['Format_Commercial_IfAny'])
					if (!fileDb.codecs.audioCommercial.includes(stream['Format_Commercial_IfAny']))
						fileDb.codecs.audioCommercial.push(stream['Format_Commercial_IfAny'])
				if (stream['Channels']) {
					const chans = parseInt(stream['Channels'])
					if (chans > audioChans)
						audioChans = chans
				}
			} else if (stream['@type'] == 'Text') {
				if (stream['Language'])
					if (!fileDb.languages.subtitles.includes(stream['Language']))
						fileDb.languages.subtitles.push(stream['Language'])
			}
		})
		if (hasVideoStream) {
			if (videoRes.height && videoRes.width) {
				fileDb.videoHeight = videoRes.height
				fileDb.videoWidth = videoRes.width
			}
			if (audioChans) {
				if (audioChans == 2)
					fileDb.audioChannels = '2.0'
				else if (audioChans == 6)
					fileDb.audioChannels = '5.1'
				else if (audioChans == 8)
					fileDb.audioChannels = '7.1'
			}
			fileDb.filename = filename
			const tnpParsed = tnp(filename)
			if ((tnpParsed || {}).quality)
				fileDb.source = tnpParsed.quality
			if ((tnpParsed || {}).excess)
				fileDb.excess = tnpParsed.excess
			if (filename.includes('.')) {
				const container = filename.split('.').pop()
				fileDb.container = container.toLowerCase()
			}
			if (imdbId && !fileDb.imdbId) {
				fileDb.matchedImdbByMediaInfo = false
				fileDb.imdbId = imdbId
			}
		}

		try {
			fs.writeFileSync(dbFile, JSON.stringify(fileDb, null, 4))
		} catch(e) {
			logging.log('Warning: Could not write rpdb.json file to folder after probing the video file')
			console.error(e)
		}

		resolve(fileDb)

	})
}

var resolution = [
    { name: '480p', width: 852, height: 480 },
    { name: '576p', width: 768, height: 576 },
    { name: '720p', width: 1280, height: 720 },
    { name: '1080p', width: 1920, height: 1080 },
    { name: '2k', width: 2048, height: 1080 },
    { name: '4k', width: 3840, height: 2160 },
    { name: '5k', width: 5120, height: 2880 },
    { name: '8k', width: 7680, height: 4320 },
]

function findResolution(width, height) {
    let quality = false
    function betweenRes(val, type, idx) {
    	return (
    				resolution[idx][type] == val ||
    				(val > resolution[idx][type] && (!resolution[idx+1] || val < resolution[idx+1][type])) ||
    				(val < resolution[idx][type] && (!resolution[idx-1] || val > resolution[idx-1][type]))
    			)
    }
    resolution.some((res, idx) => {
    	if (res.height == height) {
    		if (betweenRes(width, 'width', idx)) {
 	  			quality = res.name
    			return true
    		}
    	} if (res.width == width) {
    		if (betweenRes(height, 'height', idx)) {
    			quality = res.name
    			return true
    		}
    	}
    })
    if (!quality)
    	resolution.some((res, idx) => {
    		if (height <= res.height && (!resolution[idx-1] || height > resolution[idx-1].height)) {
    			quality = res.name
    			return true
    		}
    	})
    return quality
}

const getQueryString = (fileDb, required, fileLoc, defBadges) => {
	if (!fileDb) return false
	if (!required || !Object.keys(required).length) return false

	let badges = []

	if (required.videoQuality && fileDb.videoHeight) {
		const quality = findResolution(fileDb.videoWidth, fileDb.videoHeight)
		if (quality)
			badges.push(quality)
	}

	if (required.colorRange) {
		if (fileDb.isDolbyVision)
			badges.push(defBadges.dolbyvision || 'dolbyvision')
		else if (fileDb.isHdr)
			badges.push(defBadges.hdr || 'hdrcolor')
	}

	if (required.videoCodec) {
		if (((fileDb.codecs || {}).video || []).length) {
			let isAvc = false
			let isHevc = false
			fileDb.codecs.video.some(el => {
				if (['h264', 'x264', 'avc'].includes(el)) {
					isAvc = true
					return true
				} else if (['h265', 'x265', 'hevc'].includes(el)) {
					isHevc = true
					return true
				}
			})
			if (isHevc)
				badges.push('h265')
			else if (isAvc)
				badges.push('h264')
		}
	}

	if (required.audioChannels)
		if (fileDb.audioChannels)
			badges.push('audio' + fileDb.audioChannels.replace('.', ''))

	let excess = fileDb.excess || []
	excess = Array.isArray(excess) ? excess : [excess]

	if (required.videoSource) {
		let source = false

		const hasRemux = excess.some(el => {
			return (el || '').toLowerCase().includes('remux')
		})
		if (hasRemux) {
			source = defBadges.remux || 'remuxgold'
		}
		if (!source && fileDb.source) {
			if (['bluray', 'brrip','bdrip'].includes(fileDb.source.toLowerCase()))
				source = 'bluray'
			else if (fileDb.source.toLowerCase().includes('dvd'))
				source = 'dvd'
			else if (fileDb.source.toLowerCase().includes('web'))
				source = 'web'
		}
		if (!source && excess.length) {
			if (excess.some(el => el.toLowerCase().includes('dvd')))
				source = 'dvd'
			else if (excess.some(el => el.toLowerCase().includes('web')))
				source = 'web'
		}
		if (source)
			badges.push(source)
	}

	let langIso6391 = false

	let badgeCountry = false

	if ((required.countryFlag || '').includes('_')) {
		const badgeLang = required.countryFlag.split('_')[0]
		badgeCountry = required.countryFlag.split('_')[1].replace('-','_').toLowerCase()
		required.audioLang = badgeLang
		required.subLang = badgeLang
	}

	let foundLang = false

	if (required.audioLang)
		if ((fileDb.languages.audio || []).length)
			if (fileDb.languages.audio.includes(required.audioLang))
				foundLang = true

	if (!foundLang && required.subLang) {
		if ((fileDb.languages.subtitles || []).length)
			if (fileDb.languages.subtitles.includes(required.subLang))
				foundLang = true

		if (!foundLang && fileLoc) {

			// check if subtitle language is available as file

			if ((getSubFileLangs(fileLoc) || []).includes(required.subLang))
				foundLang = true

		}
	}

	if (foundLang && badgeCountry)
		badges.push('country.' + badgeCountry)

	return badges.length ? badges.join(',') : false
}

module.exports = { probe, getQueryString, getImdbId, getDbFile }
