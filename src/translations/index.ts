// Strautomator Core: Translations

import {LanguageString} from "./types"
import {UserPreferences} from "../users/types"
import de from "./de"
import en from "./en"
import es from "./es"
import fr from "./fr"
import it from "./it"
import nl from "./nl"
import pl from "./pl"
import pt from "./pt"
import logger from "anyhow"

/**
 * Map of translated strings in multiple languages.
 */
export const languageStrings: {[id: string]: LanguageString} = {
    de: de,
    en: en,
    es: es,
    fr: fr,
    it: it,
    nl: nl,
    pl: pl,
    pt: pt
}

/**
 * Returns a translated string.
 * @param id ID of the string to be translated.
 * @param preferences User preferences with language set.
 * @param capitalized Optional, return string capitalized
 */
export const translation = (id: string, preferences: UserPreferences, capitalized?: boolean): string => {
    let language = preferences?.language || "en"
    if (!language || !languageStrings[language]) {
        language = "en"
    }

    if (!id) {
        logger.warn("Translations.translation", language, "Translation ID passed as null")
        return ""
    }

    const ref = languageStrings[language]

    // Capitalizer helper.
    const capitalizer = (w) => w.charAt(0).toUpperCase() + w.slice(1)

    // If ID has a dot, consider its first part as the parent object (category).
    const arrId = id.split(".")
    const category = arrId.length == 2 ? arrId.shift() : null
    const subId = arrId.shift()

    let result: string
    if (category && ref[category]) {
        result = ref[category][subId] || ref[category][subId.split(" ").map(capitalizer).join("")]
    } else {
        result = ref[id] || ref[id.split(" ").map(capitalizer).join("")]
    }

    if (!result) {
        logger.debug("Translations.translation", language, `No translation found for: ${id}`)
        return id
    }

    return capitalized ? result.charAt(0).toUpperCase() + result.slice(1) : result
}
