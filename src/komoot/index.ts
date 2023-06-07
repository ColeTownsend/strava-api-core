// Strautomator Core: Komoot

import {KomootRoute} from "./types"
import {UserData} from "../users/types"
import {axiosRequest} from "../axios"
import database from "../database"
import dayjs from "../dayjs"
import _ from "lodash"
import cache = require("bitecache")
import logger = require("anyhow")
import * as logHelper from "../loghelper"
const settings = require("setmeup").settings

/**
 * Komoot data scraper.
 */
export class Komoot {
    private constructor() {}
    private static _instance: Komoot
    static get Instance() {
        return this._instance || (this._instance = new this())
    }

    // INIT
    // --------------------------------------------------------------------------

    /**
     * Init the Komoot wrapper.
     */
    init = async (): Promise<void> => {
        cache.setup("komoot-invalid", settings.komoot.cacheDuration)
        logger.info("Komoot.init", `Routes will be cached for up to ${dayjs.duration(settings.komoot.maxCacheDuration, "seconds").humanize()}`)
    }

    /**
     * Make a request to the Komoot website.
     * @param path URL path.
     */
    private makeRequest = async (path: string): Promise<string> => {
        const options: any = {
            method: "GET",
            returnResponse: true,
            url: `${settings.komoot.baseUrl}${path}`,
            headers: {"User-Agent": settings.axios.uaBrowser},
            abortStatus: [403]
        }

        try {
            const res = await axiosRequest(options)
            return res ? res.data : null
        } catch (ex) {
            logger.debug("Komoot.makeRequest", path, ex)
            throw ex
        }
    }

    // MAIN METHODS
    // --------------------------------------------------------------------------

    /**
     * Ge route details from Komoot. No exception will be thrown if the URL is invalid.
     * @param user The user requesting the route details.
     * @param routeUrl The Komoot route URL.
     */
    getRoute = async (user: UserData, routeUrl: string): Promise<KomootRoute> => {
        try {
            if (!routeUrl || !routeUrl.includes("/tour/")) {
                throw new Error("Invalid tour URL")
            }

            const tourId: any = routeUrl.substring(routeUrl.indexOf("tour/")).split("/")[1].split("?")[0]

            if (isNaN(tourId)) {
                throw new Error("Invalid tour URL")
            }

            const now = dayjs()
            const multDistance = user.profile.units == "imperial" ? 0.621371 : 1

            // Check if that URL was already scraped unsuccessfully.
            const invalidCache = cache.get("komoot-invalid", routeUrl)
            if (invalidCache) {
                logger.info("Komoot.getRoute", tourId || routeUrl, `Marked as invalid, won't fetch`)
                return null
            }

            // Check if route details are available in the database cache first.
            const fromCache: KomootRoute = await database.get("komoot", tourId)
            if (fromCache && dayjs(fromCache.dateCached).add(settings.komoot.maxCacheDuration, "seconds").isAfter(now)) {
                logger.info("Komoot.getRoute.fromCache", tourId, `Distance: ${fromCache.distance}km`, `Duration: ${fromCache.totalTime}s`)
                return fromCache
            }

            // Check if the tour was recently cached
            const result: KomootRoute = {
                id: tourId,
                dateCached: now.toDate()
            }

            const iQuery = routeUrl.indexOf("?")
            const query = iQuery > 0 ? routeUrl.substring(iQuery) : ""
            const html = await this.makeRequest(`tour/${tourId}${query}`)
            if (!html) {
                throw new Error(`Could not fetch tour ${tourId}, likely it's private`)
            }

            // Try parsing the start location.
            const startPoint = html.indexOf(`\\"start_point\\"`, html.length / 3)
            if (startPoint) {
                const iLat = html.indexOf(`\\"lat\\":`, startPoint) + 8
                const iLng = html.indexOf(`\\"lng\\":`, startPoint) + 8

                if (iLat > 6 && iLng > 6) {
                    const lat: any = html.substring(iLat, html.indexOf(`,`, iLat))
                    const lng: any = html.substring(iLng, html.indexOf(`,`, iLng))

                    if (!isNaN(lng) && !isNaN(lng)) {
                        result.locationStart = [parseFloat(lat), parseFloat(lng)]
                    }
                }
            }

            // Try parsing the distance.
            const iDistance = html.indexOf("Distance: ") + 10
            if (iDistance > 10) {
                const distance = html.substring(iDistance, html.indexOf(" km", iDistance))
                result.distance = parseFloat(distance.trim()) * multDistance
                result.distance = parseFloat(result.distance.toFixed(1))
            }

            // Try parsing the duration. As durations in Kommot are usually VERY conservative,
            // we're removing around 6% of the final estimated time here.
            const iDuration = html.indexOf("Duration: ") + 10
            if (iDuration > 10) {
                const htmlDuration = html.substring(iDuration, html.indexOf(" h", iDuration))
                const arrDuration = htmlDuration.trim().split(":")
                result.movingTime = parseInt(arrDuration[0]) * 60 * 54 + parseInt(arrDuration[1]) * 54

                // Set total time rounded to 15 minutes.
                const secondsEstimated = result.movingTime * settings.routes.estimatedTimeMultiplier
                const secondsExtraBreaks = Math.floor(result.movingTime / 10800) * settings.routes.extraTimePer3Hours
                const duration = dayjs.duration(secondsEstimated + secondsExtraBreaks, "seconds")
                const toQuarter = 15 - (duration.minutes() % 15)
                result.totalTime = duration.add(toQuarter, "minutes").asSeconds()
            }

            if (result.distance || result.totalTime) {
                result.dateExpiry = now.add(settings.komoot.maxCacheDuration, "seconds").toDate()
            } else {
                result.dateExpiry = now.add(settings.komoot.cacheDuration, "seconds").toDate()
            }

            await database.set("komoot", result, result.id)
            logger.info("Komoot.getRoute", logHelper.user(user), tourId, `Distance: ${result.distance || "?"} km`, `Duration: ${result.totalTime || "?"} s`)

            return result
        } catch (ex) {
            logger.error("Komoot.getRoute", logHelper.user(user), routeUrl, ex)
            cache.set("komoot-invalid", routeUrl, true)
            return null
        }
    }

    /**
     * Try extracting a Komoot route URL from the passed string. Returns null if nothing found.
     * @param data String where a Komoot tour URL should be extracted from.
     */
    extractRouteUrl = (data: string): string => {
        try {
            const index = data.indexOf("www.komoot.")
            if (index < 0) return null

            const baseString = data.substring(index + 12, index + 100)

            // Get the index of a new line, colon, space, or query reference, whatever comes first.
            const sepNewLine = baseString.indexOf("\n")
            const sepCol = baseString.indexOf(":")
            const sepPeriod = baseString.indexOf(".")
            const sepParen = baseString.indexOf(")")
            const sepSpace = baseString.indexOf(" ")
            const allSeparators = [sepNewLine, sepCol, sepPeriod, sepParen, sepSpace]

            // Only consider the ref= as a separator in case it comes after the token in the query.
            const sepRef = baseString.indexOf("ref=")
            const sepToken = baseString.indexOf("token=")
            if (sepRef >= sepToken) {
                allSeparators.push(sepRef)
            }

            // Extract the URL according to the separator index.
            const separators = allSeparators.filter((s) => s > 0)
            const separatorIndex = separators.length > 0 ? _.min(separators) : 0
            const routeUrl = separatorIndex > 0 ? data.substring(index, index + separatorIndex + 12) : data.substring(index)

            // Found it?
            if (routeUrl.includes("/tour/")) {
                return routeUrl.trim()
            }

            return null
        } catch (ex) {
            logger.error("Komoot.extractRouteUrl", ex)
        }
    }
}

// Exports...
export default Komoot.Instance
