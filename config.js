const fs = require('fs')
const path = require('path')

const AppDirectory = require('appdirectory')

const isDocker = require('is-docker')

const dirs = new AppDirectory('RPDB-Folders')

const userConfigFolder = isDocker() ? '/rpdb/config' : dirs.userConfig()

if (!fs.existsSync(path.join(userConfigFolder, '..')))
	fs.mkdirSync(path.join(userConfigFolder, '..'))

if (!fs.existsSync(userConfigFolder))
	fs.mkdirSync(userConfigFolder)

const configPath = path.join(userConfigFolder, 'config.json')

const jsonfile = require('jsonfile')

// default values:

let map = {
    port: 8750,
    checkFullUpdate: 1 * 60 * 60 * 1000, // 1h
    fullUpdate: 7 * 24 * 60 * 60 * 1000, // 7d
    overwrite: false,
    minOverwritePeriod: 29 * 24 * 60 * 60 * 1000, // 29d
    lastOverwrite: { movie: 0, series: 0 },
    overwriteLast2Years: false,
    noPostersToEmptyFolders: false,
    overwriteMatches: { movie: {}, series: {} },
    imdbCache: { movie: {}, series: {} },
    mediaFolders: { movie: [], series: [] },
    lastFullUpdate: { movie: 0, series: 0 },
    apiKey: '',
    backdrops: false,
    customPosters: {},
    labels: {},
    badges: {},
    autoBadges: {},
    badgePositions: {},
    backdropBadgePositions: {},
    badgeSizes: {},
    itemLabels: {},
    itemBadges: {},
    itemAutoBadges: {},
    itemBadgePositions: {},
    itemBackdropBadgePositions: {},
    itemBadgeSizes: {},
    scanOrder: 'imdb-tmdb',
    cacheMatches: true,
    pass: false,
    watchFolderDepth: 0,
    movieTextless: false,
    seriesTextless: false,
    moviePosterType: 'poster-default',
    seriesPosterType: 'poster-default',
    movieRatingOrder: '',
    seriesRatingOrder: '',
    backdropsBadges: false,
    updateTransitionMay: true,
    ignoreInitialScan: false,
    usePolling: isDocker() ? true : false,
    pollingInterval: 100,
    posterLang: { movie: 'en', series: 'en' },
    baseUrl: '/',
    checkForLocalImdbId: false,
    overwriteProbeData: false,
    unmatched: { movie: {}, series: {} },
    missingPosters: { movie: {}, series: {} },
    plex: { protocol: 'https', host: '', port: '32400', token: '' },
    plexDelayType: false,
    plexRefreshDelay: 0,
    plexTodHour: 1,
    plexTodMin: 0,
    plexTodAmPm: 'AM',
    plexDetect: 1,
    defaultBadges: {
        dolbyvision: 'dolbyvision',
        hdr: 'hdrcolor',
        remux: 'remuxgold',
    },
    useWebhook: false,
    webhookDelay: 0,
    retryFrequency: 1,
    lastRetryMonth: -1,
    retryNewerThanMonths: 6,
}

function loadUserConfig(err, obj) {
    if (err) {

        try {
            jsonfile.atomicWriteFileSync(configPath, map)
        } catch(e) {
            // ignore error here
        }

        return map

    } else {
        let changed

        for (let key in map)
            if (!obj.hasOwnProperty(key)) {
                obj[key] = map[key]
                changed = true
            }

        if (changed)
            jsonfile.atomicWriteFileSync(configPath, obj)

        return obj
    }
}

function init() {
    let obj, err

    try {
        obj = jsonfile.readFileSync(configPath)
    } catch(e) {
        err = e
    }

    map = loadUserConfig(err, obj)
}

init()

const config = {
    getAll: () => {
        return map
    },
    get: str => {
        return map[str]
    },
    set: (str, value) => {
        map[str] = value
        jsonfile.atomicWriteFileSync(configPath, map)
    },
    has: key => {
        return map.hasOwnProperty(key)
    },
    configPath
}

module.exports = config
