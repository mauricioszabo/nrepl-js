(ns nrepl-js.server
  (:require ["node:net" :as net]
            ["node:fs" :as fs-sync]
            [nrepl-js.bencode :as bc]
            [nrepl-js.cdp-interop :as cdp]
            [nrepl-js.ops :as ops]
            [nrepl-js.tracing :as tracing]
            [nrepl-js.console :as console]
            [promesa.core :as p]))

(defonce ^:private next-connection-id (atom 0))

(defn- open-debug-sink []
  (try
    (let [fd (.openSync fs-sync "/dev/tty" "w")]
      (fn [line] (.writeSync fs-sync fd (str line "\n"))))
    (catch :default _
      (fn [line] (.write (.-stderr js/process) (str line "\n"))))))

(defn- debug! [dbg direction msg]
  (when dbg
    (dbg (str " " direction " " (js/JSON.stringify (clj->js msg))))))

(defn- append-buffer [current chunk]
  (let [current (or current (js/Buffer.alloc 0))]
    (if (pos? (.-length current))
      (js/Buffer.concat (array current chunk))
      chunk)))

(defn- decoded-message [value]
  (js->clj value :keywordize-keys true))

(defn- session-ids [ctx]
  (keys @(:sessions ctx)))

(defn- connections [ctx]
  (vals @(:connections ctx)))

(defn- make-connection [socket dbg]
  {:id (swap! next-connection-id inc)
   :socket socket
   :sessions (atom #{})
   :send (fn [msg]
           (debug! dbg "->" msg)
           (try
             (.write socket (bc/encode (clj->js msg)))
             (catch :default _)))})

(defn- remember-new-sessions! [ctx before conn]
  (doseq [sid (session-ids ctx)]
    (when-not (contains? before sid)
      (swap! (:sessions conn) conj sid))))

(defn- forget-closed-session! [msg conn]
  (when (and (= (:op msg) "close") (:session msg))
    (swap! (:sessions conn) disj (:session msg))))

(defn- dispatch-message! [ctx conn dbg msg]
  (debug! dbg "<-" msg)
  (let [send (:send conn)
        before (set (session-ids ctx))]
    (-> (p/do (ops/dispatch {:msg msg :ctx ctx :send send}))
        (p/catch (fn [err]
                   (send {:id (:id msg)
                          :err (str "op error: " (.-message err) "\n")
                          :status ["done" "error"]})))
        (p/then (fn [_]
                  (remember-new-sessions! ctx before conn)
                  (forget-closed-session! msg conn)
                  (p/recur))))))

(defn- process-buffer! [buf ctx conn dbg]
  (p/loop []
    (when-let [{:keys [value rest]} (bc/decode @buf)]
      (reset! buf rest)
      (dispatch-message! ctx conn dbg (decoded-message value)))))

(defn- handle-connection [^js socket ctx dbg]
  (let [buf (atom (js/Buffer.alloc 0))
        conn (make-connection socket dbg)]
    (swap! (:connections ctx) assoc (:id conn) conn)
    (.on socket "data"
         (fn [chunk]
           (swap! buf append-buffer chunk)
           (process-buffer! buf ctx conn dbg)))
    (.on socket "close" (fn [] (swap! (:connections ctx) dissoc (:id conn))))
    (.on socket "error" (fn []))))

(defn- make-context [cdp scripts]
  {:cdp cdp
   :scripts scripts
   :sessions (atom {})
   :default-context-id (atom nil)
   :active-eval-session (atom nil)
   :connections (atom {})})

(defn- ignore-cdp-error [promise]
  (p/catch promise (fn [_] nil)))

(defn- enable-target! [cdp]
  (p/do
    (ignore-cdp-error (cdp/call cdp "Runtime.enable"))
    (ignore-cdp-error (cdp/call cdp "Debugger.enable"))
    (ignore-cdp-error (cdp/call cdp "Runtime.runIfWaitingForDebugger"))))

(defn- attach-cdp-handlers! [cdp ctx]
  (cdp/on cdp "Runtime.executionContextCreated"
          (fn [params]
            (when (nil? @(:default-context-id ctx))
              (reset! (:default-context-id ctx) (get-in params [:context :id])))))

  (tracing/start-trace! cdp)

  (let [first-pause? (atom true)]
    (def cdp cdp)
    (cdp/on cdp "Debugger.paused"
            (fn [ev]
              ; (when @first-pause?
              ;   (ignore-cdp-error (cdp/call cdp "Debugger.resume")))
              ; (reset! first-pause? false)
              (def ev ev)))))

(defn- console-response [{:keys [stream text structured]} id session]
  (assoc {:id id
          :session session
          :structured (vec (or structured []))}
         (keyword stream)
         text))

(defn- send-console-message! [ctx msg]
  (if-let [active @(:active-eval-session ctx)]
    (doseq [conn (connections ctx)]
      (when (contains? @(:sessions conn) (:id active))
        ((:send conn) (console-response msg (or (:last-eval-id active) "0") (:id active)))))
    (doseq [conn (connections ctx)
            sid @(:sessions conn)]
      ((:send conn) (console-response msg "0" sid)))))

(defn- listen! [^js server port host]
  (p/create
   (fn [resolve reject]
     (.once server "error" reject)
     (.listen server port host (fn [] (resolve nil))))))

(defn start-server
  ([] (start-server {}))
  ([{:keys [^js cdp scripts port host debug] :or {port 0 host "127.0.0.1"}}]
   (let [dbg (when debug (open-debug-sink))
         ctx (make-context cdp scripts)
         server (.createServer net (fn [socket] (handle-connection socket ctx dbg)))]
     (attach-cdp-handlers! cdp ctx)
     (console/attach-console cdp #(send-console-message! ctx %))
     (p/do
       (enable-target! cdp)
       (p/let [_ (listen! server port host)]
         {:server server
          :port (.-port (.address server))
          :host host
          :ctx ctx})))))


#_
(->> ev :callFrames
     (map :location))
#_
(cdp/call cdp "Debugger.evaluateOnCallFrame"
          {;:callFrameId (-> ev :callFrames first :callFrameId)
           :expression  "props"
           :returnByValue false
           :generatePreview true})
