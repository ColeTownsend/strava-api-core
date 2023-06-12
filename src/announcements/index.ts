// Strautomator Core: Announcements

import {Announcement} from "./types"
import {UserData} from "../users/types"
import database from "../database"
import logger = require("anyhow")
import * as logHelper from "../loghelper"
import cache = require("bitecache")
import dayjs from "../dayjs"
const settings = require("setmeup").settings

/**
 * Announcements manager.
 */
export class Announcements {
    private constructor() {}
    private static _instance: Announcements
    static get Instance() {
        return this._instance || (this._instance = new this())
    }

    /**
     * Init the Announcements manager.
     */
    init = async (): Promise<void> => {
        const duration = dayjs.duration(settings.announcements.cacheDuration, "seconds").humanize()
        cache.setup("announcements", settings.announcements.cacheDuration)
        logger.info("Announcements.init", `Cache announcements for up to ${duration}`)
    }

    // METHODS
    // --------------------------------------------------------------------------

    /**
     * Get all announcements stored on the database.
     */
    getAll = async (): Promise<Announcement[]> => {
        try {
            const result = await database.search("announcements")

            logger.info("Announcements.getAll", `${result.length} announcements`)
            return result
        } catch (ex) {
            logger.error("Announcements.getAll", ex)
            throw ex
        }
    }

    /**
     * Get active announcements stored the database.
     */
    getActive = async (): Promise<Announcement[]> => {
        try {
            const fromCache = cache.get("announcements", "active")

            // Cached announcements still valid?
            if (fromCache && fromCache.length > 0) {
                logger.info("Announcements.getActive.fromCache", `${fromCache.length} active announcements`)
                return fromCache
            }

            // Get active announcements from database.
            const now = new Date()
            const all = await database.search("announcements", [["dateStart", "<=", now]])
            const result = all.filter((a) => a.dateExpiry >= now)
            cache.set("announcements", "active", result)
            logger.info("Announcements.getActive", `${result.length || "No"} active announcements`)

            return result
        } catch (ex) {
            logger.error("Announcements.getActive", ex)
            throw ex
        }
    }

    /**
     * Create or update an announcement.
     * @param announcement Announcement details.
     */
    upsert = async (announcement: Announcement): Promise<void> => {
        try {
            if (!announcement.id) throw new Error("Missing announcement ID")
            if (!announcement.title) throw new Error("Missing announcement title")
            if (!announcement.body) throw new Error("Missing announcement body")
            if (!announcement.dateStart) throw new Error("Missing start date")
            if (!announcement.dateExpiry) throw new Error("Missing expiry date")

            // Fetch existing announcement (if there's one).
            const doc = database.doc("announcements", announcement.id)
            const docSnapshot = await doc.get()
            const exists = docSnapshot.exists
            const logAction = exists ? "Updated" : "Created"
            const logFromTill = `${dayjs(announcement.dateStart).format("lll")} till ${dayjs(announcement.dateExpiry).format("lll")}`

            // Keep existing read count when updating.
            announcement.readCount = exists ? docSnapshot.data().readCount : 0

            // Save and log.
            await database.set("announcements", announcement, announcement.id)
            logger.info("Announcements.upsert", logAction, announcement.id, announcement.title, logFromTill)
        } catch (ex) {
            logger.error("Announcements.upsert", announcement.id, announcement.title, ex)
            throw ex
        }
    }

    /**
     * Increment the read count for the specified announcement ID.
     * @param user The user who read this announcement.
     * @param id The announcement ID.
     */
    setReadCount = async (user: UserData, id: string): Promise<void> => {
        try {
            if (!id) throw new Error("Missing announcement ID")
            if (!user || !user.id) throw new Error("Missing or invalid user")

            const userRead = cache.get("announcements", `${id}-${user.id}`)

            if (userRead) {
                logger.info("Announcements.setReadCount", id, logHelper.user(user), "Abort, user already read recently")
            } else {
                await database.increment("announcements", id, "readCount")
                cache.set("announcements", `${id}-${user.id}`, true)
                logger.info("Announcements.setReadCount", id, logHelper.user(user))
            }
        } catch (ex) {
            logger.error("Announcements.setReadCount", id, ex)
        }
    }

    // MAINTENANCE
    // --------------------------------------------------------------------------

    /**
     * Remove expired announcements.
     */
    cleanup = async (): Promise<void> => {
        try {
            const dateExpiry = dayjs.utc().subtract(settings.notifications.readDeleteAfterDays, "days").toDate()
            const counter = await database.delete("announcements", ["dateExpiry", "<", dateExpiry])
            logger.info("Announcements.cleanup", `Deleted ${counter} announcements`)
        } catch (ex) {
            logger.error("Announcements.cleanup", ex)
        }
    }
}

// Exports...
export default Announcements.Instance
