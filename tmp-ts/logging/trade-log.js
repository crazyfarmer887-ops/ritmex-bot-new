export function createTradeLog(maxEntries, seed = []) {
    const entries = seed.slice(-maxEntries);
    function push(type, detail) {
        entries.push({ time: new Date().toLocaleString(), type, detail });
        if (entries.length > maxEntries) {
            entries.shift();
        }
    }
    function all() {
        return entries;
    }
    function replace(next) {
        entries.splice(0, entries.length, ...next.slice(-maxEntries));
    }
    return { push, all, replace };
}
