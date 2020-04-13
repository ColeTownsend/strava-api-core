import { Database } from "./database";
export declare const database: Database;
import { Mailer } from "./mailer";
export declare const mailer: Mailer;
import { Maps } from "./maps";
export declare const maps: Maps;
import { PayPal } from "./paypal";
export declare const paypal: PayPal;
import { Strava } from "./strava";
export declare const strava: Strava;
import { Weather } from "./weather";
export declare const weather: Weather;
import { Users } from "./users";
export declare const users: Users;
import { Recipes } from "./recipes";
export declare const recipes: Recipes;
export * from "./recipes/types";
export * from "./strava/types";
export * from "./users/types";
export declare const startup: () => Promise<void>;
