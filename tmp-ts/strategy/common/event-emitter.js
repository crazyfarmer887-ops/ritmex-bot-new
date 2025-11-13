export class StrategyEventEmitter {
    listeners = new Map();
    on(event, handler) {
        const handlers = this.listeners.get(event) ?? new Set();
        handlers.add(handler);
        this.listeners.set(event, handlers);
    }
    off(event, handler) {
        const handlers = this.listeners.get(event);
        if (!handlers)
            return;
        handlers.delete(handler);
        if (handlers.size === 0) {
            this.listeners.delete(event);
        }
    }
    emit(event, payload, onError) {
        const handlers = this.listeners.get(event);
        if (!handlers)
            return;
        for (const handler of handlers) {
            try {
                handler(payload);
            }
            catch (error) {
                onError?.(error);
            }
        }
    }
}
