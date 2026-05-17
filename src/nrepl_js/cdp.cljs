(ns nrepl-js.cdp
  (:require ["events" :as EventEmitter]
            ["ws" :as WebSocket]
            [promesa.core :as p]))

(defn- try-connect [ws-url deadline]
  (let [^js ws (new WebSocket ws-url #js {:perMessageDeflate false :maxPayload (* 256 1024 1024)})]
    (.on ws "error" (fn []))
    (-> (p/create
         (fn [resolve reject]
           (.once ws "open" (fn [] (resolve ws)))
           (.once ws "error" (fn [err] (reject err)))))
        (p/catch
         (fn [err]
           (try (.terminate ws) (catch :default _))
           (if (>= (js/Date.now) deadline)
             (p/rejected err)
             (p/let [_ (p/delay 50)]
               (try-connect ws-url deadline))))))))

(defn connect [ws-url & [{:keys [retry-ms] :or {retry-ms 3000}}]]
  (p/let [^js ws (try-connect ws-url (+ (js/Date.now) retry-ms))
          ^js events (doto (new EventEmitter) (.setMaxListeners 0))
          pending (new js/Map)
          next-id (atom 1)
          closed (atom false)]
    (.on ws "message"
         (fn [data]
           (let [^js msg (try (js/JSON.parse (.toString data "utf8")) (catch :default _ nil))]
             (when msg
               (cond
                 (and (not (undefined? (.-id msg))) (.has pending (.-id msg)))
                 (let [^js handlers (.get pending (.-id msg))
                       resolve (.-resolve handlers)
                       reject (.-reject handlers)]
                   (.delete pending (.-id msg))
                   (if (.-error msg)
                     (if (re-find #"(?i)breakpoint.*exists\." (or (.. msg -error -message) ""))
                       (resolve #js {})
                       (reject (doto (js/Error. (or (.. msg -error -message) "CDP error"))
                                 (aset "code" (.. msg -error -code))
                                 (aset "data" (.. msg -error -data)))))
                     (resolve (or (.-result msg) #js {}))))

                 (.-method msg)
                 (.emit events (.-method msg) (or (.-params msg) #js {})))))))

    (.on ws "close"
         (fn []
           (reset! closed true)
           (.forEach pending (fn [^js handlers _]
                               ((.-reject handlers) (js/Error. "CDP connection closed"))))
           (.clear pending)
           (.emit events "__closed__")))
    (.on ws "error" (fn [err] (.emit events "__error__" err)))

    #js {:send (fn [method params]
                 (if @closed
                   (p/rejected (js/Error. "CDP connection closed"))
                   (let [id (swap! next-id inc)]
                     (p/create
                      (fn [resolve reject]
                        (.set pending id #js {:resolve resolve :reject reject})
                        (.send ws (js/JSON.stringify #js {:id id :method method :params (or params #js {})})
                               (fn [err]
                                 (when err
                                   (.delete pending id)
                                   (reject err)))))))))
         :on (fn [event listener]
               (.on events event listener)
               (fn [] (.off events event listener)))
         :close (fn [] (try (.close ws) (catch :default _)))
         :isClosed (fn [] @closed)}))
