// Strautomator Core: Komoot types

/**
 * Represents a Komoot route / tour.
 */
export interface KomootRoute {
    /** ID of the route. */
    id: string
    /** Total distance. */
    distance?: number
    /** Estimated moving time in seconds. */
    movingTime?: number
    /** Estimated total time with breaks, in seconds. */
    totalTime?: number
    /** Starting location as coordinates. */
    locationStart?: [number, number]
    /** Starting location as coordinates. */
    locationEnd?: [number, number]
    /** Mid point location as coordinates. */
    locationMid?: [number, number]
    /** Date when it was cached. */
    dateCached?: Date
    /** Date when it should expire (used for the Firestore TTL). */
    dateExpiry?: Date
}
