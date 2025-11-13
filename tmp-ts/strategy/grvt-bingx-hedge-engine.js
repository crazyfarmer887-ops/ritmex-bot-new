import { getExchangeDisplayName } from "../exchanges/create-adapter";
import { createTradeLog } from "../logging/trade-log";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe } from "./common/subscriptions";
import { getPosition } from "../utils/strategy";
import { getTopPrices } from "../utils/price";
import { decimalsOf, isNearlyZero, roundQtyDownToStep } from "../utils/math";
import { extractMessage } from "../utils/errors";
const POSITION_EPS = 1e-6;
export class GrvtBingxHedgeEngine {
    config;
    events = new StrategyEventEmitter();
    tradeLog;
    now;
    roiDecimal;
    legs;
    status = "initializing";
    timer = null;
    stopped = false;
    errorMessage = null;
    entryAverage = null;
    exitTargets = { grvt: null, bingx: null };
    entryCompletionLogged = false;
    exitCompletionLogged = false;
    constructor(config, deps) {
        this.config = config;
        this.tradeLog = createTradeLog(config.maxLogEntries);
        this.now = deps.now ?? (() => Date.now());
        this.roiDecimal = Number.isFinite(config.exitRoiPercent)
            ? Math.max(0, config.exitRoiPercent) / 100
            : 0;
        this.legs = {
            grvt: this.createLegState({
                key: "grvt",
                label: "GRVT 多头",
                exchangeId: "grvt",
                direction: "long",
                adapter: deps.grvtAdapter,
                symbol: config.grvtSymbol,
                entrySide: "BUY",
                exitSide: "SELL",
                priceTick: config.grvtPriceTick,
                qtyStep: config.grvtQtyStep,
            }),
            bingx: this.createLegState({
                key: "bingx",
                label: "BingX 空头",
                exchangeId: "bingx",
                direction: "short",
                adapter: deps.bingxAdapter,
                symbol: config.bingxSymbol,
                entrySide: "SELL",
                exitSide: "BUY",
                priceTick: config.bingxPriceTick,
                qtyStep: config.bingxQtyStep,
            }),
        };
        this.validateConfig();
        this.bootstrapLeg("grvt");
        this.bootstrapLeg("bingx");
        this.emitUpdate();
    }
    start() {
        if (this.timer || this.status === "error")
            return;
        this.stopped = false;
        this.timer = setInterval(() => this.evaluate(), this.config.pollIntervalMs);
        void this.initialize();
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.status !== "completed") {
            this.status = "stopped";
        }
        this.emitUpdate();
    }
    on(event, handler) {
        this.events.on(event, handler);
    }
    off(event, handler) {
        this.events.off(event, handler);
    }
    getSnapshot() {
        return this.buildSnapshot();
    }
    validateConfig() {
        if (!Number.isFinite(this.config.orderAmount) || this.config.orderAmount <= 0) {
            this.errorMessage = "对冲下单数量必须大于 0 (HEDGE_ORDER_AMOUNT)";
            this.status = "error";
            this.tradeLog.push("error", this.errorMessage);
            return;
        }
        if (!Number.isFinite(this.config.grvtPriceTick) ||
            !Number.isFinite(this.config.bingxPriceTick) ||
            this.config.grvtPriceTick <= 0 ||
            this.config.bingxPriceTick <= 0) {
            this.errorMessage = "价位精度 (HEDGE_GRVT_PRICE_TICK / HEDGE_BINGX_PRICE_TICK) 必须大于 0";
            this.status = "error";
            this.tradeLog.push("error", this.errorMessage);
            return;
        }
        if (!Number.isFinite(this.config.grvtQtyStep) ||
            !Number.isFinite(this.config.bingxQtyStep) ||
            this.config.grvtQtyStep <= 0 ||
            this.config.bingxQtyStep <= 0) {
            this.errorMessage = "数量精度 (HEDGE_GRVT_QTY_STEP / HEDGE_BINGX_QTY_STEP) 必须大于 0";
            this.status = "error";
            this.tradeLog.push("error", this.errorMessage);
        }
    }
    createLegState(options) {
        const priceTick = Number.isFinite(options.priceTick) && options.priceTick > 0 ? options.priceTick : 0.1;
        const qtyStep = Number.isFinite(options.qtyStep) && options.qtyStep > 0 ? options.qtyStep : 0.001;
        return {
            ...options,
            priceTick,
            qtyStep,
            topBid: null,
            topAsk: null,
            account: null,
            position: getPosition(null, options.symbol),
            orders: [],
            feedReady: {
                account: false,
                orders: false,
                depth: false,
            },
            entryTargetQty: 0,
            exitTargetQty: 0,
            entryLimitPrice: null,
            exitLimitPrice: null,
        };
    }
    async initialize() {
        try {
            await Promise.all([
                this.cancelAllOrders(this.legs.grvt, "启动清理"),
                this.cancelAllOrders(this.legs.bingx, "启动清理"),
            ]);
            this.tradeLog.push("info", "已清理两腿历史挂单，准备进场");
        }
        catch (error) {
            this.tradeLog.push("warn", `启动清理挂单失败: ${extractMessage(error)}`);
        }
        finally {
            if (this.status !== "error") {
                this.status = "waiting-entry";
                this.emitUpdate();
                this.evaluate();
            }
        }
    }
    bootstrapLeg(key) {
        const leg = this.legs[key];
        const log = (type, detail) => {
            this.tradeLog.push(type, `[${leg.label}] ${detail}`);
        };
        safeSubscribe(leg.adapter.watchAccount.bind(leg.adapter), (snapshot) => {
            leg.account = snapshot;
            leg.position = getPosition(snapshot, leg.symbol);
            if (!leg.feedReady.account) {
                this.tradeLog.push("info", `[${leg.label}] 账户数据已同步`);
            }
            leg.feedReady.account = true;
            this.evaluate();
            this.emitUpdate();
        }, log, {
            subscribeFail: (error) => `账户订阅失败: ${error instanceof Error ? error.message : String(error)}`,
            processFail: (error) => `账户推送处理异常: ${error instanceof Error ? error.message : String(error)}`,
        });
        safeSubscribe(leg.adapter.watchOrders.bind(leg.adapter), (orders) => {
            leg.orders = Array.isArray(orders)
                ? orders.filter((order) => order.symbol === leg.symbol)
                : [];
            if (!leg.feedReady.orders) {
                this.tradeLog.push("info", `[${leg.label}] 订单数据已同步`);
            }
            leg.feedReady.orders = true;
            this.refreshKnownOrderState(leg);
            this.evaluate();
            this.emitUpdate();
        }, log, {
            subscribeFail: (error) => `订单订阅失败: ${error instanceof Error ? error.message : String(error)}`,
            processFail: (error) => `订单推送处理异常: ${error instanceof Error ? error.message : String(error)}`,
        });
        safeSubscribe(leg.adapter.watchDepth.bind(leg.adapter, leg.symbol), (depth) => {
            const { topBid, topAsk } = getTopPrices(depth);
            leg.topBid = topBid;
            leg.topAsk = topAsk;
            if (!leg.feedReady.depth && (topBid != null || topAsk != null)) {
                this.tradeLog.push("info", `[${leg.label}] 深度行情已就绪`);
            }
            leg.feedReady.depth = true;
            this.evaluate();
            this.emitUpdate();
        }, log, {
            subscribeFail: (error) => `深度订阅失败: ${error instanceof Error ? error.message : String(error)}`,
            processFail: (error) => `深度推送处理异常: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
    refreshKnownOrderState(leg) {
        if (leg.entryOrderId != null) {
            const entryOrder = this.findOrder(leg, leg.entryOrderId);
            if (entryOrder) {
                leg.lastKnownEntryStatus = entryOrder.status;
                const price = Number(entryOrder.price);
                if (Number.isFinite(price) && price > 0) {
                    leg.entryLimitPrice = price;
                }
            }
        }
        if (leg.exitOrderId != null) {
            const exitOrder = this.findOrder(leg, leg.exitOrderId);
            if (exitOrder) {
                leg.lastKnownExitStatus = exitOrder.status;
                const price = Number(exitOrder.price);
                if (Number.isFinite(price) && price > 0) {
                    leg.exitLimitPrice = price;
                }
            }
        }
    }
    evaluate() {
        if (this.stopped || this.status === "error")
            return;
        if (this.status === "waiting-entry") {
            if (this.canPlaceEntry()) {
                void this.placeEntryOrders();
            }
            return;
        }
        if (this.status === "entry-submitted" || this.status === "placing-exit") {
            if (this.areEntriesFilled()) {
                if (!this.entryCompletionLogged) {
                    this.entryCompletionLogged = true;
                    this.tradeLog.push("info", "双腿入场已全部成交，准备布置退出挂单");
                }
                if (!this.exitOrdersPlaced()) {
                    void this.placeExitOrders();
                }
            }
            return;
        }
        if (this.status === "exit-submitted") {
            if (this.areExitsFilled()) {
                if (!this.exitCompletionLogged) {
                    this.exitCompletionLogged = true;
                    this.tradeLog.push("success", "对冲仓位已全部退出");
                }
                this.status = "completed";
                this.emitUpdate();
            }
        }
    }
    canPlaceEntry() {
        if (this.status !== "waiting-entry")
            return false;
        if (!Number.isFinite(this.config.orderAmount) || this.config.orderAmount <= 0) {
            return false;
        }
        const legs = Object.values(this.legs);
        for (const leg of legs) {
            if (!leg.feedReady.account || !leg.feedReady.orders || !leg.feedReady.depth) {
                return false;
            }
            if (!this.hasMarketDataForEntry(leg)) {
                return false;
            }
            if (!this.isLegFlat(leg)) {
                if (!this.entryCompletionLogged) {
                    this.tradeLog.push("warn", `[${leg.label}] 当前已有持仓 (${leg.position.positionAmt}), 等待人工处理后再进场`);
                    this.entryCompletionLogged = true;
                }
                return false;
            }
        }
        return true;
    }
    hasMarketDataForEntry(leg) {
        if (leg.entrySide === "BUY") {
            return Number.isFinite(leg.topAsk ?? NaN);
        }
        return Number.isFinite(leg.topBid ?? NaN);
    }
    async placeEntryOrders() {
        if (this.status !== "waiting-entry")
            return;
        this.status = "placing-entry";
        const longLeg = this.legs.grvt;
        const shortLeg = this.legs.bingx;
        try {
            const longPriceRaw = longLeg.entrySide === "BUY" ? longLeg.topAsk : longLeg.topBid;
            const shortPriceRaw = shortLeg.entrySide === "SELL" ? shortLeg.topBid : shortLeg.topAsk;
            if (!Number.isFinite(longPriceRaw) || !Number.isFinite(shortPriceRaw)) {
                throw new Error("无法获取最新盘口价格，稍后重试");
            }
            const longPrice = this.adjustPrice(longPriceRaw, longLeg.priceTick, "up");
            const shortPrice = this.adjustPrice(shortPriceRaw, shortLeg.priceTick, "down");
            const longQty = this.adjustQuantity(this.config.orderAmount, longLeg.qtyStep);
            const shortQty = this.adjustQuantity(this.config.orderAmount, shortLeg.qtyStep);
            if (longQty <= 0 || shortQty <= 0) {
                throw new Error("对冲下单数量在精度处理后无效，请调大 HEDGE_ORDER_AMOUNT");
            }
            const entryOrders = {};
            try {
                entryOrders.grvt = await longLeg.adapter.createOrder({
                    symbol: longLeg.symbol,
                    side: longLeg.entrySide,
                    type: "LIMIT",
                    price: longPrice,
                    quantity: longQty,
                    timeInForce: "GTC",
                    reduceOnly: "false",
                });
                this.tradeLog.push("order", `[${longLeg.label}] 入场挂单 ${longLeg.entrySide} ${longQty} @ ${longPrice}`);
                entryOrders.bingx = await shortLeg.adapter.createOrder({
                    symbol: shortLeg.symbol,
                    side: shortLeg.entrySide,
                    type: "LIMIT",
                    price: shortPrice,
                    quantity: shortQty,
                    timeInForce: "GTC",
                    reduceOnly: "false",
                });
                this.tradeLog.push("order", `[${shortLeg.label}] 入场挂单 ${shortLeg.entrySide} ${shortQty} @ ${shortPrice}`);
            }
            catch (error) {
                const message = extractMessage(error);
                this.tradeLog.push("error", `入场挂单失败: ${message}`);
                this.errorMessage = message;
                if (entryOrders.grvt) {
                    await this.cancelSpecificOrder(longLeg, entryOrders.grvt.orderId, "入场失败回滚(GRVT)");
                }
                if (entryOrders.bingx) {
                    await this.cancelSpecificOrder(shortLeg, entryOrders.bingx.orderId, "入场失败回滚(BingX)");
                }
                this.status = "waiting-entry";
                this.emitUpdate();
                return;
            }
            longLeg.entryOrderId = entryOrders.grvt?.orderId ?? longLeg.entryOrderId;
            longLeg.entryTargetQty = longQty;
            longLeg.entryLimitPrice = longPrice;
            longLeg.lastKnownEntryStatus = entryOrders.grvt?.status ?? "NEW";
            shortLeg.entryOrderId = entryOrders.bingx?.orderId ?? shortLeg.entryOrderId;
            shortLeg.entryTargetQty = shortQty;
            shortLeg.entryLimitPrice = shortPrice;
            shortLeg.lastKnownEntryStatus = entryOrders.bingx?.status ?? "NEW";
            this.entryAverage = (longPrice + shortPrice) / 2;
            this.exitTargets.grvt =
                this.roiDecimal > 0
                    ? this.adjustPrice(this.entryAverage * (1 + this.roiDecimal), longLeg.priceTick, "up")
                    : longPrice;
            this.exitTargets.bingx =
                this.roiDecimal > 0
                    ? this.adjustPrice(this.entryAverage * (1 - this.roiDecimal), shortLeg.priceTick, "down")
                    : shortPrice;
            this.entryCompletionLogged = false;
            this.exitCompletionLogged = false;
            this.status = "entry-submitted";
            this.errorMessage = null;
            this.tradeLog.push("info", `入场挂单完成 ｜ 平均价 ${this.entryAverage?.toFixed(4) ?? "-"} ｜ ROI 目标 ${(this.roiDecimal * 100).toFixed(2)}%`);
            this.emitUpdate();
        }
        catch (error) {
            const message = extractMessage(error);
            this.tradeLog.push("error", `准备入场失败: ${message}`);
            this.errorMessage = message;
            this.status = "waiting-entry";
            this.emitUpdate();
        }
    }
    async placeExitOrders() {
        if (this.status !== "entry-submitted" && this.status !== "placing-exit")
            return;
        if (this.exitOrdersPlaced())
            return;
        this.status = "placing-exit";
        const longLeg = this.legs.grvt;
        const shortLeg = this.legs.bingx;
        try {
            const longQty = this.adjustQuantity(this.getLegExitQuantity(longLeg), longLeg.qtyStep);
            const shortQty = this.adjustQuantity(this.getLegExitQuantity(shortLeg), shortLeg.qtyStep);
            if (longQty <= 0 || shortQty <= 0) {
                throw new Error("退出数量无效，持仓尚未形成或账户快照未刷新");
            }
            const longPriceTarget = this.exitTargets.grvt ??
                this.adjustPrice((this.entryAverage ?? longLeg.entryLimitPrice ?? longLeg.topBid ?? 0) * (1 + this.roiDecimal), longLeg.priceTick, "up");
            const shortPriceTarget = this.exitTargets.bingx ??
                this.adjustPrice((this.entryAverage ?? shortLeg.entryLimitPrice ?? shortLeg.topAsk ?? 0) * (1 - this.roiDecimal), shortLeg.priceTick, "down");
            const exitOrders = {};
            try {
                exitOrders.grvt = await longLeg.adapter.createOrder({
                    symbol: longLeg.symbol,
                    side: longLeg.exitSide,
                    type: "LIMIT",
                    price: longPriceTarget,
                    quantity: longQty,
                    timeInForce: "GTC",
                    reduceOnly: "true",
                });
                this.tradeLog.push("order", `[${longLeg.label}] 退出挂单 ${longLeg.exitSide} ${longQty} @ ${longPriceTarget} (reduceOnly)`);
                exitOrders.bingx = await shortLeg.adapter.createOrder({
                    symbol: shortLeg.symbol,
                    side: shortLeg.exitSide,
                    type: "LIMIT",
                    price: shortPriceTarget,
                    quantity: shortQty,
                    timeInForce: "GTC",
                    reduceOnly: "true",
                });
                this.tradeLog.push("order", `[${shortLeg.label}] 退出挂单 ${shortLeg.exitSide} ${shortQty} @ ${shortPriceTarget} (reduceOnly)`);
            }
            catch (error) {
                const message = extractMessage(error);
                this.tradeLog.push("error", `退出挂单失败: ${message}`);
                this.errorMessage = message;
                if (exitOrders.grvt) {
                    await this.cancelSpecificOrder(longLeg, exitOrders.grvt.orderId, "退出失败回滚(GRVT)");
                }
                if (exitOrders.bingx) {
                    await this.cancelSpecificOrder(shortLeg, exitOrders.bingx.orderId, "退出失败回滚(BingX)");
                }
                this.status = "entry-submitted";
                this.emitUpdate();
                return;
            }
            longLeg.exitOrderId = exitOrders.grvt?.orderId ?? longLeg.exitOrderId;
            longLeg.exitTargetQty = longQty;
            longLeg.exitLimitPrice = longPriceTarget;
            longLeg.lastKnownExitStatus = exitOrders.grvt?.status ?? "NEW";
            shortLeg.exitOrderId = exitOrders.bingx?.orderId ?? shortLeg.exitOrderId;
            shortLeg.exitTargetQty = shortQty;
            shortLeg.exitLimitPrice = shortPriceTarget;
            shortLeg.lastKnownExitStatus = exitOrders.bingx?.status ?? "NEW";
            this.status = "exit-submitted";
            this.errorMessage = null;
            this.emitUpdate();
        }
        catch (error) {
            const message = extractMessage(error);
            this.tradeLog.push("error", `准备退出失败: ${message}`);
            this.errorMessage = message;
            this.status = "entry-submitted";
            this.emitUpdate();
        }
    }
    exitOrdersPlaced() {
        return this.legs.grvt.exitOrderId != null && this.legs.bingx.exitOrderId != null;
    }
    areEntriesFilled() {
        const grvtQty = Math.abs(this.legs.grvt.position.positionAmt);
        const bingxQty = Math.abs(this.legs.bingx.position.positionAmt);
        const grvtTarget = this.legs.grvt.entryTargetQty;
        const bingxTarget = this.legs.bingx.entryTargetQty;
        if (grvtTarget <= 0 || bingxTarget <= 0)
            return false;
        return (grvtQty >= Math.max(grvtTarget - POSITION_EPS, POSITION_EPS) &&
            bingxQty >= Math.max(bingxTarget - POSITION_EPS, POSITION_EPS));
    }
    areExitsFilled() {
        return this.isLegFlat(this.legs.grvt) && this.isLegFlat(this.legs.bingx);
    }
    isLegFlat(leg) {
        return isNearlyZero(leg.position.positionAmt, POSITION_EPS);
    }
    getLegExitQuantity(leg) {
        const absPosition = Math.abs(leg.position.positionAmt);
        if (absPosition > POSITION_EPS) {
            return absPosition;
        }
        return leg.entryTargetQty;
    }
    async cancelAllOrders(leg, context) {
        try {
            await leg.adapter.cancelAllOrders({ symbol: leg.symbol });
            this.tradeLog.push("order", `[${leg.label}] ${context}已撤销全部挂单`);
        }
        catch (error) {
            this.tradeLog.push("warn", `[${leg.label}] ${context}撤单失败: ${extractMessage(error)}`);
        }
    }
    async cancelSpecificOrder(leg, orderId, context) {
        if (orderId == null)
            return;
        try {
            await leg.adapter.cancelOrder({ symbol: leg.symbol, orderId });
            this.tradeLog.push("order", `[${leg.label}] ${context} 撤销订单 ${orderId}`);
        }
        catch (error) {
            this.tradeLog.push("warn", `[${leg.label}] ${context} 撤单失败: ${extractMessage(error)}`);
        }
    }
    adjustPrice(price, tick, direction) {
        if (!Number.isFinite(price) || price <= 0)
            return price;
        if (!Number.isFinite(tick) || tick <= 0)
            return Number(price.toFixed(6));
        const decimals = Math.min(12, Math.max(0, decimalsOf(tick)));
        const ratio = price / tick;
        let units;
        if (direction === "up") {
            units = Math.ceil(ratio - 1e-9);
        }
        else {
            units = Math.floor(ratio + 1e-9);
        }
        if (!Number.isFinite(units) || units <= 0) {
            units = 1;
        }
        const adjusted = units * tick;
        return Number(adjusted.toFixed(decimals));
    }
    adjustQuantity(qty, step) {
        if (!Number.isFinite(qty) || qty <= 0)
            return 0;
        if (!Number.isFinite(step) || step <= 0)
            return qty;
        const rounded = roundQtyDownToStep(qty, step);
        const decimals = Math.min(12, Math.max(0, decimalsOf(step)));
        return Number(rounded.toFixed(decimals));
    }
    findOrder(leg, orderId) {
        return leg.orders.find((order) => String(order.orderId) === String(orderId));
    }
    buildSnapshot() {
        return {
            ready: this.isReady(),
            status: this.status,
            roiTargetPercent: this.config.exitRoiPercent,
            entryAverage: this.entryAverage,
            exitTargets: { ...this.exitTargets },
            legs: {
                grvt: this.buildLegSnapshot(this.legs.grvt),
                bingx: this.buildLegSnapshot(this.legs.bingx),
            },
            tradeLog: this.tradeLog.all(),
            lastUpdated: this.now(),
            errorMessage: this.errorMessage,
        };
    }
    isReady() {
        return (this.status !== "initializing" &&
            Object.values(this.legs).every((leg) => leg.feedReady.account && leg.feedReady.orders && leg.feedReady.depth));
    }
    buildLegSnapshot(leg) {
        return {
            label: leg.label,
            exchange: getExchangeDisplayName(leg.exchangeId),
            symbol: leg.symbol,
            direction: leg.direction,
            entrySide: leg.entrySide,
            exitSide: leg.exitSide,
            topBid: leg.topBid,
            topAsk: leg.topAsk,
            position: leg.position,
            entryOrder: leg.entryOrderId != null ? this.buildOrderSummary(leg, leg.entryOrderId) : null,
            exitOrder: leg.exitOrderId != null ? this.buildOrderSummary(leg, leg.exitOrderId) : null,
            feedReady: { ...leg.feedReady },
        };
    }
    buildOrderSummary(leg, orderId) {
        const order = this.findOrder(leg, orderId);
        if (!order) {
            return {
                id: orderId,
                status: leg.entryOrderId === orderId
                    ? leg.lastKnownEntryStatus ?? "UNKNOWN"
                    : leg.lastKnownExitStatus ?? "UNKNOWN",
                price: leg.entryOrderId === orderId ? leg.entryLimitPrice : leg.exitLimitPrice,
                origQty: null,
                executedQty: null,
                reduceOnly: leg.entryOrderId === orderId ? false : true,
                side: leg.entryOrderId === orderId ? leg.entrySide : leg.exitSide,
            };
        }
        const price = Number(order.price);
        const origQty = Number(order.origQty);
        const executedQty = Number(order.executedQty);
        return {
            id: order.orderId,
            status: order.status ?? "UNKNOWN",
            price: Number.isFinite(price) ? price : null,
            origQty: Number.isFinite(origQty) ? origQty : null,
            executedQty: Number.isFinite(executedQty) ? executedQty : null,
            reduceOnly: Boolean(order.reduceOnly),
            side: order.side,
        };
    }
    emitUpdate() {
        const snapshot = this.buildSnapshot();
        this.events.emit("update", snapshot, (error) => {
            this.tradeLog.push("error", `推送订阅回调异常: ${String(error)}`);
        });
    }
}
