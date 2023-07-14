// Strautomator Core: PayPal types

/**
 * PayPal auth with access token and expiry date.
 */
export interface PayPalAuth {
    /** PayPal OAuth2 access token. */
    accessToken: string
    /** Expiry timestamp (unix epoch). */
    expiresAt: number
}

/**
 * A PayPal billing plan.
 */
export interface PayPalBillingPlan {
    /** Billing plan ID. */
    id: string
    /** Product ID. */
    productId: string
    /** Billing plan name. */
    name: string
    /** Date when billing plan was created. */
    dateCreated: Date
    /** Plan's price. */
    price: number
    /** Currency. */
    currency: string
    /** Billing frequency (month or year). */
    frequency?: string
    /** Is the billing plan currently enabled? */
    enabled?: boolean
}

/**
 * A PayPal product.
 */
export interface PayPalProduct {
    /** Product ID. */
    id: string
    /** Product name. */
    name: string
    /** Date when product was created. */
    dateCreated: Date
}

/**
 * A PayPal subscription (user subscribed to Strautomator).
 */
export interface PayPalSubscription {
    /** Subscription ID. */
    id: string
    /** User ID (set when subscribing, might be null when only fetching subscriptions from PayPal). */
    userId: string
    /** Email of the subscriber. */
    email?: string
    /** Subscription status. */
    status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED"
    /** Billing plan details. */
    billingPlan: PayPalBillingPlan
    /** Date of creation of the subscription. */
    dateCreated: Date
    /** Date of last update of the subscription. */
    dateUpdated: Date
    /** Date of next payment. */
    dateNextPayment?: Date
    /** URL for the user to proceed and approve the subscription. */
    approvalUrl?: string
    /** Details of the last payment (if any was made). */
    lastPayment?: {
        /** Payment amount. */
        amount: number
        /** Payment currency. */
        currency: string
        /** Payment date. */
        date: Date
    }
}

/**
 * A PayPal transaction.
 */
export interface PayPalTransaction {
    /** Transaction ID. */
    id: string
    /** Transaction amount. */
    amount: number
    /** Transaction currency. */
    currency: string
    /** Transaction date. */
    date: Date
    /** Reference subscription. */
    subscriptionId?: string
    /** Payer's email. */
    email?: string
}

/**
 * A webhook registered on PayPal.
 */
export interface PayPalWebhook {
    /** ID of the webhook. */
    id: string
    /** URL of the webhook. */
    url: string
}
