(ns nrepl-js.core
  (:require ["node:fs/promises" :as fs]
            ["node:child_process" :refer [spawn]]
            ["node:path" :as path]
            ["node:readline/promises" :as readline-promises]
            [nrepl-js.inspector :as inspector]
            [nrepl-js.cdp :as cdp]
            [nrepl-js.scripts :as scripts]
            [nrepl-js.server :as server]
            [promesa.core :as p]))

(defn start
  ([] (start {}))
  ([{:keys [inspect-host inspect-port inspect-target inspect-ws-url port host debug]
     :or {inspect-host "  127.0.0.1" inspect-port 9229 port 0 host "127.0.0.1" debug false}}]
   (p/let [ws-url (or inspect-ws-url
                      (inspector/discover {:host inspect-host
                                           :port inspect-port
                                           :target inspect-target}))
           conn (cdp/connect ws-url)
           script-registry (scripts/create-script-registry conn)
           result (server/start-server {:cdp conn
                                        :scripts script-registry
                                        :port port
                                        :host host
                                        :debug debug})]
     (let [{:keys [server port host ^js ctx]} result]
       {:port port
        :host host
        :cdp conn
        :server server
        :ctx ctx
        :close (fn []
                 (p/do
                   (.call (.-close conn) conn)
                   (.forEach (.-connections ctx)
                             (fn [^js c]
                               (try (.destroy (.-socket c)) (catch :default _))))
                   (p/create (fn [resolve _]
                               (.close server (fn [] (resolve nil)))))))}))))

(defn- parse-args [argv]
  (let [args (atom {:port 0 :host "127.0.0.1" :inspect-host "127.0.0.1" :inspect-port 9229
                    :inspect-target nil :list-targets false :spawn nil
                    :write-port-file true :debug false})
        i (atom 0)]
    (while (< @i (count argv))
      (let [a (nth argv @i)
            nxt (fn [] (let [v (nth argv (inc @i))] (swap! i inc) v))]
        (cond
          (= a "--port") (swap! args assoc :port (js/Number (nxt)))
          (= a "--host") (swap! args assoc :host (nxt))
          (= a "--inspect-host") (swap! args assoc :inspect-host (nxt))
          (= a "--inspect-port") (swap! args assoc :inspect-port (js/Number (nxt)))
          (= a "--target") (swap! args assoc :inspect-target (nxt))
          (= a "--list-targets") (swap! args assoc :list-targets true)
          (= a "--spawn") (swap! args assoc :spawn (nxt))
          (= a "--no-port-file") (swap! args assoc :write-port-file false)
          (= a "--debug") (swap! args assoc :debug true)
          (or (= a "-h") (= a "--help"))
          (do
            (js/console.log
             "nrepl-js — nREPL server backed by the V8 Inspector\n\nUsage: nrepl-js [options]\n  --port <p>            nREPL TCP port (default: 0 = OS-assigned)\n  --host <h>            bind host (default: 127.0.0.1)\n  --inspect-host <h>    inspector host (default: 127.0.0.1)\n  --inspect-port <p>    inspector port (default: 9229)\n  --target <text>       attach to target whose title/url/id/type partially matches text\n  --list-targets        list inspector targets and exit\n  --spawn <file>        spawn 'node --inspect=0 <file>' and attach to it\n  --no-port-file        don't write .nrepl-port to cwd\n  --debug               log incoming (<-) and outgoing (->) nREPL messages to stdout\n")
            (.exit js/process 0))
          :else
          (do
            (.error js/console "unknown arg:" a)
            (.exit js/process 2))))
      (swap! i inc))
    @args))

(defn- spawn-inspected [file]
  (p/create
   (fn [resolve reject]
     (let [^js child (spawn (.-execPath js/process) (array "--inspect=0" file) #js {:stdio (array "inherit" "inherit" "pipe")})
           buf (atom "")]
       (.on (.-stderr child) "data"
            (fn [chunk]
              (let [s (.toString chunk "utf8")]
                (.write (.-stderr js/process) s)
                (swap! buf str s)
                (let [m (re-find #"Debugger listening on ws://[^:]+:(\d+)" @buf)]
                  (when m
                    (resolve {:child child :inspect-port (js/Number (second m))}))))))
       (.once child "exit"
              (fn [code] (reject (js/Error. (str "spawned node exited: " code)))))
       (js/setTimeout
        (fn [] (reject (js/Error. "inspector port timeout")))
        5000)))))

(defn- target-label [^js target]
  (when target
    (let [title (or (.-title target) "(untitled)")
          type (or (.-type target) "unknown")
          url (or (.-url target) "")]
      (str title " [" type "]" (when (seq url) (str " " url))))))

(defn- choose-target [args]
  (p/let [targets (inspector/list-targets {:host (:inspect-host args) :port (:inspect-port args)})
          debuggable (into-array (filter #(.-webSocketDebuggerUrl ^js %) (array-seq targets)))]
    (cond
      (:list-targets args)
      (do
        (js/console.log (inspector/format-target-list targets))
        (.exit js/process 0))

      (:inspect-target args)
      (let [^js target (inspector/select-target targets (:inspect-target args))]
        {:target target :ws-url (.-webSocketDebuggerUrl target)})

      (<= (.-length debuggable) 1)
      (let [^js target (inspector/select-target targets)]
        {:target target :ws-url (.-webSocketDebuggerUrl target)})

      :else
      (do
        (js/console.log "Inspector targets:")
        (js/console.log (inspector/format-target-list debuggable))
        (if-not (.-isTTY (.-stdin js/process))
          (p/rejected (js/Error. "multiple inspector targets found; pass --target <title-or-url-substring>"))
          (p/let [^js rl (.createInterface readline-promises
                                           #js {:input (.-stdin js/process)
                                                :output (.-stdout js/process)})
                  answer (-> (.question rl "Select target by number or partial text: ")
                             (p/then (fn [a] (.close rl) (.trim a))))]
            (when (empty? answer)
              (throw (js/Error. "no target selected")))
            (let [n (js/Number answer)]
              (if (and (js/Number.isInteger n) (>= n 1) (<= n (.-length debuggable)))
                (let [^js target (aget debuggable (dec n))]
                  {:target target :ws-url (.-webSocketDebuggerUrl target)})
                (let [^js target (inspector/select-target debuggable answer)]
                  {:target target :ws-url (.-webSocketDebuggerUrl target)})))))))))

(defn main [ & args]
  (let [args (parse-args args)]
    (-> (p/let [spawn-result (when (:spawn args) (spawn-inspected (:spawn args)))
                args (if spawn-result
                       (assoc args :inspect-port (:inspect-port spawn-result))
                       args)
                child (:child spawn-result)
                selected (choose-target args)
                handle (start {:inspect-host (:inspect-host args)
                               :inspect-port (:inspect-port args)
                               :inspect-ws-url (:ws-url selected)
                               :port (:port args)
                               :host (:host args)
                               :debug (:debug args)})]
          (js/console.log (str "nREPL server listening on " (:host args) ":" (:port handle)
                               " (attached to " (target-label (:target selected))
                               " at " (:inspect-host args) ":" (:inspect-port args) ")"))
          (when (:write-port-file args)
            (p/catch
             (.writeFile fs (.join path (.cwd js/process) ".nrepl-port") (str (:port handle)))
             (fn [err] (.error js/console "warning: could not write .nrepl-port:" (.-message err)))))

          (let [shutdown (fn [sig]
                           (.error js/console (str "\nshutting down (" sig ")"))
                           (-> (p/do ((:close handle)))
                               (p/finally (fn []
                                            (when child (try (.kill ^js child) (catch :default _)))
                                            (when (:write-port-file args)
                                              (p/catch
                                               (.unlink fs (.join path (.cwd js/process) ".nrepl-port"))
                                               (fn [_])))
                                            (.exit js/process 0)))))]
            (.on js/process "SIGINT" (fn [] (shutdown "SIGINT")))
            (.on js/process "SIGTERM" (fn [] (shutdown "SIGTERM")))))
        (p/catch (fn [err]
                   (.error js/console "nrepl-js failed:" (.-message err))
                   (.exit js/process 1))))))
