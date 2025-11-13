export function safeSubscribe(subscribe, handler, log, messages) {
    try {
        subscribe((payload) => {
            try {
                handler(payload);
            }
            catch (error) {
                log("error", messages.processFail(error));
            }
        });
    }
    catch (error) {
        log("error", messages.subscribeFail(error));
    }
}
