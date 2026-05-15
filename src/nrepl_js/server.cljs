(ns nrepl-js.server
  (:require ["node:net" :as net]
            ["node:fs" :as fs-sync]
            [nrepl-js.bencode :as bc]
            [nrepl-js.ops :as ops]
            [nrepl-js.tracing :as tracing]
            [nrepl-js.console :as console]
            [promesa.core :as p]))

(defn- open-debug-sink []
  (try
    (let [fd (.openSync fs-sync "/dev/tty" "w")]
      (fn [line] (.writeSync fs-sync fd (str line "\n"))))
    (catch :default _
      (fn [line] (.write (.-stderr js/process) (str line "\n"))))))

(defn- handle-connection [^js socket ^js ctx dbg]
  (let [buf (atom (js/Buffer.alloc 0))
        sessions (new js/Set)
        conn #js {:socket socket
                  :sessions sessions
                  :send (fn [msg]
                          (when dbg (dbg (str " -> " (js/JSON.stringify msg))))
                          (try (.write socket (bc/encode msg)) (catch :default _)))}]
    (.add (.-connections ctx) conn)

    (.on socket "data"
         (fn [chunk]
           (let [current (or @buf (js/Buffer.alloc 0))]
             (reset! buf (if (pos? (.-length current))
                           (js/Buffer.concat (array current chunk))
                           chunk)))
           (p/loop []
             (let [r (bc/decode @buf)]
               (when r
                 (reset! buf (:rest r))
                 (let [^js msg (:value r)
                       send (.-send conn)]
                   (when dbg (dbg (str " <- " (js/JSON.stringify msg))))
                   (let [before (new js/Set (.keys (.-sessions ctx)))]
                     (-> (p/do (ops/dispatch {:msg msg :ctx ctx :send send}))
                         (p/catch (fn [err]
                                    (send #js {:id (.-id msg)
                                               :err (str "op error: " (.-message err) "\n")
                                               :status (array "done" "error")})))
                         (p/then (fn [_]
                                   (doseq [sid (js/Array.from (.keys (.-sessions ctx)))]
                                     (when-not (.has before sid)
                                       (.add sessions sid)))
                                   (when (and (= (.-op msg) "close") (.-session msg))
                                     (.delete sessions (.-session msg)))
                                   (p/recur)))))))))))

    (.on socket "close" (fn [] (.delete (.-connections ctx) conn)))
    (.on socket "error" (fn []))))

(defn start-server
  ([] (start-server {}))
  ([{:keys [^js cdp scripts port host debug] :or {port 0 host "127.0.0.1"}}]
   (let [dbg (when debug (open-debug-sink))]
     (p/do
       (p/catch (.call (.-send cdp) cdp "Runtime.enable") (fn [_]))
       (p/catch (.call (.-send cdp) cdp "Debugger.enable") (fn [_]))
       (p/catch (.call (.-send cdp) cdp "Runtime.runIfWaitingForDebugger") (fn [_]))

       (let [ctx #js {:cdp cdp
                      :scripts scripts
                      :sessions (new js/Map)
                      :defaultContextId nil
                      :activeEvalSession nil
                      :connections (new js/Set)}]

         (.call (.-on cdp) cdp "Runtime.executionContextCreated"
                (fn [^js params]
                  (when (nil? (.-defaultContextId ctx))
                    (set! (.-defaultContextId ctx) (.. params -context -id)))))

         (p/catch (.call (.-send cdp) cdp "Runtime.enable") (fn [_]))
         (p/catch (.call (.-send cdp) cdp "Debugger.enable") (fn [_]))
         (p/catch (.call (.-send cdp) cdp "Runtime.runIfWaitingForDebugger") (fn [_]))

         (.call (.-on cdp) cdp "Debugger.scriptParsed"
                (fn [^js ev]
                  (when-not (re-find #"node_modules" (or (.-url ev) ""))
                    (tracing/instrument-source cdp ev))))

         (let [first-pause (atom true)]
           (.call (.-on cdp) cdp "Debugger.paused"
                  (fn [_]
                    (when @first-pause
                      (.call (.-send cdp) cdp "Debugger.resume"))
                    (reset! first-pause false))))

         (console/attach-console cdp
                                 (fn [{:keys [stream text structured]}]
                                   (let [^js active (.-activeEvalSession ctx)
                                         make-msg (fn [id session]
                                                    (let [m #js {:id id :session session :structured (into-array structured)}]
                                                      (aset m stream text)
                                                      m))]
                                     (if active
                                       (.forEach (.-connections ctx)
                                                 (fn [^js conn]
                                                   (when (.has (.-sessions conn) (.-id active))
                                                     (.call (.-send conn) conn
                                                            (make-msg (or (.-lastEvalId active) "0") (.-id active))))))
                                       (.forEach (.-connections ctx)
                                                 (fn [^js conn]
                                                   (.forEach (.-sessions conn)
                                                             (fn [sid]
                                                               (.call (.-send conn) conn
                                                                      (make-msg "0" sid))))))))))

         (let [server (.createServer net (fn [socket] (handle-connection socket ctx dbg)))]
           (p/let [_ (p/create
                      (fn [resolve reject]
                        (.once server "error" reject)
                        (.listen server port host (fn [] (resolve nil)))))]
             {:server server
              :port (.-port (.address server))
              :host host
              :ctx ctx})))))))
