// Strautomator Core: Calendar

import {CalendarOptions} from "./types"
import {UserData} from "../users/types"
import strava from "../strava"
import ical = require("ical-generator")
import logger = require("anyhow")
import moment = require("moment")
import url = require("url")
const settings = require("setmeup").settings

/**
 * Messages manager.
 */
export class Calendar {
    private constructor() {}
    private static _instance: Calendar
    static get Instance() {
        return this._instance || (this._instance = new this())
    }

    // INIT
    // --------------------------------------------------------------------------

    /**
     * Init the Calendar manager.
     */
    init = async (): Promise<void> => {
        try {
            logger.info("Calendar.init")
        } catch (ex) {
            logger.error("Calendar.init", ex)
            throw ex
        }
    }

    // CALENDAR METHODS
    // --------------------------------------------------------------------------

    /**
     * Generate the activities calendar and return its iCal string representation.
     * @param user The user requesting the calendar.
     * @param options Calendar generation options.
     */
    generate = async (user: UserData, options: CalendarOptions): Promise<string> => {
        let optionsLog: string

        try {
            if (!options.sportTypes || options.sportTypes.length == 0) {
                options.sportTypes = null
            }

            const maxDays = user.isPro ? settings.plans.pro.maxCalendarDays : settings.plans.free.maxCalendarDays
            const minDate = moment().utc().hours(0).minutes(0).subtract(maxDays, "days")
            const dateFrom = options.dateFrom ? options.dateFrom : minDate
            const tsAfter = dateFrom.valueOf() / 1000
            const tsBefore = new Date().valueOf() / 1000

            optionsLog = `Since ${moment(dateFrom).format("ll")}, `
            optionsLog += options.sportTypes ? options.sportTypes.join(", ") : "all sports"
            if (options.excludeCommutes) optionsLog += ", exclude commutes"

            // Validation checks.
            if (minDate.isAfter(dateFrom)) {
                throw new Error(`Minimum accepted "date from" for the calendar is ${minDate.format("L")} (${maxDays} days)`)
            }

            // Set calendar name based on passed filters.
            let calName = settings.calendar.name
            if (options.sportTypes) calName += ` (${options.sportTypes.join(", ")})`

            // Prepare calendar details.
            const domain = url.parse(settings.app.url).hostname
            const prodId = {company: "Devv", product: "Strautomator", language: "EN"}
            const calUrl = `${settings.app.url}calendar/${user.urlToken}`

            // Create ical container.
            const icalOptions: ical.CalendarData = {
                name: calName,
                domain: domain,
                prodId: prodId,
                url: calUrl,
                ttl: settings.calendar.ttl
            }
            const cal = ical(icalOptions)

            // Get activities from Strava.
            const activities = await strava.activities.getActivities(user, {before: tsBefore, after: tsAfter})

            // Iterate activities from Strava, checking filters before proceeding.
            for (let a of activities) {
                if (options.sportTypes && options.sportTypes.indexOf(a.type) < 0) continue
                if (options.excludeCommutes && a.commute) continue

                // Add activity to the calendar as an event.
                const event = cal.createEvent({
                    uid: a.id,
                    start: a.dateStart,
                    end: a.dateEnd,
                    summary: a.name,
                    description: a.commute ? `(Commute) ${a.description}` : a.description,
                    location: a.locationEnd ? a.locationEnd.join(",") : "",
                    url: `https://www.strava.com/activities/${a.id}`
                })

                // Geo location available?
                if (a.locationEnd) {
                    event.geo({lat: a.locationEnd[0], lon: a.locationEnd[1]})
                }
            }

            logger.info("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, `${cal.events.length} activities`)

            return cal.toString()
        } catch (ex) {
            logger.error("Calendar.generate", `User ${user.id} ${user.displayName}`, `${optionsLog}`, ex)
            throw ex
        }
    }
}

// Exports...
export default Calendar.Instance
