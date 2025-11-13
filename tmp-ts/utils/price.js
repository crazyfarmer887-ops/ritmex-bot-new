export function getTopPrices(depth) {
    const bid = Number(depth?.bids?.[0]?.[0]);
    const ask = Number(depth?.asks?.[0]?.[0]);
    return {
        topBid: Number.isFinite(bid) ? bid : null,
        topAsk: Number.isFinite(ask) ? ask : null,
    };
}
export function getMidOrLast(depth, ticker) {
    const { topBid, topAsk } = getTopPrices(depth);
    if (topBid != null && topAsk != null)
        return (topBid + topAsk) / 2;
    const last = Number(ticker?.lastPrice);
    return Number.isFinite(last) ? last : null;
}
