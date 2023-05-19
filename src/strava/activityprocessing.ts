// Strautomator Core: Strava Activity Processing

import {StravaActivity, StravaActivityFilter, StravaProcessedActivity, StravaRideType, StravaRunType} from "./types"
import {RecipeData} from "../recipes/types"
import {UserData} from "../users/types"
import stravaActivities from "./activities"
import stravaAthletes from "./athletes"
import stravaFtp from "./ftp"
import database from "../database"
import eventManager from "../eventmanager"
import notifications from "../notifications"
import recipes from "../recipes"
import users from "../users"
import _ from "lodash"
import logger = require("anyhow")
import dayjs from "../dayjs"
const settings = require("setmeup").settings

/**
 * Strava activity processing manager.
 */
export class StravaActivityProcessing {
    private constructor() {}
    private static _instance: StravaActivityProcessing
    static get Instance(): StravaActivityProcessing {
        return this._instance || (this._instance = new this())
    }

    /**
     * Holds the date of the oldest queued activity to be processed.
     */
    oldestQueueDate: Date = null

    // PROCESSING ACTIVITIES
    // --------------------------------------------------------------------------

    /**
     * Get saved processed activities for the specified user.
     * @param user The activities owner.
     * @param dateFrom Activities processed since date.
     * @param dateTo Activities processed up to date.
     * @param limit Optional, limit how many results should be returned?
     *
     */
    getProcessedActivities = async (user: UserData, dateFrom?: Date, dateTo?: Date, limit?: number): Promise<StravaProcessedActivity[]> => {
        try {
            let logFrom = ""
            let logTo = ""
            let logLimit = ""

            const where: any[] = [["user.id", "==", user.id]]

            if (dateFrom) {
                where.push(["dateProcessed", ">=", dateFrom])
                logFrom = ` from ${dayjs(dateFrom).format("ll")}`
            }
            if (dateTo) {
                where.push(["dateProcessed", "<=", dateTo])
                logTo = ` to ${dayjs(dateTo).format("ll")}`
            }
            if (limit) {
                logLimit = `, limit ${limit}`
            }

            const activities = await database.search("activities", where, ["dateProcessed", "desc"], limit)
            logger.info("Strava.getProcessedActivities", `User ${user.id} ${user.displayName}`, `Got ${activities.length || "no"} activities${logFrom}${logTo}${logLimit}`)

            return activities
        } catch (ex) {
            logger.error("Strava.getProcessedActivities", `User ${user.id} ${user.displayName}`, dateFrom, dateTo, ex)
        }
    }

    /**
     * Batch process activities for the specified user. This will effectively add the
     * activities for the specified range to the processing queue.
     * @param user The activities owner (user).
     * @param dDateFrom Activities since (from that date).
     * @param dDateTo Activities up to (till that date), if not passed will use today.
     * @param filter Additional activity filters.
     */
    batchProcessActivities = async (user: UserData, dDateFrom: dayjs.Dayjs, dDateTo?: dayjs.Dayjs, filter?: StravaActivityFilter): Promise<number> => {
        if (!dDateTo) dDateTo = dayjs()
        if (!filter) filter = {}

        let activityCount = 0
        const dateLog = `${dDateFrom.format("lll")} to ${dDateTo.format("lll")}`
        const now = dayjs().utc()

        try {
            if (user.suspended || !user.recipes || Object.keys(user.recipes).length == 0) {
                logger.info("Strava.processActivity", `User ${user.id} ${user.displayName} is suspended or has no recipes, won't process`)
                return null
            }

            // Check if passed date range is valid.
            const maxDays = user.isPro ? settings.plans.pro.batchDays : settings.plans.free.batchDays
            const minDate = now.subtract(maxDays, "days").startOf("day")
            if (minDate.isAfter(dDateFrom)) {
                throw new Error(`Invalid date range, minimum allowed date: ${minDate.format("LL")}`)
            }

            // Fetch user activities for the specified time range.
            const activities = await stravaActivities.getActivities(user, {after: dDateFrom, before: dDateTo})

            if (activities.length == 0) {
                logger.warn("Strava.batchProcessActivities", `User ${user.id} ${user.displayName}`, dateLog, "No activities for that date range")
                return 0
            }

            // Add each of the user's activities to the processing queue, but only if they are valid
            // according to the (optional) passed filters.
            for (let activity of activities) {
                try {
                    let valid = true
                    if (filter.private === true && !activity.private) valid = false
                    if (filter.private === false && activity.private) valid = false
                    if (filter.commute === true && !activity.commute) valid = false
                    if (filter.commute === false && activity.commute) valid = false
                    if (filter.race === true && activity.workoutType != StravaRideType.Race && activity.workoutType != StravaRunType.Race) valid = false
                    if (filter.race === false && (activity.workoutType == StravaRideType.Race || activity.workoutType == StravaRunType.Race)) valid = false
                    if (filter.sportType && activity.sportType != filter.sportType) valid = false

                    // Passed the activity filters? Proceed and queue.
                    if (valid) {
                        await this.queueActivity(user, activity.id, true)
                        activityCount++
                    }
                } catch (innerEx) {
                    logger.error("Strava.batchProcessActivities", `User ${user.id} ${user.displayName}`, `Activity ${activity.id}`, innerEx)
                }
            }

            // Update user with the current date.
            await users.update({id: user.id, displayName: user.displayName, dateLastBatchProcessing: now.toDate()})

            logger.info("Strava.batchProcessActivities", `User ${user.id} ${user.displayName}`, dateLog, `Queued ${activities.length} activities`)

            return activityCount
        } catch (ex) {
            logger.error("Strava.batchProcessActivities", `User ${user.id} ${user.displayName}`, dateLog, ex)
            throw ex
        }
    }

    /**
     * Process activity event pushed by Strava.
     * @param user The activity's owner (user).
     * @param activityId The activity's unique ID.
     * @param queued Was the activity queued to be processed? Defaults to false (real time).
     */
    processActivity = async (user: UserData, activityId: number, queued?: boolean): Promise<StravaProcessedActivity> => {
        let saveError
        let activity: StravaActivity

        try {
            let recipe: RecipeData
            let recipeIds = []

            // If user has no recipes? Stop here.
            if (!user.recipes || Object.keys(user.recipes).length == 0) {
                logger.info("Strava.processActivity", `User ${user.id} ${user.displayName} has no recipes, won't process activity ${activityId}`)
                return null
            }

            // User suspended? Stop here.
            if (user.suspended) {
                logger.warn("Strava.processActivity", `User ${user.id} ${user.displayName} is suspended, won't process activity ${activityId}`)
                return null
            }

            // Get activity details from Strava.
            try {
                activity = await stravaActivities.getActivity(user, activityId)
            } catch (ex) {
                const status = ex.response?.status || ex.status || null

                if (status == 404) {
                    logger.warn("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId} not found`)
                    return null
                }

                // Add the activity to the queue to retry processing it later.
                if (!queued) {
                    await this.queueActivity(user, activityId)
                }

                throw ex
            }

            // Check for new records.
            stravaAthletes.checkActivityRecords(user, [activity])

            // Get recipes, having the defaults first and then sorted by order.
            let sortedRecipes: any[] = _.sortBy(Object.values(user.recipes), ["defaultFor", "order", "title"])

            // If PRO subscription was cancelled but user still have many recipes, consider just the first ones.
            if (!user.isPro && sortedRecipes.length > settings.plans.free.maxRecipes) {
                sortedRecipes = sortedRecipes.slice(0, settings.plans.free.maxRecipes)
            }

            // Evaluate each of user's recipes, and set update to true if something was processed.
            for (recipe of sortedRecipes) {
                try {
                    if (await recipes.evaluate(user, recipe.id, activity)) {
                        recipeIds.push(recipe.id)

                        if (recipe.killSwitch) {
                            logger.debug("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, `Recipe ${recipe.id} kill switch`)
                            break
                        }
                    }
                } catch (innerEx) {
                    logger.error("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, innerEx)
                }
            }

            // Activity updated? Save to Strava and increment activity counter.
            if (recipeIds.length > 0) {
                const actions = []
                recipeIds.forEach((rid) => user.recipes[rid].actions.forEach((a) => actions.push(a.type)))

                logger.info("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, queued ? "From queue" : "Realtime", `Recipes: ${recipeIds.join(", ")}`, `Actions: ${_.uniq(actions).join(", ")}`)

                // Remove duplicates from list of updated fields.
                activity.updatedFields = _.uniq(activity.updatedFields)

                // Write suspended (possibly missing permissions)? Stop here.
                if (user.writeSuspended) {
                    logger.warn("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, "User.writeSuspended, won't update the activity")
                    return null
                }

                // Save, and if it fails try again once.
                try {
                    await stravaActivities.setActivity(user, activity)
                } catch (ex) {
                    logger.error("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, ex)
                    saveError = ex.friendlyMessage || ex.message || ex

                    // Create notification for user in case the activity exists but could not be processed.
                    if (activity.dateEnd) {
                        try {
                            let aDate = dayjs(activity.dateEnd)
                            if (activity.utcStartOffset) {
                                aDate = aDate.add(activity.utcStartOffset, "minutes")
                            }

                            const title = `Failed to process activity ${activity.id}`
                            const body = `There was an error processing your ${activity.sportType} "${activity.name}", on ${aDate.format("lll")}. Strava returned an error message.`
                            const expiry = dayjs().add(14, "days").toDate()

                            await notifications.createNotification(user, {title: title, body: body, activityId: activity.id, dateExpiry: expiry})
                        } catch (innerEx) {
                            logger.warn("Strava.processActivity", `Failed creating notification for activity ${activityId}, from user ${user.id}`)
                        }
                    }
                }

                // Save activity to the database and update count on user data.
                try {
                    await users.setActivityCount(user)
                    user.activityCount++

                    return await this.saveProcessedActivity(user, activity, recipeIds, saveError)
                } catch (ex) {
                    logger.error("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, "Not saved to database", ex)
                } finally {
                    eventManager.emit("Strava.processActivity", user, activity)
                }
            } else {
                logger.info("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, `No matching recipes`)
            }

            // Check for FTP updates in case user has opted-in and the activity happened in the last few days.
            try {
                const shouldUpdateFtp = user.isPro && user.preferences?.ftpAutoUpdate && user.profile.ftp
                const powerIncreased = activity.hasPower && activity.wattsWeighted >= user.profile.ftp
                const isRecent = dayjs().utc().subtract(2, "days").isBefore(activity.dateStart)
                if (shouldUpdateFtp && powerIncreased && isRecent) {
                    await stravaFtp.processFtp(user, [activity], true)
                }
            } catch (ftpEx) {
                logger.error("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, "Failed to auto-update FTP", ftpEx)
            }
        } catch (ex) {
            logger.error("Strava.processActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, ex)
            throw ex
        }

        return null
    }

    /**
     * Save a processed activity with user and recipe details to the database.
     * @param user The activity's owner.
     * @param activity The Strava activity details.
     * @param recipeIds Array of triggered recipe IDs.
     * @param error If errored, this will contain the error details.
     */
    saveProcessedActivity = async (user: UserData, activity: StravaActivity, recipeIds: string[], error?: string): Promise<StravaProcessedActivity> => {
        try {
            let recipeDetails = {}
            let updatedFields = {}

            // Get recipe summary.
            for (let id of recipeIds) {
                recipeDetails[id] = {
                    title: user.recipes[id].title,
                    conditions: _.map(user.recipes[id].conditions, recipes.getConditionSummary),
                    actions: _.map(user.recipes[id].actions, recipes.getActionSummary)
                }
            }

            // Get updated fields.
            for (let field of activity.updatedFields) {
                if (field == "gear") {
                    updatedFields[field] = activity.gear.id == "none" ? "None" : `${activity.gear.name} (${activity.gear.id})`
                } else {
                    updatedFields[field] = activity[field]
                }
            }

            // Data to be saved on the database.
            const data: StravaProcessedActivity = {
                id: activity.id,
                dateProcessed: dayjs.utc().toDate(),
                user: {
                    id: user.id,
                    displayName: user.displayName
                },
                recipes: recipeDetails,
                updatedFields: updatedFields
            }

            // Extra activity details in case user has not opted for the privacy mode.
            if (!user.preferences.privacyMode) {
                data.sportType = activity.sportType
                data.name = activity.name
                data.dateStart = activity.dateStart
                data.utcStartOffset = activity.utcStartOffset

                if (activity.newRecords) {
                    data.newRecords = activity.newRecords
                }
            }

            // Linkback added to activity?
            if (activity.linkback) {
                logger.info("Strava.linkback", `User ${user.id} ${user.displayName}`, `Activity ${activity.id}`)
                data.linkback = true
            }

            // Make sure error is a string (if an error was passed).
            if (error) {
                data.error = error.toString()
            }

            // Save and return result.
            await database.set("activities", data, activity.id.toString())
            logger.debug("Strava.saveProcessedActivity", data)

            return data
        } catch (ex) {
            logger.error("Strava.saveProcessedActivity", `User ${user.id} ${user.displayName}`, `Activity ${activity.id}`, ex)
            throw ex
        }
    }

    /**
     * Delete all saved / processed activities for the specified user and / or max age.
     * At least one argument is required. Returns the number of deleted activities.
     * @param user Optional user account.
     * @param ageDays Optional max age (in days).
     */
    deleteProcessedActivities = async (user?: UserData | null, ageDays?: number): Promise<number> => {
        if (!user && !ageDays) {
            throw new Error("At least a user or a max age in days is necessary")
        }

        if (!ageDays) ageDays = 0

        const userLog = user ? `User ${user.id} ${user.displayName}` : "All users"
        const sinceLog = ageDays > 0 ? `Older than ${ageDays} days` : "Since the beginning"
        const where: any[] = []

        try {
            if (user) {
                where.push(["user.id", "==", user.id])
            }
            if (ageDays > 0) {
                const maxDate = dayjs().subtract(ageDays, "days").toDate()
                where.push(["dateProcessed", "<", maxDate])
            }

            // At least a user or age must be passed.
            if (where.length == 0) {
                throw new Error("A user or an ageDays must be passed")
            }

            const count = await database.delete("activities", where)
            logger.info("Strava.deleteProcessedActivities", userLog, sinceLog, `Deleted ${count || "no"} activities`)

            return count
        } catch (ex) {
            logger.error("Strava.deleteProcessedActivities", userLog, sinceLog, ex)
            return 0
        }
    }

    // ACTIVITY QUEUE
    // --------------------------------------------------------------------------

    /**
     * Add activity to the collection of activities to be processed later.
     * @param user The activity's owner (user).
     * @param activityId The activity's unique ID.
     * @param batch Queued as part of a batch processing for old activities?
     */
    queueActivity = async (user: UserData, activityId: number, batch?: boolean): Promise<void> => {
        if (user.suspended) {
            logger.warn("Strava.queueActivity", `User ${user.id} ${user.displayName} is suspended, won't process activity ${activityId}`)
            return
        }

        // Add the activity to the queue to be processed on the next batch.
        // If the activity was already queued then keep the original dateQueued.
        try {
            let activity: Partial<StravaProcessedActivity> = await database.get("activities", activityId.toString())
            let existing = activity ? true : false

            // Set processed activity defaults.
            if (!activity) activity = {}
            activity.id = activityId
            activity.user = {id: user.id, displayName: user.displayName}
            activity.dateQueued = activity.dateQueued || new Date()
            activity.retryCount = (activity.retryCount || 0) + 1

            // Part of a batch processing? Flag it.
            if (batch) {
                activity.batch = true
            }

            await database.set("activities", activity, activityId.toString())

            if (existing) {
                logger.warn("Strava.queueActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId} already queued or processed`)
            } else {
                logger.info("Strava.queueActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId} queued`)

                // If no queued activities were added since the last processed queue, set current date as the oldest.
                if (!this.oldestQueueDate) {
                    this.oldestQueueDate = new Date()
                }
            }
        } catch (ex) {
            logger.error("Strava.queueActivity", `User ${user.id} ${user.displayName}`, `Activity ${activityId}`, ex)
            throw ex
        }
    }

    /**
     * Check if the oldest activity queued in memory has reached the time threshold,
     * and if so, process all relevant queued activities.
     */
    checkQueuedActivities = async (): Promise<void> => {
        const minDate = dayjs().subtract(settings.strava.processingQueue.delayedInterval, "seconds")

        if (minDate.isAfter(this.oldestQueueDate)) {
            await this.processQueuedActivities()
        } else {
            const dateLog = this.oldestQueueDate ? this.oldestQueueDate.toString() : "none"
            logger.debug("Strava.checkQueuedActivities", "Nothing to be processed at the moment", `oldestQueueDate = ${dateLog}`)
        }
    }

    /**
     * Get queued activities, with an optional minimum interval.
     * @param beforeDate Only get activities that were queued before that specified date.
     * @param batchSize Optional batch size, otherwise use the default from settings.
     */
    getQueuedActivities = async (beforeDate: Date, batchSize?: number): Promise<StravaProcessedActivity[]> => {
        const logDate = `Before ${dayjs(beforeDate).format("lll")}`
        if (!batchSize) batchSize = settings.strava.processingQueue.batchSize

        // Get queued activities from the database.
        try {
            const where = [["dateQueued", "<=", beforeDate]]
            const activities: StravaProcessedActivity[] = await database.search("activities", where, "dateQueued", batchSize)

            if (activities.length > 0) {
                logger.info("Strava.getQueuedActivities", logDate, `Batch size: ${batchSize}`, `Got ${activities.length} queued activities`)
                return activities
            }

            // If no recent activities were returned, check if we have older activities as part of batch processing?
            const batchWhere = [["batch", "==", true]]
            const batchActivities = await database.search("activities", batchWhere, null, batchSize)

            const batchLog = batchActivities.length > 0 ? `${batchActivities.length} batch activities` : "no queued or batch activities"
            logger.info("Strava.getQueuedActivities", logDate, `Batch size: ${batchSize}`, `Got ${batchLog}`)

            return batchActivities
        } catch (ex) {
            logger.error("Strava.getQueuedActivities", logDate, `Batch size: ${batchSize}`, ex)
        }
    }

    /**
     * Get and process queued (delayed processing) activities.
     * @param batchSize Optional batch size, otherwise use the default from settings (10 activities).
     */
    processQueuedActivities = async (batchSize?: number): Promise<void> => {
        const usersCache: {[id: string]: UserData} = {}
        if (!batchSize) batchSize = settings.strava.processingQueue.batchSize

        // Reset oldest queued activity date.
        this.oldestQueueDate = null

        try {
            const beforeDate = dayjs().subtract(settings.strava.processingQueue.delayedInterval, "seconds").toDate()
            const activities = await this.getQueuedActivities(beforeDate, batchSize)
            let processedCount = 0

            // No activities to be processed? Stop here.
            if (activities.length == 0) {
                logger.debug("Strava.processQueuedActivities", `Batch size: ${batchSize}`, `No queued activities to be processed`)
                return
            }

            // Process each of the queued activities.
            for (let activity of activities) {
                try {
                    if (!usersCache[activity.user.id]) {
                        usersCache[activity.user.id] = await users.getById(activity.user.id)
                    }

                    const processed = await this.processActivity(usersCache[activity.user.id], activity.id, true)

                    // Queued activity is invalid or had no matching recipes? Delete it.
                    if (!processed) {
                        await this.deleteQueuedActivity(activity)
                    } else {
                        processedCount++
                    }
                } catch (activityEx) {
                    if (activity.retryCount >= settings.strava.processingQueue.retry) {
                        logger.warn("Strava.processQueuedActivities", `Failed to process queued activity ${activity.id} from user ${activity.user.id} too many times`)
                        await this.deleteQueuedActivity(activity)
                    } else {
                        logger.warn("Strava.processQueuedActivities", `Failed to process queued activity ${activity.id} from user ${activity.user.id}, will retry`)
                        await database.increment("activities", activity.id.toString(), "retryCount")
                    }
                }
            }

            if (processedCount > 0) {
                logger.info("Strava.processQueuedActivities", `Batch size: ${batchSize}`, `Processed ${processedCount} out of ${activities.length} queued activities`)
            } else {
                logger.debug("Strava.processQueuedActivities", `Batch size: ${batchSize}`, `No processed activities out of ${activities.length} queued activities`)
            }
        } catch (ex) {
            logger.error("Strava.processQueuedActivities", `Batch size: ${batchSize}`, ex)
        }
    }

    /**
     * Delete the queued or processed activity from the database.
     * @param activity The activity to be deleted.
     */
    deleteQueuedActivity = async (activity: StravaProcessedActivity): Promise<void> => {
        try {
            const count = await database.delete("activities", activity.id.toString())

            if (count > 0) {
                logger.info("Strava.deleteQueuedActivity", `User ${activity.user.id} ${activity.user.displayName}`, `Activity ${activity.id} deleted`)
            } else {
                logger.warn("Strava.deleteQueuedActivity", `User ${activity.user.id} ${activity.user.displayName}`, `Activity ${activity.id} not previously saved`)
            }
        } catch (ex) {
            logger.error("Strava.deleteQueuedActivity", `User ${activity.user.id} ${activity.user.displayName}`, `Activity ${activity.id}`, ex)
            throw ex
        }
    }
}

// Exports...
export default StravaActivityProcessing.Instance
