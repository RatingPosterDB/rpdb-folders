
const fs = require('fs')
const path = require('path')

const browser = require('./browser')

const fileHelper = require('./files')

const convert3To1 = require('iso-639-3-to-1')

const tnp = require('torrent-name-parser')

const extRequire = require('./externalRequire')

let ffprobe = false
let ffprobeStatic = false

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

const probe = (fileLoc, isDirectFile, isSeries, imdbId) => {
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
				resolve(false)
				return
			}
		} else {
			dirname = path.dirname(fileLoc)
		}

		const filename = path.basename(fileLoc)

		const nameNoExt = fileHelper.removeExtension(filename)

		const dbFile = isDirectFile ? path.join(dirname, nameNoExt + '-rpdb.json') : path.join(dirname, 'rpdb.json')

		if (fs.existsSync(dbFile)) {
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

		if (!ffprobe)
			ffprobe = extRequire('ffprobe')

		if (!ffprobeStatic)
			ffprobeStatic = extRequire('ffprobe-static')

		ffprobe(fileLoc, { path: (ffprobeStatic || {}).path }, (err, info) => {
			if (err) {
				console.error(err || Error('Unknown video probing error'))
				resolve(false)
				return
			}
			if (!((info || {}).streams || []).length) {
				console.error(Error('Missing video probing response'))
				resolve(false)
				return
			}
			const fileDb = {
				codecs: {
					video: [],
					audio: [],
				},
				languages: {
					subtitles: [],
					audio: [],
				}
			}
			let hasVideoStream = false
			info.streams.forEach(stream => {
				if (stream.codec_type == 'video') {
					hasVideoStream = true
					if (stream.codec_name)
						if (!fileDb.codecs.video.includes(stream.codec_name))
							fileDb.codecs.video.push(stream.codec_name)
					if (!fileDb.quality) {
						const height = stream.height || stream.coded_height
						if (height) {
							if (height < 240)
								fileDb.quality = 'sd'
							else if (height >= 240 && height < 360)
								fileDb.quality = '240p'
							else if (height >= 360 && height < 480)
								fileDb.quality = '360p'
							else if (height >= 480 && height < 720)
								fileDb.quality = '480p'
							else if (height >= 720 && height < 1080)
								fileDb.quality = '720p'
							else if (height >= 1080 && height < 1440)
								fileDb.quality = '1080p'
							else if (height >= 1440 && height < 2160)
								fileDb.quality = '2k'
							else if (height >= 2160 && height < 2880)
								fileDb.quality = '4k'
							else if (height >= 2880 && height < 4320)
								fileDb.quality = '5k'
							else if (height >= 4320)
								fileDb.quality = '8k'
						}
					}
					if (!fileDb.isHdr)
						if (stream.color_space && stream.color_transfer && stream.color_primaries)
							if (stream.color_space == 'bt2020nc' &&
								stream.color_transfer == 'smpte2084' &&
								stream.color_primaries == 'bt2020')
								fileDb.isHdr = true
					if ((stream.codec_tag_string || '') == 'dvhe')
						fileDb.isDolbyVision = true
				} else if (stream.codec_type == 'audio') {
					if ((stream.tags || {}).language)
						if (!fileDb.languages.audio.includes(stream.tags.language))
							fileDb.languages.audio.push(stream.tags.language)
					if (stream.codec_name)
						if (!fileDb.codecs.audio.includes(stream.codec_name))
							fileDb.codecs.audio.push(stream.codec_name)
					if (stream.channels) {
						if (stream.channels == 2)
							fileDb.audioChannels = '2.0'
						else if (stream.channels == 6)
							fileDb.audioChannels = '5.1'
						else if (stream.channels == 8)
							fileDb.audioChannels = '7.1'
					}
				} else if (stream.codec_type == 'subtitle') {
					if ((stream.tags || {}).language)
						if (!fileDb.languages.subtitles.includes(stream.tags.language))
							fileDb.languages.subtitles.push(stream.tags.language)
				}
			})
			if (hasVideoStream) {
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
				if (imdbId)
					fileDb.imdbId = imdbId
			}

			try {
				fs.writeFileSync(dbFile, JSON.stringify(fileDb, null, 4))
			} catch(e) {}

			resolve(fileDb)
		})
	})
}

const getQueryString = (fileDb, required, fileLoc) => {
	if (!fileDb) return false
	if (!required || !Object.keys(required).length) return false

	let badges = []

	if (required.videoQuality)
		if (fileDb.quality)
			badges.push(fileDb.quality)

	if (required.colorRange) {
		if (fileDb.isDolbyVision)
			badges.push('dolbyvision')
		else if (fileDb.isHdr)
			badges.push('hdrcolor')
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

	if (required.videoSource) {
		let source = false
		if ((fileDb.excess || []).some(el => el.toLowerCase().includes('remux')))
			source = 'remuxgold'
		if (!source && fileDb.source) {
			if (['bluray', 'brrip','bdrip'].includes(fileDb.source.toLowerCase()))
				source = 'bluray'
			else if (fileDb.source.toLowerCase().includes('dvd'))
				source = 'dvd'
			else if (fileDb.source.toLowerCase().includes('web'))
				source = 'web'
		}
		if (!source && (fileDb.excess || []).length) {
			if (fileDb.excess.some(el => el.toLowerCase().includes('dvd')))
				source = 'dvd'
			else if (fileDb.excess.some(el => el.toLowerCase().includes('web')))
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
			if (fileDb.languages.audio.map(el => convert3To1(el)).includes(required.audioLang))
				foundLang = true

	if (!foundLang && required.subLang) {
		if ((fileDb.languages.subtitles || []).length)
			if (fileDb.languages.subtitles.map(el => convert3To1(el)).includes(required.subLang))
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

module.exports = { probe, getQueryString, getImdbId }
