export class HttpNonceManager {
    accountIndex;
    apiKeyIndices;
    http;
    slots = new Map();
    pointer = 0;
    initPromise = null;
    constructor(options) {
        if (!options.apiKeyIndices.length) {
            throw new Error("Nonce manager requires at least one API key index");
        }
        this.accountIndex = options.accountIndex;
        this.apiKeyIndices = Array.from(new Set(options.apiKeyIndices)).sort((a, b) => a - b);
        this.http = options.http;
    }
    async init(force = false) {
        if (!this.initPromise || force) {
            this.initPromise = this.refreshAll(force).catch((error) => {
                this.initPromise = null;
                throw error;
            });
        }
        await this.initPromise;
    }
    next() {
        if (!this.slots.size) {
            throw new Error("Nonce manager not initialized");
        }
        const slot = this.pickSlot();
        const nonce = slot.next;
        slot.lastIssued = nonce;
        slot.next = nonce + 1n;
        return { apiKeyIndex: slot.apiKeyIndex, nonce };
    }
    acknowledgeFailure(apiKeyIndex) {
        const slot = this.slots.get(apiKeyIndex);
        if (!slot || slot.lastIssued === null)
            return;
        slot.next = slot.lastIssued;
        slot.lastIssued = null;
    }
    async refresh(apiKeyIndex) {
        const nonce = await this.http.getNextNonce(this.accountIndex, apiKeyIndex);
        // eslint-disable-next-line no-console
        if (process.env.LIGHTER_DEBUG === "1" || process.env.LIGHTER_DEBUG === "true") {
            console.debug("[LighterNonceManager] refresh", { apiKeyIndex, nonce: nonce.toString() });
        }
        this.slots.set(apiKeyIndex, { apiKeyIndex, next: nonce, lastIssued: null });
    }
    async refreshAll(force) {
        await Promise.all(this.apiKeyIndices.map(async (index) => {
            if (!force && this.slots.has(index))
                return;
            await this.refresh(index);
        }));
        this.pointer = 0;
    }
    pickSlot() {
        const total = this.apiKeyIndices.length;
        if (total === 0) {
            throw new Error("Nonce manager not initialized");
        }
        const index = this.apiKeyIndices[this.pointer % total];
        this.pointer = (this.pointer + 1) % total;
        const slot = this.slots.get(index);
        if (!slot) {
            throw new Error(`Nonce slot for API key index ${index} is not initialized`);
        }
        return slot;
    }
}
